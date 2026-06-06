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
 * E2E tests: Category D — Error Handling & Malformed Data.
 *
 * Validates that the decoder correctly rejects non-XCHN transactions,
 * handles corrupted payloads gracefully, and continues processing after
 * encountering invalid data.
 */

const assert = require('assert')
const crypto = require('crypto')
const txBuilder = require('./helpers/txBuilder')
const {
    assertNoTransaction,
    assertTransaction,
    getDecoderBlockData
} = require('./helpers/assertions')

describe('E2E: Error Handling', function () {
    this.timeout(0)

    // ---------------------------------------------------------------
    // D1: Non-XCHN transaction rejection
    // ---------------------------------------------------------------
    describe('non-XCHN transaction rejection', () => {

        it('D1.1 — should not store a plain BTC transfer (no OP_RETURN)', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const { txHash, blockIndex } = await txBuilder.broadcastPlainTransaction(funded)
            await txBuilder.waitForDecoder(blockIndex)

            // Give decoder extra time to process
            await new Promise(r => setTimeout(r, 2000))

            const tx = await global.db.getTransaction(txHash)
            assert.strictEqual(tx, null, 'Plain BTC transfer should not be in decoder DB')
        })

        it('D1.2 — should not store a transaction with random OP_RETURN bytes', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded)
            await txBuilder.waitForDecoder(blockIndex)
            await new Promise(r => setTimeout(r, 2000))

            await assertNoTransaction(global.db, txHash)
        })

        it('D1.3 — should not store a transaction with text OP_RETURN', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const textData = Buffer.from('HELLO WORLD THIS IS NOT XCHN DATA', 'utf-8')
            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded, textData)
            await txBuilder.waitForDecoder(blockIndex)
            await new Promise(r => setTimeout(r, 2000))

            await assertNoTransaction(global.db, txHash)
        })

        it('D1.4 — should not store OP_RETURN starting with "XCHN" but not obfuscated', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            // Raw "XCHN" prefix without proper AES encryption won't deobfuscate correctly
            const fakeXchn = Buffer.from('XCHNthis_is_fake_data_not_encrypted')
            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded, fakeXchn)
            await txBuilder.waitForDecoder(blockIndex)
            await new Promise(r => setTimeout(r, 2000))

            // After deobfuscation, this won't have the XCHN magic word, so it should be rejected
            const tx = await global.db.getTransaction(txHash)
            assert.strictEqual(tx, null, 'Fake XCHN data should not be stored')
        })

        it('D1.5 — should skip coinbase transactions', async () => {
            // Mine a block with only a coinbase (no user transactions)
            const height = await txBuilder.mineBlocks(1)
            await txBuilder.waitForDecoder(height)

            // Query the block — it should have no XCHN transactions
            const rows = await getDecoderBlockData(global.db, height)
            assert.strictEqual(rows.length, 0, 'Coinbase-only block should have no XCHN rows')
        })
    })

    // ---------------------------------------------------------------
    // D2: Corrupted XCHN payloads
    // ---------------------------------------------------------------
    describe('corrupted XCHN payloads', () => {

        it('D2.1 — truncated payload should not crash decoder', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()

            // Create a valid XCHN prefix but truncate the payload
            const truncated = txBuilder.obfuscate(
                Buffer.from('XCHN'),  // Just the prefix, no ACTION data
                funded.txid
            )

            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded, truncated)
            await txBuilder.waitForDecoder(blockIndex)
            await new Promise(r => setTimeout(r, 2000))

            // Decoder should not crash — verify by processing the next transaction
            const funded2 = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|AFTERTRUNC|1|' + global.mainTestAddress + '|'
            const { txHash: hash2, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action)
            await txBuilder.waitForDecoder(bi2)

            const tx2 = await txBuilder.waitForTransaction(hash2)
            assert.strictEqual(tx2.data, action, 'Decoder should still work after truncated payload')
        })

        it('D2.2 — binary garbage after XCHN prefix should not crash decoder', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()

            // Valid XCHN prefix + random garbage
            const garbage = Buffer.concat([
                Buffer.from('XCHN'),
                crypto.randomBytes(30)
            ])
            const obfuscated = txBuilder.obfuscate(garbage, funded.txid)

            const { txHash, blockIndex } = await txBuilder.broadcastNonXchnOpReturn(funded, obfuscated)
            await txBuilder.waitForDecoder(blockIndex)
            await new Promise(r => setTimeout(r, 2000))

            // Decoder should continue — verify with next valid tx
            const funded2 = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|AFTERGARBAGE|1|' + global.mainTestAddress + '|'
            const { txHash: hash2, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action)
            await txBuilder.waitForDecoder(bi2)

            const tx2 = await txBuilder.waitForTransaction(hash2)
            assert.strictEqual(tx2.data, action, 'Decoder should still work after garbage payload')
        })
    })

    // ---------------------------------------------------------------
    // D3: Decoder stability after mixed valid/invalid blocks
    // ---------------------------------------------------------------
    describe('decoder stability', () => {

        it('D3.1 — should process valid tx after a block with only invalid data', async () => {
            // Send 3 invalid transactions in sequence
            for (let i = 0; i < 3; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                await txBuilder.broadcastNonXchnOpReturn(funded)
            }

            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks)

            // Now send a valid XCHN transaction
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|STABLE|999|' + global.mainTestAddress + '|stability test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('D3.2 — should store only valid tx from mixed valid+invalid sequence', async () => {
            // Alternate invalid and valid transactions
            const invalidFunded1 = await txBuilder.createFundedLegacyAddress()
            const { txHash: invalidHash1, blockIndex: bi1 } = await txBuilder.broadcastPlainTransaction(invalidFunded1)
            await txBuilder.waitForDecoder(bi1)

            const validFunded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|MIXED|100|' + global.mainTestAddress + '|valid'
            const { txHash: validHash, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(validFunded, action)
            await txBuilder.waitForDecoder(bi2)

            const invalidFunded2 = await txBuilder.createFundedLegacyAddress()
            const { txHash: invalidHash2, blockIndex: bi3 } = await txBuilder.broadcastNonXchnOpReturn(invalidFunded2)
            await txBuilder.waitForDecoder(bi3)

            // Only the valid tx should be in the DB
            await assertNoTransaction(global.db, invalidHash1)
            const validTx = await txBuilder.waitForTransaction(validHash)
            assert.strictEqual(validTx.data, action)
            await assertNoTransaction(global.db, invalidHash2)
        })

        it('D3.3 — should handle empty blocks gracefully', async () => {
            // Mine blocks with no user transactions (just coinbase)
            const startBlock = await global.db.getLastBlockIndex()
            const newHeight = await txBuilder.mineBlocks(5)
            await txBuilder.waitForDecoder(newHeight)

            // Verify blocks are tracked but no XCHN transactions added
            const lastBlock = await global.db.getLastBlockIndex()
            assert.strictEqual(lastBlock, newHeight, 'Decoder should track empty blocks')

            // Verify no XCHN rows for any of the empty blocks
            for (let h = startBlock + 1; h <= newHeight; h++) {
                const rows = await getDecoderBlockData(global.db, h)
                assert.strictEqual(rows.length, 0, `Empty block ${h} should have no XCHN rows`)
            }
        })

        it('D3.4 — decoder should be synced after processing all test blocks', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks)

            assert.ok(global.decoder.isSynced(), 'Decoder should report synced after processing')
        })
    })
})
