// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Every decoder table carries a recorded reorg decision. Each table in src/sql/
// must be either deleted by deleteBlockByIndex (rollback) or exempted here with
// a written reason, so a new table cannot ship without one.

'use strict';

const assert   = require('assert');
const fs       = require('fs');
const path     = require('path');
const sinon    = require('sinon');
const Database = require('../../src/db.js');

const SQL_DIR  = path.join(__dirname, '..', '..', 'src', 'sql');
const UNIVERSE = fs.readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.slice(0, -'.sql'.length))
    .sort();

const REORG_POLICY = Object.freeze({
    blocks:                   { mode: 'rollback' },
    transactions:             { mode: 'rollback' },
    transaction_outputs:      { mode: 'rollback' },
    dispensers:               { mode: 'rollback' },
    dispenser_extension_undo: { mode: 'rollback' },
    events: { mode: 'exempt', reason:
        'Append-only audit log with no block_index column; the REORG marker records the rollback in this same log, ' +
        'and the indexer reads events by ascending id, so removing rows would break its reorg detection.' },
    index_addresses: { mode: 'exempt', reason:
        'Append-only INSERT IGNORE first-reference lookup; its AUTO_INCREMENT id is a local artifact that consumers ' +
        'resolve back to the address string and never feed into a consensus value.' },
    index_transactions: { mode: 'exempt', reason:
        'Append-only INSERT IGNORE hash lookup; an orphaned row is referenced only by rows that are rolled back, ' +
        'and only by id, so it is inert once its block is deleted.' },
    pubkeys: { mode: 'exempt', reason:
        'address_id -> pubkey written INSERT IGNORE at first spend and keyed by index_addresses ids, which are never ' +
        'rolled back or reused, so a key stays bound to its own address. The indexer reads it only as source_pubkey ' +
        'into its own pubkeys mirror, which no block hash or state root reads, so a row an orphaned block revealed early ' +
        'differs from a from-genesis node only in that unhashed mirror. Never feed source_pubkey into a hashed value.' },
    mempool_transactions: { mode: 'exempt', reason:
        'Node-local snapshot of unconfirmed transactions with no block linkage; the mempool poll reconciles it ' +
        'against the node mempool every cycle (reconcileMempoolSnapshot).' },
});

// Collect the table names deleteBlockByIndex issues DELETE statements against.
async function deletedTables() {
    const conn = {
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves(),
    };
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_mainnet', 'u', 'p');
    db.pool = { getConnection: sinon.stub().resolves(conn) };
    await db.deleteBlockByIndex(10, 'deadbeef');
    const tables = new Set();
    for (const call of conn.query.getCalls()) {
        for (const m of String(call.args[0]).matchAll(/DELETE\s+(?:\w+\s+)?FROM\s+(\w+)/gi)) tables.add(m[1]);
    }
    return tables;
}

describe('decoder reorg table coverage', function () {
    afterEach(() => sinon.restore());

    it('reads a non-trivial table list from src/sql', function () {
        assert.ok(UNIVERSE.length >= 10, 'expected at least 10 tables in ' + SQL_DIR + ', found ' + UNIVERSE.length);
    });

    it('every src/sql table has a recorded reorg decision', function () {
        const unclassified = UNIVERSE.filter(t => !Object.prototype.hasOwnProperty.call(REORG_POLICY, t));
        assert.deepStrictEqual(unclassified, [],
            'tables with no reorg decision: ' + unclassified.join(', ') + '. Delete them in deleteBlockByIndex ' +
            '(src/db/blocks.js) and mark them rollback here, or exempt them here with a reason.');
    });

    it('every policy entry names a real src/sql table', function () {
        const stale = Object.keys(REORG_POLICY).filter(t => !UNIVERSE.includes(t));
        assert.deepStrictEqual(stale, [], 'policy entries for tables no longer in src/sql: ' + stale.join(', '));
    });

    it('every exemption carries a written reason', function () {
        for (const [table, policy] of Object.entries(REORG_POLICY)) {
            if (policy.mode !== 'exempt') continue;
            assert.ok(typeof policy.reason === 'string' && policy.reason.length > 40,
                'exempt table ' + table + ' needs a reason longer than 40 characters');
        }
    });

    it('deleteBlockByIndex deletes exactly the rollback tables', async function () {
        const deleted = [...await deletedTables()].sort();
        const rollback = Object.keys(REORG_POLICY).filter(t => REORG_POLICY[t].mode === 'rollback').sort();
        assert.deepStrictEqual(deleted, rollback,
            'deleteBlockByIndex DELETE targets must equal the rollback tables in REORG_POLICY');
    });
});
