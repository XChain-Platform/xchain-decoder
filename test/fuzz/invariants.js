/**
 * Property-based invariant checks for fuzz testing.
 * Every fuzz harness uses these to verify results are well-formed.
 */

const assert = require('assert')

/**
 * Verify parseTransaction result satisfies all invariants.
 * Returns an object { ok, violations } where violations is an array of strings.
 */
function checkParseTransactionResult(result, input) {
    const violations = []

    // parseTransaction may return null (for coinbase/non-standard) — that's valid
    if (result === null) return { ok: true, violations: [] }

    // Must be an object
    if (typeof result !== 'object') {
        violations.push(`Result is ${typeof result}, expected object or null`)
        return { ok: false, violations }
    }

    // Required keys
    const requiredKeys = ['data', 'rawData', 'source', 'destination', 'dispenseOutputs']
    for (const key of requiredKeys) {
        if (!(key in result)) {
            violations.push(`Missing required key: ${key}`)
        }
    }

    // data must be a Buffer
    if ('data' in result && !Buffer.isBuffer(result.data)) {
        violations.push(`result.data is ${typeof result.data}, expected Buffer`)
    }

    // rawData must be a Buffer or null
    if ('rawData' in result && result.rawData !== null && !Buffer.isBuffer(result.rawData)) {
        violations.push(`result.rawData is ${typeof result.rawData}, expected Buffer or null`)
    }

    // source must be a string or null
    if ('source' in result && result.source !== null && typeof result.source !== 'string') {
        violations.push(`result.source is ${typeof result.source}, expected string or null`)
    }

    // destination must be null (current protocol)
    if ('destination' in result && result.destination !== null) {
        violations.push(`result.destination is ${result.destination}, expected null`)
    }

    // dispenseOutputs must be an array
    if ('dispenseOutputs' in result && !Array.isArray(result.dispenseOutputs)) {
        violations.push(`result.dispenseOutputs is ${typeof result.dispenseOutputs}, expected Array`)
    }

    // Each dispense output must have required fields
    if (Array.isArray(result.dispenseOutputs)) {
        for (let i = 0; i < result.dispenseOutputs.length; i++) {
            const o = result.dispenseOutputs[i]
            if (!o.destinationAddress) violations.push(`dispenseOutputs[${i}] missing destinationAddress`)
            if (typeof o.vout !== 'number') violations.push(`dispenseOutputs[${i}].vout is ${typeof o.vout}, expected number`)
        }
    }

    return { ok: violations.length === 0, violations }
}

/**
 * Verify removeObfuscation result satisfies all invariants.
 */
function checkRemoveObfuscationResult(result, inputData, inputTxid) {
    const violations = []

    // Must be a Buffer or null
    if (result !== null && !Buffer.isBuffer(result)) {
        violations.push(`Result is ${typeof result}, expected Buffer or null`)
    }

    return { ok: violations.length === 0, violations }
}

/**
 * Verify blockFromBuffer/blockFromHex result satisfies all invariants.
 */
function checkBlockResult(result) {
    const violations = []

    if (typeof result !== 'object' || result === null) {
        violations.push(`Result is ${result}, expected Block object`)
        return { ok: false, violations }
    }

    if (typeof result.version !== 'number') {
        violations.push(`block.version is ${typeof result.version}, expected number`)
    }

    if (!Buffer.isBuffer(result.prevHash) && !(result.prevHash instanceof Uint8Array)) {
        violations.push(`block.prevHash is ${typeof result.prevHash}, expected Buffer`)
    }

    if (typeof result.timestamp !== 'number') {
        violations.push(`block.timestamp is ${typeof result.timestamp}, expected number`)
    }

    if (result.transactions && !Array.isArray(result.transactions)) {
        violations.push(`block.transactions is ${typeof result.transactions}, expected Array`)
    }

    return { ok: violations.length === 0, violations }
}

/**
 * Verify a DISPENSER parse does not produce invalid field accesses.
 * This checks the inline parsing logic from XChainDecoder.start().
 */
function checkDispenserParse(decodedData) {
    const violations = []

    if (!decodedData.startsWith('DISPENSER')) {
        return { ok: true, violations: [] }
    }

    const parts = decodedData.split('|')

    // The decoder requires length >= 13 and version == 0
    if (parts.length < 13) {
        // Decoder should skip this — no violation
        return { ok: true, violations: [] }
    }

    const version = parseInt(parts[1])
    if (version !== 0) {
        return { ok: true, violations: [] }
    }

    // If we get here, the decoder would process it — check field access safety
    if (parts[2] === undefined) violations.push('giveCoin (parts[2]) is undefined')
    if (parts[6] === undefined) violations.push('getCoin (parts[6]) is undefined')
    if (parts[9] === undefined) violations.push('getAddress (parts[9]) is undefined')
    if (parts[12] === undefined) violations.push('expiration (parts[12]) is undefined')

    return { ok: violations.length === 0, violations }
}

/**
 * Assert that a function completes within a timeout (detect infinite loops).
 */
function withTimeout(fn, ms) {
    ms = ms || 5000
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout: function did not complete within ${ms}ms`))
        }, ms)

        Promise.resolve(fn()).then(result => {
            clearTimeout(timer)
            resolve(result)
        }).catch(err => {
            clearTimeout(timer)
            reject(err)
        })
    })
}

module.exports = {
    checkParseTransactionResult,
    checkRemoveObfuscationResult,
    checkBlockResult,
    checkDispenserParse,
    withTimeout
}
