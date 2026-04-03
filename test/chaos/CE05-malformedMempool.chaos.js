/**
 * CE-05: Malformed Mempool Transaction
 *
 * Tests that the decoder handles malformed transaction hex in the
 * mempool gracefully without crashing. This validates the fix
 * applied to wrap transactionFromHex() in a try/catch.
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, createMockConnector, captureConsole } = require('./helpers')

describe('CE-05: Malformed Mempool Transaction', function () {
    let decoder
    let mockDb
    let mockConnector

    beforeEach(function () {
        decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        mockDb = createMockDatabase()
        mockConnector = createMockConnector()
        decoder.db = mockDb
        decoder.connector = mockConnector
        decoder.sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 50)))
    })

    afterEach(function () {
        decoder.stop()
    })

    it('should not crash on invalid transaction hex in mempool', async function () {
        mockConnector.getRawMempool.resolves(['tx1', 'tx2', 'tx3'])
        mockConnector.getRawTransactions.resolves([
            'deadbeef',   // Invalid tx hex
            null,         // Null entry
            'cafebabe'    // Another invalid hex
        ])
        mockDb.deleteAndCompareTxsNotInList.resolves({ transactionsDeleted: 0 })

        const { errors } = await captureConsole(async () => {
            await decoder.updateMempool()
        })

        const parseErrors = errors.filter(e => e.includes('failed to parse tx hex'))
        assert.ok(parseErrors.length >= 1, `Should log parse errors, got: ${JSON.stringify(errors)}`)
        assert.strictEqual(decoder.mempoolBusy, false, 'mempoolBusy should be reset after completion')
    })

    it('should continue processing after malformed tx', async function () {
        // Create a valid tx hex followed by an invalid one
        // Use the XChainBlockDecoder to understand what we need
        const validCoinbaseTxHex =
            '01000000' + // version
            '01' + // 1 input
            '0000000000000000000000000000000000000000000000000000000000000000' + // prev hash (coinbase)
            'ffffffff' + // prev index
            '07' + '04ffff001d0104' + // coinbase script
            'ffffffff' + // sequence
            '01' + // 1 output
            '00f2052a01000000' + // amount
            '43' + // script length (67 bytes)
            '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac' +
            '00000000' // locktime

        mockConnector.getRawMempool.resolves(['badtx', 'goodtx'])
        mockConnector.getRawTransactions.resolves([
            'zzzz_not_hex',  // Invalid — should be caught and logged
            validCoinbaseTxHex  // Valid coinbase — will be parsed (coinbase returns null from parseTransaction)
        ])
        mockDb.deleteAndCompareTxsNotInList.resolves({ transactionsDeleted: 0 })

        const { errors } = await captureConsole(async () => {
            await decoder.updateMempool()
        })

        assert.strictEqual(decoder.mempoolBusy, false, 'mempoolBusy should be false after completion')
        const parseErrors = errors.filter(e => e.includes('failed to parse tx hex'))
        assert.ok(parseErrors.length >= 1, 'Should have at least one parse error for the bad tx')
    })

    it('should skip mempool update when mempoolBusy is true', async function () {
        decoder.mempoolBusy = true

        const { logs } = await captureConsole(async () => {
            await decoder.updateMempool()
        })

        const busyLogs = logs.filter(l => l.includes('still busy'))
        assert.ok(busyLogs.length >= 1, 'Should log that mempool is busy')
        assert.ok(!mockConnector.getRawMempool.called, 'Should not call getRawMempool when busy')
    })

    it('should reset mempoolBusy on getRawMempool failure', async function () {
        mockConnector.getRawMempool.rejects(new Error('Connection lost'))

        await captureConsole(async () => {
            await decoder.updateMempool()
        })

        assert.strictEqual(decoder.mempoolBusy, false, 'mempoolBusy should be reset after failure')
    })

    it('should handle getRawTransactions batch failure and continue', async function () {
        const mempoolTxIds = Array.from({ length: 1500 }, (_, i) => `tx${i}`)
        mockConnector.getRawMempool.resolves(mempoolTxIds)
        mockDb.deleteAndCompareTxsNotInList.resolves({ transactionsDeleted: 0 })

        let batchCalls = 0
        mockConnector.getRawTransactions = sinon.stub().callsFake(async () => {
            batchCalls++
            if (batchCalls === 1) {
                throw new Error('Batch timeout')
            }
            return [] // Empty response for subsequent batches
        })

        await captureConsole(async () => {
            await decoder.updateMempool()
        })

        assert.ok(batchCalls >= 2, 'Should have attempted at least 2 batches despite first failure')
        assert.strictEqual(decoder.mempoolBusy, false, 'mempoolBusy should be reset')
    })

    it('should verify transactionFromHex is wrapped in try/catch in source', function () {
        const fs = require('fs')
        const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8')

        // Find the mempool section with transactionFromHex
        const lines = source.split('\n')
        let foundTryCatch = false
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('transactionFromHex') && lines[i].includes('xchainBlockDecoder')) {
                // Check preceding lines for try {
                for (let j = Math.max(0, i - 5); j < i; j++) {
                    if (lines[j].includes('try {') || lines[j].includes('try{')) {
                        foundTryCatch = true
                        break
                    }
                }
                // Check following lines for catch
                for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
                    if (lines[j].includes('catch')) {
                        foundTryCatch = true
                        break
                    }
                }
            }
        }
        assert.ok(foundTryCatch, 'transactionFromHex in mempool should be wrapped in try/catch')
    })
})
