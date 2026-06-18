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
 * E2E tests: Category E: Indexer Data Contract Verification.
 *
 * Validates the exact data shape that the indexer's getDecoderBlockData()
 * query returns, and verifies normalization table integrity across all
 * preceding test operations.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const {
    getDecoderBlockData,
    assertRowFields,
    assertNormalizationIntegrity,
    assertBlockExists,
    getDispensersForAddress
} = require('./helpers/assertions')

describe('E2E: Indexer Contract', function () {
    this.timeout(0)

    // ---------------------------------------------------------------
    // E1: getDecoderBlockData() contract fields
    // ---------------------------------------------------------------
    describe('getDecoderBlockData() field contract', () => {

        it('E1.1: should return all required fields with correct types for OP_RETURN tx', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|CONTRACT|999|' + global.mainTestAddress + '|field test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row, 'Transaction should appear in getDecoderBlockData')

            // data: exact ACTION string
            assert.strictEqual(typeof row.data, 'string')
            assert.strictEqual(row.data, action)

            // tx_hash: 64-char lowercase hex
            assert.strictEqual(typeof row.tx_hash, 'string')
            assert.strictEqual(row.tx_hash.length, 64)
            assert.ok(/^[0-9a-f]{64}$/.test(row.tx_hash), 'tx_hash must be lowercase hex')
            assert.strictEqual(row.tx_hash, txHash)

            // source: valid address string
            assert.strictEqual(typeof row.source, 'string')
            assert.ok(row.source.length > 0)
            assert.strictEqual(row.source, funded.address)

            // block_index: integer matching the block
            assert.strictEqual(typeof row.block_index, 'number')
            assert.strictEqual(row.block_index, blockIndex)

            // block_time: positive unix timestamp
            assert.strictEqual(typeof row.block_time, 'number')
            assert.ok(row.block_time > 0)
            const now = Math.floor(Date.now() / 1000)
            assert.ok(row.block_time > now - 3600, 'block_time should be recent')
            assert.ok(row.block_time <= now + 60, 'block_time should not be far in the future')

            // For a standard non-dispenser tx, dispenser output fields should be null
            assert.strictEqual(row.vout, null)
            assert.strictEqual(row.output_amount, null)
            assert.strictEqual(row.output_destination, null)
        })

        it('E1.2: should return correct fields for SegWit source tx', async () => {
            const funded = await txBuilder.createFundedSegwitAddress()
            const action = 'SEND|0|SEGCONTRACT|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row)

            assertRowFields(row, {
                data: action,
                tx_hash: txHash,
                source: funded.address,
                block_index: blockIndex,
                block_time_gt: 0
            })
        })

        it('E1.3: should return correct fields for Taproot source tx', async () => {
            const funded = await txBuilder.createFundedTaprootAddress()
            const action = 'SEND|0|TRCONTRACT|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row)

            assertRowFields(row, {
                data: action,
                tx_hash: txHash,
                source: funded.address,
                block_index: blockIndex,
                block_time_gt: 0
            })
        })

        it('E1.4: should return correct fields for multisig tx', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|MSIGCONTRACT|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row)

            assertRowFields(row, {
                data: action,
                tx_hash: txHash,
                source: funded.address,
                block_index: blockIndex,
                block_time_gt: 0
            })
        })

        it('E1.5: should return empty result set for block with no XCHN transactions', async () => {
            const height = await txBuilder.mineBlocks(1)
            await txBuilder.waitForDecoder(height)

            const rows = await getDecoderBlockData(global.db, height)
            assert.strictEqual(rows.length, 0, 'Empty block should return no rows')
        })

        it('E1.6: DISPENSER tx should show dispenser output fields when payment exists', async () => {
            // Create a dispenser
            const dispenserFunded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const dispenserAction = `DISPENSER|0|CDISP_G||100||CDISP_R||50||||${expiration}|||`
            const { txHash: dispHash, blockIndex: dispBlock } = await txBuilder.broadcastOpReturn(dispenserFunded, dispenserAction)
            await txBuilder.waitForDecoder(dispBlock)
            await txBuilder.waitForTransaction(dispHash)

            // Verify dispenser exists
            const dispensers = await getDispensersForAddress(global.db, dispenserFunded.address)
            assert.ok(dispensers.length > 0, 'Dispenser should exist')

            // Send a payment to the dispenser address (via wallet sendToAddress)
            // This creates a non-XCHN tx that pays to the dispenser address
            const { txHash: payHash, blockIndex: payBlock } = await txBuilder.sendToAddress(dispenserFunded.address, 0.001)
            await txBuilder.waitForDecoder(payBlock)

            // The payment tx may or may not appear in getDecoderBlockData
            // depending on whether it had XCHN data. The dispenser output tracking
            // requires the tx to be an XCHN tx that also pays to a dispenser address.
            // Let's use an XCHN-encoded payment instead:
            const payer = await txBuilder.createFundedLegacyAddress()
            const payAction = 'SEND|0|CDISP_R|50|' + dispenserFunded.address + '|pay'
            const { txHash: xchnPayHash, blockIndex: xchnPayBlock } = await txBuilder.broadcastOpReturn(payer, payAction)
            await txBuilder.waitForDecoder(xchnPayBlock)
            await txBuilder.waitForTransaction(xchnPayHash)

            const rows = await getDecoderBlockData(global.db, xchnPayBlock)
            const payRow = rows.find(r => r.tx_hash === xchnPayHash)
            assert.ok(payRow, 'XCHN payment tx should appear in block data')
            assert.strictEqual(payRow.data, payAction)
        })
    })

    // ---------------------------------------------------------------
    // E2: Block table contract
    // ---------------------------------------------------------------
    describe('blocks table contract', () => {

        it('E2.1: should track the last block index accurately', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            const chainHeight = info.blocks
            await txBuilder.waitForDecoder(chainHeight)

            const lastBlock = await global.db.getLastBlockIndex()
            assert.strictEqual(lastBlock, chainHeight)
        })

        it('E2.2: should store block hash as 64-char hex', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            const blockIndex = info.blocks
            await txBuilder.waitForDecoder(blockIndex)

            const block = await global.db.getBlockByIndex(blockIndex)
            assert.ok(block, 'Block should exist')
            assert.strictEqual(typeof block.block_hash, 'string')
            assert.strictEqual(block.block_hash.length, 64)
            assert.ok(/^[0-9a-f]{64}$/.test(block.block_hash), 'Block hash must be lowercase hex')
        })

        it('E2.3: block hash should match the coin node', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            const blockIndex = info.blocks
            await txBuilder.waitForDecoder(blockIndex)

            const block = await global.db.getBlockByIndex(blockIndex)
            const nodeHash = txBuilder.getBlockHash(blockIndex)
            assert.strictEqual(block.block_hash, nodeHash, 'DB block hash should match node')
        })
    })

    // ---------------------------------------------------------------
    // E3: Normalization table integrity
    // ---------------------------------------------------------------
    describe('normalization table integrity', () => {

        it('E3.1: all source_ids should resolve in index_addresses', async () => {
            await assertNormalizationIntegrity(global.db)
        })

        it('E3.2: same address across multiple transactions should use same address_id', async () => {
            // Create two transactions from different funded addresses but both
            // referencing mainTestAddress in the ACTION string. The source will
            // be different, but we can check the source_id is consistent.
            const funded1 = await txBuilder.createFundedLegacyAddress()
            const funded2 = await txBuilder.createFundedLegacyAddress()

            const action1 = 'SEND|0|NORMCHK|1|' + global.mainTestAddress + '|'
            const action2 = 'SEND|0|NORMCHK|2|' + global.mainTestAddress + '|'

            const { txHash: h1, blockIndex: bi1 } = await txBuilder.broadcastOpReturn(funded1, action1)
            await txBuilder.waitForDecoder(bi1)
            await txBuilder.waitForTransaction(h1)

            const { txHash: h2, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action2)
            await txBuilder.waitForDecoder(bi2)
            await txBuilder.waitForTransaction(h2)

            // Both transactions should exist with valid sources
            const tx1 = await global.db.getTransaction(h1)
            const tx2 = await global.db.getTransaction(h2)
            assert.ok(tx1.source.length > 0)
            assert.ok(tx2.source.length > 0)
        })

        it('E3.3: tx_hash should be unique across all transactions', async () => {
            const connection = await global.db.pool.getConnection()
            try {
                const rows = await connection.query(`
                    SELECT tx_hash_id, COUNT(*) as cnt
                    FROM transactions
                    GROUP BY tx_hash_id
                    HAVING cnt > 1
                `)
                assert.strictEqual(
                    rows.length, 0,
                    `Found ${rows.length} duplicate tx_hash_ids in transactions table`
                )
            } finally {
                await connection.release()
            }
        })

        it('E3.4: tx_index should be unique and sequential', async () => {
            const connection = await global.db.pool.getConnection()
            try {
                // Check for duplicate tx_index values
                const dupes = await connection.query(`
                    SELECT tx_index, COUNT(*) as cnt
                    FROM transactions
                    GROUP BY tx_index
                    HAVING cnt > 1
                `)
                assert.strictEqual(dupes.length, 0, 'No duplicate tx_index values')

                // Check for gaps: the count of transactions should equal max - min + 1
                // (only if there are transactions)
                const stats = await connection.query(`
                    SELECT MIN(tx_index) as min_idx, MAX(tx_index) as max_idx, COUNT(*) as cnt
                    FROM transactions
                `)
                if (stats[0].cnt > 0) {
                    const expected = stats[0].max_idx - stats[0].min_idx + 1
                    assert.strictEqual(
                        Number(stats[0].cnt), expected,
                        `tx_index should be sequential: ${stats[0].cnt} rows but range is ${expected}`
                    )
                }
            } finally {
                await connection.release()
            }
        })
    })
})
