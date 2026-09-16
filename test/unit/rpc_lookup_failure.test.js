// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')
const { buildDecoder, fakeTx } = require('./rpc_lookup_failure.test/helpers/decoder_harness')

// Regression tests for two consensus-divergence classes in the block loop.
//
// RPC lookups: getSourceFromOutput / findFundingFeeOutputs swallowed RPC
// failures into source=null / no-fee-output, so a node with a flaky coin-node
// RPC committed DIFFERENT block contents than a healthy node (a tx silently
// skipped, or a fee output silently absent). Lookup failures must now throw
// tagged rpcLookupFailure, and the block loop must retry the block
// indefinitely, never quarantining: an RPC outage is not a poison tx.
//
// Rollback signals: the block loop ignored the `false` returns by which db
// helpers signal "the INSERT/UPDATE failed and the block transaction was
// already rolled back", and kept writing rows on fresh autocommit connections
// OUTSIDE any transaction. Every rollback-signalling return must now abort and
// retry the block, re-deriving the in-memory cursors from the DB: a retried
// block that reuses the advanced tx counter assigns different tx_index values
// than a clean instance, and tx_index is replicated content.
const OUTER_TITLE = 'XChainDecoder RPC-lookup + rollback-signal hardening'

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe('getSourceFromOutput', function () {
        function bareDecoder() {
            return new XChainDecoder(
                'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
            )
        }

        it('throws a tagged error when the prevout RPC fetch fails, instead of returning null', async function () {
            const decoder = bareDecoder()
            decoder.connector = {
                getRawTransaction: async () => { throw new Error('getRawTransaction failed after 10 attempts') }
            }
            await assert.rejects(
                () => decoder.getSourceFromOutput('aa'.repeat(32), 0),
                (err) => err.rpcLookupFailure === true
            )
            assert.strictEqual(decoder.rpcErrors, 1)
        })

        it('throws a tagged error on an empty RPC result (a confirmed prevout always exists)', async function () {
            const decoder = bareDecoder()
            decoder.connector = { getRawTransaction: async () => null }
            await assert.rejects(
                () => decoder.getSourceFromOutput('aa'.repeat(32), 0),
                (err) => err.rpcLookupFailure === true
            )
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe('findFundingFeeOutputs', function () {
        function feeDecoder() {
            return new XChainDecoder(
                'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false,
                'bcrt1qfeedest000000000000000000000000000000'
            )
        }

        it('still returns [] for the deterministic no-fee-destination case', async function () {
            const decoder = new XChainDecoder(
                'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
            )
            decoder.connector = {
                getRawTransaction: async () => { throw new Error('must not even be called') }
            }
            assert.deepStrictEqual(await decoder.findFundingFeeOutputs('aa'.repeat(32)), [])
        })

        it('throws a tagged error when the funding-tx fetch fails, instead of returning []', async function () {
            const decoder = feeDecoder()
            decoder.connector = {
                getRawTransaction: async () => { throw new Error('node busy') }
            }
            await assert.rejects(
                () => decoder.findFundingFeeOutputs('aa'.repeat(32)),
                (err) => err.rpcLookupFailure === true
            )
            assert.strictEqual(decoder.rpcErrors, 1)
        })

        it('throws a tagged error on an empty RPC result for the funding tx', async function () {
            const decoder = feeDecoder()
            decoder.connector = { getRawTransaction: async () => null }
            await assert.rejects(
                () => decoder.findFundingFeeOutputs('aa'.repeat(32)),
                (err) => err.rpcLookupFailure === true
            )
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe('block loop RPC-failure classification', function () {
        it('retries the block past TX_PARSE_MAX_RETRIES on tagged RPC failures, never quarantining', async function () {
            const { decoder, calls } = buildDecoder({ transactions: [fakeTx('cafe01')] })

            // Fail 5 times (beyond TX_PARSE_MAX_RETRIES = 3), then succeed. The old
            // retry/quarantine path would have quarantined the tx on attempt 4.
            let parseCalls = 0
            decoder.parseTransaction = async () => {
                parseCalls++
                if (parseCalls <= 5) {
                    const err = new Error('prevout lookup failed')
                    err.rpcLookupFailure = true
                    throw err
                }
                return null
            }

            await decoder.start()

            assert.strictEqual(parseCalls, 6, 'the block must be retried until the RPC recovers')
            assert.strictEqual(calls.endTransaction, 5, 'each failed attempt rolls the block back')
            assert.strictEqual(calls.commitTransaction, 1, 'the block commits once the lookup succeeds')
            assert.strictEqual(calls.insertEvent.length, 0, 'an RPC failure must NEVER quarantine the tx')
        })
    })
})
