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
 * Fuzz harness for XChainDecoder#removeObfuscation()
 *
 * Targets: AES-128-CTR decryption, key/IV derivation from txid,
 * non-Buffer type handling, boundary-length inputs.
 */

const assert = require('assert')
const crypto = require('crypto')
const XChainDecoder = require('../../../src/XChainDecoder')
const { flipBits } = require('../mutators/bitFlip')
const { mutateRandom, truncate, extend } = require('../mutators/byteManipulate')
const { encrypt, randomTxid } = require('../mutators/structureAware')
const { checkRemoveObfuscationResult, withTimeout } = require('../invariants')
const FuzzReporter = require('../reporter')
const fixtures = require('../../fixtures/crypto.json')

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS) || 5000

function createDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
}

describe('Fuzz: removeObfuscation', function () {
    this.timeout(120000)
    let decoder
    let reporter

    before(() => {
        reporter = new FuzzReporter('removeObfuscation')
    })

    beforeEach(() => {
        decoder = createDecoder()
    })

    after(() => {
        reporter.printSummary()
        const s = reporter.getSummary()
        assert.strictEqual(s.crashes, 0, `${s.crashes} crashes found; check test/fuzz/crashes/removeObfuscation/`)
        assert.strictEqual(s.invariantViolations, 0, `${s.invariantViolations} invariant violations found`)
        assert.strictEqual(s.timeouts, 0, `${s.timeouts} timeouts found`)
    })

    // --- Hypothesis H1: Short txid strings ---
    describe('H1: short/malformed txid', () => {
        const shortTxids = [
            '', 'a', 'ab', 'abc',
            '0'.repeat(8), '0'.repeat(16), '0'.repeat(31), '0'.repeat(32),
            '0'.repeat(33), '0'.repeat(64), '0'.repeat(128),
            'zzzzzzzzzzzzzzzz', // non-hex
            null, undefined
        ]

        for (const txid of shortTxids) {
            it(`should not crash with txid=${JSON.stringify(txid)}`, async () => {
                const data = Buffer.from(fixtures.xchnPayload.cipher, 'hex')
                try {
                    const result = await withTimeout(() => decoder.removeObfuscation(data, txid), 5000)
                    const check = checkRemoveObfuscationResult(result, data, txid)
                    if (!check.ok) {
                        reporter.recordInvariantViolation({ data: data.toString('hex'), txid }, check.violations, 'short_txid')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ data: data.toString('hex'), txid }, 'short_txid')
                    } else {
                        reporter.recordCrash({ data: data.toString('hex'), txid }, err, 'short_txid')
                    }
                    // Don't re-throw; we want to continue fuzzing and report at the end
                }
            })
        }
    })

    // --- Random data with valid txid ---
    describe('random data, valid txid', () => {
        it(`should handle ${ITERATIONS} random buffers`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const size = crypto.randomInt(256)
                const data = crypto.randomBytes(size)
                try {
                    const result = await withTimeout(() => decoder.removeObfuscation(data, fixtures.txid), 5000)
                    const check = checkRemoveObfuscationResult(result, data, fixtures.txid)
                    if (!check.ok) {
                        reporter.recordInvariantViolation({ data: data.toString('hex'), txid: fixtures.txid }, check.violations, 'random_data')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ data: data.toString('hex'), txid: fixtures.txid }, 'random_data')
                    } else {
                        reporter.recordCrash({ data: data.toString('hex'), txid: fixtures.txid }, err, 'random_data')
                    }
                }
            }
        })
    })

    // --- Mutated known-good payloads ---
    describe('mutated known-good payloads', () => {
        it(`should handle ${ITERATIONS} bit-flipped payloads`, async () => {
            const seed = Buffer.from(fixtures.xchnPayload.cipher, 'hex')
            for (let i = 0; i < ITERATIONS; i++) {
                const mutated = flipBits(seed, 4)
                try {
                    const result = await withTimeout(() => decoder.removeObfuscation(mutated, fixtures.txid), 5000)
                    const check = checkRemoveObfuscationResult(result, mutated, fixtures.txid)
                    if (!check.ok) {
                        reporter.recordInvariantViolation({ data: mutated.toString('hex'), txid: fixtures.txid }, check.violations, 'bit_flip')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ data: mutated.toString('hex'), txid: fixtures.txid }, 'bit_flip')
                    } else {
                        reporter.recordCrash({ data: mutated.toString('hex'), txid: fixtures.txid }, err, 'bit_flip')
                    }
                }
            }
        })
    })

    // --- Random txid + random data ---
    describe('random txid + random data', () => {
        it(`should handle ${ITERATIONS} fully random inputs`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const size = crypto.randomInt(512)
                const data = crypto.randomBytes(size)
                const txid = randomTxid()
                try {
                    const result = await withTimeout(() => decoder.removeObfuscation(data, txid), 5000)
                    const check = checkRemoveObfuscationResult(result, data, txid)
                    if (!check.ok) {
                        reporter.recordInvariantViolation({ data: data.toString('hex'), txid }, check.violations, 'random_all')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ data: data.toString('hex'), txid }, 'random_all')
                    } else {
                        reporter.recordCrash({ data: data.toString('hex'), txid }, err, 'random_all')
                    }
                }
            }
        })
    })

    // --- Non-Buffer types ---
    describe('non-Buffer types', () => {
        const nonBufferInputs = [
            null, undefined, 0, 1, -1, NaN, Infinity, -Infinity,
            true, false, '', 'hello', '0'.repeat(100),
            {}, [], { length: 10 }, [1, 2, 3],
            new Uint8Array(10), new Uint8Array(0),
            Symbol('test'), () => {}, BigInt(42)
        ]

        for (const input of nonBufferInputs) {
            const label = typeof input === 'symbol' ? 'Symbol' :
                          typeof input === 'function' ? 'function' :
                          typeof input === 'bigint' ? `BigInt(${input})` :
                          JSON.stringify(input)
            it(`should not crash with data=${label}`, async () => {
                try {
                    const result = await withTimeout(() => decoder.removeObfuscation(input, fixtures.txid), 5000)
                    const check = checkRemoveObfuscationResult(result, input, fixtures.txid)
                    if (!check.ok) {
                        reporter.recordInvariantViolation({ data: label, txid: fixtures.txid }, check.violations, 'non_buffer')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ data: label, txid: fixtures.txid }, 'non_buffer')
                    } else {
                        reporter.recordCrash({ data: label, txid: fixtures.txid }, err, 'non_buffer')
                    }
                }
            })
        }
    })

    // --- Boundary sizes ---
    describe('boundary-size buffers', () => {
        const sizes = [0, 1, 2, 3, 4, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 76, 128, 256, 1024, 65536]

        for (const size of sizes) {
            it(`should handle ${size}-byte buffer`, async () => {
                const data = crypto.randomBytes(size)
                try {
                    const result = await withTimeout(() => decoder.removeObfuscation(data, fixtures.txid), 5000)
                    const check = checkRemoveObfuscationResult(result, data, fixtures.txid)
                    if (!check.ok) {
                        reporter.recordInvariantViolation({ size, txid: fixtures.txid }, check.violations, 'boundary_size')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ size, txid: fixtures.txid }, 'boundary_size')
                    } else {
                        reporter.recordCrash({ size, txid: fixtures.txid }, err, 'boundary_size')
                    }
                }
            })
        }
    })
})
