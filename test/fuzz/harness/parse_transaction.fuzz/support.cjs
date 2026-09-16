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
 * Fuzz harness for XChainDecoder#parseTransaction()
 *
 * Targets: OP_RETURN, P2SH, P2WSH, multisig code paths, script decompilation,
 * dispenser detection, source resolution edge cases.
 */

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../../src/XChainDecoder')
const { checkParseTransactionResult, withTimeout } = require('../../support/invariants')
const FuzzReporter = require('../../support/reporter')

bitcoin.initEccLib(ecc)

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS) || 2000

function createDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false)
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('mocked'))
    }
    return decoder
}

// Errors thrown by bitcoinjs-lib during Transaction.fromHex/fromBuffer are expected
// when we feed it corrupted hex. These are not decoder bugs.
function isBitcoinjsParseError(err) {
    const msg = err.message || ''
    return msg.includes('Cannot read slice out of bounds') ||
           msg.includes('Transaction has unexpected data') ||
           msg.includes('RangeError: value out of range') ||
           msg.includes('out of range') ||
           msg.includes('outside buffer bounds') ||
           msg.includes('Expected') // bitcoinjs-lib format errors
}

// THE INJECTED RPC FAILURE IS THE CONTRACT WORKING, NOT A CRASH.
//
// `createDecoder` stubs `connector.getRawTransaction` to reject, on purpose:
// every fuzz input runs without a node. Any input whose parse needs a prevout
// (P2SH/P2WSH source resolution, envelope commit/reveal, dispenser funding)
// therefore hits that rejection.
//
// The decoder's documented answer to an RPC lookup failure is to tag it
// `rpcLookupFailure = true` and RETHROW, so the block loop rolls the block
// back and retries rather than committing a tx sourced from a failed lookup
// (XChainDecoder.js: "A prevout lookup that FAILS is not a prevout that does
// not exist"). Swallowing it would be the consensus bug.
//
// This mock counts that rethrow as a crash, and the
// cost is not cosmetic: a `FUZZ_ITERATIONS=100` run reported 411 crashes, of
// which 411 were this mock. Across every crash file the suite has ever
// written, 7693 of 7704 were. Real findings do not survive that ratio - the
// two genuine ones in that pile (a `no_inputs` TypeError, since fixed) sat
// unread for a month.
//
// Keyed on the TAG rather than on the stub's message, so this stays a real
// assertion: if the decoder ever stops tagging an RPC failure, these stop
// being expected and the suite goes red, which is exactly the signal the
// block loop depends on.
function isInjectedRpcFailure(err) {
    return err != null && err.rpcLookupFailure === true
}

// Helper to run one fuzz iteration
async function fuzzOne(decoder, reporter, txOrHex, mutatorName) {
    try {
        let result
        if (typeof txOrHex === 'string') {
            result = await withTimeout(() => decoder.parseRawTransaction(txOrHex), 5000)
        } else {
            result = await withTimeout(() => decoder.parseTransaction(txOrHex), 5000)
        }
        const check = checkParseTransactionResult(result)
        if (!check.ok) {
            reporter.recordInvariantViolation(txOrHex, check.violations, mutatorName)
        } else {
            reporter.recordSuccess()
        }
    } catch (err) {
        if (err.message.startsWith('Timeout:')) {
            reporter.recordTimeout(txOrHex, mutatorName)
        } else if (typeof txOrHex === 'string' && isBitcoinjsParseError(err)) {
            // Expected: bitcoinjs-lib rejects malformed hex before decoder code runs
            reporter.recordSuccess()
        } else if (isInjectedRpcFailure(err)) {
            // Expected: this harness has no node, and the decoder is supposed
            // to fail loud on a prevout lookup it cannot complete.
            reporter.recordSuccess()
        } else {
            reporter.recordCrash(txOrHex, err, mutatorName)
        }
    }
}

function configureSuite() {
    const reporter = new FuzzReporter('parseTransaction')
    afterEach(() => {
        sinon.restore()
    })
    after(() => {
        reporter.printSummary()
        const s = reporter.getSummary()
        assert.strictEqual(s.crashes, 0, `${s.crashes} crashes found; see test/fuzz/crashes/parseTransaction/`)
        assert.strictEqual(s.invariantViolations, 0, `${s.invariantViolations} invariant violations found`)
        assert.strictEqual(s.timeouts, 0, `${s.timeouts} timeouts found`)
    })
    return reporter
}

module.exports = {
    ITERATIONS,
    checkParseTransactionResult,
    configureSuite,
    createDecoder,
    fuzzOne,
    isInjectedRpcFailure,
    withTimeout
}
