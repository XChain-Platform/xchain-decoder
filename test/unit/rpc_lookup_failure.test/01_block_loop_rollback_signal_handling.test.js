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
const { buildDecoder, fakeTx } = require('./helpers/decoder_harness')

const OUTER_TITLE = 'XChainDecoder RPC-lookup + rollback-signal hardening'
const BLOCK_TITLE = 'block loop rollback-signal handling'
const ACTION_PARSE_RESULT = () => ({
    data: Buffer.from('SEND|0|BTC|XCHAIN|1|addr2'),
    compiledDataLength: 30,
    rawData: null,
    source: 'addr1',
    destination: null,
    dispenseOutputs: [],
    paymentOutputs: []
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {
        it('retries the block when deleteOpenDispensers signals rollback via false', async function () {
            const { decoder, calls } = buildDecoder()

            decoder.db.deleteOpenDispensers = async () => {
                calls.deleteOpenDispensers++
                return calls.deleteOpenDispensers === 1 ? false : true
            }

            await decoder.start()

            assert.strictEqual(calls.deleteOpenDispensers, 2, 'the soft-expire must be retried with the block')
            assert.strictEqual(calls.insertBlock, 2, 'the block insert must rerun on the retry')
            assert.strictEqual(calls.commitTransaction, 1)
        })

        it('retries the block when the open-dispenser set cannot be loaded (null)', async function () {
            const { decoder, calls } = buildDecoder()

            decoder.db.getAllOpenDispenserAddresses = async () => {
                calls.getAllOpenDispenserAddresses++
                return calls.getAllOpenDispenserAddresses === 1 ? null : new Set()
            }

            await decoder.start()

            assert.strictEqual(calls.getAllOpenDispenserAddresses, 2, 'the load must be retried with the block')
            assert.strictEqual(calls.endTransaction, 1, 'the failed attempt must roll back')
            assert.strictEqual(calls.commitTransaction, 1)
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {
        it('aborts and retries the block when insertTransactionOutput signals rollback via false', async function () {
            const dispenseTx = {
                getId: () => 'cafe02',
                outs: []
            }
            const { decoder, calls } = buildDecoder({ transactions: [dispenseTx] })

            decoder.parseTransaction = async () => {
                const result = ACTION_PARSE_RESULT()
                result.dispenseOutputs = [
                    { vout: 0, destinationAddress: 'dispAddr', amount: 100n },
                    { vout: 1, destinationAddress: 'dispAddr', amount: 100n }
                ]
                return result
            }

            let outputInserts = 0
            decoder.db.insertTransactionOutput = async () => {
                outputInserts++
                return outputInserts === 1 ? false : true
            }

            await decoder.start()

            // First pass: 1 failed insert, then stop writing (the second output
            // must NOT be attempted on the rolled-back pass). Retry pass: both.
            assert.strictEqual(outputInserts, 3, 'no further outputs may be written after the rollback signal')
            assert.strictEqual(calls.insertTransaction.length, 2, 'the tx insert must rerun on the block retry')
            assert.strictEqual(calls.commitTransaction, 1)
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {
        it('re-derives tx_index from the DB after a rollback so a retried block matches a clean instance', async function () {
            const { decoder, calls } = buildDecoder({ transactions: [fakeTx('cafe03')] })

            decoder.parseTransaction = async () => ACTION_PARSE_RESULT()

            let txInserts = 0
            decoder.db.insertTransaction = async (tx) => {
                txInserts++
                calls.insertTransaction.push({ ...tx })
                if (txInserts === 1) {
                    // Simulate the db helper's real contract: the failed INSERT
                    // already rolled the block transaction back.
                    return false
                }
                return true
            }

            await decoder.start()

            assert.strictEqual(calls.insertTransaction.length, 2)
            assert.strictEqual(calls.insertTransaction[0].index, 1)
            assert.strictEqual(
                calls.insertTransaction[1].index, 1,
                'the retry must reuse tx_index 1 (stale in-memory counter would have written 2)'
            )
            assert.strictEqual(calls.commitTransaction, 1)
        })
    })
})
