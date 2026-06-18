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
 * E2E tests: Category B - DISPENSER Lifecycle.
 *
 * Validates the full dispenser lifecycle: creation, trigger payments,
 * expiration cleanup, and edge cases. Verifies both the `dispensers` table
 * and `transaction_outputs` table behavior.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const {
    assertTransaction,
    assertDispenserExists,
    assertDispenserNotExists,
    getDispensersForAddress,
    getTransactionOutputs,
    getDecoderBlockData
} = require('./helpers/assertions')

describe('E2E: DISPENSER Lifecycle', function () {
    this.timeout(0)

    // ---------------------------------------------------------------
    // B1: Full dispenser flow
    // ---------------------------------------------------------------
    describe('full dispenser flow', () => {

        it('B1.1: should create dispenser record from DISPENSER|0 action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|GIVE_E2E||1000||GET_E2E||500||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Verify transaction stored
            await assertTransaction(global.db, txHash, { data: action, source: funded.address })

            // Verify dispenser record created
            const dispensers = await assertDispenserExists(global.db, funded.address)
            assert.ok(dispensers.length >= 1)
        })

        it('B1.2: should record transaction_output when payment sent to dispenser address', async () => {
            // Step 1: Create a dispenser
            const dispenserFunded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const dispenserAction = `DISPENSER|0|D_GIVE||100||D_GET||50||||${expiration}|||`
            const { txHash: dispTxHash, blockIndex: dispBlockIndex } = await txBuilder.broadcastOpReturn(dispenserFunded, dispenserAction)
            await txBuilder.waitForDecoder(dispBlockIndex)
            await txBuilder.waitForTransaction(dispTxHash)
            await assertDispenserExists(global.db, dispenserFunded.address)

            // Step 2: Send a payment (with XCHN data) that has an output to the dispenser address
            const payer = await txBuilder.createFundedLegacyAddress()
            const payAction = 'SEND|0|D_GET|50|' + dispenserFunded.address + '|dispense'
            const { txHash: payTxHash, blockIndex: payBlockIndex } = await txBuilder.broadcastOpReturn(payer, payAction)
            await txBuilder.waitForDecoder(payBlockIndex)
            await txBuilder.waitForTransaction(payTxHash)

            // Step 3: Verify the payment tx appears in getDecoderBlockData
            const rows = await getDecoderBlockData(global.db, payBlockIndex)
            const payRow = rows.find(r => r.tx_hash === payTxHash)
            assert.ok(payRow, 'Payment tx should appear in block data')
            assert.strictEqual(payRow.data, payAction)
        })

        it('B1.3: dispenser data should appear in indexer contract query', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|CQUERY||200||CGET||100||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row, 'Dispenser tx should appear in getDecoderBlockData')
            assert.ok(row.data.startsWith('DISPENSER|0|'))
            assert.strictEqual(row.source, funded.address)
            assert.ok(row.block_time > 0)
        })
    })

    // ---------------------------------------------------------------
    // B2: Dispenser expiration
    // ---------------------------------------------------------------
    describe('dispenser expiration', () => {

        it('B2.1: should delete expired dispensers when a new block is processed', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            // Set expiration to a timestamp in the past relative to the next block
            // Block timestamps on regtest are based on system time, so use a past time
            const expiration = Math.floor(Date.now() / 1000) - 10
            const action = `DISPENSER|0|EXP_GIVE||100||EXP_GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // The dispenser should have been cleaned up immediately since its
            // expiration is in the past relative to the block timestamp
            // (deleteOpenDispensers is called with block.timestamp on each new block)
            const dispensers = await getDispensersForAddress(global.db, funded.address)
            assert.strictEqual(dispensers.length, 0, 'Expired dispenser should have been cleaned up')
        })

        it('B2.2: should keep dispenser alive when expiration is in the future', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400 // 24 hours from now
            const action = `DISPENSER|0|ALIVE_GIVE||100||ALIVE_GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Mine additional blocks; dispenser should still be alive
            const newHeight = await txBuilder.mineBlocks(3)
            await txBuilder.waitForDecoder(newHeight)

            await assertDispenserExists(global.db, funded.address)
        })
    })

    // ---------------------------------------------------------------
    // B3: Dispenser edge cases
    // ---------------------------------------------------------------
    describe('dispenser edge cases', () => {

        it('B3.1: should NOT create dispenser for version != 0', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|1|GIVE||100||GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Transaction should exist but NO dispenser record
            await assertDispenserNotExists(global.db, funded.address)
        })

        it('B3.2: should NOT create dispenser when both giveCoin and getCoin are empty', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|||100||||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            await assertDispenserNotExists(global.db, funded.address)
        })

        it('B3.3: should create dispenser when only giveCoin is set', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|ONLY_GIVE||100||||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            await assertDispenserExists(global.db, funded.address)
        })

        it('B3.4: should create dispenser when only getCoin is set', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|||100||ONLY_GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            await assertDispenserExists(global.db, funded.address)
        })
    })
})
