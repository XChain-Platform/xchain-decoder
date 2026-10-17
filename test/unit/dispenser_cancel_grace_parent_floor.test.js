'use strict'

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
const sinon = require('sinon')

const XChainDecoder = require('../../src/XChainDecoder')
const { storeBlock } = require('../../src/XChainDecoder/block_store')
const protocolTime = require('../../src/protocol/protocol_time')
const {
    DISPENSER_CANCEL_GRACE_PARENT_FLOOR_ACTIVATION,
    DISPENSER_CANCEL_GRACE_SECONDS,
    cancelGraceFloor,
} = require('../../src/protocol/dispenser_cancel_grace')

function makeBlockStoreContext(blockReads, floors){
    return {
        consensusNetwork: 'testnet',
        blockchainInfoLastBlock: 100,
        db: {
            beginTransaction: async () => {},
            getBlockByIndex: async (height) => {
                blockReads.push(height)
                return { block_time: 100 + height }
            },
            insertBlock: async () => true,
            deleteOpenDispensers: async () => true,
            commitTransaction: async () => true,
            purgeExpiredDispensers: async () => true,
            getAllOpenDispenserAddresses: async (floor) => {
                floors.push(floor)
                return new Set()
            },
        },
    }
}

function makeBlockLoop(){
    return {
        blocksQuantity: 0,
        blocksCount: 0,
        transactionsCount: 0,
        validTransactionsCount: 0,
        outputCount: 0,
        startTimeStamp: Date.now(),
        txParseRetryCounts: new Map(),
        insertQuarantineCounts: new Map(),
        insertQuarantine: new Set(),
    }
}

describe('dispenser cancellation grace parent protocol floor', function () {
    afterEach(function () {
        sinon.restore()
    })

    it('uses the earlier parent protocol time only on an active network', function () {
        assert.strictEqual(cancelGraceFloor('regtest', 10000, 9000), 5400)
        assert.strictEqual(cancelGraceFloor('regtest', 10000, 12000), 6400)
        assert.strictEqual(cancelGraceFloor('mainnet', 10000, 9000), 6400)
        assert.strictEqual(cancelGraceFloor('testnet', 10000, 9000), 6400)
    })

    it('falls back to the block clock when no finite parent clock is available', function () {
        assert.strictEqual(
            cancelGraceFloor('regtest', 10000, null),
            10000 - DISPENSER_CANCEL_GRACE_SECONDS)
        assert.strictEqual(
            cancelGraceFloor('regtest', 10000, 'not-a-time'),
            10000 - DISPENSER_CANCEL_GRACE_SECONDS)
    })

    it('anchors a mempool refresh to the latest stored parent protocol time', async function () {
        sinon.stub(Date, 'now').returns(10000 * 1000)
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.consensusNetwork = 'regtest'
        decoder.lastProcessedBlockIndex = 7

        const blockReads = []
        const floors = []
        decoder.mempoolDb = {
            getBlockByIndex: async (height) => {
                blockReads.push(height)
                return { block_time: 9000 }
            },
            getAllOpenDispenserAddresses: async (floor) => {
                floors.push(floor)
                return new Set()
            },
            deleteAndCompareTxsNotInList: async () => ({ transactionsDeleted: 0 }),
        }
        decoder.connector = {
            getRawMempool: async () => [],
            getRawTransactions: async () => [],
        }

        await decoder.updateMempool()

        assert.deepStrictEqual(blockReads, [7])
        assert.deepStrictEqual(floors, [9000 - DISPENSER_CANCEL_GRACE_SECONDS])
    })

    it('keeps the current block MTP window bounded when resolving its parent clock', async function () {
        const activation = DISPENSER_CANCEL_GRACE_PARENT_FLOOR_ACTIVATION
        const previousActivation = activation.testnet
        activation.testnet = 0
        const createContext = sinon.spy(protocolTime, 'createBlockTimeContext')
        const blockReads = []
        const floors = []
        const context = makeBlockStoreContext(blockReads, floors)

        try {
            await storeBlock.call(
                context, makeBlockLoop(), { timestamp: 500, transactions: [] }, 12, 'hash', 'parent')
        } finally {
            activation.testnet = previousActivation
        }

        assert.deepStrictEqual(blockReads, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
        assert.strictEqual(createContext.firstCall.args[2].length, protocolTime.MEDIAN_TIME_SPAN)
        assert.deepStrictEqual(floors, [105 - DISPENSER_CANCEL_GRACE_SECONDS])
    })
})
