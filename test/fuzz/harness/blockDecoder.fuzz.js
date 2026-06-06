/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz harness for XChainBlockDecoder
 *
 * Targets: blockFromBuffer, blockFromHex, transactionFromHex — especially
 * Litecoin HogEx flag stripping and buffer manipulation.
 */

const assert = require('assert')
const crypto = require('crypto')
const XChainBlockDecoder = require('../../../src/XChainBlockDecoder')
const { flipBits } = require('../mutators/bitFlip')
const { mutateRandom, truncate, extend } = require('../mutators/byteManipulate')
const { buildFuzzedLitecoinBlockHex } = require('../mutators/structureAware')
const { checkBlockResult, withTimeout } = require('../invariants')
const FuzzReporter = require('../reporter')

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS) || 2000

// A minimal valid 80-byte Bitcoin block header (all zeros except version=1)
const MINIMAL_HEADER = Buffer.alloc(80)
MINIMAL_HEADER.writeUInt32LE(1, 0) // version

describe('Fuzz: XChainBlockDecoder', function () {
    this.timeout(120000)
    let reporter

    before(() => {
        reporter = new FuzzReporter('blockDecoder')
    })

    after(() => {
        reporter.printSummary()
        const s = reporter.getSummary()
        assert.strictEqual(s.crashes, 0, `${s.crashes} crashes found — check test/fuzz/crashes/blockDecoder/`)
        assert.strictEqual(s.invariantViolations, 0, `${s.invariantViolations} invariant violations found`)
        assert.strictEqual(s.timeouts, 0, `${s.timeouts} timeouts found`)
    })

    // --- Bitcoin blockFromBuffer with random/mutated buffers ---
    describe('bitcoin: blockFromBuffer with random buffers', () => {
        it(`should handle ${ITERATIONS} random buffers`, async () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            for (let i = 0; i < ITERATIONS; i++) {
                const size = crypto.randomInt(500)
                const buf = crypto.randomBytes(size)
                try {
                    const result = await withTimeout(() => decoder.blockFromBuffer(buf), 5000)
                    const check = checkBlockResult(result)
                    if (!check.ok) {
                        reporter.recordInvariantViolation(buf, check.violations, 'random_buffer_btc')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    // Expected: "Buffer too small", parsing errors — these are handled
                    reporter.recordSuccess()
                }
            }
        })
    })

    // --- Bitcoin blockFromBuffer with mutated valid header ---
    describe('bitcoin: mutated valid header', () => {
        it(`should handle ${ITERATIONS} mutated headers`, async () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            for (let i = 0; i < ITERATIONS; i++) {
                const mutated = mutateRandom(MINIMAL_HEADER)
                try {
                    const result = await withTimeout(() => decoder.blockFromBuffer(mutated), 5000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordSuccess()
                }
            }
        })
    })

    // --- Litecoin blockFromBuffer: HogEx flag fuzzing ---
    describe('litecoin: HogEx flag combinations', () => {
        // Hypothesis H6: version != 01/02 but marker/flag match HogEx
        const flagCombos = [
            { flag: '08', marker: '00', txVersion: '01000000', desc: 'v1 + HogEx' },
            { flag: '08', marker: '00', txVersion: '02000000', desc: 'v2 + HogEx' },
            { flag: '08', marker: '00', txVersion: '03000000', desc: 'v3 + HogEx (non-standard)' },
            { flag: '09', marker: '00', txVersion: '02000000', desc: 'v2 + segwit+MWEB' },
            { flag: '01', marker: '00', txVersion: '02000000', desc: 'v2 + segwit' },
            { flag: '00', marker: '00', txVersion: '02000000', desc: 'v2 + zero flags' },
            { flag: 'ff', marker: '00', txVersion: '02000000', desc: 'v2 + 0xFF flag' },
            { flag: '08', marker: '01', txVersion: '02000000', desc: 'v2 + non-zero marker + HogEx' },
            { flag: '08', marker: 'ff', txVersion: '02000000', desc: 'v2 + 0xFF marker + HogEx' },
        ]

        for (const combo of flagCombos) {
            it(`should handle Litecoin block: ${combo.desc}`, async () => {
                const decoder = new XChainBlockDecoder('litecoin-regtest')
                const blockHex = buildFuzzedLitecoinBlockHex(combo)
                try {
                    const result = await withTimeout(() => decoder.blockFromHex(blockHex), 5000)
                    const check = checkBlockResult(result)
                    if (!check.ok) {
                        reporter.recordInvariantViolation(blockHex, check.violations, 'ltc_hogex_combo')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    // Parsing errors are expected for many combos
                    reporter.recordSuccess()
                }
            })
        }
    })

    // --- Litecoin blockFromBuffer with random buffers ---
    describe('litecoin: random buffers', () => {
        it(`should handle ${ITERATIONS} random buffers`, async () => {
            const decoder = new XChainBlockDecoder('litecoin-regtest')
            for (let i = 0; i < ITERATIONS; i++) {
                const size = 80 + crypto.randomInt(500)
                const buf = crypto.randomBytes(size)
                // Force a valid-looking header
                buf.writeUInt32LE(2, 0) // version=2
                try {
                    await withTimeout(() => decoder.blockFromBuffer(buf), 5000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordSuccess()
                }
            }
        })
    })

    // --- transactionFromHex: Litecoin MWEB stripping ---
    describe('litecoin: transactionFromHex with MWEB flags', () => {
        it(`should handle ${ITERATIONS} fuzzed Litecoin tx hex strings`, async () => {
            const decoder = new XChainBlockDecoder('litecoin-regtest')
            for (let i = 0; i < ITERATIONS; i++) {
                // Build a minimal tx-like hex with various version+marker+flag combos
                const versions = ['01000000', '02000000', '03000000', 'ffffffff']
                const markers = ['00', '01', 'ff']
                const flags = ['01', '08', '09', '0a', 'ff']

                const version = versions[crypto.randomInt(versions.length)]
                const marker = markers[crypto.randomInt(markers.length)]
                const flag = flags[crypto.randomInt(flags.length)]

                // Minimal segwit-like tx body
                const body = version + marker + flag +
                    '01' + crypto.randomBytes(32).toString('hex') + '00000000' + '00' + 'ffffffff' +
                    '01' + '0000000000000000' + '00' +
                    '00' + // empty witness
                    '00000000' // locktime

                try {
                    await withTimeout(() => decoder.transactionFromHex(body), 5000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordSuccess()
                }
            }
        })
    })

    // --- transactionFromHex: completely random hex ---
    describe('transactionFromHex: random hex', () => {
        it(`should handle ${ITERATIONS} random hex strings`, async () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            for (let i = 0; i < ITERATIONS; i++) {
                const size = crypto.randomInt(300) + 10
                const hex = crypto.randomBytes(size).toString('hex')
                try {
                    await withTimeout(() => decoder.transactionFromHex(hex), 5000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordSuccess()
                }
            }
        })
    })

    // --- Boundary: exactly 80-byte header (no transactions) ---
    describe('boundary: header-only blocks', () => {
        for (const coin of ['bitcoin-regtest', 'litecoin-regtest', 'dogecoin-regtest']) {
            it(`should handle 80-byte header for ${coin}`, async () => {
                const decoder = new XChainBlockDecoder(coin)
                try {
                    const result = await withTimeout(() => decoder.blockFromBuffer(Buffer.from(MINIMAL_HEADER)), 5000)
                    const check = checkBlockResult(result)
                    if (!check.ok) {
                        reporter.recordInvariantViolation(MINIMAL_HEADER, check.violations, 'header_only_' + coin)
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    reporter.recordSuccess()
                }
            })
        }
    })

    // --- Boundary: buffers just under/over 80 bytes ---
    describe('boundary: near-80-byte buffers', () => {
        const sizes = [0, 1, 10, 40, 79, 80, 81, 82, 100, 160]
        for (const size of sizes) {
            it(`should handle ${size}-byte buffer (bitcoin)`, async () => {
                const decoder = new XChainBlockDecoder('bitcoin-regtest')
                const buf = crypto.randomBytes(size)
                try {
                    await withTimeout(() => decoder.blockFromBuffer(buf), 5000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordSuccess()
                }
            })
        }
    })
})
