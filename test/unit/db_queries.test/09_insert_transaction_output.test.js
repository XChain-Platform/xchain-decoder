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
