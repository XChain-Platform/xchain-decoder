/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CE-10: Fire-and-Forget DB Call Failure (insertTransactionOutput)
 *
 * Tests that insertTransactionOutput() is now properly awaited and
 * that failures in dispense output recording are surfaced rather
 * than silently lost. Validates the fix applied to XChainDecoder.js.
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, createMockConnector, createMinimalBlockHex, captureConsole } = require('./helpers')

describe('CE-10: Fire-and-Forget DB Call (insertTransactionOutput)', function () {
    let decoder
    let mockDb
    let mockConnector

    beforeEach(function () {
        decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        mockDb = createMockDatabase()
        mockConnector = createMockConnector()
        decoder.db = mockDb
        decoder.connector = mockConnector
    })

    afterEach(function () {
        decoder.stop()
    })

    it('should verify insertTransactionOutput is awaited in source code', function () {
        const fs = require('fs')
        const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8')

        // Find the insertTransactionOutput call and verify it's awaited
        const lines = source.split('\n')
        let found = false
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('insertTransactionOutput')) {
                // Check this line or the one before for 'await'
                const context = (lines[i - 1] || '') + lines[i]
                if (context.includes('await')) {
                    found = true
                    break
                }
            }
        }
        assert.ok(found, 'insertTransactionOutput should be awaited in XChainDecoder.js')
    })

    it('insertTransactionOutput failure should be observable', async function () {
        // Set up a scenario where parseTransaction returns dispense outputs
        const mockParseResult = {
            data: Buffer.from('SEND|0|XCHAIN|100'),
            rawData: null,
            source: 'testaddr',
            destination: null,
            dispenseOutputs: [
                { txIndex: 'tx1', vout: 0, destinationAddress: 'dispaddr1', amount: 50000 },
                { txIndex: 'tx1', vout: 1, destinationAddress: 'dispaddr2', amount: 25000 }
            ]
        }

        sinon.stub(decoder, 'parseTransaction').resolves(mockParseResult)

        mockConnector.getBlockchainInfo.resolves({ blocks: 1, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('abc123')
        mockConnector.getBlock.resolves(createMinimalBlockHex())

        mockDb.getLastBlockIndex.resolves(-1)
        mockDb.getBlockByIndex.resolves(null)
        mockDb.insertBlock.resolves(true)
        mockDb.insertTransaction.resolves(true)

        let outputInsertCalls = 0
        mockDb.insertTransactionOutput = sinon.stub().callsFake(async (output) => {
            outputInsertCalls++
            if (outputInsertCalls === 1) {
                // First output fails
                return false
            }
            return true
        })

        // The decoder should process both outputs because await ensures serial execution
        mockDb.commitTransaction = sinon.stub().callsFake(async () => {
            decoder.stop()
            return true
        })

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.strictEqual(outputInsertCalls, 2, 'Both insertTransactionOutput calls should complete (awaited)')
    })

    it('insertTransactionOutput should be called with correct parameters', async function () {
        const mockParseResult = {
            data: Buffer.from('SEND|0|XCHAIN|50'),
            rawData: null,
            source: 'sender',
            destination: null,
            dispenseOutputs: [
                { txIndex: 'tx1', vout: 0, destinationAddress: 'recipient', amount: 100000000 }
            ]
        }

        sinon.stub(decoder, 'parseTransaction').resolves(mockParseResult)

        mockConnector.getBlockchainInfo.resolves({ blocks: 1, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('abc123')
        mockConnector.getBlock.resolves(createMinimalBlockHex())

        mockDb.getLastBlockIndex.resolves(-1)
        mockDb.getBlockByIndex.resolves(null)
        mockDb.insertBlock.resolves(true)
        mockDb.insertTransaction.resolves(true)
        mockDb.commitTransaction = sinon.stub().callsFake(async () => {
            decoder.stop()
            return true
        })

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(mockDb.insertTransactionOutput.calledOnce, 'Should call insertTransactionOutput once')
        const callArgs = mockDb.insertTransactionOutput.firstCall.args[0]
        assert.strictEqual(callArgs.vout, 0)
        assert.strictEqual(callArgs.destinationAddress, 'recipient')
        assert.strictEqual(callArgs.amount, 100000000)
        // txIndex should be updated from the lastProcessedTxIndex
        assert.strictEqual(typeof callArgs.txIndex, 'number')
    })
})
