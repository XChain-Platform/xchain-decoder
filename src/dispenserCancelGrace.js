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
 **********************************************************************
 *
 * XChain Decoder - dispenser cancellation grace window on payment capture
 *
 * The indexer keeps a CANCELLED dispenser fillable past its own expiration. Its expiration
 * pass skips `cancelling` rows (xchain-indexer/src/db.js getExpiredItems, `s2.status='open'`),
 * findMatchingDispensers still matches `status IN ('open','cancelling')`, and DISPENSER_CLOSE
 * fires only at the cancel's block time plus DISPENSER_CLOSE_DELAY (3600s). The decoder
 * mirrors no cancel at all, deliberately, so it soft-expires that dispenser at its raw
 * expiration and drops the address from the block loop's payment-capture set.
 *
 * Cancel a funded dispenser shortly before its expiration and the two lifecycles diverge in
 * the money-bearing direction: the indexer still settles fills, the decoder captures no
 * output, and because the indexer only ever sees outputs the decoder persisted to
 * transaction_outputs, the buyer's native coin reaches the seller with no DISPENSE record and
 * no inventory release.
 *
 * A blanket grace window closes it by construction. A valid cancel always PRECEDES the
 * dispenser's own expiration, so `expiration + grace` always covers `cancel_time + close
 * delay`, with no cancel parsing, no BATCH sub-command gate dependency, and no cancel-target
 * resolution (the guess the advisory contract in db.js retired).
 *
 * WHAT THE GRACE MOVES, AND WHAT IT MUST NOT. The widening applies to the CAPTURE SET only:
 * getAllOpenDispenserAddresses admits a row whose expiration is no older than the floor this
 * module computes. The soft-expire predicate, the expiry MARK, the extend mirror, the
 * oracle-address resolution and the hard purge keep their current timing. That confines the
 * change to the over-capture direction the advisory contract calls safe, because capture is a
 * Set membership test that the indexer arbitrates afterwards. Delaying the MARK instead would
 * reach getOpenDispenserOracleAddressBySource, whose below-gate `ORDER BY ... LIMIT 1` would
 * then rank a dead row first; oracle-fee capture is a single-address EQUALITY test, so a wrong
 * pick captures NOTHING. That is the under-capture direction, a second funds-loss path rather
 * than a fix. Widen the capture set, never the mark.
 *
 * Changing which outputs are persisted is consensus-affecting, so it rides a flag-day in the
 * same shape as dispenserExpiryRealign: this module holds the one pure decision.
 *
 ********************************************************************/

'use strict';

const { DISPENSER_CANCEL_GRACE_ACTIVATION } = require('./protocol/constants.js')

// Seconds a soft-expired dispenser stays an eligible payment destination at/above the gate.
//
// Pinned to the indexer's DISPENSER_CLOSE_DELAY (xchain-indexer/src/config.js). The invariant
// is GRACE >= CLOSE_DELAY: the indexer stops matching a cancelled dispenser at cancel time
// plus its close delay, and the cancel precedes the expiration, so a grace of at least the
// close delay covers every block in which the indexer can still settle a fill. Equal, not
// larger, because every extra second is capture the indexer discards. dispenserCancelGrace
// tests read the indexer's value directly, so retuning it there fails this suite until this
// constant follows.
const DISPENSER_CANCEL_GRACE_SECONDS = 3600

// Is the grace window in force for a block at `blockTime` on this network?
//
// Fails CLOSED twice over, since either failure mode would widen the persisted output set on
// a chain whose fleet has not armed the change (a fork):
//   * an unrecognized network name reads as "no grace", not "no gate";
//   * a null (DISARMED) entry means the network's maintainers have not ratified an instant
//     yet, and stays inactive at every block time rather than defaulting to genesis-on.
//
// Comparison is `blockTime >= activation`, the same >= semantics the indexer's
// protocol_changes gates and the sibling dispenser gates use.
function isDispenserCancelGraceActive(consensusNetwork, blockTime){
    const activation = DISPENSER_CANCEL_GRACE_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const t = Number(blockTime)
    if (!Number.isFinite(t)) return false
    return t >= activation
}

// The capture floor for a block: the oldest expiration still eligible for payment capture.
//
// Returns null below the gate, which getAllOpenDispenserAddresses reads as "keep the
// unwidened set", so a from-genesis re-decode of pre-flag-day history reproduces the output
// set the fleet wrote live, byte for byte. Above it the floor is a pure function of the
// block's own header time, so two honest nodes load the identical capture set.
function cancelGraceFloor(consensusNetwork, blockTime){
    if (!isDispenserCancelGraceActive(consensusNetwork, blockTime)) return null
    return Number(blockTime) - DISPENSER_CANCEL_GRACE_SECONDS
}

module.exports = {
    DISPENSER_CANCEL_GRACE_ACTIVATION,
    DISPENSER_CANCEL_GRACE_SECONDS,
    isDispenserCancelGraceActive,
    cancelGraceFloor,
}
