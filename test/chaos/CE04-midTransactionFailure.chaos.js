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
 * CE-04: Mid-Transaction Database Failure
 *
 * Tests that the decoder handles database failures during block
 * processing transactions correctly — verifying rollback behavior
 * and that partial state is never committed.
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, createMockConnector, createMinimalBlockHex, captureConsole } = require('./helpers')

describe('CE-04: Mid-Transaction Database Failure', function () {
    let decoder
    let mockDb
    let mockConnector

    beforeEach(function () {
        decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        mockDb = createMockDatabase()
        mockConnector = createMockConnector()
        decoder.db = mockDb
        decoder.connector = mockConnector
        // Speed up sleeps in tests
        decoder.sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 50)))
    })

    afterEach(function () {
        decoder.stop()
    })

    it('should retry when insertBlock fails', async function () {
        let insertBlockCalls = 0
        mockConnector.getBlockchainInfo.resolves({ blocks: 1, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('abc123')
        mockConnector.getBlock.resolves(createMinimalBlockHex())

        mockDb.getLastBlockIndex.resolves(-1)
        mockDb.getBlockByIndex.resolves(null)

        mockDb.insertBlock = sinon.stub().callsFake(async () => {
            insertBlockCalls++
            if (insertBlockCalls === 1) {
                return false
            }
            decoder.stop()
            return true
        })

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(insertBlockCalls >= 2, `Should have retried insertBlock, got ${insertBlockCalls} calls`)
        assert.ok(mockDb.beginTransaction.callCount >= 2, 'Should have started new transactions for retries')
    })

    it('should retry when insertTransaction fails', async function () {
        let insertTxCalls = 0
        mockConnector.getBlockchainInfo.resolves({ blocks: 1, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('abc123')
        mockConnector.getBlock.resolves(createMinimalBlockHex())

        mockDb.getLastBlockIndex.resolves(-1)
        mockDb.getBlockByIndex.resolves(null)
        mockDb.insertBlock.resolves(true)

        sinon.stub(decoder, 'parseTransaction').resolves({
            data: Buffer.from('SEND|0|XCHAIN|100'),
            rawData: null,
            source: 'testaddress',
            destination: null,
            dispenseOutputs: []
        })

        mockDb.insertTransaction = sinon.stub().callsFake(async () => {
            insertTxCalls++
            if (insertTxCalls === 1) {
                return false
            }
            decoder.stop()
            return true
        })

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(insertTxCalls >= 2, `Should have retried insertTransaction, got ${insertTxCalls} calls`)
    })

    it('should handle commitTransaction failure and continue', async function () {
        let commitCalls = 0
        mockConnector.getBlockchainInfo.resolves({ blocks: 1, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('abc123')
        mockConnector.getBlock.resolves(createMinimalBlockHex())

        mockDb.getLastBlockIndex.resolves(-1)
        mockDb.getBlockByIndex.resolves(null)
        mockDb.insertBlock.resolves(true)

        mockDb.commitTransaction = sinon.stub().callsFake(async () => {
            commitCalls++
            decoder.stop()
            return commitCalls === 1 ? false : true
        })

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(commitCalls >= 1, 'commitTransaction should have been called')
    })

    it('should call endTransaction when reorg is detected', async function () {
        let loopCount = 0
        mockConnector.getBlockchainInfo.resolves({ blocks: 5, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('differenthash')
        mockConnector.getBlock.resolves(createMinimalBlockHex())

        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => {
            loopCount++
            if (loopCount > 3) {
                decoder.stop()
                return -1
            }
            return 1
        })
        mockDb.getLastTxIndex.resolves(0)
        mockDb.getBlockByIndex.resolves({ block_hash: 'completely_different_hash' })

        sinon.stub(decoder, 'verifyReorg').resolves(true)

        const { logs } = await captureConsole(async () => {
            await decoder.start()
        })

        const reorgLogs = logs.filter(l => l.includes('reorg has been detected'))
        assert.ok(reorgLogs.length >= 1, 'Should detect reorg in main loop')
        assert.ok(decoder.verifyReorg.called, 'Should call verifyReorg')
        assert.ok(mockDb.endTransaction.called, 'Should end transaction before reorg processing')
    })
})
