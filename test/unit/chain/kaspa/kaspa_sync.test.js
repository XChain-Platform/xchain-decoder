/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************
 *
 * kaspa_sync part: the wiring, not the ingest.
 *
 * The ingest itself is covered by kaspa_block_decoder.test.js plus the family
 * suite in the reference implementation. What this file pins is the part
 * contract: it must refuse to start on a decoder configured for another
 * wireFormat, refuse to start twice, report null stats when idle (a normal
 * state, not an error), and stop gracefully — the in-flight tick completes.
 *
 * No network and no platform module graph: the part is driven with a fake
 * `this`, a fake rpc and a fake db, which is also what makes it runnable in
 * this repo's test job without pulling bitcoinjs in.
 **********************************************************************/
'use strict';

const assert = require('assert');

const kaspaSync = require('../../../../src/XChainDecoder/kaspa_sync.js');

const EMPTY_SLICE = { removedChainBlockHashes: [], addedChainBlockHashes: [], chainBlockAcceptedTransactions: [] };

function fakeRpc({ slices = [EMPTY_SLICE] } = {}) {
    let index = 0;
    return {
        calls: 0,
        connected: 0,
        disconnected: 0,
        async connect() { this.connected++; return this; },
        async disconnect() { this.disconnected++; },
        async getBlockDagInfo() { return { pruningPointHash: 'pp'.repeat(32) }; },
        async getVirtualChainFromBlockV2() {
            this.calls++;
            return slices[Math.min(index++, slices.length - 1)];
        },
    };
}

function fakeDb() {
    return { statements: [], async query(sql, values) { this.statements.push(String(sql).split(' ').slice(0, 2).join(' ')); } };
}

function decoderHost({ wireFormat = 'kaspa', rpc = fakeRpc() } = {}) {
    return {
        network: 'kaspa-testnet',
        db: fakeDb(),
        xchainBlockDecoder: { wireFormat },
        log() {},
        __rpc: rpc,
    };
}

describe('kaspa_sync part', function () {

    it('exposes the three methods the class picks up via Object.assign', function () {
        assert.strictEqual(typeof kaspaSync.startKaspaIngest, 'function');
        assert.strictEqual(typeof kaspaSync.stopKaspaIngest, 'function');
        assert.strictEqual(typeof kaspaSync.kaspaIngestStats, 'function');
    });

    it('refuses to start on a decoder configured for another wireFormat', function () {
        const host = decoderHost({ wireFormat: 'default' });
        assert.throws(() => kaspaSync.startKaspaIngest.call(host, { rpc: host.__rpc, maxTicks: 1 }),
            /configured for wireFormat "default"/);
        assert.strictEqual(host.kaspaService, undefined, 'a refused start must leave no service behind');
    });

    it('refuses a second start instead of silently double-ingesting', function () {
        const host = decoderHost();
        const service = kaspaSync.startKaspaIngest.call(host, { rpc: host.__rpc, maxTicks: 1 });
        assert.ok(service);
        assert.throws(() => kaspaSync.startKaspaIngest.call(host, { rpc: host.__rpc, maxTicks: 1 }),
            /already running a Kaspa ingest/);
    });

    it('reports null stats when this instance is not the Kaspa writer', function () {
        assert.strictEqual(kaspaSync.kaspaIngestStats.call({}), null);
    });

    it('runs a tick and stops gracefully, disconnecting the client', async function () {
        const host = decoderHost();
        const service = kaspaSync.startKaspaIngest.call(host, { rpc: host.__rpc, intervalMs: 1, maxTicks: 1 });
        assert.strictEqual(service.networkId, 'kaspa-testnet');
        await host.kaspaIngestPromise;

        assert.strictEqual(host.__rpc.connected, 1, 'the client is connected before the loop starts');
        assert.strictEqual(host.__rpc.disconnected, 1, 'and disconnected when the loop settles');
        assert.ok(host.__rpc.calls >= 1, 'the loop actually pulled a slice');
        assert.strictEqual(service.ticks, 1);

        // One tick against an empty slice writes nothing (no blocks -> no plan). READS are fine:
        // init() reconciles the write floor with a SELECT even when there is no checkpoint file.
        const wrote = host.db.statements.filter((s) => /^(INSERT|DELETE)/i.test(String(s.sql || s)));
        assert.strictEqual(wrote.length, 0, 'an empty slice must produce no write');
    });

    it('surfaces stats while running and stops on request', async function () {
        const host = decoderHost();
        const service = kaspaSync.startKaspaIngest.call(host, { rpc: host.__rpc, intervalMs: 50 });
        const stats = kaspaSync.kaspaIngestStats.call(host);
        assert.ok(stats, 'stats are available while the loop owns the chain');
        assert.strictEqual(typeof stats.ticks, 'number');

        assert.strictEqual(await kaspaSync.stopKaspaIngest.call(host), true);
        assert.strictEqual(await kaspaSync.stopKaspaIngest.call(host), false, 'stopping twice is not an error');
        assert.strictEqual(kaspaSync.kaspaIngestStats.call(host), null, 'stats go null once stopped');
    });

    it('stop is safe when nothing was ever started', async function () {
        assert.strictEqual(await kaspaSync.stopKaspaIngest.call({}), false);
    });
});

describe('kaspa_sync logging', function () {
    it('prefers the platform logger (real levels); the decoder sink is only the fallback', function () {
        assert.strictEqual(typeof kaspaSync.kaspaLogger, 'function');
        const logger = kaspaSync.kaspaLogger(function () {});
        for (const lvl of ['error', 'warn', 'info', 'debug']) assert.strictEqual(typeof logger[lvl], 'function');
        const src = require('fs').readFileSync(require('path').join(__dirname, '../../../../src/XChainDecoder/kaspa_sync.js'), 'utf8');
        assert.ok(src.includes("require('../observability/logger')"), 'platform logger must be preferred over the sink');
    });
});
