// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the container exit path. `docker stop` sends SIGTERM to node (PID 1 via the
// Dockerfile's exec-form CMD) and this drain is everything between that signal and
// the process ending. Before it existed the handler only set stopFlag, the listener
// and the pool kept the process alive, and every stop ended in SIGKILL (exit 137).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createShutdown, createDecoderDrain, closeServer, closeDatabases, resolveTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS } = require('../../src/shutdown');

const NODE_DIR = process.env.XCHAIN_NODE_DIR || path.join(__dirname, '..', '..', '..', 'xchain-node');
const NODE_STOP_BUDGET_SRC = path.join(NODE_DIR, 'src', 'services', 'stop_budget_service.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Read the budget xchain-node stops `module` with, from its source text (the
// sibling's npm deps are not installed on the venue, so it is not required).
// Throws on a shape it cannot read, so a moved table fails instead of skipping.
function nodeStopBudgetSeconds(module){
    const src = fs.readFileSync(NODE_STOP_BUDGET_SRC, 'utf8');
    const table = /MODULE_STOP_TIMEOUT_SECONDS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(src);
    if(!table) throw new Error('no MODULE_STOP_TIMEOUT_SECONDS table in ' + NODE_STOP_BUDGET_SRC);
    const row = new RegExp("'" + module + "'\\s*:\\s*(\\d+)").exec(table[1]);
    if(row) return parseInt(row[1], 10);
    const fallback = /DEFAULT_MODULE_STOP_TIMEOUT_SECONDS\s*=\s*(\d+)/.exec(src);
    if(!fallback) throw new Error('no DEFAULT_MODULE_STOP_TIMEOUT_SECONDS in ' + NODE_STOP_BUDGET_SRC);
    return parseInt(fallback[1], 10);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000, intervalMs = 10){
    const deadline = Date.now() + timeoutMs;
    while(Date.now() < deadline){
        if(await predicate()) return true;
        await sleep(intervalMs);
    }
    return Boolean(await predicate());
}

const silentLog = { log(){}, warn(){}, error(){} };

// Manual hard-exit timer. It records what was armed and every handle passed to
// clear, so deleting a clear call fails an assertion instead of passing silently
// on the `finished` guard alone.
function makeTimerFake(){
    const armed = [];
    const cleared = [];
    return {
        armed,
        cleared,
        setTimer(fn, ms){ const handle = { id: armed.length }; armed.push({ fn, ms, handle }); return handle; },
        clearTimer(handle){ cleared.push(handle); }
    };
}

// Minimal XChainDecoder stand-in: records call ORDER, because the ordering is the
// contract (health flag before stop, pools closed last).
function makeDecoder(order){
    let resolveLoop;
    const loop = new Promise((res) => { resolveLoop = res; });
    const db = (name) => ({
        closed: false,
        async close(){ this.closed = true; order.push('close:' + name); }
    });
    return {
        stopped: false,
        db:        db('db'),
        mempoolDb: db('mempoolDb'),
        loop,
        // The real stop() only sets stopFlag; the loop breaks at the top of its next
        // iteration, which the test models by resolving the loop promise later.
        stop(){ this.stopped = true; order.push('stop'); setImmediate(resolveLoop); }
    };
}

function makeServer(order){
    return {
        closed: false,
        idleDropped: false,
        close(cb){ this.closed = true; order.push('server.close'); setImmediate(cb); },
        closeIdleConnections(){ this.idleDropped = true; }
    };
}

describe('graceful shutdown', function(){

    describe('createShutdown', function(){

        it('runs the drain and exits zero when it completes', async function(){
            const codes = [];
            let drained = false;
            const shutdown = createShutdown({
                drain: async () => { drained = true; },
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            assert.ok(await waitUntil(() => codes.length > 0), 'timed out waiting for the clean drain to reach exit()');
            assert.strictEqual(drained, true);
            assert.deepStrictEqual(codes, [0]);
        });

        it('is idempotent: a second signal does not re-enter the drain', async function(){
            const codes = [];
            let calls = 0;
            const shutdown = createShutdown({
                drain: async () => { calls++; await sleep(20); },
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            shutdown('SIGTERM');
            shutdown('SIGINT');
            assert.ok(await waitUntil(() => codes.length > 0), 'timed out waiting for the single in-flight drain to reach exit()');
            assert.strictEqual(calls, 1, 'drain must run exactly once');
            assert.deepStrictEqual(codes, [0]);
        });
    });
});

describe('graceful shutdown', function(){
    describe('createShutdown', function(){

        // The reason the handler is safe to install at all: registering one REMOVES
        // node's default terminate, so without this bound a hung drain turns every
        // stop into a container that lingers until the supervisor's grace expires.
        it('hard-exits non-zero when the drain overruns its budget', async function(){
            const codes = [];
            const shutdown = createShutdown({
                drain: () => new Promise(() => {}),   // never settles
                timeoutMs: 20,
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            assert.ok(await waitUntil(() => codes.length > 0), 'timed out waiting for the hard-exit timer to fire');
            assert.deepStrictEqual(codes, [1]);
        });

        it('exits non-zero when the drain throws, and only once', async function(){
            const codes  = [];
            const timers = makeTimerFake();
            const shutdown = createShutdown({
                drain: async () => { throw new Error('pool refused to close'); },
                timeoutMs: 50,
                exit: (c) => codes.push(c),
                log: silentLog,
                setTimer: timers.setTimer,
                clearTimer: timers.clearTimer
            });
            shutdown('SIGTERM');
            assert.ok(await waitUntil(() => codes.length > 0), 'the drain rejection never reached the exit seam');
            assert.deepStrictEqual(codes, [1]);
            assert.strictEqual(timers.armed.length, 1, 'exactly one hard-exit timer must be armed');
            assert.strictEqual(timers.armed[0].ms, 50, 'the hard-exit timer was armed with the wrong budget');
            assert.deepStrictEqual(timers.cleared, [timers.armed[0].handle], 'the hard-exit timer was never cleared');
            // Fire the stale callback by hand: the window the old sleep(120) waited out.
            timers.armed[0].fn();
            assert.deepStrictEqual(codes, [1], 'a cleared timer must not add a second exit');
        });
    });
});

describe('graceful shutdown', function(){
    describe('createShutdown', function(){

        it('does not fire the hard-exit timer after a clean drain', async function(){
            const codes  = [];
            const timers = makeTimerFake();
            const shutdown = createShutdown({
                drain: async () => {},
                timeoutMs: 20,
                exit: (c) => codes.push(c),
                log: silentLog,
                setTimer: timers.setTimer,
                clearTimer: timers.clearTimer
            });
            shutdown('SIGTERM');
            assert.ok(await waitUntil(() => codes.length > 0), 'the clean drain never reached the exit seam');
            assert.deepStrictEqual(codes, [0]);
            assert.strictEqual(timers.armed[0].ms, 20, 'the hard-exit timer was armed with the wrong budget');
            assert.deepStrictEqual(timers.cleared, [timers.armed[0].handle], 'the hard-exit timer was never cleared');
            timers.armed[0].fn();
            assert.deepStrictEqual(codes, [0], 'a cleared timer must not add a second exit');
        });
    });
});

describe('graceful shutdown', function(){
    describe('resolveTimeoutMs', function(){
        it('prefers an explicit budget, then the env var, then the default', function(){
            assert.strictEqual(resolveTimeoutMs(1234, {}), 1234);
            assert.strictEqual(resolveTimeoutMs(undefined, { SHUTDOWN_TIMEOUT_MS: '4321' }), 4321);
            assert.strictEqual(resolveTimeoutMs(undefined, {}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
            assert.strictEqual(resolveTimeoutMs(0, { SHUTDOWN_TIMEOUT_MS: 'nonsense' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
        });

        // xchain-node stops a decoder with a 120 s budget and stamps it on the
        // container; the drain's own bound must end in a LOGGED exit before that.
        it('stays under the 120 s budget xchain-node gives a decoder', function(){
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < 120000,
                'a budget at or above the container stop-timeout ends in the daemon\'s SIGKILL, which is what this replaces');
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS > 10000,
                'a block boundary on a mainnet chain is not reached in docker\'s ten seconds');
        });

        // The literal above is a copy of xchain-node's number; this holds the
        // relation against the sibling's own table, so a one-sided edit goes red.
        it('stays under the stop budget in xchain-node\'s own table when that checkout is beside this one', function(){
            if(!fs.existsSync(NODE_STOP_BUDGET_SRC)){
                if(REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + NODE_STOP_BUDGET_SRC + ' is absent');
                this.skip();
            }
            const budgetSeconds = nodeStopBudgetSeconds('xchain-decoder');
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < budgetSeconds * 1000,
                'xchain-decoder drains for ' + DEFAULT_SHUTDOWN_TIMEOUT_MS + ' ms but xchain-node stops it after '
                + budgetSeconds + ' s (' + NODE_STOP_BUDGET_SRC + '), so every overrun ends in the daemon\'s SIGKILL');
        });
    });

    describe('closeServer', function(){
        it('resolves once, and drops idle keep-alive sockets that would hold close() open', async function(){
            const order = [];
            const server = makeServer(order);
            await closeServer(server);
            assert.strictEqual(server.closed, true);
            assert.strictEqual(server.idleDropped, true);
        });

        it('resolves on a missing or closeless server rather than hanging the drain', async function(){
            await closeServer(null);
            await closeServer({});
        });
    });

    describe('closeDatabases', function(){
        it('closes each handle once and survives one that refuses', async function(){
            let closes = 0;
            const ok = { async close(){ closes++; } };
            const bad = { async close(){ throw new Error('refused'); } };
            await closeDatabases([ok, ok, bad, null, {}], silentLog);
            assert.strictEqual(closes, 1);
        });
    });
});

describe('graceful shutdown', function(){
    describe('createDecoderDrain', function(){

        it('flips health, stops the decoder, drains the server and loop, then closes both pools', async function(){
            const order   = [];
            const decoder = makeDecoder(order);
            const server  = makeServer(order);
            let running   = true;

            const drain = createDecoderDrain({
                decoder,
                server,
                loopSettled: decoder.loop,
                onDraining: () => { running = false; order.push('health-flag'); },
                log: silentLog
            });
            await drain();

            assert.strictEqual(running, false, '/live must stop reporting the decoder running');
            assert.strictEqual(decoder.stopped, true);
            assert.strictEqual(server.closed, true);
            assert.ok(order.indexOf('health-flag') < order.indexOf('stop'), 'health flag must flip before stop(), not after');
            for(const name of ['db', 'mempoolDb']){
                assert.ok(order.indexOf('close:' + name) > order.indexOf('server.close'), name + ' must close after the server has drained');
                assert.ok(order.indexOf('close:' + name) > order.indexOf('stop'), name + ' must close after the parse loop was told to stop');
            }
            assert.ok(decoder.db.closed && decoder.mempoolDb.closed);
        });

        it('waits for the parse loop to break before closing pools', async function(){
            const order   = [];
            const decoder = makeDecoder(order);
            const server  = makeServer(order);

            let breakLoop;
            const loop = new Promise((res) => { breakLoop = res; });
            const drain = createDecoderDrain({ decoder, server, loopSettled: loop, log: silentLog });

            let settled = false;
            const running = drain().then(() => { settled = true; });

            // Wait on the positive marker, not a clock: past server.close the drain has
            // nothing left but the loop promise, so non-settlement here is structural.
            assert.ok(await waitUntil(() => order.includes('server.close')), 'the drain never reached the parse-loop wait');
            assert.strictEqual(settled, false, 'the drain must not finish while the parse loop is mid-block');
            assert.strictEqual(decoder.db.closed, false, 'closing a pool under an open block transaction is the exact abort this fix removes');

            breakLoop();
            await running;
            assert.strictEqual(decoder.db.closed, true);
        });
    });
});

describe('graceful shutdown', function(){
    describe('createDecoderDrain', function(){

        it('survives a rejected loop promise', async function(){
            const order   = [];
            const decoder = makeDecoder(order);
            const server  = makeServer(order);
            const drain = createDecoderDrain({
                decoder, server,
                loopSettled: Promise.reject(new Error('fatal decoder error')),
                log: silentLog
            });
            await drain();
            assert.strictEqual(decoder.db.closed, true);
        });

        it('drains a partially-built process without throwing', async function(){
            const drain = createDecoderDrain({ decoder: null, server: null, log: silentLog });
            await drain();
        });
    });

    // The Database class had no close() at all, which is half of why the process
    // could not exit: the pool's sockets kept the event loop alive.
    describe('Database.close()', function(){
        it('ends the pool once and releases a held transaction connection first', async function(){
            const Database = require('../../src/db');
            const db = Object.create(Database.prototype);
            const calls = [];
            db.transactionConnection = { async release(){ calls.push('release'); } };
            db.pool = { async end(){ calls.push('end'); } };
            await db.close();
            await db.close();
            assert.deepStrictEqual(calls, ['release', 'end']);
            assert.strictEqual(db.transactionConnection, null);
            assert.strictEqual(db.pool, null);
        });
    });
});
