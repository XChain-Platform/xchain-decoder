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
 **********************************************************************
 *
 * XChain Decoder - Graceful shutdown
 *
 * Bounded, idempotent drain for SIGTERM/SIGINT, the same shape as the
 * indexer's src/shutdown.js. The Dockerfile CMD runs node as PID 1, so
 * `docker stop` delivers SIGTERM here.
 *
 * Before this file the handler in api.js only set the decoder's stopFlag. The
 * parse loop did break at its next block boundary, but the Express listener
 * and the MariaDB pool kept the event loop alive and nothing called exit, so
 * the process parked with the loop stopped until docker's SIGKILL: every stop
 * of a decoder, ever, ended in exit 137 (measured by an operator with
 * `docker stop -t 180` on a BTC mainnet stack, 2026-09-10). A killed decoder
 * mid-rollback is the case that matters, because an interrupted rollback is
 * what resets the dispenser purge budget.
 *
 * Registering a handler REMOVES node's default terminate, so the handler
 * carries its own hard-exit timer: a drain that hangs must still end the
 * process, or a stop becomes a container that lingers under any supervisor
 * with a long grace period, which is strictly worse than the kill.
 *
 ********************************************************************/

// Hard-exit budget for the whole drain. xchain-node stops a decoder with a
// 120 s budget (and stamps it on the container as --stop-timeout), so the
// default sits under that: an overrun that ends in our own logged exit is
// diagnosable, one that ends in the daemon's SIGKILL is not. On a container
// created before the budget existed docker's ten seconds still applies and
// this timer never gets to fire; nothing here can change that from inside.
// SHUTDOWN_TIMEOUT_MS overrides for a slow chain.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 100000;

function resolveTimeoutMs(timeoutMs, env){
    if(Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
    const raw = parseInt((env || process.env).SHUTDOWN_TIMEOUT_MS, 10);
    return (Number.isFinite(raw) && raw > 0) ? raw : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

// Close an http.Server and resolve once it has stopped listening. Idle keep-alive
// sockets would otherwise hold close() open indefinitely while no request is in
// flight, so they are dropped explicitly; requests already being served finish.
function closeServer(server){
    return new Promise((resolve) => {
        if(!server || typeof server.close !== 'function') return resolve();
        let settled = false;
        const done = () => { if(!settled){ settled = true; resolve(); } };
        try {
            server.close(done);
            if(typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        } catch(_){
            done();
        }
    });
}

// Best-effort close of a set of Database handles, deduped by identity. A pool
// that refuses to close must not abort the rest of the drain.
async function closeDatabases(handles, log){
    const logger = log || console;
    const seen = new Set();
    for(const db of (handles || [])){
        if(!db || typeof db.close !== 'function' || seen.has(db)) continue;
        seen.add(db);
        try { await db.close(); }
        catch(err){ logger.warn('Shutdown: closing a database pool failed: ' + (err && err.message ? err.message : err)); }
    }
}

/**
 * Build an idempotent signal handler that runs `drain` under a hard-exit bound.
 *
 * @param {object}   opts
 * @param {function} opts.drain      async work to finish before exiting
 * @param {number}   [opts.timeoutMs] hard-exit budget (default SHUTDOWN_TIMEOUT_MS / 100000)
 * @param {function} [opts.exit]     process-exit seam (tests pass their own)
 * @param {object}   [opts.log]      console-shaped logger
 * @returns {function(string): void} handler to register on SIGTERM / SIGINT
 */
function createShutdown({ drain, timeoutMs, exit, log } = {}){
    const onExit  = exit || ((code) => process.exit(code));
    const logger  = log || console;
    const budget  = resolveTimeoutMs(timeoutMs);
    let signalled = false;

    return function shutdown(signal){
        // A second signal must not restart the sequence: re-entering would call
        // stop() and close pools underneath a drain already using them.
        if(signalled){
            logger.log('Shutdown already in progress; ignoring ' + (signal || 'signal') + '.');
            return;
        }
        signalled = true;
        logger.log('Received ' + (signal || 'signal') + ', draining (hard exit in ' + budget + 'ms)...');

        let finished = false;
        const timer = setTimeout(() => {
            if(finished) return;
            finished = true;
            // Non-zero: the drain did NOT complete, so work was cut off exactly as a
            // SIGKILL would have cut it. A clean drain below exits 0.
            logger.error('Shutdown drain exceeded ' + budget + 'ms; exiting hard.');
            onExit(1);
        }, budget);

        Promise.resolve().then(() => drain()).then(
            () => {
                if(finished) return;
                finished = true;
                clearTimeout(timer);
                logger.log('Shutdown drain complete; exiting.');
                onExit(0);
            },
            (err) => {
                if(finished) return;
                finished = true;
                clearTimeout(timer);
                logger.error('Shutdown drain failed:', err);
                onExit(1);
            }
        );
    };
}

/**
 * The decoder's drain, as its own function so the exit path is unit-testable.
 *
 * Order is load-bearing:
 *   1. flip the health flag FIRST: stop() only sets stopFlag and the parse loop
 *      can take a whole block to notice, and /live must not answer 200 for a
 *      decoder that is leaving.
 *   2. stop() the decoder (stopFlag; the loop clears its own mempool interval
 *      on the way out).
 *   3. drain the HTTP server and the parse loop together; the loop breaks at
 *      the top of its iteration, never mid-transaction.
 *   4. close the two DB pools LAST, since both of the above still need them.
 *
 * The wait on step 3 is unbounded HERE and bounded by the caller's hard-exit
 * timer, because both ways it can overrun (a block or a rollback slower than
 * the budget, or a boot still inside the DB connect retry that never entered
 * the loop) should end in a logged non-zero exit, not a clean one.
 *
 * @param {object}   opts
 * @param {object}   opts.decoder      XChainDecoder instance
 * @param {object}   opts.server       http.Server returned by app.listen()
 * @param {Promise}  [opts.loopSettled] promise that settles when start()'s loop exits
 * @param {function} [opts.onDraining] flips the api-local decoderRunning flag
 * @param {object}   [opts.log]        console-shaped logger
 */
function createDecoderDrain({ decoder, server, loopSettled, onDraining, log } = {}){
    const logger = log || console;
    return async function drain(){
        if(typeof onDraining === 'function') onDraining();
        if(decoder && typeof decoder.stop === 'function') decoder.stop();

        await Promise.all([
            closeServer(server),
            // start() resolves when the parse loop breaks on stopFlag. It is already
            // .catch()'d at the call site (a fatal decoder error exits 1 there), so a
            // rejection here is that same handled error and must not fail the drain.
            Promise.resolve(loopSettled).catch(() => {})
        ]);

        await closeDatabases(decoder ? [decoder.db, decoder.mempoolDb] : [], logger);
    };
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    resolveTimeoutMs,
    closeServer,
    closeDatabases,
    createShutdown,
    createDecoderDrain
};
