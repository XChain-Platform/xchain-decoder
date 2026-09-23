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
 * This module holds the pure decisions capture needs to see through a BATCH: the gate, the
 * sub-command split, and the WHOLE-BATCH REJECTION mirror (hasProvablyRejectedBatch) that
 * stops capture reading a batch's siblings when the indexer throws the whole record out. The
 * split MUST agree with the indexer's, because a decoder
 * that disagrees about what the sub-commands ARE captures for actions the indexer never
 * runs (or misses ones it does) - a worse fault than the one being fixed. See
 * batchSubCommands in batch_sub_command_capture/sub_commands.js for the equivalence argument
 * against xchain-indexer/src/actions/batch/validate.js readCommands.
 *
 ********************************************************************/

'use strict';

const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION } = require('./constants.js')
const ACTION_ALIASES = require('./action_aliases.js')
const { COMMAND_LIMIT,
        ACTION_LIMITS,
        GATED_ACTION_LIMITS,
        CHILD_ISSUE_KEY,
        WEIGHT_BUDGET,
        COMMAND_WEIGHTS,
        COST_WEIGHTING_ACTIVATION } = require('./indexer_batch_limits.js')

const { BATCH_SUB_COMMAND_FORMATS,
        isBatchSubCommandCaptureActive,
        batchSubCommands,
        subCommandActionName,
        hasProvablyRejectedSubCommand,
        expandSubCommandAlias,
        isLegacyActionFormat,
        subCommandTick,
        subCommandLimitKey,
        maxIdenticalMintTicks } = require('./batch_sub_command_capture/sub_commands.js')
const { hasProvablyRejectedBatch,
        isBatchCostWeightingActive,
        subCommandCostWeight,
        batchCostWeight } = require('./batch_sub_command_capture/batch_cost.js')

// The list of action strings the output-capture decision should be taken over.
//
// Below the gate, and for every transaction that is not a BATCH, this is exactly
// `[decodedData]`, so `commands.some(c => c.startsWith('COINPAY|'))` reduces to the
// `decodedData.startsWith('COINPAY|')` test it replaces and capture is byte-identical to
// the legacy behaviour. Above the gate a BATCH yields its sub-commands INSTEAD of itself:
// the BATCH string can never carry a capture-selecting prefix of its own, so dropping it
// changes nothing and keeps the list to things that are actually dispatched.
//
// Two things happen to that sub-command list, and NEITHER can run below the gate, which is
// what makes this whole file inert for pre-flag-day history:
//
//   1. A batch the indexer PROVABLY rejects as a whole yields the EMPTY list, because it
//      runs none of its commands (see hasProvablyRejectedBatch, which covers the empty
//      ACTION name, the 250-command cap and the per-ACTION caps).
//   2. Sub-command ACTION names are alias-expanded, because that is the name the indexer
//      DISPATCHES on. Un-expanded, a batched alias reaches capture in its wire spelling
//      while the indexer runs its canonical one, and the day an alias resolves to COINPAY
//      or DISPENSER that gap becomes a missed settlement output - the money-bearing
//      direction. Nothing moves today (no alias resolves to either), which is precisely
//      when a consensus-affecting rule is cheap to state.
//
// Step 2 assumes the indexer has ALREADY normalized sub-actions wherever this gate is
// live, i.e. that on every armed network BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION is at
// or after BATCH_SUBACTION_NORMALIZATION. Below THAT flag an aliased sub-command is an
// unregistered name and whole-batch-rejects instead of dispatching, so expanding it there
// would over-capture. The ordering holds today (testnet/regtest genesis-on for both,
// mainnet normalization at 2026-08-07, below this gate's 2026-08-16 instant) and
// batch_sub_command_output_capture_activation.test.js drives it against the sibling indexer
// rather than leaving it as a comment.
function captureCommands(decodedData, consensusNetwork, blockTime){
    if (!isBatchSubCommandCaptureActive(consensusNetwork, blockTime))
        return [decodedData]
    const subCommands = batchSubCommands(decodedData)
    if (subCommands === null) return [decodedData]
    if (hasProvablyRejectedBatch(subCommands, ACTION_ALIASES, consensusNetwork, blockTime)) return []
    return subCommands.map(command => expandSubCommandAlias(command, ACTION_ALIASES))
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
    subCommandActionName,
    hasProvablyRejectedSubCommand,
    hasProvablyRejectedBatch,
    isBatchCostWeightingActive,
    subCommandCostWeight,
    batchCostWeight,
    expandSubCommandAlias,
    isLegacyActionFormat,
    subCommandTick,
    subCommandLimitKey,
    maxIdenticalMintTicks,
    captureCommands,
    collapseDispenserRegistrations,
    COMMAND_LIMIT,
    ACTION_LIMITS,
    GATED_ACTION_LIMITS,
    CHILD_ISSUE_KEY,
    WEIGHT_BUDGET,
    COMMAND_WEIGHTS,
    COST_WEIGHTING_ACTIVATION,
}
