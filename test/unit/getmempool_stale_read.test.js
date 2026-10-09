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

const assert = require('assert');
const sinon = require('sinon');
const { createMempoolMethods } = require('../../src/api');

describe('getmempool stale reads', function () {
    let clock;
    let previousTtl;

    beforeEach(function () {
        previousTtl = process.env.GETMEMPOOL_CACHE_MS;
        process.env.GETMEMPOOL_CACHE_MS = '5000';
        clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] });
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        clock.restore();
        sinon.restore();
        if (previousTtl === undefined) delete process.env.GETMEMPOOL_CACHE_MS;
        else process.env.GETMEMPOOL_CACHE_MS = previousTtl;
    });

    it('serves the last good snapshot as stale and retries immediately after a failed refresh', async function () {
        const firstRow = { tx_hash: 'aa', source: 'alice', data: 'first', first_seen: 11 };
        const recoveredRow = { tx_hash: 'bb', source: 'bob', data: 'second', first_seen: 22 };
        const getRows = sinon.stub();
        getRows.onCall(0).resolves([firstRow]);
        getRows.onCall(1).rejects(new Error('read failed'));
        getRows.onCall(2).resolves([recoveredRow]);
        const getTotal = sinon.stub();
        getTotal.onCall(0).resolves(7);
        getTotal.onCall(1).resolves(8);
        const decoder = {
            nodeMempoolTxCount: 12,
            nodeMempoolUpdatedAt: 900,
            mempoolDb: {
                getMempoolTransactions: getRows,
                getMempoolTransactionCount: getTotal
            }
        };
        const getmempool = createMempoolMethods(decoder).getmempool;

        const fresh = await getmempool({ limit: 500 });
        assert.strictEqual(fresh.stale, false);
        assert.strictEqual(fresh.read_ok_at, 1000);
        assert.strictEqual(fresh.total, 7);
        assert.strictEqual(fresh.rows[0].tx_hash, 'aa');

        clock.tick(5000);
        const failed = await getmempool({ limit: 500 });
        assert.strictEqual(failed.stale, true);
        assert.strictEqual(failed.read_ok_at, 1000);
        assert.strictEqual(failed.total, 7);
        assert.strictEqual(failed.rows[0].tx_hash, 'aa');

        const recovered = await getmempool({ limit: 500 });
        assert.strictEqual(getRows.callCount, 3);
        assert.strictEqual(recovered.stale, false);
        assert.strictEqual(recovered.read_ok_at, 6000);
        assert.strictEqual(recovered.total, 8);
        assert.strictEqual(recovered.rows[0].tx_hash, 'bb');
    });

    it('reports a stale empty fallback when the first read fails without a prior good timestamp', async function () {
        const getRows = sinon.stub().rejects(new Error('read failed'));
        const decoder = {
            nodeMempoolTxCount: -1,
            nodeMempoolUpdatedAt: null,
            mempoolDb: {
                getMempoolTransactions: getRows,
                getMempoolTransactionCount: sinon.stub().resolves(0)
            }
        };
        const getmempool = createMempoolMethods(decoder).getmempool;

        const result = await getmempool({ limit: 500 });
        assert.strictEqual(result.stale, true);
        assert.strictEqual(result.read_ok_at, null);
        assert.strictEqual(result.total, 0);
        assert.deepStrictEqual(result.rows, []);

        await getmempool({ limit: 500 });
        assert.strictEqual(getRows.callCount, 2);
    });
});
