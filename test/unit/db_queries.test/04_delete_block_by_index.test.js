// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Unit tests for Database query methods (no real DB).
// Covers: all async query methods, getConnection retry/give-up,
// releaseConnection, beginTransaction, endTransaction, commitTransaction,
// verifyDatabase, createDatabase, dropDatabase, and related helpers.
// Uses sinon to inject a fake pool (no proxyquire).

'use strict';

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../../src/db.js');


function makeDb(name = 'xchain_btc_mainnet') {
    return new Database('127.0.0.1', 3306, name, 'u', 'p');
}

// Build a fake connection + pool stub that resolves with the given query stub.
function withConn(queryStub) {
    const conn = {
        query:            queryStub || sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves(),
    };
    const pool = { getConnection: sinon.stub().resolves(conn) };
    return { pool, conn };
}

// Inject a fake pool into db (replaces the one created by mariadbMock).
function injectPool(db, pool) {
    db.pool = pool;
}

describe('Database#deleteBlockByIndex()', () => {
    afterEach(() => sinon.restore());

    it('executes 4 DELETE queries and returns true on success', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        const r = await db.deleteBlockByIndex(10);
        assert.strictEqual(r, true);
        const calls = conn.query.getCalls().map(c => c.args[0]);
        // Explicit per-table checks instead of a magic DELETE count: the rollback
        // must touch exactly transaction_outputs, dispensers, transactions, blocks.
        for (const table of ['transaction_outputs', 'dispensers', 'transactions', 'blocks']) {
            assert.ok(
                calls.some(s => new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i').test(s)),
                `must DELETE FROM ${table} on reorg rollback`
            );
        }
        // events (and index_addresses) are append-only audit/lookup tables and are
        // intentionally NOT rolled back on reorg (see the comment in db.js next to
        // the DELETEs); orphaned PARSE_ERROR rows are accepted stale history and the
        // REORG marker records the deletion in that same log.
        assert.ok(
            !calls.some(s => /DELETE\s+FROM\s+(events|index_addresses)\b/i.test(s)),
            'events/index_addresses must never be deleted on reorg'
        );
        const deletes = calls.filter(s => /DELETE/i.test(s));
        assert.strictEqual(deletes.length, 4, 'no additional undeclared DELETE targets');
        // The resurrect UPDATE (clearing expiry marks left by this now-orphaned
        // block) must run BEFORE the dispenser row-delete, so a dispenser expired
        // by this block is restored on reorg.
        const resurrectIdx = calls.findIndex(s => /UPDATE\s+dispensers\s+SET\s+expired_block_index\s*=\s*NULL/i.test(s));
        const dispDeleteIdx = calls.findIndex(s => /DELETE\s+FROM\s+dispensers/i.test(s));
        assert.ok(resurrectIdx >= 0, 'must clear soft-expiry marks for the orphaned block');
        assert.ok(resurrectIdx < dispDeleteIdx, 'resurrect UPDATE must precede the dispenser DELETE');
    });

    it('throws on query error (propagates after rolling back)', async () => {
        const db = makeDb();
        const err = new Error('query failed');
        const q = sinon.stub()
            .onFirstCall().rejects(err);  // first query fails
        const { pool } = withConn(q);
        injectPool(db, pool);
        await assert.rejects(() => db.deleteBlockByIndex(5), /query failed/);
    });

    it('passes blockIndex to DELETE queries', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.deleteBlockByIndex(77);
        // Every parameterized DELETE call should include [77] as params
        const paramCalls = conn.query.getCalls().filter(c => Array.isArray(c.args[1]) && c.args[1][0] === 77);
        assert.ok(paramCalls.length >= 4);
    });

});
describe('Database#deleteBlockByIndex()', () => {
    afterEach(() => sinon.restore());

    // The decoder reorg signal must be crash-durable: the REORG audit marker for a
    // rolled-back block has to commit ATOMICALLY with that block's deletion.
    // A once-at-end event write left a crash window where blocks were gone but no marker
    // existed, so the indexer (which detects decoder reorgs only via these events rows)
    // never retracted the orphaned old-chain rows it had already indexed.
    it('[REGRESSION M-12] writes the per-block REORG marker in the SAME transaction, before commit', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        const r = await db.deleteBlockByIndex(42, 'deadbeefhash');
        assert.strictEqual(r, true);

        const eventCall = conn.query.getCalls().find(c => /INSERT\s+INTO\s+events/i.test(c.args[0]));
        assert.ok(eventCall, 'a REORG event INSERT must run inside deleteBlockByIndex when a block hash is given');
        // code column is REORG and payload is the single-block array the indexer parses.
        assert.strictEqual(eventCall.args[1][1], 'REORG');
        assert.deepStrictEqual(JSON.parse(eventCall.args[1][2]), [{ block_index: 42, block_hash: 'deadbeefhash' }]);
        // Atomicity: the marker INSERT must precede the transaction commit (same tx).
        assert.ok(conn.commit.called, 'the transaction must commit');
        assert.ok(eventCall.callId < conn.commit.getCall(0).callId, 'REORG marker must be inserted before commit');
    });

    it('[REGRESSION M-12] rolls back the block delete AND its marker together on failure', async () => {
        const db = makeDb();
        // Fail only the events INSERT; the deletes succeed. Because they share one
        // transaction, the whole thing must roll back and throw (no half-applied state).
        const q = sinon.stub().callsFake(async (sql) => {
            if (/INSERT\s+INTO\s+events/i.test(sql)) throw new Error('event insert failed');
            return [];
        });
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        await assert.rejects(() => db.deleteBlockByIndex(42, 'deadbeefhash'), /event insert failed/);
        assert.ok(conn.rollback.called, 'the shared transaction must roll back when the marker insert fails');
        assert.ok(!conn.commit.called, 'a delete whose marker failed must never commit');
    });

    it('writes NO event when called without a block hash (non-reorg delete stays a plain delete)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.deleteBlockByIndex(10);
        const eventCall = conn.query.getCalls().find(c => /INSERT\s+INTO\s+events/i.test(c.args[0]));
        assert.strictEqual(eventCall, undefined, 'no REORG marker without a block hash');
    });

});
describe('Database#deleteBlockByIndex()', () => {
    afterEach(() => sinon.restore());

    it('a PARSE_ERROR audit row survives the rollback of its block (append-only events contract)', async () => {
        // Intended behavior, documented in db.js: events is an append-only audit log
        // with no block_index column, so rolling back a block leaves its PARSE_ERROR
        // rows in place (stale-but-harmless history) and adds a REORG marker.
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        await db.insertEvent('PARSE_ERROR', { block_index: 42, reason: 'bad tx' });
        await db.deleteBlockByIndex(42, 'deadbeefhash');

        const calls = conn.query.getCalls().map(c => c.args[0]);
        // (a) nothing ever deletes from events, so the PARSE_ERROR row persists;
        assert.ok(!calls.some(s => /DELETE\s+FROM\s+events\b/i.test(s)),
            'rollback must not delete audit events for the orphaned block');
        // (b) the deletion itself is recorded as a REORG marker in that same log.
        const eventInserts = conn.query.getCalls().filter(c => /INSERT\s+INTO\s+events/i.test(c.args[0]));
        assert.strictEqual(eventInserts.length, 2, 'PARSE_ERROR insert + REORG marker');
        assert.strictEqual(eventInserts[1].args[1][1], 'REORG');
    });
});
