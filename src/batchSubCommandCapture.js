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
 * XChain Decoder - payment-output capture through a BATCH
 *
 * The decoder decides which native-coin outputs to persist by reading the TOP-LEVEL
 * action string: `decodedData.startsWith("COINPAY|")` selects settlement capture, and
 * resolveOracleFeeAddresses' matching `startsWith("DISPENSER|")` selects oracle-fee
 * capture. Both are FALSE for a BATCH that carries those actions as sub-commands, so
 * `BATCH|0|COINPAY|0|x;COINPAY|0|y` persists NOTHING.
 *
 * The indexer only ever sees outputs the decoder persisted. A batched COINPAY therefore
 * reaches it with an empty COIN_DESTINATION and settles nothing ("COINPAY (skip):
 * destination mismatch tx= payee=<seller>"), and a batched Mode B DISPENSER is rejected
 * for a missing oracle fee whether or not the payer paid. Both are money-bearing: the
 * coin is spent on chain and no obligation clears.
 *
 * The SAME blindness reaches the open-dispenser REGISTRY: `decodedData.startsWith("DISPENSER")`
 * is false for `BATCH|0|DISPENSER|0|...`, so a dispenser created inside a batch never entered
 * getAllOpenDispenserAddresses, payments to it were never captured as dispense outputs, and no
 * DISPENSE ever fired - while the INDEXER registered it. Same gate, same command view; see
 * collapseDispenserRegistrations below for the one thing registration needs that capture does
 * not (the dispensers PRIMARY KEY is per-transaction, and a batch breaks that assumption).
 *
 * This module holds the pure decisions capture needs to see through a BATCH: the gate,
 * and the sub-command split. The split MUST agree with the indexer's, because a decoder
 * that disagrees about what the sub-commands ARE captures for actions the indexer never
 * runs (or misses ones it does) - a worse fault than the one being fixed. See
 * batchSubCommands below for the equivalence argument against
 * xchain-indexer/src/actions/batch.js.
 *
 ********************************************************************/

'use strict';

const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION } = require('./protocol/constants.js')

// The BATCH FORMAT versions the indexer registers (xchain-indexer/src/actions/batch.js
// `this.formats`, which today holds only 0 = 'VERSION|COMMAND'). A BATCH whose FORMAT is
// not registered is whole-batch rejected there with 'invalid: VERSION (unknown)' and no
// sub-command ever runs, so capture must not see sub-commands in one either. Adding a
// format here without the indexer registering it would capture for commands nothing
// executes; the conformance suite reads the indexer's map and pins the two together.
const BATCH_SUB_COMMAND_FORMATS = [0]

// Is sub-command-aware payment-output capture in force for a block at `blockTime` on
// this network?
//
// At/above the gate the capture decision runs over a BATCH's sub-commands; below it the
// legacy top-level-only view stands, so a from-genesis re-decode of pre-flag-day history
// reproduces the output set the fleet wrote live, byte for byte.
//
// Fails CLOSED twice over, since either failure mode would widen the persisted output set
// on a chain whose fleet has not armed the change (a fork):
//   * an unrecognized network name reads as "legacy top-level-only capture", not "no gate";
//   * a null (DISARMED) entry means the network's maintainers have not ratified an instant
//     yet, and stays inactive at every block time rather than defaulting to genesis-on.
//
// Comparison is `blockTime >= activation`, the same >= semantics the indexer's
// protocol_changes gates use.
function isBatchSubCommandCaptureActive(consensusNetwork, blockTime){
    const activation = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const t = Number(blockTime)
    if (!Number.isFinite(t)) return false
    return t >= activation
}

// The sub-commands of a BATCH action string, or null when the string is not a BATCH at all.
// An empty array means "a BATCH, but one whose sub-commands never execute".
//
// EQUIVALENCE WITH THE INDEXER (xchain-indexer/src/actions/batch.js run()):
//
//   let commands = String(data['TX_DATA']).split(';');
//   commands[0] = commands[0].replace('BATCH|' + format + '|','');
//
// where `format` is util.getFormatVersion of the token after 'BATCH|'. Three facts make
// the head-prefix test below identical to that pair for every string whose sub-commands
// actually run:
//
//   1. Only a REGISTERED format survives. `this.formats[format] === undefined` sets
//      'invalid: VERSION (unknown)' and the sub-command loop is skipped entirely.
//   2. The strip is a literal `'BATCH|' + format + '|'` replace, so it can only fire on a
//      head whose FORMAT token reads exactly as the derived integer. A token that derives
//      to 0 by another spelling ('', '"0"', ' 0 ', '00') leaves the head intact.
//   3. When the head is NOT stripped, element 0's action name is still BATCH, and
//      actionLimits['BATCH'] is 0, so the scan sets 'invalid: BATCH (limit)' and again no
//      sub-command runs. (This also covers the case where the replace fires on a LATER
//      'BATCH|0|' occurrence inside element 0: the head survives, so the action is BATCH.)
//
// So sub-commands execute if and only if the string literally begins 'BATCH|<F>|' for a
// registered F, and then the command list is the remainder split on ';'. The prefix holds
// no ';', so slicing before the split gives the identical array the indexer builds.
//
// Empty elements are KEPT, matching the indexer's raw ';'-split list (a trailing ';'
// yields a trailing empty command there, which its activation scan whole-batch rejects).
// They carry no action prefix, so they select no capture; keeping them costs nothing and
// keeps the two lists index-for-index comparable.
function batchSubCommands(decodedData){
    if (typeof decodedData !== 'string' || !decodedData.startsWith('BATCH|'))
        return null
    for (const format of BATCH_SUB_COMMAND_FORMATS){
        const prefix = 'BATCH|' + format + '|'
        if (decodedData.startsWith(prefix))
            return decodedData.slice(prefix.length).split(';')
    }
    return []
}

// The list of action strings the output-capture decision should be taken over.
//
// Below the gate, and for every transaction that is not a BATCH, this is exactly
// `[decodedData]`, so `commands.some(c => c.startsWith('COINPAY|'))` reduces to the
// `decodedData.startsWith('COINPAY|')` test it replaces and capture is byte-identical to
// the legacy behaviour. Above the gate a BATCH yields its sub-commands INSTEAD of itself:
// the BATCH string can never carry a capture-selecting prefix of its own, so dropping it
// changes nothing and keeps the list to things that are actually dispatched.
function captureCommands(decodedData, consensusNetwork, blockTime){
    if (!isBatchSubCommandCaptureActive(consensusNetwork, blockTime))
        return [decodedData]
    const subCommands = batchSubCommands(decodedData)
    return (subCommands === null) ? [decodedData] : subCommands
}

// Collapse the v0 DISPENSER creates of ONE transaction to at most one registration per
// OPERATING ADDRESS, keeping the LATEST expiration and the first oracle address named.
// Input order is sub-command position order; output order is first-appearance order.
//
// WHY IT EXISTS. The decoder's registry is keyed PRIMARY KEY(tx_index, address_id) (see
// src/sql/dispensers.sql). A transaction could only ever carry ONE create before this
// change, so that key was unique by construction. A BATCH can carry several, and every
// create that omits GET_ADDRESS operates on the transaction SOURCE, so
// `DISPENSER|0|...;DISPENSER|0|...` is two rows with one key. The second INSERT raises
// errno 1062, insertDispenser reports DUPLICATED_TRANSACTION, and the block loop reads
// that as "already stored" - leaving the row holding the FIRST create's expiration. When
// that is the EARLIER of the two, the decoder soft-expires the address while the indexer
// still holds the second dispenser open, stops capturing payments to it, and real
// dispenses are lost. That is the under-capture direction db.js (above
// extendOpenDispenserExpirationBySource) calls money-bearing.
//
// So the collapse is deliberate, not incidental: taking the MAX expiration keeps the
// address open until the last of the batch's dispensers closes, which is the
// hold-open-LONGER direction the advisory contract permits. The first NON-EMPTY oracle
// wins for the same reason: an address recorded is an oracle-fee output capturable.
//
// A transaction with one create (every non-BATCH transaction, and every transaction below
// the gate) returns that create unchanged, so this is a no-op on the legacy path.
//
// RESIDUAL, stated rather than hidden: dispensers.oracle_address_id is ONE column, so a
// batch opening two Mode B dispensers on the SAME operating address naming DIFFERENT
// oracles records only the first, and a later v2 refill of the second (which resolves its
// oracle from these rows, by SOURCE) captures no oracle-fee output. Recording both needs a
// per-sub-command discriminator in the dispensers PRIMARY KEY - a schema migration on
// every decoder in the fleet, mainnet included, where this gate is DISARMED - which is a
// wider blast radius than the hole it would close. Registering ONE of the two is strictly
// better than today, where a batch registers NEITHER.
function collapseDispenserRegistrations(candidates){
    const collapsed = new Map()
    if (!Array.isArray(candidates)) return []
    for (const candidate of candidates){
        if (!candidate || !candidate.address) continue
        const existing = collapsed.get(candidate.address)
        if (existing === undefined){
            collapsed.set(candidate.address, {
                address:       candidate.address,
                sourceAddress: candidate.sourceAddress,
                oracleAddress: candidate.oracleAddress || null,
                expiration:    candidate.expiration,
            })
            continue
        }
        if (candidate.expiration > existing.expiration)
            existing.expiration = candidate.expiration
        if (!existing.oracleAddress && candidate.oracleAddress)
            existing.oracleAddress = candidate.oracleAddress
    }
    return [...collapsed.values()]
}

module.exports = {
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
    BATCH_SUB_COMMAND_FORMATS,
    isBatchSubCommandCaptureActive,
    batchSubCommands,
    captureCommands,
    collapseDispenserRegistrations,
}
