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

// The one recovery for a halt that rolled back blocks above the stored tip: a parked
// decoder never re-parses that range, so clear-reorg-halt's re-parse check can never pass.
const RESET_RECOVERY = '`xchain-node reset xchain-decoder <chain> <network> --with-indexer --yes`'

// Count the rolled-back heights above the stored tip to choose a halt's recovery:
// undefined when the db has no such count (older and minimal db shapes), null when
// it cannot be read. Never throws.
async function readRolledBackAboveTip(db){
    if (!db || typeof db.countReorgDeletesAboveTip !== 'function') return undefined
    try {
        const count = await db.countReorgDeletesAboveTip()
        return (Number.isInteger(count) && count >= 0) ? count : null
    } catch (_) {
        return null
    }
}

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
            // field: this is the one halt /status and /live can report only
            // from this process's memory, because no marker is ever written.
            detail: canPersist ? undefined
                : 'db.markReorgHalted is unavailable: the durable halt marker cannot be persisted, '
                + 'so GET /status, GET /live and the JSON-RPC health method report this halt only from '
                + 'this process\'s memory and lose it on restart. This log line is the only lasting record of it.'
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
        // The incident shape the bootstrap gate exists to stop: the process exits,
        // the container restarts, and the entry guard, health surfaces and gate all
        // read a marker that was never written, so the gate would publish this
        // database as known-good. The depth ceiling survives (it is re-derived from
        // the per-block REORG markers), but nothing durable records the halt, so
        // this line is the only evidence and it has to name the required action.
        logger.error('verifyReorg: the durable REORG_HALT marker could NOT be persisted after '
            + attempts + ' attempt(s)'
            + (lastError ? ' (' + (lastError.message || String(lastError)) + ')' : '')
            + '. This database is NOT a valid bootstrap source: the halt is recorded nowhere durable, '
            + 'so after a restart the health surfaces and the bootstrap gate will not report it. '
            + 'The safe-depth ceiling still holds across a restart, because it is re-derived from the '
            + 'per-block REORG markers committed with each delete, and a restarted decoder that reaches '
            + 'it halts again and retries this write. '
            + 'REQUIRED OPERATOR ACTION: full resync from a known-good snapshot, and do not publish '
            + 'or snapshot this database until then.')
    }
}

// Persist the durable halt marker before an abort throws. Feature-detected, and
// non-throwing so a marker failure never masks the loud abort, but NOT silent:
// the outcome is honoured, published on the health surface and logged, because
// an unrecorded halt is invisible after a restart to the health surfaces and the
// bootstrap gate (the depth ceiling itself is re-derived from per-block REORG markers).
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

module.exports = { haltReorg, RESET_RECOVERY, readRolledBackAboveTip }
