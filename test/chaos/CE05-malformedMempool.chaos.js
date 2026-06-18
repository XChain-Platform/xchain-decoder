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
            'zzzz_not_hex',  // Invalid: should be caught and logged
            validCoinbaseTxHex  // Valid coinbase: will be parsed (coinbase returns null from parseTransaction)
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

    it('should reset mempoolBusy when deleteAndCompareTxsNotInList throws after the sort phase', async function () {
        // First unguarded post-sort await: a transient DB failure (connection drop,
        // lock timeout) here must not leave the busy flag stuck true.
        mockConnector.getRawMempool.resolves(['tx1', 'tx2'])
        mockDb.deleteAndCompareTxsNotInList.rejects(new Error('Lock wait timeout exceeded'))

        // The exception still propagates (the production setInterval callback has a
        // .catch() that logs it); what matters is the finally clears the busy flag.
        await captureConsole(async () => {
            await decoder.updateMempool().catch(() => {})
        })

        assert.strictEqual(decoder.mempoolBusy, false, 'mempoolBusy must be reset even when a post-sort DB op throws')
    })

    it('should reset mempoolBusy when insertMempoolTransaction throws', async function () {
        // Third unguarded post-sort await: an exception while persisting a parsed tx
        // must still clear the busy flag via the finally block.
        const validCoinbaseTxHex =
            '01000000' +
            '01' +
            '0000000000000000000000000000000000000000000000000000000000000000' +
            'ffffffff' +
            '07' + '04ffff001d0104' +
            'ffffffff' +
            '01' +
            '00f2052a01000000' +
            '43' +
            '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac' +
            '00000000'

        mockConnector.getRawMempool.resolves(['goodtx'])
        mockConnector.getRawTransactions.resolves([validCoinbaseTxHex])
        mockDb.deleteAndCompareTxsNotInList.resolves({ transactionsDeleted: 0 })
        // Force a non-null parse result so insertMempoolTransaction is reached.
        decoder.parseTransaction = sinon.stub().resolves({ source: 'src', destination: 'dst', amount: 0, data: null })
        mockDb.insertMempoolTransaction.rejects(new Error('Deadlock found when trying to get lock'))

        await captureConsole(async () => {
            await decoder.updateMempool().catch(() => {})
        })

        assert.strictEqual(decoder.mempoolBusy, false, 'mempoolBusy must be reset when insertMempoolTransaction throws')
    })

    it('should resume mempool tracking on the next tick after a post-sort DB throw', async function () {
        // Tick 1: post-sort DB op throws.
        mockConnector.getRawMempool.resolves(['tx1'])
        mockDb.deleteAndCompareTxsNotInList.rejects(new Error('Connection reset'))

        await captureConsole(async () => {
            await decoder.updateMempool().catch(() => {})
        })
        assert.strictEqual(decoder.mempoolBusy, false, 'flag should be clear after the failing tick')

        // Tick 2: DB recovers. The next tick must proceed normally rather than
        // short-circuiting on the busy guard (the original stuck-flag failure mode).
        mockConnector.getRawMempool.resetHistory()
        mockDb.deleteAndCompareTxsNotInList.resolves({ transactionsDeleted: 0 })
        mockConnector.getRawTransactions.resolves([])

        const { logs } = await captureConsole(async () => {
            await decoder.updateMempool()
        })

        assert.ok(mockConnector.getRawMempool.called, 'next tick must call getRawMempool, not short-circuit on the busy guard')
        assert.ok(!logs.some(l => l.includes('still busy')), 'next tick must not report the mempool as still busy')
        assert.strictEqual(decoder.mempoolBusy, false, 'flag should be clear after the recovered tick')
    })

    it('should verify the post-sort body is wrapped in try/finally that resets mempoolBusy in source', function () {
        const fs = require('fs')
        const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8')

        // The updateMempool body must end in a finally clause that clears the flag.
        const start = source.indexOf('async updateMempool')
        assert.ok(start >= 0, 'updateMempool method should exist')
        const body = source.slice(start)
        const finallyIdx = body.indexOf('finally')
        assert.ok(finallyIdx >= 0, 'updateMempool should contain a finally block')
        const finallyBlock = body.slice(finallyIdx, finallyIdx + 400)
        assert.ok(/this\.mempoolBusy\s*=\s*false/.test(finallyBlock),
            'the finally block should reset this.mempoolBusy = false')
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
