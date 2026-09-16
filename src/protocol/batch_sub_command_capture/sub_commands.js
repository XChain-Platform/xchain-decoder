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
 **********************************************************************/

'use strict';

const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION } = require('../constants.js')
const { CHILD_ISSUE_KEY } = require('../indexer_batch_limits.js')

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
// Empty elements are KEPT, matching the indexer's raw ';'-split list, and keeping them is
// LOAD-BEARING rather than merely tidy. A trailing ';' yields a trailing empty command
// there, whose action name is '' and which its activation scan whole-batch rejects, so no
// sub-command in that batch runs at all. An earlier note here read "they carry no action
// prefix, so they select no capture; keeping them costs nothing" - true of the empty
// element itself and false of the batch containing it, which is the whole point of
// hasProvablyRejectedSubCommand below. Keeping them also keeps the two lists
// index-for-index comparable.
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

// The ACTION NAME of a sub-command: every character before the first '|', or the whole
// string when it carries none. Byte-for-byte the indexer's own
// `String(command).split('|')[0]`, which is the token BOTH of its per-command scans key on
// (the activation scan and the per-ACTION limit tally). Kept as one function so the two
// readers below cannot drift into two ideas of where a name ends.
function subCommandActionName(command){
    if (typeof command !== 'string') return null
    const pipeIndex = command.indexOf('|')
    return (pipeIndex === -1) ? command : command.slice(0, pipeIndex)
}

// Does this BATCH carry a sub-command whose ACTION NAME the indexer's activation scan
// PROVABLY rejects, taking the whole batch down with it?
//
// WHY CAPTURE HAS TO CARE. batch.js runs, before any dispatch:
//
//     for(let command of commands){
//         let action = String(command).split('|')[0];
//         if(normalize) action = this.normalizeSubAction(action);
//         if(!error && await this.protocolChanges.isEnabled(action, ...) == false)
//             error = 'invalid: ACTION (unknown)';
//     }
//
// and `isEnabled` returns FALSE for any name absent from its registry. One rejected name
// invalidates the WHOLE batch as a single record, so NO sub-command runs - not even the
// well-formed ones beside it. Capture that keeps reading those siblings persists outputs
// for actions the indexer never executes: the same over-capture the DISPENSER prefix
// tightening closes, reached through a sibling command instead of through the DISPENSER
// command's own name. `BATCH|0|DISPENSER|0|...;` (one trailing semicolon) registers a
// dispenser here and none there, and payments to that address are then read as dispenses
// no indexer will ever settle.
//
// WHY ONLY THE EMPTY NAME, when the scan rejects far more than that. Suppression is the
// UNDER-capture direction, the money-bearing one: refuse capture for a batch the indexer
// actually runs and a real settlement output is never persisted. So this may only fire on
// names it can PROVE are unregistered, and the decoder holds no copy of that registry.
// Measured against the sibling indexer at this commit, 53 names are enabled there and
// absent from VALID_ACTION_NAMES here (DISPENSE, XCALL, ORDER_MATCH and every non-action
// feature-gate flag: UNIFIED_FEES, ISSUANCE_FEE, FIX_OUTPUT_FANOUT, ...), so a gate keyed
// on the decoder's own known-name set would suppress capture for batches the indexer
// dispatches normally. The EMPTY name is different in kind rather than in degree: '' is
// not an ACTION and not a feature-gate flag, no addChange can name it, and it is the one
// verdict this file can reach on its own evidence.
//
// The rest of the class is now closed as far as it is provable, in hasProvablyRejectedBatch
// below: the nested BATCH, the per-ACTION caps, the 250-command cap and the
// BATCH_COST_WEIGHTING weight budget, against the indexer's tables vendored canonically in
// src/protocol/indexerBatchLimits.js. The UNKNOWN NAME is still the one cause left open, and
// deliberately, for the reason this paragraph gives: a vendored name LIST is not closed under
// registry growth, so a stale one under-captures.
//
// A '' name is reachable two ways and both are covered, because both are what
// `split('|')[0]` yields: an EMPTY element (a trailing ';', a ';;', or the whole command
// list being empty) and an element that leads with the delimiter (`|0|x`).
function hasProvablyRejectedSubCommand(subCommands){
    return subCommands.some(command => subCommandActionName(command) === '')
}

// Expand a short-form ACTION alias on a sub-command, mirroring the alias half of the
// indexer's `batch.js normalizeSubAction`. Only the NAME is rewritten; every character
// from the first '|' onward is returned verbatim.
//
// The VERSION-0 injection normalizeSubAction also performs is deliberately NOT mirrored:
// it applies to ISSUE/MINT/SEND only, it edits PARAMS rather than the name, and no capture
// decision in this decoder reads either - so mirroring it would move nothing and would
// couple this file to a second cross-repo rule for no gain.
//
// `aliases` is passed in rather than closed over so a test can drive a synthetic table:
// with the real one this expansion is a no-op for capture, because no alias resolves to
// COINPAY or DISPENSER, and a check nothing can exercise is not a check.
//
// TWO guards, each load-bearing on a case the other does not reach, which is why both
// stay: hasOwnProperty because these names are untrusted wire bytes and a sub-command
// spelled `constructor|0|x` would otherwise read a member off the table's PROTOTYPE, and
// the string check because a table entry of any other type would splice a number, an
// object or nothing onto the head of a command the capture sites then prefix-match.
// Against the REAL table both are unreachable (it is an object literal of five string
// values, pinned to the canonical manifest), and the indexer's `for...in` walk is
// equivalent on it for the same reason - an object literal's inherited members are not
// enumerable. They are stated rather than assumed because this function also takes tables
// its caller does not own.
function expandSubCommandAlias(command, aliases){
    const actionName = subCommandActionName(command)
    if (actionName === null || actionName === '') return command
    const canonical = expandAliasName(actionName, aliases)
    if (canonical === actionName) return command
    return canonical + command.slice(actionName.length)
}

// The alias rewrite on the NAME alone, split out of expandSubCommandAlias because the
// whole-batch rejection scan below needs the canonical name without rebuilding the command
// string. Returns `actionName` unchanged when the table holds no usable entry; both guards
// are the ones documented on expandSubCommandAlias and are the reason this is one function
// rather than two copies of the lookup.
function expandAliasName(actionName, aliases){
    if (typeof actionName !== 'string' || actionName === '') return actionName
    if (!Object.prototype.hasOwnProperty.call(aliases, actionName)) return actionName
    const canonical = aliases[actionName]
    if (typeof canonical !== 'string' || canonical.length === 0) return actionName
    return canonical
}

// ---------------------------------------------------------------------------------------
// THE REST OF THE WHOLE-BATCH REJECTION CLASS.
//
// hasProvablyRejectedSubCommand above closes ONE cause (the empty ACTION name). The indexer
// rejects a BATCH as a single record - so that NOT ONE sub-command runs - for several more,
// and capture that keeps reading the siblings persists outputs for actions nothing executes:
// a dispenser registers here and nowhere else, and payments to it are then classified
// against a dispenser that never settles.
//
// WHAT IS MIRRORED, and it is deliberately a SUBSET (see hasProvablyRejectedBatch):
//   * the global 250-command cap                      -> 'invalid: COMMAND (limit)'
//   * a nested BATCH sub-command (actionLimits.BATCH=0)-> 'invalid: BATCH (limit)'
//   * more than one TOP-LEVEL (undotted) ISSUE         -> 'invalid: ISSUE (limit)'
//   * more than one DEPLOY                             -> 'invalid: DEPLOY (limit)'
//   * two MINTs naming the SAME literal TICK           -> 'invalid: MINT (limit)'
//
// WHICH FLAG STATE THESE ARE READ IN, and it is the whole difficulty. The indexer applies
// the 250 cap, the dotted-TICK ISSUE exemption and the DEPLOY cap only at/after
// BATCH_ISSUANCE_LIMITS. This module applies the POST-flag rule set UNCONDITIONALLY, and
// that is sound rather than convenient, for two separate reasons:
//
//   1. Nothing here can run below BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION, and that gate
//      is REQUIRED to sit at or after the indexer's BATCH_ISSUANCE_LIMITS instant on every
//      armed network - the LEDGER tier of batchSubCommandOutputCaptureActivation.test.js,
//      which predates this change and exists for the settlement ledger. So at every block
//      time these rules are evaluated, that flag is already on. batch_limits_vendoring.test.js
//      completes the argument by pinning the other two halves of the indexer's own gate
//      (its block-index thresholds are 0, and its registered semver is at or below the
//      indexer's compiled CONSENSUS_VERSION), so "the time has passed" really does mean
//      "the flag is active" and not merely "one of its three conditions is met".
//   2. Even if that ordering were somehow violated, the two UNGATED mirrors stay correct and
//      the two rules the SUB-SET direction protects still cannot suppress a dispatched
//      batch: below the flag the indexer's ISSUE cap is STRICTER (every dotted child counts
//      top-level) and its MINT cap is STRICTER (raw occurrences, not distinct ticks), so a
//      mirror written to the post-flag rule refuses a SUBSET of what it rejects. Only the
//      250-command cap and the DEPLOY cap genuinely need reason 1, and they are named here
//      rather than buried so the day the ordering changes, this comment is the thing to
//      re-read.
//
// THE TRAP THIS ROW EXISTS FOR: after BATCH_ISSUANCE_LIMITS arms, a batch of ONE parent plus
// MANY dotted children is VALID. A decoder that naively mirrored the pre-flag `ISSUE: 1` cap
// would suppress capture for exactly those batches - UNDER-capture, on the very feature the
// flag ships. Measured against the live BTC regtest corpus at the time of writing, 21 of 67
// real on-chain batches carry two or more ISSUE sub-commands that the exemption makes valid,
// so the naive mirror is not a theoretical regression, it is the common case.
//
// WHAT IS NOT MIRRORED, and why, is in hasProvablyRejectedBatch.
// ---------------------------------------------------------------------------------------

// The indexer's `util.isNumeric`, mirrored verbatim, because isLegacyActionFormat below
// branches on it and a divergence here moves a TICK by one position.
function isNumeric(value){
    return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value))
}

// The indexer's `util.isLegacyActionFormat`, mirrored verbatim. It decides whether
// normalizeSubAction splices an implied VERSION 0 onto an ISSUE/MINT/SEND's params, which is
// what puts TICK at params[1] for BTNS-style legacy commands. Getting this wrong reads the
// wrong field as the TICK, which for ISSUE means calling a child top-level (suppression that
// the indexer would not do: the money-bearing direction), so it is pinned against the real
// sibling helper over a vector table in batch_limits_vendoring.test.js.
function isLegacyActionFormat(params){
    const version = params[0]
    if (String(version).length > 2) return true
    if (typeof version === 'string' && !isNumeric(version)) return true
    return false
}

// The TICK a sub-command's handler will parse: params[1] in all seven ISSUE formats and in
// MINT's single format, read AFTER the implied legacy VERSION 0 is injected. Mirrors the
// indexer's `Batch.subCommandTick` (and the extraction inside `Batch.classifyLimitAction`,
// which keeps its own copy there for the same landed-consensus reason).
//
// `normalize` is not a parameter: every block time this module runs at is at/after
// BATCH_SUBACTION_NORMALIZATION, asserted by the NORMALIZATION tier of
// batchSubCommandOutputCaptureActivation.test.js, so the indexer's `normalize` is true.
// Returns '' when there is no TICK at all - never a token named the empty string.
// Never throws: a classifier crash here would take down block decoding.
function subCommandTick(action, command){
    try {
        const params = String(command).split('|').slice(1)
        if (['ISSUE','MINT','SEND'].includes(action) && isLegacyActionFormat(params))
            params.splice(0, 0, 0)
        const tick = params[1]
        if (tick === undefined || tick === null) return ''
        return String(tick).trim()
    } catch (e) {
        return ''
    }
}

// The key a sub-command is COUNTED under by the indexer's per-ACTION limit scan
// (`Batch.classifyLimitAction`). Only ISSUE is reclassified: a dotted TICK is a CHILD
// issuance and lands in the non-ACTION bucket CHILD_ISSUE_KEY, exempt from the cap of 1.
//
// A caret TICK (^<id>) is NEVER exempt - its dot is a decimal in an id reference, not a
// namespace separator - and an ISSUE with no readable TICK counts TOP-LEVEL, because
// exemption is granted on positive evidence only. Both of those are the indexer's rules, not
// choices made here; note that both push a command INTO the capped bucket, i.e. toward
// suppression, which is why the whole classifier is driven against the real sibling rather
// than argued.
function subCommandLimitKey(command, aliases){
    const rawName = subCommandActionName(command)
    if (rawName === null) return null
    const action = expandAliasName(rawName, aliases)
    if (action !== 'ISSUE') return action
    try {
        const params = String(command).split('|').slice(1)
        if (isLegacyActionFormat(params)) params.splice(0, 0, 0)
        let tick = params[1]
        if (tick === undefined || tick === null) return action
        tick = String(tick)
        if (tick.charAt(0) === '^') return action
        if (tick.includes('.')) return CHILD_ISSUE_KEY
        return action
    } catch (e) {
        return action
    }
}

// The largest number of MINT sub-commands in this batch naming the SAME LITERAL TICK.
//
// This is a strict LOWER BOUND on the indexer's `maxMintsPerDistinctTick`, which buckets by
// RESOLVED ticker id and needs a database the decoder does not have. The bound is sound in
// the only direction that matters: `getTickerId` is a function of the tick string, so two
// IDENTICAL strings always land in the same bucket there (and two empty strings share the
// unresolved bucket), hence maxIdentical <= maxDistinct and `maxIdentical > cap` implies
// `maxDistinct > cap`. The converse does not hold - `JDOG` and `^614` can be one token - so
// this mirror stays silent on exactly the cases it cannot prove, which is the safe direction.
// A Map, not an object literal: these are untrusted wire strings and `__proto__` or
// `constructor` would read as an already-present entry on an object.
function maxIdenticalMintTicks(ticks){
    const counts = new Map()
    let max = 0
    for (const tick of ticks){
        const count = (counts.get(tick) || 0) + 1
        counts.set(tick, count)
        if (count > max) max = count
    }
    return max
}

module.exports = {
    BATCH_SUB_COMMAND_FORMATS,
    isBatchSubCommandCaptureActive,
    batchSubCommands,
    subCommandActionName,
    hasProvablyRejectedSubCommand,
    expandSubCommandAlias,
    expandAliasName,
    isNumeric,
    isLegacyActionFormat,
    subCommandTick,
    subCommandLimitKey,
    maxIdenticalMintTicks,
}
