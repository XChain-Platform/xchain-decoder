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

// BATCH formats eligible for sub-command capture; conformance tests pin this
// list to the indexer's registered formats.
const BATCH_SUB_COMMAND_FORMATS = [0]

// Enable sub-command capture at or after a numeric network activation.
// Unknown networks, disarmed entries, and invalid block times fail closed.
function isBatchSubCommandCaptureActive(consensusNetwork, blockTime){
    const activation = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const t = Number(blockTime)
    if (!Number.isFinite(t)) return false
    return t >= activation
}

// Split a registered BATCH into sub-commands, preserving empty elements.
// Return null for non-BATCH input and [] for an unregistered format.
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

// Read the action name before the first delimiter, matching the indexer's
// per-command scans. Non-string commands have no action name.
function subCommandActionName(command){
    if (typeof command !== 'string') return null
    const pipeIndex = command.indexOf('|')
    return (pipeIndex === -1) ? command : command.slice(0, pipeIndex)
}

// An empty action name is the only decoder-local admission failure that is
// safe to treat as a whole-batch rejection without a stale action allowlist.
function hasProvablyRejectedSubCommand(subCommands){
    return subCommands.some(command => subCommandActionName(command) === '')
}

// Expand only a sub-command's action-name alias, leaving parameters unchanged.
// Own-property and string checks keep untrusted names out of the alias prototype.
function expandSubCommandAlias(command, aliases){
    const actionName = subCommandActionName(command)
    if (actionName === null || actionName === '') return command
    const canonical = expandAliasName(actionName, aliases)
    if (canonical === actionName) return command
    return canonical + command.slice(actionName.length)
}

// Return a usable own alias value, or the original action name.
function expandAliasName(actionName, aliases){
    if (typeof actionName !== 'string' || actionName === '') return actionName
    if (!Object.prototype.hasOwnProperty.call(aliases, actionName)) return actionName
    const canonical = aliases[actionName]
    if (typeof canonical !== 'string' || canonical.length === 0) return actionName
    return canonical
}

// The remaining limit helpers mirror only rejection cases the decoder can prove.
// Capture activation must not precede the indexer's issuance-limit rules.

// The indexer's `util.isNumeric`, mirrored verbatim, because isLegacyActionFormat below
// branches on it and a divergence here moves a TICK by one position.
function isNumeric(value){
    return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value))
}

// Mirror the indexer's legacy-format test, which controls VERSION 0 injection
// before ISSUE, MINT, and SEND ticker extraction.
function isLegacyActionFormat(params){
    const version = params[0]
    if (String(version).length > 2) return true
    if (typeof version === 'string' && !isNumeric(version)) return true
    return false
}

// Read the normalized ISSUE, MINT, or SEND ticker at params[1].
// Return '' on missing or malformed input; capture runs after normalization.
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

// Classify per-action limits after alias and legacy normalization.
// Only a dotted, non-caret ISSUE ticker uses the child-issuance bucket;
// missing or caret tickers remain top-level ISSUEs.
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

// Count the largest group of identical literal MINT tickers, a lower bound on
// resolved-ticker grouping. Map safely accepts untrusted ticker strings.
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
    isLegacyActionFormat,
    subCommandTick,
    subCommandLimitKey,
    maxIdenticalMintTicks,
}
