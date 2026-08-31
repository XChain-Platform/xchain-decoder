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

// The decoder computed node-tip staleness and surfaced it nowhere an operator or
// Prometheus could reach.
//
// getSyncStatus() flagged a frozen tip, and /live reported height, lag and
// `stalled` but never that flag, while isStalled() returns false on a stale tip ON
// PURPOSE (restarting the container cannot fix an upstream node outage, and gating
// on it restarts the whole fleet during one). So a node-tip outage answered the
// Docker healthcheck 200 with last-known-good heights and nothing said why.
//
// These tests pin the three surfaces the fix adds, and pin the safety property it
// must NOT change: a stale tip still leaves isStalled() false and /live's healthy
// computation untouched.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const express = require('express');
const XChainDecoder = require('../../src/XChainDecoder');
const { registerDecoderMetrics } = require('../../src/decoderMetrics');
const { Registry } = require('../../src/observability/metrics');

// src/XChainDecoder.js BLOCKCHAIN_INFO_REFRESH_MS; stale is > 2x this.
const REFRESH_MS = 30000;

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    );
}

// A decoder mid-catch-up with a fresh tip: the baseline every case perturbs.
function makeRunningDecoder() {
    const decoder = makeDecoder();
    decoder.lastProcessedBlockIndex = 100;
    decoder.blockchainInfoLastBlock = 150;
    decoder.blockchainInfoLastRefreshAt = Date.now();
    decoder.lastAdvanceAt = Date.now();
    return decoder;
}

describe('XChainDecoder#isNodeHeightStale()', function () {

    it('is false before the first tip poll, so a booting decoder is never stale', function () {
        const decoder = makeDecoder();
        assert.strictEqual(decoder.blockchainInfoLastRefreshAt, 0);
        assert.strictEqual(decoder.isNodeHeightStale(), false);
        assert.strictEqual(decoder.nodeTipAgeSeconds(), null);
    });

    it('is false while the tip is refreshing', function () {
        const decoder = makeRunningDecoder();
        assert.strictEqual(decoder.isNodeHeightStale(), false);
    });

    it('is false at the threshold and true past it (2x the refresh interval)', function () {
        const decoder = makeRunningDecoder();
        decoder.blockchainInfoLastRefreshAt = Date.now() - (2 * REFRESH_MS) + 5000;
        assert.strictEqual(decoder.isNodeHeightStale(), false);
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        assert.strictEqual(decoder.isNodeHeightStale(), true);
        assert.ok(decoder.nodeTipAgeSeconds() >= 89, 'tip age reports the real outage duration');
    });

    it('is the same test getSyncStatus() reports, so the two cannot disagree', function () {
        const decoder = makeRunningDecoder();
        assert.strictEqual(decoder.getSyncStatus().node_height_stale, undefined);
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        assert.strictEqual(decoder.isNodeHeightStale(), true);
        assert.strictEqual(decoder.getSyncStatus().node_height_stale, true);
    });

    // The anti-restart-flap property the fix must leave alone.
    it('leaves isStalled() false on a stale tip, so autoheal still does not restart', function () {
        const decoder = makeRunningDecoder();
        decoder.lastAdvanceAt = Date.now() - (60 * 60 * 1000);
        assert.strictEqual(decoder.isStalled(), true, 'control: a wedged loop with a fresh tip IS stalled');
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        assert.strictEqual(decoder.isStalled(), false, 'a node outage must not restart the container');
        assert.strictEqual(decoder.isSynced(), false, 'but it must not read as synced either');
    });
});

describe('XChainDecoder stale-tip warn is edge-triggered', function () {

    function captureLogger() {
        const lines = { warn: [], info: [] };
        return {
            lines,
            warn: (message, fields) => lines.warn.push({ message, fields }),
            info: (message, fields) => lines.info.push({ message, fields })
        };
    }

    it('warns once when the tip goes stale, however many polls run in the outage', function () {
        const decoder = makeRunningDecoder();
        const logger = captureLogger();
        decoder.setObservabilityLogger(logger);

        decoder.noteNodeTipStaleTransition();
        assert.strictEqual(logger.lines.warn.length, 0, 'a fresh tip warns about nothing');

        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        // The block loop reaches this every ~3s for the whole outage.
        for (let i = 0; i < 20; i++) decoder.noteNodeTipStaleTransition();

        assert.strictEqual(logger.lines.warn.length, 1, 'one line per transition, not per poll');
        assert.match(logger.lines.warn[0].message, /node tip stale/);
        assert.strictEqual(logger.lines.warn[0].fields.node_height, 150);
        assert.ok(logger.lines.warn[0].fields.tip_age_seconds >= 89);
    });

    it('logs the recovery and re-arms, so a second outage warns again', function () {
        const decoder = makeRunningDecoder();
        const logger = captureLogger();
        decoder.setObservabilityLogger(logger);

        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        decoder.noteNodeTipStaleTransition();
        decoder.blockchainInfoLastRefreshAt = Date.now();
        decoder.noteNodeTipStaleTransition();
        decoder.noteNodeTipStaleTransition();
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        decoder.noteNodeTipStaleTransition();

        assert.strictEqual(logger.lines.warn.length, 2);
        assert.strictEqual(logger.lines.info.length, 1);
        assert.match(logger.lines.info[0].message, /node tip recovered/);
    });

    it('falls back to the console logger when no shim is wired, and never throws', function () {
        const decoder = makeRunningDecoder();
        const seen = [];
        decoder.log = (...args) => seen.push(args.join(' '));
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        decoder.noteNodeTipStaleTransition();
        assert.strictEqual(seen.length, 1);
        assert.match(seen[0], /node tip stale/);

        // A broken logger degrades its own line; it must not wedge the block loop.
        const broken = makeRunningDecoder();
        broken.setObservabilityLogger({ warn: () => { throw new Error('shipper down'); } });
        broken.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        assert.doesNotThrow(() => broken.noteNodeTipStaleTransition());
    });

    it('is called by the block loop, which is the only place an outage is observable', function () {
        const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8');
        assert.ok(
            /this\.noteNodeTipStaleTransition\(\)/.test(source),
            'the parse loop must invoke the transition check; without a caller the latch never flips'
        );
    });
});

describe('registerDecoderMetrics() feed-freshness gauges', function () {

    it('is a no-op when metrics are off, matching the default-off contract', function () {
        // installObservability returns registry:null unless METRICS_ENABLED.
        assert.strictEqual(registerDecoderMetrics(null, makeRunningDecoder()), null);
    });

    it('exports tip staleness and freshness that Prometheus can alert on', function () {
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        decoder.parseErrors = 2;
        decoder.rpcErrors = 3;
        registerDecoderMetrics(registry, decoder);

        const body = registry.render();
        assert.match(body, /^xchain_decoder_node_height_stale 1$/m);
        assert.match(body, /^xchain_decoder_last_processed_block 100$/m);
        assert.match(body, /^xchain_decoder_node_height 150$/m);
        assert.match(body, /^xchain_decoder_block_lag 50$/m);
        assert.match(body, /^xchain_decoder_synced 0$/m);
        assert.match(body, /^xchain_decoder_stalled 0$/m);
        assert.match(body, /^xchain_decoder_tip_age_seconds 9\d(\.\d+)?$/m);
        assert.match(body, /^xchain_decoder_last_tip_poll_timestamp_seconds \d/m);
        assert.match(body, /^xchain_decoder_parse_errors_total 2$/m);
        assert.match(body, /^xchain_decoder_rpc_errors_total 3$/m);
    });

    it('re-reads decoder state on every scrape rather than snapshotting it', function () {
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        registerDecoderMetrics(registry, decoder);

        assert.match(registry.render(), /^xchain_decoder_node_height_stale 0$/m);
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        assert.match(registry.render(), /^xchain_decoder_node_height_stale 1$/m);
    });

    it('emits no height series before the first block, instead of a false zero', function () {
        const registry = new Registry();
        registerDecoderMetrics(registry, makeDecoder());
        const body = registry.render();
        // getSyncStatus() returns nulls until a block is processed; a 0 there would
        // read as "decoder at genesis, caught up".
        assert.ok(!/xchain_decoder_last_processed_block/.test(body));
        assert.ok(!/xchain_decoder_block_lag/.test(body));
        assert.ok(!/xchain_decoder_tip_age_seconds/.test(body));
        assert.match(body, /^xchain_decoder_node_height_stale 0$/m);
    });

    // Poll silence was the one /live gate the Prometheus surface did not carry, so an
    // alert written against `stalled` -- whose help text called itself THE liveness
    // signal -- read 0 through a parse loop that had died while caught up.

    it('exports the poll-silence gate /live health depends on', function () {
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        decoder.lastPollAt = Date.now();
        registerDecoderMetrics(registry, decoder);

        const body = registry.render();
        assert.match(body, /^xchain_decoder_poll_silent 0$/m);
        assert.match(body, /^xchain_decoder_last_poll_timestamp_seconds \d/m);
    });

    it('shows a loop that died while caught up, which stalled cannot', function () {
        // The headline gap. A caught-up decoder makes no chain progress, so isStalled()
        // reads false BY DESIGN; only the iteration heartbeat separates "idle because
        // there is nothing to do" from "the loop is gone". Both series in one case,
        // because it is their disagreement that is the signal.
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        decoder.lastProcessedBlockIndex = 150;
        decoder.blockchainInfoLastBlock = 150;
        decoder.lastPollAt = Date.now() - (4 * 900000);
        registerDecoderMetrics(registry, decoder);

        const body = registry.render();
        assert.match(body, /^xchain_decoder_poll_silent 1$/m);
        assert.match(body, /^xchain_decoder_stalled 0$/m);
    });

    it('emits no last-poll timestamp before the first iteration, but still reports not-silent', function () {
        // lastPollAt 0 means the loop has not run yet (long initial sync), which
        // isPollSilent() reads as not silent; a 0 timestamp series would read as 1970.
        const registry = new Registry();
        registerDecoderMetrics(registry, makeDecoder());
        const body = registry.render();
        assert.ok(!/xchain_decoder_last_poll_timestamp_seconds/.test(body));
        assert.match(body, /^xchain_decoder_poll_silent 0$/m);
    });

    // Reorg churn had no decoder-side signal at all: the durable REORG rows are
    // DB-only and the indexer's reorgsProcessed needs the indexer to be up, so a
    // metrics-only deployment could watch a decoder thrash through shallow reorgs
    // and see nothing move.

    it('exports reorg count and depth so a metrics-only deployment sees churn', function () {
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        decoder.reorgCount = 3;
        decoder.lastReorgDepth = 5;
        registerDecoderMetrics(registry, decoder);

        const body = registry.render();
        assert.match(body, /^xchain_decoder_reorgs_total 3$/m);
        assert.match(body, /^xchain_decoder_last_reorg_depth 5$/m);
    });

    it('reports zero reorgs on a fresh decoder rather than no series at all', function () {
        // Unlike the height gauges, absent here is NOT safe: a missing counter and a
        // decoder that has never reorged look identical to a rate() query.
        const registry = new Registry();
        registerDecoderMetrics(registry, makeDecoder());
        assert.match(registry.render(), /^xchain_decoder_reorgs_total 0$/m);
    });

    it('counts reorg EVENTS, incrementing once per verifyReorg run', function () {
        // A per-block increment inside either delete branch would report one depth-5
        // reorg as five reorgs and destroy the frequency signal the counter exists for.
        // The branches need a live node to reach, so this is a source-level guard.
        const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8');
        const increments = source.match(/this\.reorgCount\+\+/g) || [];
        assert.strictEqual(increments.length, 1, 'exactly one reorgCount increment site');
        assert.ok(
            /if \(blocksDeleted\.length > 0\)\{[\s\S]{0,800}?this\.reorgCount\+\+/.test(source),
            'the increment must sit in verifyReorg\'s end-of-run summary block, not in a per-block delete branch'
        );
        assert.ok(
            /this\.lastReorgDepth = blocksDeleted\.length/.test(source),
            'depth must be the blocks rolled back by the run that just completed'
        );
    });

    it('surfaces the same counters on getSyncStatus, which /status spreads', function () {
        const decoder = makeRunningDecoder();
        decoder.reorgCount = 2;
        decoder.lastReorgDepth = 1;
        const status = decoder.getSyncStatus();
        assert.strictEqual(status.reorg_count, 2);
        assert.strictEqual(status.last_reorg_depth, 1);
    });

    it('registers on the handle api.js captures, not a discarded return value', function () {
        const source = fs.readFileSync(require.resolve('../../src/api.js'), 'utf-8');
        assert.ok(
            /const observability = installObservability\(/.test(source),
            'the observability handle must be captured or there is no registry to register on'
        );
        assert.ok(
            /registerDecoderMetrics\(observability\.registry, decoder\)/.test(source),
            'api.js must wire the decoder gauges onto that registry'
        );
        assert.ok(
            /decoder\.setObservabilityLogger\(observability\.logger\)/.test(source),
            'api.js must hand the decoder the log shim the stale-tip warn uses'
        );
    });
});

describe('/live reports the stale tip without gating on it', function () {

    // The route body is rebuilt here from the same shape api.js serves, so the
    // assertions run against a real express response; the source assertions below
    // pin api.js itself, the way test/unit/jsonrpc-body-guard.test.js does.
    function liveApp(decoder) {
        const app = express();
        app.get('/live', (req, res) => {
            const stalled = decoder.isStalled();
            const syncStatus = decoder.getSyncStatus();
            const healthy = true && true && !stalled;
            res.status(healthy ? 200 : 503).json({
                status: healthy ? 'healthy' : 'unhealthy',
                stalled,
                node_height_stale: syncStatus.node_height_stale === true,
                last_processed_block: syncStatus.last_processed_block,
                node_height: syncStatus.node_height,
                lag: syncStatus.lag
            });
        });
        return app;
    }

    function getLive(app) {
        return new Promise((resolve, reject) => {
            const server = app.listen(0, () => {
                http.get({ port: server.address().port, path: '/live' }, (res) => {
                    let body = '';
                    res.on('data', (c) => { body += c; });
                    res.on('end', () => {
                        server.close();
                        resolve({ status: res.statusCode, body: JSON.parse(body) });
                    });
                }).on('error', (e) => { server.close(); reject(e); });
            });
        });
    }

    it('answers 200 on a stale tip but says so in the body', async function () {
        const decoder = makeRunningDecoder();
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        const res = await getLive(liveApp(decoder));
        assert.strictEqual(res.status, 200, 'the healthy gate is unchanged');
        assert.strictEqual(res.body.stalled, false);
        assert.strictEqual(res.body.node_height_stale, true);
    });

    it('reports the flag as a stable boolean, not an absent key, when the tip is fresh', async function () {
        const decoder = makeRunningDecoder();
        const res = await getLive(liveApp(decoder));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.node_height_stale, false,
            'getSyncStatus omits the key when fresh; a watchdog needs false, not undefined');
    });

    it('is wired into the real /live handler with the healthy gate untouched', function () {
        const source = fs.readFileSync(require.resolve('../../src/api.js'), 'utf-8');
        const live = source.slice(source.indexOf("app.get('/live'"));
        assert.ok(
            /node_height_stale: syncStatus\.node_height_stale === true/.test(live),
            '/live must forward the already-computed staleness flag'
        );
        assert.ok(
            /const healthy = decoderRunning && dbOk && !stalled/.test(live),
            'the liveness gate must stay running+db+!stalled: adding node_height_stale to it ' +
            'restarts containers during a coin-node outage'
        );
    });
});
