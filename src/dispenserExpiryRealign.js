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
 * XChain Decoder - dispenser soft-expire measurement point
 *
 * The decoder and the indexer expire the same dispenser at OPPOSITE ENDS of the same
 * block. The decoder runs db.deleteOpenDispensers before its transaction loop and then
 * loads the open-dispenser address set that loop tests every output against, so on the
 * FIRST block whose header time passes an expiration the dispenser is already gone from
 * that set. The indexer runs utility.processExpirations AFTER its transaction loop
 * (xchain-indexer/src/XChainIndexer.js, beside processBetPasses), so for every
 * transaction in that same block it still treats the dispenser as open.
 *
 * The indexer only ever sees outputs the decoder persisted to transaction_outputs. So on
 * that one boundary block a native payment to the dispenser is dropped by the decoder and
 * no DISPENSE ever reaches the indexer: the payer's coin is spent and nothing is
 * dispensed for it. Money-bearing, and unreachable by any in-memory re-seed, because the
 * transactions preceding an edit in the block are already past by the time anything could
 * notice.
 *
 * Moving the decoder's soft-expire to the end of its block loop puts both measurement
 * points in the same place, which is what makes a boundary block yield the same DISPENSE
 * set on both sides. That move changes which outputs get persisted, so it is
 * consensus-affecting and rides a flag-day: this module holds the one pure decision, in
 * the same shape as oracleFeeOutput.isOracleFeeCaptureActive.
 *
 ********************************************************************/

'use strict';

const { DISPENSER_EXPIRY_REALIGN_ACTIVATION } = require('./protocol/constants.js')

// Is the END-OF-BLOCK dispenser soft-expire in force for a block at `blockTime` on this
// network?
//
// At/above the gate the block loop skips its pre-loop deleteOpenDispensers and runs it
// after the transaction loop instead, inside the same block transaction. Below it the
// legacy block-start soft-expire stands, so a from-genesis re-decode of pre-flag-day
// history reproduces the output set the fleet wrote live, byte for byte.
//
// Fails CLOSED twice over, since either failure mode would move a consensus measurement
// point on a chain whose fleet has not armed the change (a fork):
//   * an unrecognized network name reads as "legacy block-start expiry", not "no gate";
//   * a null (DISARMED) entry means the network's maintainers have not ratified an
//     instant yet, and stays inactive at every block time rather than defaulting to
//     genesis-on.
//
// Comparison is `blockTime >= activation`, the same >= semantics the indexer's
// protocol_changes gates use.
function isDispenserExpiryRealignActive(consensusNetwork, blockTime){
    const activation = DISPENSER_EXPIRY_REALIGN_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const t = Number(blockTime)
    if (!Number.isFinite(t)) return false
    return t >= activation
}

module.exports = {
    DISPENSER_EXPIRY_REALIGN_ACTIVATION,
    isDispenserExpiryRealignActive,
}
