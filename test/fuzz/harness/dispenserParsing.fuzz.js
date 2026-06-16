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
 * Fuzz harness for DISPENSER pipe-delimited string parsing.
 *
 * The DISPENSER parsing logic is inline in XChainDecoder.start() (lines 661-679).
 * This harness extracts and tests that logic directly without needing the full
 * decoder pipeline.
 */

const assert = require('assert')
const crypto = require('crypto')
const { checkDispenserParse, withTimeout } = require('../invariants')
const { randomDispenserString } = require('../mutators/structureAware')
const FuzzReporter = require('../reporter')

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS) || 5000

/**
 * Extracted DISPENSER parsing logic from XChainDecoder.start().
 * Returns { shouldInsert, fields } or throws on unexpected errors.
 */
function parseDispenserData(decodedData) {
    if (!decodedData.startsWith('DISPENSER')) {
        return { shouldInsert: false, fields: null }
    }

    const decodedDataSplit = decodedData.split('|')
    const commandVersion = decodedDataSplit[1]

    if (parseInt(commandVersion) === 0 && decodedDataSplit.length >= 13) {
        const giveCoin = decodedDataSplit[2]
        const getCoin = decodedDataSplit[6]
        const getAddress = decodedDataSplit[9]
        const expiration = decodedDataSplit[12]

        if ((getCoin !== '') || (giveCoin !== '')) {
            return {
                shouldInsert: true,
                fields: { giveCoin, getCoin, getAddress, expiration }
            }
        }
    }

    return { shouldInsert: false, fields: null }
}

describe('Fuzz: DISPENSER parsing', function () {
    this.timeout(120000)
    let reporter

    before(() => {
        reporter = new FuzzReporter('dispenserParsing')
    })

    after(() => {
        reporter.printSummary()
        const s = reporter.getSummary()
        assert.strictEqual(s.crashes, 0, `${s.crashes} crashes found — check test/fuzz/crashes/dispenserParsing/`)
        assert.strictEqual(s.invariantViolations, 0, `${s.invariantViolations} invariant violations found`)
        assert.strictEqual(s.timeouts, 0, `${s.timeouts} timeouts found`)
    })

    // --- Random DISPENSER strings ---
    describe('random DISPENSER strings', () => {
        it(`should handle ${ITERATIONS} random DISPENSER strings`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const input = randomDispenserString()
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    const check = checkDispenserParse(input)
                    if (!check.ok) {
                        reporter.recordInvariantViolation(input, check.violations, 'random_dispenser')
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout(input, 'random_dispenser')
                    } else {
                        reporter.recordCrash(input, err, 'random_dispenser')
                    }
                }
            }
        })
    })

    // --- Hypothesis H5: edge-case pipe counts ---
    describe('H5: boundary pipe counts', () => {
        const cases = [
            'DISPENSER',
            'DISPENSER|',
            'DISPENSER|0',
            'DISPENSER|0|',
            'DISPENSER|0||',
            'DISPENSER|0|||||||||||',   // 11 pipes (12 fields)
            'DISPENSER|0||||||||||||',  // 12 pipes (13 fields) — minimum valid
            'DISPENSER|0|||||||||||||', // 13 pipes (14 fields)
            'DISPENSER|0||||||||||||||||||||||', // many empty fields
            'DISPENSER|0|a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p', // all populated
        ]

        for (const input of cases) {
            it(`should handle "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`, async () => {
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordCrash(input, err, 'boundary_pipes')
                }
            })
        }
    })

    // --- Malformed version field ---
    describe('malformed version field', () => {
        const versions = [
            '', '0', '1', '-1', '999', 'abc', 'null', 'undefined', 'NaN',
            'Infinity', '-Infinity', '0x0', '0.5', '1e10',
            '0'.repeat(1000), // very long number string
            '\x00', '\n', '\t'
        ]

        for (const version of versions) {
            const label = JSON.stringify(version).substring(0, 30)
            it(`should handle version=${label}`, async () => {
                const input = `DISPENSER|${version}|GIVE||||||GET||||||||3600`
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordCrash(input, err, 'malformed_version')
                }
            })
        }
    })

    // --- Fields containing pipe characters and special chars ---
    describe('fields with special characters', () => {
        it(`should handle ${ITERATIONS} strings with special chars in fields`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const specialChars = ['|', '\\', '\n', '\r', '\t', '\x00', '\xFF',
                    '||', '|||', 'DISPENSER', 'null', 'undefined',
                    '<script>', '${eval}', '__proto__', 'constructor']

                // Build a DISPENSER string with 13+ fields, some containing special chars
                const fields = ['DISPENSER', '0']
                for (let j = 0; j < 15; j++) {
                    if (crypto.randomInt(3) === 0) {
                        fields.push(specialChars[crypto.randomInt(specialChars.length)])
                    } else {
                        fields.push(crypto.randomBytes(crypto.randomInt(10)).toString('hex'))
                    }
                }
                const input = fields.join('|')

                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    reporter.recordSuccess()
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout(input, 'special_chars')
                    } else {
                        reporter.recordCrash(input, err, 'special_chars')
                    }
                }
            }
        })
    })

    // --- Expiration field edge values ---
    describe('expiration field edge values', () => {
        const expirations = [
            '0', '-1', '-999999', String(Number.MAX_SAFE_INTEGER),
            String(Number.MAX_SAFE_INTEGER + 1), 'Infinity', '-Infinity', 'NaN',
            '', '   ', '1.5', '1e18', '0x1000',
            String(2 ** 32 - 1), String(2 ** 32), String(2 ** 53),
            'abc', '\x00'
        ]

        for (const exp of expirations) {
            it(`should handle expiration=${JSON.stringify(exp)}`, async () => {
                const input = `DISPENSER|0|GIVE||||||GET|||||${exp}`
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordCrash(input, err, 'expiration_edge')
                }
            })
        }
    })

    // --- Non-DISPENSER prefixes that are close ---
    describe('near-miss DISPENSER prefixes', () => {
        // These do NOT start with 'DISPENSER' — should never trigger insert
        const nonMatching = [
            'DISPENSAR', 'DISPENSE', 'dispenser',
            'Dispenser', ' DISPENSER', 'XDISPENSER', 'DISPENSEr'
        ]
        // These DO start with 'DISPENSER' — may or may not insert depending on fields
        const matching = [
            'DISPENSERR', 'DISPENSER\x00', 'DISPENSER '
        ]

        for (const prefix of nonMatching) {
            it(`should not trigger insert for prefix="${prefix}"`, async () => {
                const input = `${prefix}|0|GIVE||||||GET|||||3600`
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    assert.strictEqual(result.shouldInsert, false, 'Non-matching prefix should not trigger insert')
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordCrash(input, err, 'near_miss_prefix')
                }
            })
        }

        for (const prefix of matching) {
            it(`should not crash for prefix="${JSON.stringify(prefix)}"`, async () => {
                const input = `${prefix}|0|GIVE||||||GET|||||3600`
                try {
                    await withTimeout(() => parseDispenserData(input), 1000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordCrash(input, err, 'near_miss_prefix_matching')
                }
            })
        }
    })

    // --- BATCH with embedded DISPENSER ---
    describe('BATCH-like strings with embedded DISPENSER', () => {
        const batchCases = [
            'DISPENSER|0|A||||||B|||||3600;SEND|0|XCHAIN|1000',
            'SEND|0|XCHAIN|1000;DISPENSER|0|A||||||B|||||3600',
            'DISPENSER|0|A||||||B|||||3600;DISPENSER|0|C||||||D|||||7200',
        ]

        for (const input of batchCases) {
            it(`should handle batch: "${input.substring(0, 60)}..."`, async () => {
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 1000)
                    reporter.recordSuccess()
                } catch (err) {
                    reporter.recordCrash(input, err, 'batch_embedded')
                }
            })
        }
    })

    // --- Extremely long strings ---
    describe('extremely long DISPENSER strings', () => {
        const lengths = [1000, 10000, 100000]

        for (const len of lengths) {
            it(`should handle ${len}-char DISPENSER string`, async () => {
                const longField = 'A'.repeat(len)
                const input = `DISPENSER|0|${longField}||||||${longField}|||||3600`
                try {
                    const result = await withTimeout(() => parseDispenserData(input), 5000)
                    reporter.recordSuccess()
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout(input, 'long_string')
                    } else {
                        reporter.recordCrash(input, err, 'long_string')
                    }
                }
            })
        }
    })
})
