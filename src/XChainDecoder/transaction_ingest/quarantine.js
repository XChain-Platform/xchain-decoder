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
 * XChain Decoder - Transaction Quarantine State
 *
 ********************************************************************/

const { TX_PARSE_MAX_RETRIES } = require('../constants.js')

// Key retry and quarantine state by exact block and transaction position.
function quarantineKey(nextBlockHeight, nextBlockHash, txIndex){
    return nextBlockHeight + ':' + nextBlockHash + ':' + txIndex
}

// Record one more failed attempt for this key and return the running total.
function countAttempt(attempts, key){
    const attempt = (attempts.get(key) || 0) + 1
    attempts.set(key, attempt)
    return attempt
}

// Tell the stall verdict that the quarantine ladder took a real step.
function noteLadderStep(decoder, attempt){
    if (attempt <= TX_PARSE_MAX_RETRIES + 1) decoder.lastLadderStepAt = Date.now()
}

// Drop retry counts and quarantined positions after their block commits.
function clearQuarantineState(loop){
    loop.txParseRetryCounts.clear()
    loop.insertQuarantineCounts.clear()
    loop.insertQuarantine.clear()
    if (loop.insertQuarantineCounted) loop.insertQuarantineCounted.clear()
    if (loop.parseQuarantine) loop.parseQuarantine.clear()
}

// Count a transaction this decoder skipped for good.
function noteQuarantine(decoder, height, hash){
    decoder.quarantinedTxs = (decoder.quarantinedTxs || 0) + 1
    decoder.lastQuarantinedBlock = height
    decoder.lastQuarantinedTxHash = hash || null
    decoder.lastQuarantinedAt = new Date().toISOString()
}

module.exports = { quarantineKey, countAttempt, noteLadderStep, clearQuarantineState, noteQuarantine }
