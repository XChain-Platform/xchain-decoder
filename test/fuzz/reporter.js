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
 * Fuzz crash reporter: logs failing inputs to disk and provides summaries.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CRASHES_DIR = path.join(__dirname, 'crashes')

class FuzzReporter {
    constructor(targetName) {
        this.targetName = targetName
        this.crashDir = path.join(CRASHES_DIR, targetName)
        this.stats = {
            iterations: 0,
            crashes: 0,
            invariantViolations: 0,
            timeouts: 0,
            startTime: Date.now(),
            errorTypes: {}
        }

        // Ensure crash directory exists
        fs.mkdirSync(this.crashDir, { recursive: true })
    }

    /** Record a successful iteration. */
    recordSuccess() {
        this.stats.iterations++
    }

    /** Record a crash with the input that caused it. */
    recordCrash(input, error, mutatorName) {
        this.stats.iterations++
        this.stats.crashes++

        const errorType = error.constructor.name + ': ' + (error.code || error.message.substring(0, 80))
        this.stats.errorTypes[errorType] = (this.stats.errorTypes[errorType] || 0) + 1

        const crashId = crypto.randomBytes(8).toString('hex')
        const crashData = {
            id: crashId,
            target: this.targetName,
            timestamp: new Date().toISOString(),
            mutator: mutatorName || 'unknown',
            error: {
                name: error.constructor.name,
                message: error.message,
                code: error.code || null,
                stack: error.stack
            },
            input: serializeInput(input)
        }

        const filePath = path.join(this.crashDir, `crash_${crashId}.json`)
        fs.writeFileSync(filePath, JSON.stringify(crashData, null, 2))
        return crashId
    }

    /** Record an invariant violation (not a crash, but incorrect output). */
    recordInvariantViolation(input, violations, mutatorName) {
        this.stats.iterations++
        this.stats.invariantViolations++

        const crashId = crypto.randomBytes(8).toString('hex')
        const crashData = {
            id: crashId,
            target: this.targetName,
            timestamp: new Date().toISOString(),
            type: 'invariant_violation',
            mutator: mutatorName || 'unknown',
            violations: violations,
            input: serializeInput(input)
        }

        const filePath = path.join(this.crashDir, `invariant_${crashId}.json`)
        fs.writeFileSync(filePath, JSON.stringify(crashData, null, 2))
        return crashId
    }

    /** Record a timeout. */
    recordTimeout(input, mutatorName) {
        this.stats.iterations++
        this.stats.timeouts++

        const crashId = crypto.randomBytes(8).toString('hex')
        const crashData = {
            id: crashId,
            target: this.targetName,
            timestamp: new Date().toISOString(),
            type: 'timeout',
            mutator: mutatorName || 'unknown',
            input: serializeInput(input)
        }

        const filePath = path.join(this.crashDir, `timeout_${crashId}.json`)
        fs.writeFileSync(filePath, JSON.stringify(crashData, null, 2))
        return crashId
    }

    /** Get the summary stats. */
    getSummary() {
        const elapsed = Date.now() - this.stats.startTime
        return {
            ...this.stats,
            elapsedMs: elapsed,
            iterationsPerSecond: Math.round(this.stats.iterations / (elapsed / 1000))
        }
    }

    /** Print summary to console. */
    printSummary() {
        const s = this.getSummary()
        console.log(`\n--- Fuzz Summary: ${this.targetName} ---`)
        console.log(`  Iterations:    ${s.iterations}`)
        console.log(`  Crashes:       ${s.crashes}`)
        console.log(`  Invariant:     ${s.invariantViolations}`)
        console.log(`  Timeouts:      ${s.timeouts}`)
        console.log(`  Duration:      ${s.elapsedMs}ms`)
        console.log(`  Speed:         ${s.iterationsPerSecond} iter/s`)
        if (Object.keys(s.errorTypes).length > 0) {
            console.log(`  Error types:`)
            for (const [type, count] of Object.entries(s.errorTypes)) {
                console.log(`    ${type}: ${count}`)
            }
        }
        console.log('')
    }
}

function serializeInput(input) {
    if (Buffer.isBuffer(input)) {
        return { type: 'buffer', hex: input.toString('hex'), length: input.length }
    }
    if (typeof input === 'string') {
        return { type: 'string', value: input.substring(0, 10000), length: input.length }
    }
    if (typeof input === 'object' && input !== null) {
        try {
            // For transaction objects, try to serialize to hex
            if (typeof input.toHex === 'function') {
                return { type: 'transaction_hex', hex: input.toHex() }
            }
            return { type: 'object', json: JSON.stringify(input, (key, val) => {
                if (Buffer.isBuffer(val)) return { __buffer: val.toString('hex') }
                return val
            }).substring(0, 10000) }
        } catch (e) {
            return { type: 'object', error: 'Could not serialize: ' + e.message }
        }
    }
    return { type: typeof input, value: String(input) }
}

module.exports = FuzzReporter
