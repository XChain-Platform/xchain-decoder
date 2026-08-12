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

// /live used to answer 200 forever while the parse loop was dead.
//
// Health was decoderRunning && dbOk && !stalled, and every gate in isStalled() is a
// statement about CHAIN PROGRESS: it returns false for a caught-up decoder and false
// again on a stale tip (deliberately, because restarting the container cannot fix an
// upstream node outage). So a loop that died while caught up left running true, db
// true and stalled false, and the Docker HEALTHCHECK kept the container alive while
// nothing parsed.
//
// These cases drive the REAL registrar out of src/api.js against a REAL XChainDecoder,
// not a copy of the route rebuilt in the test. The copy is what makes this class of
// test worthless: the handler's whole job is to answer 503 in states a hand-written
// stand-in would simply not reproduce, and a source-text grep for `isPollSilent`
// proves only that the string is present, never that the status code changes.

const assert = require('assert');
const http = require('http');
const express = require('express');
const XChainDecoder = require('../../src/XChainDecoder');
const { registerLiveRoute } = require('../../src/api');

// src/XChainDecoder.js POLL_SILENT_MS: 2 * STALL_ALERT_MS, both at their defaults.
const SILENT_MS = 2 * 900000;

// A caught-up decoder: nothing to parse, tip fresh, loop iterating. isStalled() is
// false here by construction, which is the whole reason the heartbeat had to exist.
function caughtUpDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    );
    decoder.lastProcessedBlockIndex = 150;
    decoder.blockchainInfoLastBlock = 150;
    decoder.blockchainInfoLastRefreshAt = Date.now();
    decoder.lastAdvanceAt = Date.now();
    decoder.lastPollAt = Date.now();
    decoder.synced = true;
    // Only the DB round-trip is stubbed; every predicate under test is the real one.
    decoder.db = { ping: async () => true };
    decoder.connector = { rpcErrors: 0 };
    return decoder;
}

function liveApp(decoder, running = true) {
    const app = express();
    registerLiveRoute(app, decoder, () => running);
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

describe('/live gates on the poll-loop heartbeat', function () {

    it('answers 200 while the loop is iterating, caught up and quiet', async function () {
        const res = await getLive(liveApp(caughtUpDecoder()));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.poll_silent, false);
        assert.strictEqual(res.body.stalled, false);
        assert.ok(res.body.last_poll_at > 0, 'the heartbeat is on the wire for a watchdog');
    });

    // The control the fix is measured against: the same decoder, the same everything,
    // with the loop no longer iterating. Every pre-existing field still reads healthy.
    it('answers 503 when the loop stops iterating, with nothing else having changed', async function () {
        const decoder = caughtUpDecoder();
        decoder.lastPollAt = Date.now() - (SILENT_MS + 60000);

        assert.strictEqual(decoder.isStalled(), false,
            'control: isStalled() cannot see a dead loop on a caught-up chain');
        assert.strictEqual(decoder.isSynced(), true,
            'control: the decoder still reports synced, so lag alarms stay quiet too');

        const res = await getLive(liveApp(decoder));
        assert.strictEqual(res.status, 503, 'a dead loop is exactly the wedge a restart fixes');
        assert.strictEqual(res.body.status, 'unhealthy');
        assert.strictEqual(res.body.poll_silent, true);
        assert.strictEqual(res.body.running, true, 'the flag that used to be the only signal');
        assert.strictEqual(res.body.db, true);
        assert.strictEqual(res.body.stalled, false);
    });

    it('is not silent before the loop has iterated once, so a booting decoder stays 200', async function () {
        const decoder = caughtUpDecoder();
        decoder.lastPollAt = 0;
        const res = await getLive(liveApp(decoder));
        assert.strictEqual(res.status, 200, 'a long initial sync must not be restarted');
        assert.strictEqual(res.body.poll_silent, false);
        assert.strictEqual(res.body.last_poll_at, null);
    });

    // The outage retry path re-enters the loop top every ~3s (catch -> sleep(3000) ->
    // continue main_parsing), so the heartbeat keeps ticking through a node outage.
    // Pinned because a heartbeat that went silent on an outage would restart every
    // container in the fleet during an upstream outage, which is the one thing this
    // gate must never do.
    it('stays 200 through a node-tip outage, so containers are not restarted', async function () {
        const decoder = caughtUpDecoder();
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * 30000);
        decoder.lastPollAt = Date.now() - 3000;

        assert.strictEqual(decoder.isNodeHeightStale(), true, 'control: the tip really is frozen');

        const res = await getLive(liveApp(decoder));
        assert.strictEqual(res.status, 200, 'restarting the container cannot fix an upstream outage');
        assert.strictEqual(res.body.node_height_stale, true, 'reported, not gated');
        assert.strictEqual(res.body.poll_silent, false);
    });

    // shutdown() and start()'s settle both flip the flag; the probe must answer 503 on
    // it immediately rather than waiting out the poll-silence window.
    it('answers 503 the moment the running flag drops, ahead of the silence window', async function () {
        const res = await getLive(liveApp(caughtUpDecoder(), false));
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.running, false);
        assert.strictEqual(res.body.poll_silent, false, 'the drain is crisp, not window-delayed');
    });

    it('answers 503 when the DB ping fails, which the heartbeat must not mask', async function () {
        const decoder = caughtUpDecoder();
        decoder.db = { ping: async () => { throw new Error('pool gone'); } };
        const res = await getLive(liveApp(decoder));
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.db, false);
    });
});
