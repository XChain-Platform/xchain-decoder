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
describe('XChainDecoder RPC-lookup + rollback-signal hardening', function () {
    this.timeout(0)

    const PREV_WIRE = Buffer.from(
        '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
        'hex'
    )

    function fakeTx(id) {
        return { getId: () => id, outs: [] }
    }

    function buildDecoder({ transactions = [] } = {}) {
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.startBlockIndex = 0
        decoder.sleep = async () => {}

        const calls = {
            insertBlock: 0,
            endTransaction: 0,
            commitTransaction: 0,
            insertEvent: [],
            insertTransaction: [],
            insertTransactionOutput: 0,
            deleteOpenDispensers: 0,
            getAllOpenDispenserAddresses: 0,
        }

        decoder.connector = {
            getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
            getBlockHash: async () => 'aabbccdd',
            getBlock: async () => ''
        }

        decoder.db = {
            createDatabase: async () => true,
            verifyDatabase: async () => true,
            verifyTables: async () => true,
            runMigrations: async () => ({ applied: [], pending: [] }),
            getLastBlockIndex: async () => -1,
            getLastTxIndex: async () => 0,
            beginTransaction: async () => {},
            endTransaction: async () => { calls.endTransaction++ },
            commitTransaction: async () => {
                calls.commitTransaction++
                // The block made it all the way through: stop the loop.
                decoder.stopFlag = true
                return true
            },
            deleteOpenDispensers: async () => { calls.deleteOpenDispensers++; return true },
            purgeExpiredDispensers: async () => true,
            getAllOpenDispenserAddresses: async () => { calls.getAllOpenDispenserAddresses++; return new Set() },
            insertEvent: async (code, data) => {
                calls.insertEvent.push({ code, data })
                return true
            },
            insertBlock: async () => {
                calls.insertBlock++
                return true
            },
            insertTransaction: async (tx) => {
                calls.insertTransaction.push({ ...tx })
                return true
            },
            insertTransactionOutput: async () => {
                calls.insertTransactionOutput++
                return true
            },
            DUPLICATED_TRANSACTION: 1,
        }

        decoder.xchainBlockDecoder = {
            blockFromHex: () => ({
                prevHash: Buffer.from(PREV_WIRE),
                timestamp: 1700000000,
                transactions
            })
        }

        return { decoder, calls }
    }

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

    describe('block loop rollback-signal handling', function () {
        const ACTION_PARSE_RESULT = () => ({
            data: Buffer.from('SEND|0|BTC|XCHAIN|1|addr2'),
            compiledDataLength: 30,
            rawData: null,
            source: 'addr1',
            destination: null,
            dispenseOutputs: [],
            paymentOutputs: []
        })

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

    // The other half of the classification. The prevout helpers must not wrap the RPC
    // fetch AND the wire-decode of its response in one try that tags everything escaping
    // it as rpcLookupFailure: a deterministic decode fault would then take the unbounded
    // height retry above and wedge the decoder at that height forever, bypassing the
    // quarantine ladder. getRawTransaction answers with a whole JSON-decoded hex string
    // or fails, so a decode throw is CONTENT every instance sees alike: it must escape
    // untagged.
    describe('wire-decode faults escape untagged', function () {
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

    // Quarantine is parity-safe only for a fault every instance shares. An inactive
    // BigInt-safe bufferutils reader makes a DOGE output > 2^53-1 sat undecodable on
    // THIS instance alone, so after the change above it would quarantine a transaction
    // healthy instances decode. Refusing to start is the only convergent answer.
    describe('start() refuses a Dogecoin decoder with an inactive BigInt reader', function () {
        const bufferutils = require('bitcoinjs-lib/src/bufferutils')

        function withInactiveReader(run) {
            const originalReadUInt64 = bufferutils.BufferReader.prototype.readUInt64
            bufferutils.BufferReader.prototype.readUInt64 = function () {
                throw new Error('RangeError: value out of range')
            }
            return (async () => {
                try {
                    await run()
                } finally {
                    bufferutils.BufferReader.prototype.readUInt64 = originalReadUInt64
                }
            })()
        }

        it('throws instead of warning and running on', async function () {
            await withInactiveReader(async () => {
                const { decoder } = buildDecoder()
                decoder.xchainBlockDecoder.coin = 'dogecoin'
                await assert.rejects(() => decoder.start(), /BigInt-safe 64-bit reader is NOT active/)
            })
        })

        it('leaves a non-Dogecoin decoder alone', async function () {
            await withInactiveReader(async () => {
                const { decoder, calls } = buildDecoder()
                await decoder.start()
                assert.strictEqual(calls.commitTransaction, 1, 'a BTC decoder still starts')
            })
        })
    })
})
