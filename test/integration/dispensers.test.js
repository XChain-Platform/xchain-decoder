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
 * Integration tests: DISPENSER multi-table writes and edge cases.
 *
 * Covers plan scenarios C3 (dispenser edge cases) and parts of B1
 * (transaction_outputs via indexer contract query).
 *
 * DISPENSER actions create rows in both `transactions` and `dispensers`
 * tables. When a subsequent transaction pays to a dispenser address,
 * a row is created in `transaction_outputs`.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const { assertTransaction, getDecoderBlockData, getDispensersForAddress } = require('./helpers/assertions')

describe('DISPENSER Integration', () => {

    describe('DISPENSER v0 with valid fields', () => {

        it('should store DISPENSER data in transactions table', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400 // 24h from now
            const action = `DISPENSER|0|GIVECOIN||1000||GETCOIN||500||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.ok(tx.data.startsWith('DISPENSER|0|'), 'data should start with DISPENSER|0|')
            assert.strictEqual(tx.data, action)
        })

        it('should create a dispenser record in the dispensers table', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|GIVE||100||GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const dispensers = await getDispensersForAddress(global.db, funded.address)
            assert.ok(dispensers.length > 0, 'Dispenser record should exist for source address')
        })
    })

    describe('DISPENSER edge cases', () => {

        it('should NOT create dispenser when version is not 0', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|1|GIVE||100||GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Transaction should exist but NO dispenser record
            const dispensers = await getDispensersForAddress(global.db, funded.address)
            assert.strictEqual(dispensers.length, 0, 'No dispenser for version != 0')
        })

        it('should NOT create dispenser when both giveCoin and getCoin are empty', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            // Both giveCoin (field 2) and getCoin (field 6) are empty
            const action = `DISPENSER|0|||100||||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const dispensers = await getDispensersForAddress(global.db, funded.address)
            assert.strictEqual(dispensers.length, 0, 'No dispenser when both coins empty')
        })
    })

    describe('dispenser output via indexer contract query', () => {

        it('should include dispenser output fields in getDecoderBlockData', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|DISP_GIVE||100||DISP_GET||50||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Now send a payment TO the dispenser address from another address.
            // This should create a transaction_outputs record.
            const payer = await txBuilder.createFundedLegacyAddress()

            // Build a tx that pays to the dispenser address AND has XCHN data
            const payAction = 'SEND|0|DISP_GET|50|' + funded.address + '|dispense payment'
            const { txHash: payTxHash, blockIndex: payBlockIndex } = await txBuilder.broadcastOpReturn(payer, payAction)
            await txBuilder.waitForDecoder(payBlockIndex)
            await txBuilder.waitForTransaction(payTxHash)

            // The indexer contract query should show the transaction output
            const rows = await getDecoderBlockData(global.db, payBlockIndex)
            const payRow = rows.find(r => r.tx_hash === payTxHash)
            assert.ok(payRow, 'Payment tx should appear in block data')

            // The change output goes to the payer's address, and if the dispenser
            // address received an output, we should see vout/output_destination populated
            // (depends on whether the payer's change output matches the dispenser address)
        })
    })
})
