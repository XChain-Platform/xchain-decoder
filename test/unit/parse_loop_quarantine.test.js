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

// Hardening tests for the start() parse loop.
//
// Bug: blockFromHex (block level) and parseTransaction (tx level) were called
// unguarded inside the main_parsing loop. A single throw escaped start(),
// whose rejection api.js only logs, so one undecodable block or transaction
// permanently stopped the decode pipeline at that height (and a restart
// re-fetched the same block and died again).
//
// Fix: block-level decode failures roll back and retry (never skip a block);
// transaction-level failures retry the whole block TX_PARSE_MAX_RETRIES times
// (so a transient RPC/DB blip never skips a tx), then quarantine the poison
// transaction with a PARSE_ERROR event and continue. A mempool parse throw
// skips just that tx instead of aborting the whole mempool cycle.
describe('XChainDecoder parse-loop quarantine', function () {
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
            deleteOpenDispensers: async () => true,
            purgeExpiredDispensers: async () => {},
            getAllOpenDispenserAddresses: async () => new Set(),
            insertEvent: async (code, data) => {
                calls.insertEvent.push({ code, data })
                return true
            },
            insertBlock: async () => {
                calls.insertBlock++
                return true
            }
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

    it('survives a blockFromHex throw and retries the block instead of dying', async function () {
        const { decoder, calls } = buildDecoder()

        let blockFromHexCalls = 0
        decoder.xchainBlockDecoder.blockFromHex = () => {
            blockFromHexCalls++
            if (blockFromHexCalls === 1) {
                throw new Error('corrupt block hex')
            }
            return { prevHash: Buffer.from(PREV_WIRE), timestamp: 1700000000, transactions: [] }
        }

        await decoder.start()

        assert.strictEqual(blockFromHexCalls, 2, 'block decode should have been retried after the throw')
        assert.strictEqual(calls.insertBlock, 1, 'the block should be inserted on the successful retry')
        assert.strictEqual(calls.endTransaction, 1, 'the failed attempt should roll back')
        assert.strictEqual(decoder.parseErrors, 1)
        assert.strictEqual(calls.insertEvent.length, 0, 'a block-level failure is never quarantined')
    })

    it('retries the whole block when parseTransaction throws transiently (no quarantine)', async function () {
        const { decoder, calls } = buildDecoder({ transactions: [fakeTx('cafe01')] })

        let parseCalls = 0
        decoder.parseTransaction = async () => {
            parseCalls++
            if (parseCalls === 1) {
                throw new Error('transient RPC blip')
            }
            return null
        }

        await decoder.start()

        assert.strictEqual(parseCalls, 2, 'the tx should be re-parsed on the block retry')
        assert.strictEqual(calls.endTransaction, 1, 'the failed attempt should roll back')
        assert.strictEqual(calls.commitTransaction, 1, 'the block should commit on the retry')
        assert.strictEqual(calls.insertEvent.length, 0, 'a transiently failing tx must NOT be quarantined')
    })

    it('quarantines a poison transaction after exhausting block retries', async function () {
        const { decoder, calls } = buildDecoder({ transactions: [fakeTx('cafe01')] })

        let parseCalls = 0
        decoder.parseTransaction = async () => {
            parseCalls++
            throw new Error('poison transaction')
        }

        await decoder.start()

        // TX_PARSE_MAX_RETRIES (3) block retries + the final quarantining attempt
        assert.strictEqual(parseCalls, 4, 'three block retries then a quarantining attempt')
        assert.strictEqual(calls.endTransaction, 3, 'each retry rolls the block back')
        assert.strictEqual(calls.commitTransaction, 1, 'the block still commits after the quarantine')
        assert.strictEqual(calls.insertEvent.length, 1, 'the quarantine must be recorded')
        assert.strictEqual(calls.insertEvent[0].code, 'PARSE_ERROR')
        assert.strictEqual(calls.insertEvent[0].data.tx_hash, 'cafe01')
        assert.strictEqual(calls.insertEvent[0].data.block_index, 0)
        assert.strictEqual(calls.insertEvent[0].data.error, 'poison transaction')
    })

    it('skips just the failing tx during a mempool update instead of aborting the cycle', async function () {
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.sleep = async () => {}

        decoder.connector = {
            getRawMempool: async () => ['aa', 'bb'],
            getRawTransactions: async () => ['deadbeef01', 'deadbeef02']
        }
        decoder.xchainBlockDecoder = {
            transactionFromHex: (hex) => ({ ins: [{}], outs: [], getId: () => hex })
        }
        // Mempool maintenance runs on mempoolDb, never the block db, so a mempool
        // failure can never roll back a block mid-parse.
        decoder.mempoolDb = {
            deleteAndCompareTxsNotInList: async () => ({ transactionsDeleted: 0 }),
            insertMempoolTransaction: async () => true
        }

        const parsed = []
        decoder.parseTransaction = async (tx) => {
            parsed.push(tx.getId())
            if (parsed.length === 1) {
                throw new Error('poison mempool tx')
            }
            return null
        }

        await decoder.updateMempool()

        assert.deepStrictEqual(parsed, ['deadbeef01', 'deadbeef02'], 'the second tx must still be processed after the first throws')
        assert.strictEqual(decoder.parseErrors, 1)
        assert.strictEqual(decoder.mempoolBusy, false, 'the busy flag must be released')
    })
})
