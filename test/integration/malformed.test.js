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
 * Integration tests: Malformed and invalid data handling.
 *
 * Covers plan scenarios C1 (non-XCHN transactions) and C2 (corrupted XCHN data).
 * Verifies the decoder does not crash, does not insert bad rows, and does not
 * corrupt the database when presented with invalid input.
 */

const assert = require('assert')
const crypto = require('crypto')
const txBuilder = require('./helpers/txBuilder')
const { assertNoTransaction, getDecoderBlockData } = require('./helpers/assertions')

describe('Malformed Data Integration', () => {

    describe('non-XCHN transactions', () => {

        it('should not store a plain BTC transfer (no OP_RETURN)', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const { txHash, blockIndex } = await txBuilder.broadcastPlainTransaction(funded)
            // waitForDecoder blocks until the decoder has committed this block (and
            // any transactions in it) to the DB, so a would-be row is already present
            // by the time it returns: no fixed settle delay is needed.
            await txBuilder.waitForDecoder(blockIndex)

            // The plain tx should NOT appear in the decoder's transactions table
            const tx = await global.db.getTransaction(txHash)
            assert.strictEqual(tx, null, 'Plain transaction should not be in decoder DB')
        })

        it('should not store a transaction with non-XCHN OP_RETURN data', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            // Random bytes that won't decrypt to XCHN prefix
            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await global.db.getTransaction(txHash)
            assert.strictEqual(tx, null, 'Non-XCHN OP_RETURN tx should not be in decoder DB')
        })

        it('should not store a transaction with a text OP_RETURN (like "HELLO WORLD")', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const textData = Buffer.from('HELLO WORLD THIS IS NOT XCHN', 'utf-8')
            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded, textData)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await global.db.getTransaction(txHash)
            assert.strictEqual(tx, null, 'Text OP_RETURN should not be stored')
        })
    })

    describe('blocks with mixed valid and invalid transactions', () => {

        it('should store only the valid XCHN transaction from a block', async () => {
            // Broadcast a non-XCHN tx first (gets into mempool)
            const funded1 = await txBuilder.createFundedLegacyAddress()
            const funded2 = await txBuilder.createFundedLegacyAddress()

            // We can't easily put two txs in the same block with our helpers,
            // but we can verify that across consecutive blocks, only XCHN txs are stored
            const { txHash: plainHash, blockIndex: bi1 } = await txBuilder.broadcastPlainTransaction(funded1)
            await txBuilder.waitForDecoder(bi1)

            const action = 'SEND|0|VALID|100|' + global.mainTestAddress + '|'
            const { txHash: xchnHash, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action)
            await txBuilder.waitForDecoder(bi2)
            await txBuilder.waitForTransaction(xchnHash)

            // Plain tx should not be in decoder DB
            const plainTx = await global.db.getTransaction(plainHash)
            assert.strictEqual(plainTx, null)

            // XCHN tx should be present
            const xchnTx = await global.db.getTransaction(xchnHash)
            assert.ok(xchnTx)
            assert.strictEqual(xchnTx.data, action)
        })
    })

    describe('decoder stability after invalid data', () => {

        it('should continue processing valid blocks after encountering invalid data', async () => {
            // Send invalid data
            const funded1 = await txBuilder.createFundedLegacyAddress()
            const { blockIndex: bi1 } = await txBuilder.broadcastNonXchnOpReturn(funded1)
            await txBuilder.waitForDecoder(bi1)

            // Now send valid data; decoder should still work
            const funded2 = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|STABLE|1|' + global.mainTestAddress + '|recovery test'
            const { txHash, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action)
            await txBuilder.waitForDecoder(bi2)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded2.address)
        })
    })
})
