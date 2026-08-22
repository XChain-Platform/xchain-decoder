/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// The remote-mempool surface added for the explorer's replica deployments:
// mempool_transactions is deliberately excluded from xchain-sync replication
// (node-local, non-deterministic), so an explorer serving from synced replicas
// can only see pending actions through the decoder's own API. These tests pin
// the three pieces that surface provides:
//   1. the node-mempool observation snapshot updateMempool records,
//   2. the bounded DB reads the API serves rows from,
//   3. the api.js getmempool method's contract (cache, clamp, field mapping).

const assert       = require('assert');
const fs           = require('fs');
const path         = require('path');
const sinon        = require('sinon');
const XChainDecoder = require('../../src/XChainDecoder');
const Database      = require('../../src/db.js');

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    );
}

function withConn(queryStub) {
    const conn = {
        query:   queryStub || sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
    };
    const pool = { getConnection: sinon.stub().resolves(conn) };
    return { pool, conn };
}

describe('node-mempool observation snapshot', () => {
    afterEach(() => sinon.restore());

    it('starts unknown: -1 count / null timestamp until the first poll', () => {
        const decoder = makeDecoder();
        assert.strictEqual(decoder.nodeMempoolTxCount, -1);
        assert.strictEqual(decoder.nodeMempoolUpdatedAt, null);
    });

    it('updateMempool records the DEDUPED node mempool size and a timestamp', async () => {
        const decoder = makeDecoder();
        sinon.stub(decoder.connector, 'getRawMempool').resolves(['bb', 'aa', 'aa']);
        sinon.stub(decoder.connector, 'getRawTransactions').resolves([]);
        decoder.mempoolDb = {
            deleteAndCompareTxsNotInList: sinon.stub().resolves({ transactionsDeleted: 0 }),
        };
        await decoder.updateMempool();
        assert.strictEqual(decoder.nodeMempoolTxCount, 2);           // 'aa' deduped
        assert.ok(typeof decoder.nodeMempoolUpdatedAt === 'number');
        assert.strictEqual(decoder.mempoolBusy, false);
    });

    it('a failed getrawmempool leaves the previous snapshot standing', async () => {
        const decoder = makeDecoder();
        decoder.nodeMempoolTxCount = 5;
        decoder.nodeMempoolUpdatedAt = 12345;
        sinon.stub(decoder.connector, 'getRawMempool').rejects(new Error('node down'));
        await decoder.updateMempool();
        assert.strictEqual(decoder.nodeMempoolTxCount, 5);
        assert.strictEqual(decoder.nodeMempoolUpdatedAt, 12345);
        assert.strictEqual(decoder.mempoolBusy, false);
    });
});

describe('Database#getMempoolTransactions()', () => {
    afterEach(() => sinon.restore());

    it('reads the raw-string columns + first_seen in tx_hash order with a clamped limit', async () => {
        const db  = new Database('127.0.0.1', 3306, 'xchain_btc', 'u', 'p');
        const row = { tx_hash: 'aa', source: 's', data: 'MINT|0|TOK|1', first_seen: new Date() };
        const q   = sinon.stub().resolves([row]);
        const { pool, conn } = withConn(q);
        db.pool = pool;
        const rows = await db.getMempoolTransactions(9999);
        assert.deepStrictEqual(rows, [row]);
        const sql = q.firstCall.args[0];
        assert.ok(sql.includes('tx_hash, source, data, first_seen'));
        // Action-carrying rows only: the table holds a row for EVERY mempool tx
        // (data blanked to '' when the tx carried no valid ACTION), so an
        // unfiltered window fills with actionless rows on a busy chain and the
        // consumer's feed renders empty. Measured on BTC testnet: 32 of 32.
        assert.ok(/WHERE data IS NOT NULL AND data != ''/.test(sql), 'window must filter to action-carrying rows');
        // No PK and the table is rewritten every poll cycle: the window must be
        // keyed on the unique tx_hash index to be a stable snapshot, and the
        // limit clamps to the same 500-row cap the explorer window uses.
        assert.ok(/ORDER BY tx_hash\s+LIMIT 500/.test(sql));
        assert.ok(conn.release.calledOnce);
    });

    it('releases the connection even when the query throws', async () => {
        const db = new Database('127.0.0.1', 3306, 'xchain_btc', 'u', 'p');
        const q  = sinon.stub().rejects(new Error('boom'));
        const { pool, conn } = withConn(q);
        db.pool = pool;
        await assert.rejects(() => db.getMempoolTransactions(10));
        assert.ok(conn.release.calledOnce);
    });
});

describe('Database#getMempoolTransactionCount()', () => {
    afterEach(() => sinon.restore());

    it('returns the count as a Number (BigInt-safe) and 0 on an empty result', async () => {
        const db = new Database('127.0.0.1', 3306, 'xchain_btc', 'u', 'p');
        const q  = sinon.stub().resolves([{ count: 7n }]);
        const { pool } = withConn(q);
        db.pool = pool;
        assert.strictEqual(await db.getMempoolTransactionCount(), 7);
        // Counts only action-carrying rows. An unfiltered COUNT(*) is the size
        // of the whole node mempool, which would report every unrelated payment
        // on the chain as a pending XChain action.
        assert.ok(/WHERE data IS NOT NULL AND data != ''/.test(q.firstCall.args[0]),
            'count must filter to action-carrying rows');

        const q2 = sinon.stub().resolves([]);
        db.pool = withConn(q2).pool;
        assert.strictEqual(await db.getMempoolTransactionCount(), 0);
    });
});

// api.js builds its JSON-RPC controller inside startApi() (it is not exported),
// so the getmempool contract is pinned at the source level, the same way the
// explorer pins this repo's mempool INSERT site: the method must exist, consult
// its TTL cache before the DB, clamp the row window, and map the decoder's
// node-mempool snapshot fields into the response.
describe('api.js getmempool method (source pin)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

    it('exposes getmempool on the JSON-RPC controller', () => {
        assert.ok(/async getmempool\(/.test(src), 'getmempool method missing from api.js');
    });

    it('serves from a TTL cache so an unauthenticated burst cannot amplify into DB reads', () => {
        const at = src.indexOf('async getmempool(');
        const body = src.slice(at, at + 3000);
        assert.ok(body.includes('GETMEMPOOL_CACHE_MS'), 'getmempool lost its TTL cache knob');
        assert.ok(body.includes('getmempoolCache'), 'getmempool no longer consults the shared cache');
    });

    it('reads rows via the bounded DB helpers and clamps the per-request limit to 500', () => {
        const at = src.indexOf('async getmempool(');
        const body = src.slice(at, at + 3000);
        assert.ok(body.includes('getMempoolTransactions(500)'), 'getmempool must read the full bounded window once');
        assert.ok(body.includes('getMempoolTransactionCount()'), 'getmempool must report the true total');
        assert.ok(/Math\.min\(parseInt\(params && params\.limit, 10\) \|\| 500, 500\)/.test(body), 'per-request limit clamp missing');
    });

    it('maps the node-mempool observation snapshot into the response', () => {
        const at = src.indexOf('async getmempool(');
        const body = src.slice(at, at + 3000);
        assert.ok(body.includes('decoder.nodeMempoolTxCount'), 'node_tx_count no longer sourced from the observation snapshot');
        assert.ok(body.includes('decoder.nodeMempoolUpdatedAt'), 'node_updated_at no longer sourced from the observation snapshot');
    });
});
