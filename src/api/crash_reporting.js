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
 ********************************************************************/

const { getLogger } = require('../observability');

// The rejection side of start(): the caller has already marked the decoder
// not-running and kept the error for the health method, so this only records
// the crash and exits.
function reportStartFailure(decoder, err) {
    // One record, not a record plus a prose twin. A collector reading warn+
    // lines would file the same crash as two separate residue items, and the
    // record carries strictly more than the prose line did (message, stack,
    // and the halt state below).
    //
    // The halt state rides the crash record because the two failures look
    // identical from outside: an exited container, restart policy cycling it.
    // A decoder that aborted a rollback past the dispenser safe-depth window
    // needs an operator resync, while an ordinary crash needs a restart, and
    // the process is gone before any health route can be asked which it was.
    try {
        getLogger().error('CRASH', {
            kind:  'startFailure',
            err:   err && err.message ? err.message : String(err),
            stack: err && err.stack ? err.stack : undefined,
            reorgHalted:     decoder.reorgHalted === true,
            reorgHaltReason: decoder.reorgHaltReason || null
        })
    } catch (_) { /* never mask the crash */ }
    // A decoder whose start() rejected does no work: the parse loop never runs and
    // the process would otherwise linger as a permanently-unhealthy but RUNNING
    // container that `--restart unless-stopped` never recycles. Exit non-zero so the
    // container restart policy (or a supervisor) can act, mirroring the sibling
    // xchain-indexer fatal handler.
    //
    // A REORG_HALT refusal does not arrive here: the parse loop parks on it and
    // keeps this process up (XChainDecoder.parkOnReorgHalt), because the marker
    // outlives every restart and only an audited clear releases it, so exiting made
    // one halt an unbounded restart loop against an uncapped `--restart
    // unless-stopped`. What still reaches this handler is the fault class a restart
    // can actually repair, and those keep the visible Exited(1).
    process.exit(1)
}

// Crash visibility. Registered inside startApi(), not at module scope: several
// unit suites require src/api.js in-process under mocha to reach registerLiveRoute
// and makeRpcBatchGuard, and mocha installs its own handlers. A module-scope
// handler that calls process.exit would abort the whole run instead of failing one
// test. Same placement as xchain-sync/src/api.js.
//
// An uncaughtException leaves the parse loop and the DB pool in an unknown shape
// mid-block, so the process exits after logging and lets the restart policy act.
// An unhandledRejection logs and CONTINUES, which is the choice this file already
// made: a single unresolved promise does not by itself corrupt shared state.
function installCrashHandlers(decoder) {
    process.on('uncaughtException', (err) => {
        try {
            getLogger().error('CRASH', {
                kind:  'uncaughtException',
                err:   err && err.message ? err.message : String(err),
                stack: err && err.stack ? err.stack : undefined,
                reorgHalted:     decoder.reorgHalted === true,
                reorgHaltReason: decoder.reorgHaltReason || null
            })
        } catch (_) { /* never mask the crash */ }
        process.exit(1)
    })

    process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason))
        try {
            getLogger().error('CRASH', {
                kind:  'unhandledRejection',
                err:   err.message,
                stack: err.stack,
                reorgHalted:     decoder.reorgHalted === true,
                reorgHaltReason: decoder.reorgHaltReason || null
            })
        } catch (_) { /* never mask the rejection */ }
    })
}

module.exports = { reportStartFailure, installCrashHandlers }
