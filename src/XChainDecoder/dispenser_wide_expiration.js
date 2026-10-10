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

const {
    DISPENSER_WIDE_EXPIRATION_ACTIVATION,
    EXACT_INTEGER_EXPIRATION_ACTIVATION,
} = require('../protocol/constants.js')

const MAX_SAFE_DISPENSER_EXPIRATION = Number.MAX_SAFE_INTEGER
const U64_MAX = 18446744073709551615n

function isDispenserWideExpirationActive(consensusNetwork, blockTime){
    const activation = DISPENSER_WIDE_EXPIRATION_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const time = Number(blockTime)
    return Number.isFinite(time) && time >= activation
}

function isExactIntegerExpirationActive(consensusNetwork, blockTime){
    const activation = EXACT_INTEGER_EXPIRATION_ACTIVATION[consensusNetwork]
    return typeof activation === 'number' && Number.isFinite(Number(blockTime)) && Number(blockTime) >= activation
}

function isExactIntegerToken(value){
    const match = String(value).trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/)
    if (!match) return false
    const fraction = match[3] || match[4] || ''
    const digits = (match[2] || '') + fraction
    const exponent = Number(match[5] || 0)
    if (!Number.isSafeInteger(exponent)) return false
    const fractionalDigits = fraction.length - exponent
    if (fractionalDigits <= 0) return true
    if (fractionalDigits >= digits.length) return /^0*$/.test(digits)
    return /^0*$/.test(digits.slice(digits.length - fractionalDigits))
}

function hasValidExpirationToken(expirationToken, expiration, consensusNetwork, blockTime){
    if (!Number.isSafeInteger(expiration) || expiration < 0) return false
    if (expirationToken === undefined || expirationToken === '') return true
    return !isExactIntegerExpirationActive(consensusNetwork, blockTime) || isExactIntegerToken(expirationToken)
}

function exactUnsignedDecimal(raw){
    const token = typeof raw === 'string' ? raw.trim() : String(raw)
    const match = token.match(/^\+?([0-9]+)(?:\.([0-9]*))?(?:e([+-]?[0-9]+))?$/i)
    if (!match) return null

    const fraction = match[2] || ''
    const exponentToken = match[3] || '0'
    if (exponentToken.replace(/^[+-]?0*/, '').length > 6) return null
    const exponent = Number(exponentToken)
    let digits = match[1] + fraction
    const fractionalPlaces = fraction.length - exponent

    if (fractionalPlaces > 0){
        if (fractionalPlaces >= digits.length) return /^0+$/.test(digits) ? 0n : null
        if (!/^0+$/.test(digits.slice(-fractionalPlaces))) return null
        digits = digits.slice(0, -fractionalPlaces)
    } else if (fractionalPlaces < 0){
        const zeroCount = -fractionalPlaces
        if (!/^0+$/.test(digits) && digits.replace(/^0+/, '').length + zeroCount > 20)
            return null
        digits += '0'.repeat(zeroCount)
    }

    return BigInt(digits || '0')
}

// The decoder's dispenser set is advisory and may safely remain open longer
// than the indexer's authoritative row. A u64 expiration above the exact Number
// range is therefore represented by the largest exact Number, never by a rounded
// conversion of the wire token. Both values are far beyond the Unix timestamps
// this decoder can process, so neither side can expire first in reachable history.
function normalizeDispenserExpiration(raw, consensusNetwork, blockTime, asNumber = Number(raw)){
    if (raw === null || raw === undefined) return null
    if (typeof raw === 'string' && raw.trim() === '') return null
    if (Number.isSafeInteger(asNumber) && asNumber >= 0)
        return asNumber

    if (!isDispenserWideExpirationActive(consensusNetwork, blockTime))
        return null

    const exact = exactUnsignedDecimal(raw)
    if (exact === null) return null
    if (exact <= BigInt(MAX_SAFE_DISPENSER_EXPIRATION) || exact > U64_MAX)
        return null
    return MAX_SAFE_DISPENSER_EXPIRATION
}

module.exports = {
    DISPENSER_WIDE_EXPIRATION_ACTIVATION,
    MAX_SAFE_DISPENSER_EXPIRATION,
    U64_MAX,
    hasValidExpirationToken,
    isDispenserWideExpirationActive,
    isExactIntegerExpirationActive,
    isExactIntegerToken,
    normalizeDispenserExpiration,
}
