// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

const RAW_TIME = 500
const PREVIOUS_TIMES = Array.from({ length: 11 }, (_, index) => 100 + index)
const PROTOCOL_TIME = 105

function buildDecoder(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.consensusNetwork = 'testnet'
    decoder.startBlockIndex = 11
    decoder.sleep = async () => {}

    const calls = {
        previous: [],
        insertedBlocks: [],
        expirations: [],
        captureFloors: [],
        oracleTimes: [],
        registrations: [],
    }

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 11 }),
        getBlockHash: async () => 'block-11',
        getBlock: async () => '',
    }
    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({
            prevHash: Buffer.alloc(32),
            timestamp: RAW_TIME,
            transactions: [{ getId: () => 'tx-11', outs: [] }],
        }),
    }
    const action = 'DISPENSER|0|BTC|XCHAIN|500||2000|BTC||0.01'
    decoder.parseTransaction = async () => ({
        data: Buffer.from(action),
        source: 'source',
        sourcePubkey: null,
        destination: 'destination',
        amount: 1,
        dispenseOutputs: [],
        paymentOutputs: [],
        compiledDataLength: Buffer.byteLength(action),
        rawData: null,
    })
    decoder.resolveOracleFeeAddressesForCommands = async (commands, source, blockTime) => {
        calls.oracleTimes.push(blockTime)
        return []
    }

    decoder.db = {
        createDatabase: async () => true,
        verifyDatabase: async () => true,
        verifyTables: async () => true,
        runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => 10,
        getLastTxIndex: async () => 0,
        // Previous-block-time lookups a MTP-armed network needs for
        // block_ingest.js's fetchPreviousBlockTimes: the same
        // getBlockByIndex the reorg check already calls, one height at a
        // time, height 10 down to 0 (11 calls for MEDIAN_TIME_SPAN 11).
        getBlockByIndex: async (height) => {
            calls.previous.push(height)
            return { block_time: PREVIOUS_TIMES[height] }
        },
        beginTransaction: async () => {},
        endTransaction: async () => {},
        commitTransaction: async () => { decoder.stopFlag = true; return true },
        insertBlock: async (block) => { calls.insertedBlocks.push(block); return true },
        deleteOpenDispensers: async (height, time) => {
            calls.expirations.push({ height, time })
            return true
        },
        getAllOpenDispenserAddresses: async (floor) => {
            calls.captureFloors.push(floor)
            return new Set()
        },
        purgeExpiredDispensers: async () => true,
        insertTransaction: async () => true,
        insertTransactionOutput: async () => true,
        insertEvent: async () => true,
        insertDispenser: async (registration) => {
            calls.registrations.push(registration)
            return true
        },
        DUPLICATED_TRANSACTION: 1,
        POISON_ROW: 2,
    }

    return { decoder, calls }
}

describe('dispenser protocol time', function () {
    this.timeout(0)

    it('persists raw time while every time-keyed block consumer receives protocol time', async function () {
        const { decoder, calls } = buildDecoder()
        await decoder.start()

        assert.deepStrictEqual(calls.previous, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
        assert.strictEqual(calls.insertedBlocks.length, 1)
        assert.strictEqual(calls.insertedBlocks[0].block_time, RAW_TIME)
        assert.deepStrictEqual(calls.expirations, [{ height: 11, time: PROTOCOL_TIME }])
        assert.deepStrictEqual(calls.captureFloors, [PROTOCOL_TIME - 3600])
        assert.deepStrictEqual(calls.oracleTimes, [PROTOCOL_TIME])
        assert.strictEqual(calls.registrations.length, 1)
        assert.strictEqual(
            calls.registrations[0].expiration,
            PROTOCOL_TIME + decoder.expirationFeeDefaultDays * 86400
        )
    })

    it('retries without writes when the protocol-time history read fails', async function () {
        const { decoder, calls } = buildDecoder()
        let failedOnce = false
        decoder.db.getBlockByIndex = async (height) => {
            calls.previous.push(height)
            if (!failedOnce){
                failedOnce = true
                throw new Error('getBlockByIndex boom')
            }
            return { block_time: PREVIOUS_TIMES[height] }
        }

        await decoder.start()

        // First pass fails on the very first previous-block lookup (height 10)
        // and rolls the block back without writing; the retry redoes the full
        // walk from height 10 down to 0 and succeeds.
        assert.deepStrictEqual(calls.previous, [10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
        assert.strictEqual(calls.insertedBlocks.length, 1)
        assert.deepStrictEqual(calls.expirations, [{ height: 11, time: PROTOCOL_TIME }])
    })
})
