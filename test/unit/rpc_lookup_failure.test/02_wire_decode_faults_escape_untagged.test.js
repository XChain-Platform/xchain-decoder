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
const XChainDecoder = require('../../../src/XChainDecoder')
const { buildDecoder, fakeTx } = require('./helpers/decoder_harness')

const OUTER_TITLE = 'XChainDecoder RPC-lookup + rollback-signal hardening'
const BLOCK_TITLE = 'wire-decode faults escape untagged'
const BAD_HEX = 'deadbeef'

function decodeFaultDecoder(feeDestination = null) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, feeDestination
    )
    decoder.connector = { getRawTransaction: async () => BAD_HEX }
    decoder.xchainBlockDecoder = {
        transactionFromHex: () => { throw new Error('RangeError: value out of range') }
    }
    return decoder
}

function untagged(err) {
    assert.strictEqual(err.rpcLookupFailure, undefined,
        'a decode fault must not be tagged as a transport fault')
    return true
}

// The prevout helpers must not wrap the RPC fetch AND the wire-decode of its
// response in one try that tags everything escaping it as rpcLookupFailure: a
// deterministic decode fault would then take the unbounded height retry and
// wedge the decoder at that height forever, bypassing the quarantine ladder.
// getRawTransaction answers with a whole JSON-decoded hex string or fails, so a
// decode throw is CONTENT every instance sees alike: it must escape untagged.
describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {
        it('getSourceFromOutput: an undecodable prevout throws untagged', async function () {
            const decoder = decodeFaultDecoder()
            await assert.rejects(() => decoder.getSourceFromOutput('aa'.repeat(32), 0), untagged)
            assert.strictEqual(decoder.rpcErrors, 0, 'a decode fault is not an RPC error')
        })

        it('getSourceFromOutput: an undecodable commit funder throws untagged', async function () {
            // Reach the P2SH walk-back: the first decode answers a P2SH data-carrier
            // output, the second (the commit's own funder) is the one that cannot parse.
            const p2shScript = Buffer.alloc(23)
            p2shScript[0] = 0xa9
            p2shScript[1] = 0x14
            p2shScript[22] = 0x87

            const decoder = decodeFaultDecoder()
            let decodes = 0
            decoder.xchainBlockDecoder = {
                transactionFromHex: () => {
                    decodes++
                    if (decodes === 1) {
                        return {
                            outs: [{ script: p2shScript }],
                            ins: [{ hash: Buffer.alloc(32, 2), index: 0 }]
                        }
                    }
                    throw new Error('RangeError: value out of range')
                }
            }

            await assert.rejects(() => decoder.getSourceFromOutput('aa'.repeat(32), 0), untagged)
            assert.strictEqual(decodes, 2, 'the walk-back hop must have been reached')
            assert.strictEqual(decoder.rpcErrors, 0)
        })

        it('getEnvelopeSourceFromCommit: an undecodable commit funder throws untagged', async function () {
            const decoder = decodeFaultDecoder()
            const commitTransaction = { ins: [{ hash: Buffer.alloc(32, 1), index: 0 }] }
            await assert.rejects(() => decoder.getEnvelopeSourceFromCommit(commitTransaction), untagged)
            assert.strictEqual(decoder.rpcErrors, 0)
        })

        it('fetchEnvelopeCommitTransaction: an undecodable commit throws untagged', async function () {
            const decoder = decodeFaultDecoder()
            await assert.rejects(() => decoder.fetchEnvelopeCommitTransaction('bb'.repeat(32)), untagged)
            assert.strictEqual(decoder.rpcErrors, 0)
        })

        it('findFundingFeeOutputs: an undecodable funding tx throws untagged', async function () {
            const decoder = decodeFaultDecoder('bcrt1qfeedest000000000000000000000000000000')
            await assert.rejects(() => decoder.findFundingFeeOutputs('cc'.repeat(32)), untagged)
            assert.strictEqual(decoder.rpcErrors, 0)
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {
        it('the block loop quarantines an undecodable prevout instead of retrying forever', async function () {
            const { decoder, calls } = buildDecoder({ transactions: [fakeTx('cafe04')] })
            decoder.xchainBlockDecoder.transactionFromHex = () => {
                throw new Error('RangeError: value out of range')
            }
            decoder.connector.getRawTransaction = async () => BAD_HEX

            // Bounded so the pre-fix behaviour (a tagged error, retried at this height
            // for ever) fails the assertions instead of hanging the suite.
            let attempts = 0
            decoder.parseTransaction = async () => {
                attempts++
                if (attempts > 20){
                    decoder.stopFlag = true
                    return null
                }
                return await decoder.getSourceFromOutput('aa'.repeat(32), 0)
            }

            await decoder.start()

            assert.strictEqual(attempts, 4, 'TX_PARSE_MAX_RETRIES block retries, then quarantine')
            assert.strictEqual(calls.insertEvent.length, 1, 'the poison tx must be quarantined once')
            assert.strictEqual(calls.insertEvent[0].code, 'PARSE_ERROR')
        })
    })
})
