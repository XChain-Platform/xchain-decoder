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
 * XChain Decoder - Decoder Class
 *
 * This file handles starting the decoder and parsing blocks and transactions
 *
 ********************************************************************/

// REORG_HALT rides getLogger() rather than this.logError, because a patched
// console line carries no structured fields and coin/network/reason/depth are
// the whole content of the event. getLogger() resolves lazily, so requiring it
// here is safe before patchConsole()/installObservability() has run.
const { getLogger } = require('../observability')
const { logger } = require('./constants.js')

function announceReorgHalt(reason, blocksDeleted, canPersist){
    try {
        getLogger().error('REORG_HALT', {
            coin:    this.coinTick,
            network: this.consensusNetwork,
            reason:  reason,
            depth:   blocksDeleted.length,
            // 'attempting', not 'persisted': this record is emitted BEFORE the
            // write, so it cannot know the outcome and must not claim one. The
            // REORG_HALT_MARKER record below carries the real answer.
            marker_write: canPersist ? 'attempting' : 'unavailable',
            // Spelled out rather than left for the reader to infer from the
            // field: this is the one halt that /status and /live cannot
            // report, because the marker they read is never written.
            detail: canPersist ? undefined
                : 'db.markReorgHalted is unavailable: the durable halt marker cannot be persisted, '
                + 'so GET /status, GET /live and the JSON-RPC health method will NOT report this halt. '
                + 'This log line is the only record of it.'
        })
    } catch (_) { /* a diagnostic must never mask the abort it describes */ }
}

function reportReorgHaltMarker(persisted, attempts, lastError){
    // The outcome record. Separate from the one above because the two answer
    // different questions ("what halted, and why" vs "did the evidence land"),
    // and because collapsing them would put the reason behind the write that
    // may be the thing failing.
    try {
        getLogger().error('REORG_HALT_MARKER', {
            coin:    this.coinTick,
            network: this.consensusNetwork,
            marker_persisted: persisted,
            attempts: attempts,
            err: lastError ? (lastError.message || String(lastError)) : undefined
        })
    } catch (_) { /* a diagnostic must never mask the abort it describes */ }

    if (!persisted){
        // The incident shape the bootstrap gate exists to stop: the process is
        // about to exit, the restart policy recycles the container, the entry
        // guard reads a marker that was never written, the decoder finishes the
        // over-deep rollback, and the gate counts zero markers and publishes
        // this database as known-good. Nothing durable records it, so this line
        // is the only evidence and it has to name the required action.
        logger.error('verifyReorg: the durable REORG_HALT marker could NOT be persisted after '
            + attempts + ' attempt(s)'
            + (lastError ? ' (' + (lastError.message || String(lastError)) + ')' : '')
            + '. This database is NOT a valid bootstrap source: a restart will re-enter verifyReorg '
            + 'with a zeroed depth counter and silently resume the over-deep rollback. '
            + 'REQUIRED OPERATOR ACTION: full resync from a known-good snapshot.')
    }
}

// Persist the durable halt marker before an abort throws. Feature-detected, and
// non-throwing so a marker failure never masks the loud abort, but NOT silent:
// the outcome is honoured, published on the health surface and logged, because
// an unrecorded halt is the one state where a restart resumes the rollback.
async function haltReorg(reason, blocksDeleted){
    // Set the in-memory health state first: the durable write is best-effort,
    // but this decoder is halted either way and every health surface must say
    // so, including when the marker write itself fails.
    this.reorgHalted = true
    this.reorgHaltReason = reason
    this.reorgHaltAt = new Date().toISOString()
    this.reorgHaltCheckedAt = Date.now()

    // A decoder that decides to halt and cannot record it anywhere is the
    // worst shape this surface has: the process stops, every health route
    // reads the durable marker that was never written, and the operator gets
    // a stopped decoder with no reason on any surface they poll. The event
    // goes out BEFORE the write is attempted, so the reason survives even
    // when nothing durable can.
    const canPersist = typeof this.db.markReorgHalted === 'function'
    announceReorgHalt.call(this, reason, blocksDeleted, canPersist)

    if (!canPersist) {
        this.reorgHaltMarkerPersisted = false
        return
    }

    // Honour the write result. markReorgHalted confirms the row by read-back
    // and returns false when it cannot; the catch below only ever fires for a
    // connection or SELECT fault, because insertEvent eats the INSERT error.
    // Retried ONCE and without a sleep: a failed insertEvent rolls the open
    // block transaction back (db.js insertEvent -> endTransaction), so the
    // second attempt runs on a freshly leased pooled connection, which is a
    // materially different attempt rather than the same one repeated. No
    // backoff, because this sits directly in front of the abort throw and a
    // marker write must never delay the fault it is describing.
    let persisted = false
    let lastError = null
    let attempts  = 0
    while (attempts < 2 && !persisted){
        attempts++
        try {
            persisted = (await this.db.markReorgHalted(reason)) === true
        } catch (e) {
            lastError = e
        }
    }
    this.reorgHaltMarkerPersisted = persisted

    reportReorgHaltMarker.call(this, persisted, attempts, lastError)
}

module.exports = { haltReorg }
