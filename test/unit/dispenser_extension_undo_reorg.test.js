'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A DISPENSE expiration extend overwrites dispensers.expiration and may clear a soft-expiry
// mark. The undo table records the row as it stood before the block's first extend, a reorg
// of that block puts it back, and the reorg-safe purge drops the rows. The fake connection
// below interprets only the statements this path issues, in plain JS, so the order of
// record, extend, restore and the generic mark clear is what the cases exercise.

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../src/db.js');
const { extendEditedDispenser } = require('../../src/XChainDecoder/dispenser_registration.js');

function makeDb() {
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p');
}

function fakeStore(rows) {
    const store = { dispensers: rows, undo: [], log: [] };
    store.query = async (sql, args = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        store.log.push(s);
        if (/^INSERT IGNORE INTO dispenser_extension_undo/.test(s)) {
            const [block] = args;
            for (const d of store.dispensers) {
                if (d.expired_block_index == null || d.expired_block_index === args[3]) {
                    if (!store.undo.some(u => u.block_index === block && u.tx_index === d.tx_index && u.address_id === d.address_id)) {
                        store.undo.push({ block_index: block, tx_index: d.tx_index, address_id: d.address_id,
                            prior_expiration: d.expiration, prior_expired_block_index: d.expired_block_index });
                    }
                }
            }
        } else if (/^UPDATE dispensers d INNER JOIN dispenser_extension_undo u/.test(s)) {
            for (const u of store.undo.filter(x => x.block_index === args[0])) {
                const d = store.dispensers.find(x => x.tx_index === u.tx_index && x.address_id === u.address_id);
                if (!d) continue;
                d.expiration = u.prior_expiration;
                d.expired_block_index = u.prior_expired_block_index === u.block_index ? null : u.prior_expired_block_index;
            }
        } else if (/^DELETE FROM dispenser_extension_undo WHERE block_index = \?/.test(s)) {
            store.undo = store.undo.filter(u => u.block_index !== args[0]);
        } else if (/^DELETE FROM dispenser_extension_undo WHERE block_index <= \?/.test(s)) {
            store.undo = store.undo.filter(u => u.block_index > args[0]);
        } else if (/^UPDATE dispensers\s+SET\s+expiration = GREATEST/i.test(sql.trim())) {
            const [newExp, stamp] = args;
            for (const d of store.dispensers) {
                if (d.expired_block_index == null || d.expired_block_index === args[4]) {
                    d.expiration = Math.max(d.expiration, newExp);
                    if (d.expired_block_index === stamp) d.expired_block_index = null;
                }
            }
        } else if (/^UPDATE dispensers SET expired_block_index = NULL WHERE expired_block_index = \?/.test(s)) {
            for (const d of store.dispensers) if (d.expired_block_index === args[0]) d.expired_block_index = null;
        }
        return [];
    };
    return store;
}

function attach(db, store) {
    const conn = { query: store.query, release: sinon.stub().resolves() };
    db.pool = { getConnection: sinon.stub().resolves(conn) };
    return conn;
}

describe('dispenser expiration extend undo', () => {
    afterEach(() => sinon.restore());

    it('records the pre-extend row with the block-start value kept on a second extend', async () => {
        const db = makeDb();
        const store = fakeStore([{ tx_index: 1, address_id: 7, expiration: 1000, expired_block_index: null }]);
        attach(db, store);
        assert.strictEqual(await db.recordDispenserExtensionUndo('src', 50), true);
        await db.extendOpenDispenserExpirationBySource('src', 5000, 50);
        await db.recordDispenserExtensionUndo('src', 50);
        await db.extendOpenDispenserExpirationBySource('src', 9000, 50);
        assert.strictEqual(store.dispensers[0].expiration, 9000);
        assert.deepStrictEqual(store.undo.map(u => [u.block_index, u.prior_expiration, u.prior_expired_block_index]), [[50, 1000, null]]);
    });

    it('restores expiration and an orphaned-block expiry mark through deleteBlockByIndex', async () => {
        const db = makeDb();
        const store = fakeStore([
            { tx_index: 1, address_id: 7, expiration: 1000, expired_block_index: 50 },
            { tx_index: 2, address_id: 8, expiration: 2000, expired_block_index: null },
        ]);
        attach(db, store);
        db.beginTransaction = async () => {};
        db.commitTransaction = async () => true;
        db.transactionConnection = null;
        await db.recordDispenserExtensionUndo('src', 50);
        await db.extendOpenDispenserExpirationBySource('src', 9000, 50);
        assert.deepStrictEqual(store.dispensers.map(d => [d.expiration, d.expired_block_index]), [[9000, null], [9000, null]]);

        await db.deleteBlockByIndex(50, 'hash50');

        assert.deepStrictEqual(store.dispensers.map(d => [d.expiration, d.expired_block_index]), [[1000, null], [2000, null]]);
        assert.strictEqual(store.undo.length, 0, 'the block undo rows are dropped with the block');
        const restoreAt = store.log.findIndex(l => /^UPDATE dispensers d INNER JOIN dispenser_extension_undo/.test(l));
        const clearAt = store.log.findIndex(l => /^UPDATE dispensers SET expired_block_index = NULL/.test(l));
        assert.ok(restoreAt >= 0 && clearAt > restoreAt, 'the restore runs before the generic stamp clear');
    });

    it('keeps an earlier block close in place when restoring', async () => {
        const db = makeDb();
        const store = fakeStore([{ tx_index: 1, address_id: 7, expiration: 1000, expired_block_index: 40 }]);
        attach(db, store);
        store.undo.push({ block_index: 50, tx_index: 1, address_id: 7, prior_expiration: 1000, prior_expired_block_index: 40 });
        await db.restoreDispenserExtensions({ query: store.query }, 50);
        assert.strictEqual(store.dispensers[0].expired_block_index, 40);
    });

    it('purges undo rows at the reorg-safe height with the expired dispensers', async () => {
        const db = makeDb();
        const store = fakeStore([]);
        store.undo.push({ block_index: 10, tx_index: 1, address_id: 7 }, { block_index: 200, tx_index: 1, address_id: 7 });
        attach(db, store);
        assert.strictEqual(await db.purgeExpiredDispensers(100), true);
        assert.deepStrictEqual(store.undo.map(u => u.block_index), [200]);
    });

    it('record returns false on a query error', async () => {
        const db = makeDb();
        db.pool = { getConnection: sinon.stub().resolves({ query: sinon.stub().rejects(new Error('boom')), release: sinon.stub().resolves() }) };
        assert.strictEqual(await db.recordDispenserExtensionUndo('src', 50), false);
    });

    describe('extendEditedDispenser', () => {
        it('records before it extends', async () => {
            const order = [];
            const ctx = { db: {
                recordDispenserExtensionUndo: async () => { order.push('record'); return true },
                extendOpenDispenserExpirationBySource: async () => { order.push('extend'); return true },
            } };
            await extendEditedDispenser.call(ctx, { editSource: 's', newExpiration: 9 }, 50);
            assert.deepStrictEqual(order, ['record', 'extend']);
        });

        it('rolls back without extending when the record fails', async () => {
            const extend = sinon.stub().resolves(true);
            const ctx = { db: { recordDispenserExtensionUndo: async () => false, extendOpenDispenserExpirationBySource: extend } };
            assert.strictEqual(await extendEditedDispenser.call(ctx, { editSource: 's', newExpiration: 9 }, 50), 'rollback');
            assert.ok(extend.notCalled);
        });
    });
});
