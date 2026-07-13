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
const Database = require('../../src/db.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getLastBlockIndex
// ---------------------------------------------------------------------------

describe('Database#getLastBlockIndex()', () => {
    afterEach(() => sinon.restore());

    it('returns Number when rows have a BigInt max_height', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_height: 42n }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.getLastBlockIndex();
        assert.strictEqual(r, 42);
        assert.ok(typeof r === 'number');
    });

    it('returns -1 when max_height is null (empty blocks table)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_height: null }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastBlockIndex(), -1);
    });

    it('returns -1 when rows is empty', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastBlockIndex(), -1);
    });

    it('[REGRESSION P1] throws (never returns false) after retries on persistent query error', async () => {
        // A `false` return was silently coerced to a height (false + 1 === 1),
        // colliding block 1 and wedging the parse loop. The getter must surface a
        // real number or throw. Never a non-numeric sentinel. (sleep is stubbed so
        // the bounded retry loop doesn't take real wall-clock time.)
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('boom'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        await assert.rejects(() => db.getLastBlockIndex(), /getLastBlockIndex failed after/);
        assert.ok(conn.query.callCount >= 2, 'should retry before giving up');
    });

    it('recovers and returns the height when a transient error clears on retry', async () => {
        const db = makeDb();
        const q  = sinon.stub();
        q.onFirstCall().rejects(new Error('transient'));
        q.onSecondCall().resolves([{ max_height: 9n }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        assert.strictEqual(await db.getLastBlockIndex(), 9);
    });

    it('queries MAX(block_index) from blocks', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_height: 100n }]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.getLastBlockIndex();
        assert.ok(conn.query.calledOnce);
        assert.ok(/MAX\(block_index\)/i.test(conn.query.firstCall.args[0]));
    });
});

// ---------------------------------------------------------------------------
// getLastTxIndex
// ---------------------------------------------------------------------------

describe('Database#getLastTxIndex()', () => {
    afterEach(() => sinon.restore());

    it('returns Number when rows have a BigInt max_tx_index', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_tx_index: 7n }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.getLastTxIndex();
        assert.strictEqual(r, 7);
        assert.ok(typeof r === 'number');
    });

    it('returns -1 when max_tx_index is null', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_tx_index: null }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastTxIndex(), -1);
    });

    it('returns -1 when rows is empty', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastTxIndex(), -1);
    });

    it('[REGRESSION P1] throws (never returns false) after retries on persistent query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('oops'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        await assert.rejects(() => db.getLastTxIndex(), /getLastTxIndex failed after/);
        assert.ok(conn.query.callCount >= 2, 'should retry before giving up');
    });

    it('queries MAX(tx_index) from transactions', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_tx_index: 3n }]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.getLastTxIndex();
        assert.ok(/MAX\(tx_index\)/i.test(conn.query.firstCall.args[0]));
    });
});

// ---------------------------------------------------------------------------
// getBlockByIndex
// ---------------------------------------------------------------------------

describe('Database#getBlockByIndex()', () => {
    afterEach(() => sinon.restore());

    it('returns the first row when found', async () => {
        const block = { block_index: 5, block_hash: 'abc' };
        const db = makeDb();
        const q  = sinon.stub().resolves([block]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.getBlockByIndex(5);
        assert.deepStrictEqual(r, block);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getBlockByIndex(99), null);
    });

    it('returns null on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getBlockByIndex(1), null);
    });

    it('passes blockIndex as param', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ block_index: 10 }]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.getBlockByIndex(10);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [10]);
    });
});

// ---------------------------------------------------------------------------
// getTransaction
// ---------------------------------------------------------------------------

describe('Database#getTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns the first row when found', async () => {
        const tx = { tx_index: 1, hash: 'deadbeef' };
        const db = makeDb();
        const q  = sinon.stub().resolves([tx]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.deepStrictEqual(await db.getTransaction('deadbeef'), tx);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransaction('notfound'), null);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransaction('x'), false);
    });
});

// ---------------------------------------------------------------------------
// getTransactionId
// ---------------------------------------------------------------------------

describe('Database#getTransactionId()', () => {
    afterEach(() => sinon.restore());

    it('returns id when row found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ id: 99 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransactionId('myhash'), 99);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransactionId('missing'), null);
    });

    it('returns null (swallows) on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('bang'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        // error is caught; id stays null
        assert.strictEqual(await db.getTransactionId('bad'), null);
    });
});

// ---------------------------------------------------------------------------
// createTransaction
// ---------------------------------------------------------------------------

describe('Database#createTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns 1 for null hash (sentinel)', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createTransaction(null), 1);
    });

    it('returns 1 for empty-string hash (sentinel)', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createTransaction(''), 1);
    });

    it('returns existing id when record already exists', async () => {
        const db = makeDb();
        // getTransactionId called twice; both return 7
        const q = sinon.stub().resolves([{ id: 7 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createTransaction('abc123'), 7);
    });

    it('inserts and returns id when record does not exist (first lookup null, then 5)', async () => {
        const db = makeDb();
        // First SELECT returns nothing → INSERT → second SELECT returns id 5
        const q = sinon.stub()
            .onFirstCall().resolves([])       // getTransactionId returns null
            .onSecondCall().resolves([])      // INSERT IGNORE
            .onThirdCall().resolves([{ id: 5 }]); // getTransactionId after insert
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createTransaction('newhash'), 5);
    });

    it('does not throw when INSERT errors; returns id from re-fetch', async () => {
        const db = makeDb();
        // getTransactionId→null, INSERT throws, re-fetch returns 3
        const q = sinon.stub()
            .onFirstCall().resolves([])
            .onSecondCall().rejects(new Error('insert fail'))
            .onThirdCall().resolves([{ id: 3 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createTransaction('x'), 3);
    });
});

// ---------------------------------------------------------------------------
// getAddressId
// ---------------------------------------------------------------------------

describe('Database#getAddressId()', () => {
    afterEach(() => sinon.restore());

    it('returns id when row found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ id: 42 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getAddressId('1BitcoinAddr'), 42);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getAddressId('nobody'), null);
    });

    it('swallows query errors and returns null', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getAddressId('x'), null);
    });
});

// ---------------------------------------------------------------------------
// createAddress
// ---------------------------------------------------------------------------

describe('Database#createAddress()', () => {
    afterEach(() => sinon.restore());

    it('returns 1 for null address', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createAddress(null), 1);
    });

    it('returns 1 for empty string address', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createAddress(''), 1);
    });

    it('returns existing id when address already exists', async () => {
        const db = makeDb();
        const q = sinon.stub().resolves([{ id: 10 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createAddress('1BitcoinAddr'), 10);
    });

    it('inserts and returns id when address does not exist', async () => {
        const db = makeDb();
        const q = sinon.stub()
            .onFirstCall().resolves([])       // getAddressId → null
            .onSecondCall().resolves([])      // INSERT IGNORE
            .onThirdCall().resolves([{ id: 8 }]); // getAddressId after insert
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createAddress('newaddr'), 8);
    });
});

// ---------------------------------------------------------------------------
// hasPubkey
// ---------------------------------------------------------------------------

describe('Database#hasPubkey()', () => {
    afterEach(() => sinon.restore());

    it('returns true when a row exists', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ 1: 1 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasPubkey(5), true);
    });

    it('returns false when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasPubkey(5), false);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasPubkey(5), false);
    });

    it('passes addressId to the query', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.hasPubkey(99);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [99]);
    });
});

// ---------------------------------------------------------------------------
// insertPubkey
// ---------------------------------------------------------------------------

describe('Database#insertPubkey()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertPubkey(3, 'pubkeyHex'), true);
    });

    it('returns false on error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertPubkey(3, 'pubkeyHex'), false);
    });

    it('passes addressId and pubkey as params', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertPubkey(7, 'mypubkey');
        assert.deepStrictEqual(conn.query.firstCall.args[1], [7, 'mypubkey']);
    });
});

// ---------------------------------------------------------------------------
// insertEvent
// ---------------------------------------------------------------------------

describe('Database#insertEvent()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertEvent('NEW_BLOCK', { height: 1 }), true);
    });

    it('returns DUPLICATED_TRANSACTION (1) on errno 1062', async () => {
        const db = makeDb();
        const err = new Error('Duplicate entry');
        err.errno = 1062;
        const q  = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertEvent('X', {}), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('other'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertEvent('X', {}), false);
    });

    it('passes code and JSON-stringified data', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertEvent('MYCODE', { foo: 'bar' });
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[1], 'MYCODE');
        assert.strictEqual(args[2], JSON.stringify({ foo: 'bar' }));
    });
});

// ---------------------------------------------------------------------------
// deleteBlockByIndex
// ---------------------------------------------------------------------------

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
        // [REGRESSION P0] TP-17 F-7: a resurrect UPDATE (clear expiry marks left by
        // this now-orphaned block) must run BEFORE the dispenser row-delete, so a
        // dispenser expired by this block is restored on reorg.
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

    // [REGRESSION M-12] The decoder reorg signal must be crash-durable: the REORG audit
    // marker for a rolled-back block has to commit ATOMICALLY with that block's deletion.
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

// ---------------------------------------------------------------------------
// insertBlock
// ---------------------------------------------------------------------------

describe('Database#insertBlock()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        // createTransaction calls getTransactionId (SELECT) then maybe INSERT IGNORE
        // For simplicity, stub createTransaction on the instance
        sinon.stub(db, 'createTransaction').resolves(5);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertBlock({
            block_hash: 'abc',
            previous_block_hash: 'def',
            block_index: 1,
            block_time: 1234567890
        });
        assert.strictEqual(r, true);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        const q = sinon.stub().rejects(new Error('insert fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertBlock({ block_hash: 'x', previous_block_hash: 'y', block_index: 2, block_time: 1 });
        assert.strictEqual(r, false);
    });

    it('calls createTransaction for both block_hash and previous_block_hash', async () => {
        const db = makeDb();
        const createTxStub = sinon.stub(db, 'createTransaction').resolves(9);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        await db.insertBlock({ block_hash: 'h1', previous_block_hash: 'h2', block_index: 1, block_time: 0 });
        assert.ok(createTxStub.calledWith('h1'));
        assert.ok(createTxStub.calledWith('h2'));
    });
});

// ---------------------------------------------------------------------------
// insertTransaction
// ---------------------------------------------------------------------------

describe('Database#insertTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertTransaction({
            index: 0, hash: 'abc', block_index: 1, source: 'src', destination: 'dst',
            amount: 100, fee: 1, data: null, raw_data: null
        });
        assert.strictEqual(r, true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertTransaction({ index: 0, hash: 'x', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertTransaction({ index: 0, hash: 'x', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null }), false);
    });

    it('passes null raw_data when absent', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertTransaction({ index: 0, hash: 'h', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        const params = conn.query.firstCall.args[1];
        assert.strictEqual(params[8], null); // raw_data
    });
});

// ---------------------------------------------------------------------------
// insertMempoolTransaction
// ---------------------------------------------------------------------------

describe('Database#insertMempoolTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertMempoolTransaction({
            hash: 'abc', source: 'src', destination: 'dst', amount: 0, fee: 0, data: null
        });
        assert.strictEqual(r, true);
    });

    // Regression guard: mempool ingestion must NEVER allocate index_addresses /
    // index_transactions rows. Those lookup tables are replicated and their ids are
    // node-local non-deterministic if assigned in mempool-arrival order; ids are
    // allocated only during deterministic block-confirmation processing. Mempool rows
    // store the raw strings verbatim.
    it('does not allocate index ids and stores raw strings', async () => {
        const db = makeDb();
        const createTx = sinon.stub(db, 'createTransaction').resolves(1);
        const createAddr = sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        await db.insertMempoolTransaction({
            hash: 'rawhash', source: 'rawsrc', destination: 'rawdst', amount: 7, fee: 0, data: 'd'
        });
        assert.ok(createTx.notCalled, 'insertMempoolTransaction must not call createTransaction');
        assert.ok(createAddr.notCalled, 'insertMempoolTransaction must not call createAddress');
        const params = q.firstCall.args[1];
        assert.deepStrictEqual(params, ['rawhash', 'rawsrc', 'rawdst', 7, 0, 'd']);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertMempoolTransaction({ hash: 'x', source: 's', destination: 'd', amount: 0, fee: 0, data: null }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        const q = sinon.stub().rejects(new Error('nope'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertMempoolTransaction({ hash: 'x', source: 's', destination: 'd', amount: 0, fee: 0, data: null }), false);
    });
});

// ---------------------------------------------------------------------------
// insertDispenser
// ---------------------------------------------------------------------------

describe('Database#insertDispenser()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertDispenser({ txIndex: 1, address: 'addr', expiration: 9999 });
        assert.strictEqual(r, true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertDispenser({ txIndex: 1, address: 'a', expiration: 0 }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const q = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertDispenser({ txIndex: 1, address: 'a', expiration: 0 }), false);
    });

    it('passes txIndex, addressId, expiration as params', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(7);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertDispenser({ txIndex: 42, address: 'addr', expiration: 1234 });
        const params = conn.query.firstCall.args[1];
        assert.strictEqual(params[0], 42);
        assert.strictEqual(params[1], 7);
        assert.strictEqual(params[2], 1234);
    });

    // Y2038 regression: expiration must be stored as a raw unix integer, NOT routed
    // through FROM_UNIXTIME() (which caps at 2147483647 and NULLs anything past 2038,
    // silently dropping expirations the parser accepts up to 4294967295 / year 2106).
    it('stores expiration as a raw unix value without FROM_UNIXTIME (Y2038 safe)', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(7);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        const farFuture = 4102444800; // 2100-01-01, above the Y2038 FROM_UNIXTIME cap
        await db.insertDispenser({ txIndex: 1, address: 'addr', expiration: farFuture });
        const sql = conn.query.firstCall.args[0];
        assert.ok(!/FROM_UNIXTIME/i.test(sql), 'insertDispenser must not wrap expiration in FROM_UNIXTIME');
        assert.strictEqual(conn.query.firstCall.args[1][2], farFuture, 'far-future expiration must pass through unmodified');
    });
});

// ---------------------------------------------------------------------------
// insertTransactionOutput
// ---------------------------------------------------------------------------

describe('Database#insertTransactionOutput()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(4);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertTransactionOutput({ txIndex: 1, vout: 0, destinationAddress: 'addr', amount: 100000000n });
        assert.strictEqual(r, true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(4);
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertTransactionOutput({ txIndex: 1, vout: 0, destinationAddress: 'a', amount: 0n }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(4);
        const q = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertTransactionOutput({ txIndex: 1, vout: 0, destinationAddress: 'a', amount: 0n }), false);
    });

    it('converts BigInt amount to decimal string via bigIntSatoshiToDecimalsString', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(4);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertTransactionOutput({ txIndex: 1, vout: 0, destinationAddress: 'addr', amount: 100000000n });
        const params = conn.query.firstCall.args[1];
        assert.strictEqual(params[3], '1.00000000');
    });
});

// ---------------------------------------------------------------------------
// isThereADispenserForAddress
// ---------------------------------------------------------------------------

describe('Database#isThereADispenserForAddress()', () => {
    afterEach(() => sinon.restore());

    it('returns true when dispensers_count > 0', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ dispensers_count: 2 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.isThereADispenserForAddress('addr'), true);
    });

    it('returns false when dispensers_count === 0', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ dispensers_count: 0 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.isThereADispenserForAddress('addr'), false);
    });

    it('returns false when no rows returned', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.isThereADispenserForAddress('addr'), false);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.isThereADispenserForAddress('addr'), false);
    });
});

// ---------------------------------------------------------------------------
// getAllOpenDispenserAddresses
// ---------------------------------------------------------------------------

describe('Database#getAllOpenDispenserAddresses()', () => {
    afterEach(() => sinon.restore());

    it('returns a Set of every open-dispenser address from a single query', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([
            { address: 'addr1' },
            { address: 'addr2' },
        ]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.ok(set instanceof Set);
        assert.strictEqual(set.size, 2);
        assert.ok(set.has('addr1'));
        assert.ok(set.has('addr2'));
        // The whole point of the method: one query for the entire block, not one per output.
        assert.strictEqual(q.callCount, 1);
    });

    it('skips NULL addresses (dispenser row with no matching index_addresses join)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([
            { address: 'addr1' },
            { address: null },
        ]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.strictEqual(set.size, 1);
        assert.ok(set.has('addr1'));
        assert.ok(!set.has(null));
    });

    it('returns an empty Set when there are no open dispensers', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.ok(set instanceof Set);
        assert.strictEqual(set.size, 0);
    });

    it('returns null on query error (a failed read must stay distinguishable from an empty set)', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.strictEqual(set, null);
    });
});

// ---------------------------------------------------------------------------
// deleteOpenDispensers
// ---------------------------------------------------------------------------

describe('Database#deleteOpenDispensers()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.deleteOpenDispensers(5, 1000), true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        const err = new Error('dup'); err.errno = 1062;
        const q  = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.deleteOpenDispensers(5, 1000), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.deleteOpenDispensers(5, 1000), false);
    });

    // [REGRESSION P0] TP-17 F-7: the expiry sweep must SOFT-expire (stamp the block
    // height into expired_block_index) rather than hard-DELETE, so a reorg's
    // deleteBlockByIndex can restore a dispenser an orphaned block's non-monotonic
    // timestamp expired. It must also be idempotent on replay (IS NULL guard).
    it('soft-expires (UPDATE ... SET expired_block_index, guarded IS NULL): not a DELETE', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.deleteOpenDispensers(42, 5555);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /UPDATE\s+dispensers/i, 'must be an UPDATE');
        assert.match(sql, /SET\s+expired_block_index\s*=\s*\?/i, 'must stamp the expiring block height');
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i, 'must guard already-expired rows (idempotent replay)');
        assert.ok(!/DELETE\s+FROM/i.test(sql), 'must NOT hard-delete');
        // params: [blockIndex, minExpiration]
        assert.deepStrictEqual(conn.query.firstCall.args[1], [42, 5555]);
    });

    // Y2038 regression: compare the raw unix block time directly against the raw
    // unix expiration column, NOT through FROM_UNIXTIME() (which caps at 2038).
    it('compares expiration against the raw unix value without FROM_UNIXTIME (Y2038 safe)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.deleteOpenDispensers(7, 4102444800); // 2100-01-01, above the Y2038 cap
        const sql = conn.query.firstCall.args[0];
        assert.ok(!/FROM_UNIXTIME/i.test(sql), 'deleteOpenDispensers must not wrap the comparison in FROM_UNIXTIME');
        assert.match(sql, /expiration\s*<\s*\?/i, 'must compare expiration against the raw bound');
    });
});

// ---------------------------------------------------------------------------
// purgeExpiredDispensers
// ---------------------------------------------------------------------------

describe('Database#purgeExpiredDispensers()', () => {
    afterEach(() => sinon.restore());

    it('hard-deletes soft-expired rows at or below the safe height', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        const r = await db.purgeExpiredDispensers(900);
        assert.strictEqual(r, true);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /DELETE\s+FROM\s+dispensers/i);
        assert.match(sql, /expired_block_index\s+IS\s+NOT\s+NULL/i, 'must only touch soft-expired rows');
        assert.match(sql, /expired_block_index\s*<=\s*\?/i);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [900]);
    });

    it('is a no-op before any reorg-safe depth (negative/undefined height)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.purgeExpiredDispensers(-5), true);
        assert.strictEqual(await db.purgeExpiredDispensers(undefined), true);
        assert.ok(conn.query.notCalled, 'must not issue a DELETE when nothing is reorg-safe yet');
    });
});

// ---------------------------------------------------------------------------
// deleteAndCompareTxsNotInList
// ---------------------------------------------------------------------------

describe('Database#deleteAndCompareTxsNotInList()', () => {
    afterEach(() => sinon.restore());

    it('returns transactionsDeleted=0 when mempool is empty', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.deleteAndCompareTxsNotInList(['tx1', 'tx2']);
        assert.deepStrictEqual(r, { transactionsDeleted: 0 });
    });

    it('removes rows not in txidList and returns count', async () => {
        const db = makeDb();
        // First call: SELECT returns two rows; second call: DELETE
        const q = sinon.stub()
            .onFirstCall().resolves([
                { hash: 'aaaa', hash_id: 1 },
                { hash: 'bbbb', hash_id: 2 },
            ])
            .onSecondCall().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        // txidList contains 'aaaa' but not 'bbbb' → bbbb is deleted
        const r = await db.deleteAndCompareTxsNotInList(['aaaa']);
        assert.strictEqual(r.transactionsDeleted, 1);
    });

    it('returns transactionsDeleted=0 on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db error'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.deleteAndCompareTxsNotInList([]);
        assert.deepStrictEqual(r, { transactionsDeleted: 0 });
    });

    it('splices matched txids from list (mutates txidList)', async () => {
        const db = makeDb();
        const q = sinon.stub()
            .onFirstCall().resolves([{ hash: 'aaaa', hash_id: 1 }])
            .onSecondCall().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const list = ['aaaa', 'bbbb'];
        await db.deleteAndCompareTxsNotInList(list);
        // 'aaaa' was found in DB and in list → spliced out
        assert.ok(!list.includes('aaaa'));
    });
});

// ---------------------------------------------------------------------------
// dropDatabase
// ---------------------------------------------------------------------------

describe('Database#dropDatabase()', () => {
    afterEach(() => sinon.restore());

    it('executes all DROP TABLE queries without throwing', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.dropDatabase();
        // Should have called query at least 9 times (9 tables)
        assert.ok(conn.query.callCount >= 9);
        const sqls = conn.query.getCalls().map(c => c.args[0]);
        assert.ok(sqls.some(s => /DROP TABLE IF EXISTS blocks/i.test(s)));
        assert.ok(sqls.some(s => /DROP TABLE IF EXISTS transactions/i.test(s)));
        assert.ok(conn.release.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// getConnection: success, retry, and give-up paths
// ---------------------------------------------------------------------------

describe('Database#getConnection()', () => {
    afterEach(() => sinon.restore());

    it('returns transactionConnection when one is set', async () => {
        const db = makeDb();
        const fakeTxConn = { query: sinon.stub(), release: sinon.stub() };
        db.transactionConnection = fakeTxConn;
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeTxConn);
    });

    it('succeeds on first pool.getConnection call', async () => {
        const db = makeDb();
        const fakeConn = { query: sinon.stub(), release: sinon.stub() };
        db.pool = { getConnection: sinon.stub().resolves(fakeConn) };
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeConn);
    });

    it('retries on transient failure and succeeds on second attempt', async () => {
        const db = makeDb();
        // Stub util.sleep to avoid actual delays
        const utilMod = require('../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        const fakeConn = { query: sinon.stub(), release: sinon.stub() };
        db.pool = {
            getConnection: sinon.stub()
                .onFirstCall().rejects(new Error('transient'))
                .onSecondCall().resolves(fakeConn)
        };
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeConn);
    });

    it('throws after maxAttempts (30) consecutive failures', async () => {
        const db = makeDb();
        const utilMod = require('../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        db.pool = {
            getConnection: sinon.stub().rejects(new Error('always fails'))
        };
        await assert.rejects(
            () => db.getConnection(),
            /Failed to get database connection after 30 attempts/
        );
    });
});

// ---------------------------------------------------------------------------
// releaseConnection
// ---------------------------------------------------------------------------

describe('Database#releaseConnection()', () => {
    afterEach(() => sinon.restore());

    it('releases transactionConnection and sets it to null', async () => {
        const db = makeDb();
        const relStub = sinon.stub().resolves();
        db.transactionConnection = { release: relStub };
        await db.releaseConnection();
        assert.ok(relStub.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('does nothing when transactionConnection is null', async () => {
        const db = makeDb();
        // Should not throw
        await db.releaseConnection();
        assert.strictEqual(db.transactionConnection, null);
    });
});

// ---------------------------------------------------------------------------
// beginTransaction
// ---------------------------------------------------------------------------

describe('Database#beginTransaction()', () => {
    afterEach(() => sinon.restore());

    it('acquires lock and sets transactionConnection', async () => {
        const db = makeDb();
        const fakeConn = {
            beginTransaction: sinon.stub().resolves(),
            release: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            query: sinon.stub().resolves([]),
        };
        db.pool = { getConnection: sinon.stub().resolves(fakeConn) };
        await db.beginTransaction();
        assert.strictEqual(db.transactionConnection, fakeConn);
        assert.ok(fakeConn.beginTransaction.calledOnce);
    });

    it('releases and re-throws when beginTransaction() on connection throws', async () => {
        const db = makeDb();
        const fakeConn = {
            beginTransaction: sinon.stub().rejects(new Error('btx fail')),
            release: sinon.stub().resolves(),
        };
        db.pool = { getConnection: sinon.stub().resolves(fakeConn) };
        await assert.rejects(() => db.beginTransaction(), /btx fail/);
        assert.strictEqual(db.transactionConnection, null);
        assert.ok(fakeConn.release.calledOnce);
        // Lock should be released so next caller can proceed
        assert.strictEqual(db._transactionLock, false);
    });

    it('rolls back existing transaction if one is open before starting new', async () => {
        // beginTransaction checks `if (this.transactionConnection != null)` AFTER acquiring the lock
        // and calls endTransaction() to roll it back. We simulate this by pre-setting
        // transactionConnection and calling beginTransaction with the lock NOT held
        // (so _acquireTransactionLock resolves immediately).
        const db = makeDb();
        const rollbackStub = sinon.stub().resolves();
        const oldConn = {
            rollback: rollbackStub,
            release: sinon.stub().resolves(),
        };
        const newConn = {
            beginTransaction: sinon.stub().resolves(),
            release: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            query: sinon.stub().resolves([]),
        };
        db.pool = { getConnection: sinon.stub().resolves(newConn) };

        // Pre-set transactionConnection to simulate a leaked open transaction.
        // The lock is NOT held so _acquireTransactionLock resolves immediately.
        db.transactionConnection = oldConn;

        // beginTransaction should detect transactionConnection != null and call endTransaction
        await db.beginTransaction();
        assert.ok(rollbackStub.calledOnce, 'old transaction should have been rolled back');
    });
});

// ---------------------------------------------------------------------------
// endTransaction
// ---------------------------------------------------------------------------

describe('Database#endTransaction()', () => {
    afterEach(() => sinon.restore());

    it('rolls back and releases when transactionConnection is set', async () => {
        const db = makeDb();
        db._transactionLock = true;
        const rollbackStub = sinon.stub().resolves();
        const releaseStub  = sinon.stub().resolves();
        db.transactionConnection = { rollback: rollbackStub, release: releaseStub };
        await db.endTransaction();
        assert.ok(rollbackStub.calledOnce);
        assert.ok(releaseStub.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('releases the transaction lock', async () => {
        const db = makeDb();
        db._transactionLock = true;
        db.transactionConnection = {
            rollback: sinon.stub().resolves(),
            release: sinon.stub().resolves()
        };
        await db.endTransaction();
        assert.strictEqual(db._transactionLock, false);
    });

    it('does nothing when transactionConnection is null', async () => {
        const db = makeDb();
        db._transactionLock = true;
        // Should not throw even with no connection
        await db.endTransaction();
        assert.strictEqual(db._transactionLock, false);
    });
});

// ---------------------------------------------------------------------------
// commitTransaction
// ---------------------------------------------------------------------------

describe('Database#commitTransaction()', () => {
    afterEach(() => sinon.restore());

    it('commits, releases, clears transactionConnection, and returns true', async () => {
        const db = makeDb();
        db._transactionLock = true;
        const commitStub  = sinon.stub().resolves();
        const releaseStub = sinon.stub().resolves();
        db.transactionConnection = { commit: commitStub, release: releaseStub };
        const r = await db.commitTransaction();
        assert.strictEqual(r, true);
        assert.ok(commitStub.calledOnce);
        assert.ok(releaseStub.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('returns false when transactionConnection is null', async () => {
        const db = makeDb();
        assert.strictEqual(await db.commitTransaction(), false);
    });

    it('calls endTransaction and returns undefined/falsy on commit error', async () => {
        const db = makeDb();
        db._transactionLock = true;
        const commitStub  = sinon.stub().rejects(new Error('commit fail'));
        const rollbackStub = sinon.stub().resolves();
        const releaseStub  = sinon.stub().resolves();
        db.transactionConnection = { commit: commitStub, rollback: rollbackStub, release: releaseStub };
        const r = await db.commitTransaction();
        // After endTransaction, falls through to return false
        assert.strictEqual(r, false);
        assert.ok(rollbackStub.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// verifyDatabase
// ---------------------------------------------------------------------------

describe('Database#verifyDatabase()', () => {
    afterEach(() => sinon.restore());

    it('returns true when schemata row found', async () => {
        const db = makeDb();
        const fakeConn = {
            query: sinon.stub().resolves([{ schema_name: 'xchain_btc_mainnet' }]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, '_createConnection').resolves(fakeConn);
        const r = await db.verifyDatabase();
        assert.strictEqual(r, true);
    });

    it('returns false when schemata is empty', async () => {
        const db = makeDb();
        const fakeConn = {
            query: sinon.stub().resolves([]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, '_createConnection').resolves(fakeConn);
        const r = await db.verifyDatabase();
        assert.strictEqual(r, false);
    });

    it('retries once on error then succeeds', async () => {
        const db = makeDb();
        const utilMod = require('../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        const goodConn = {
            query: sinon.stub().resolves([{ schema_name: 'xchain_btc_mainnet' }]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, '_createConnection')
            .onFirstCall().rejects(new Error('no db'))
            .onSecondCall().resolves(goodConn);
        const r = await db.verifyDatabase();
        assert.strictEqual(r, true);
    });
});

// ---------------------------------------------------------------------------
// createDatabase
// ---------------------------------------------------------------------------

describe('Database#createDatabase()', () => {
    afterEach(() => sinon.restore());

    it('returns true after creating the database', async () => {
        const db = makeDb();
        const fakeConn = {
            query: sinon.stub().resolves([]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, '_createConnection').resolves(fakeConn);
        const r = await db.createDatabase();
        assert.strictEqual(r, true);
    });

    it('retries once on error then succeeds', async () => {
        const db = makeDb();
        const utilMod = require('../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        const goodConn = {
            query: sinon.stub().resolves([]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, '_createConnection')
            .onFirstCall().rejects(new Error('transient'))
            .onSecondCall().resolves(goodConn);
        const r = await db.createDatabase();
        assert.strictEqual(r, true);
    });
});

// ---------------------------------------------------------------------------
// Additional coverage: error paths when transactionConnection is active
// These cover the `if (this.transactionConnection)` branches in error handlers
// ---------------------------------------------------------------------------

describe('Database error-path transactionConnection branches', () => {
    afterEach(() => sinon.restore());

    // createAddress INSERT error path (line 973)
    it('createAddress: swallows INSERT error even with active transactionConnection', async () => {
        const db = makeDb();
        // Use a fake transactionConnection so getConnection returns it
        const txConn = {
            query: sinon.stub()
                .onFirstCall().resolves([])      // getAddressId → null
                .onSecondCall().rejects(new Error('insert addr fail'))  // INSERT IGNORE
                .onThirdCall().resolves([{ id: 11 }]),  // getAddressId after insert
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        // Should not throw; error in INSERT catch is logged and swallowed
        const id = await db.createAddress('newaddr2');
        // id may be 11 from re-fetch or null if re-fetch also fails; just assert no throw
        assert.ok(id === 11 || id === null);
    });

    // insertEvent: endTransaction called when transactionConnection set (line 1042-1046).
    // Regression: insertEvent previously called releaseConnection() here, which leaves
    // the transaction open on the pooled connection and never frees the transaction lock
    // (_releaseTransactionLock), deadlocking the next beginTransaction(). It must call
    // endTransaction() like every sibling insert: rollback + release + free the lock.
    it('insertEvent: calls endTransaction (rollback + frees lock) when a transaction is active on generic error', async () => {
        const db = makeDb();
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('event fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertEvent('CODE', { x: 1 });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    // Companion: with the REAL endTransaction (not stubbed), the transaction lock is
    // actually released so a subsequent beginTransaction would not deadlock.
    it('insertEvent: a transaction-active error frees the transaction lock (no deadlock)', async () => {
        const db = makeDb();
        const txConn = {
            query: sinon.stub().rejects(new Error('event fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertEvent('CODE', { x: 1 });
        assert.strictEqual(r, false);
        assert.ok(txConn.rollback.calledOnce, 'transaction should be rolled back');
        assert.strictEqual(db.transactionConnection, null, 'transaction connection cleared');
        assert.strictEqual(db._transactionLock, false, 'transaction lock released');
    });

    // insertDispenser: endTransaction called when transactionConnection set (line 1128-1129)
    it('insertDispenser: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('dispenser fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertDispenser({ txIndex: 1, address: 'a', expiration: 0 });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    // insertTransactionOutput: endTransaction called when transactionConnection set (line 1171-1172)
    it('insertTransactionOutput: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(4);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('txout fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertTransactionOutput({ txIndex: 1, vout: 0, destinationAddress: 'a', amount: 0n });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    // deleteOpenDispensers: endTransaction called when transactionConnection set (line 1223-1224)
    it('deleteOpenDispensers: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('delete fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.deleteOpenDispensers(1000);
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    // insertBlock: endTransaction called when transactionConnection set (line 717-718)
    it('insertBlock: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('block fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertBlock({ block_hash: 'x', previous_block_hash: 'y', block_index: 1, block_time: 0 });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    // insertTransaction: endTransaction called when transactionConnection set (line 801-802)
    it('insertTransaction: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('tx fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertTransaction({ index: 0, hash: 'x', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    // insertMempoolTransaction: endTransaction called when transactionConnection set (line 847-848)
    it('insertMempoolTransaction: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('mempool fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertMempoolTransaction({ hash: 'x', source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// _ensureMigrationsLedger: covered cheaply via a fake connection
// ---------------------------------------------------------------------------

describe('Database#_ensureMigrationsLedger()', () => {
    afterEach(() => sinon.restore());

    it('calls CREATE TABLE IF NOT EXISTS schema_migrations on the connection', async () => {
        const db = makeDb();
        const queryStub = sinon.stub().resolves([]);
        const conn = { query: queryStub, release: sinon.stub().resolves() };
        await db._ensureMigrationsLedger(conn);
        assert.ok(queryStub.calledOnce);
        assert.ok(/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(queryStub.firstCall.args[0]));
    });
});
