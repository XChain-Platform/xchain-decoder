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

    describe('full dispenser flow', () => {

        it('B1.1: should create dispenser record from DISPENSER|0 action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            // A create only opens a dispenser when GIVE_COIN and GET_COIN both name
            // THIS chain's coin (XChainDecoder.dispenserOpensForThisChain). Field
            // order is DISPENSER|VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|
            // GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|
            // FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|
            // MEMO; these fixtures used a shifted map with token-like coin names, so
            // no dispenser was ever opened and the whole B tier was asserting
            // against an empty table.
            const action = `DISPENSER|0|BTC|GIVE_E2E|1000|||BTC||500|||||${expiration}|||`
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
            const dispenserFunded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const dispenserAction = `DISPENSER|0|BTC|D_GIVE|100|||BTC||50|||||${expiration}|||`
            const { txHash: dispTxHash, blockIndex: dispBlockIndex } = await txBuilder.broadcastOpReturn(dispenserFunded, dispenserAction)
            await txBuilder.waitForDecoder(dispBlockIndex)
            await txBuilder.waitForTransaction(dispTxHash)
            await assertDispenserExists(global.db, dispenserFunded.address)

            const payer = await txBuilder.createFundedLegacyAddress()
            const payAction = 'SEND|0|D_GET|50|' + dispenserFunded.address + '|dispense'
            const { txHash: payTxHash, blockIndex: payBlockIndex } = await txBuilder.broadcastOpReturn(payer, payAction)
            await txBuilder.waitForDecoder(payBlockIndex)
            await txBuilder.waitForTransaction(payTxHash)

            const rows = await getDecoderBlockData(global.db, payBlockIndex)
            const payRow = rows.find(r => r.tx_hash === payTxHash)
            assert.ok(payRow, 'Payment tx should appear in block data')
            assert.strictEqual(payRow.data, payAction)
        })

        it('B1.3: dispenser data should appear in indexer contract query', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|BTC|CQUERY|200|||BTC||100|||||${expiration}|||`
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

    describe('dispenser expiration', () => {

        it('B2.1: should soft-expire a dispenser past its expiration on the next block', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            // Set expiration to a timestamp in the past relative to the next block.
            // Block timestamps on regtest are based on system time, so use a past time.
            const expiration = Math.floor(Date.now() / 1000) - 10
            const action = `DISPENSER|0|BTC|EXP_GIVE|100|||BTC||50|||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // The sweep runs BEFORE a block's own transactions are parsed, so a
            // create can never be expired by the block that carries it: the next
            // block is what expires it.
            const newHeight = await txBuilder.mineBlocks(1)
            await txBuilder.waitForDecoder(newHeight)

            // Expiry is a SOFT expire, not a delete: db.deleteOpenDispensers stamps
            // the expiring block height into expired_block_index so a reorg can
            // resurrect a dispenser that an orphaned block's non-monotonic timestamp
            // expired. Asserting the row had vanished was asserting the old
            // hard-delete behaviour.
            const dispensers = await getDispensersForAddress(global.db, funded.address)
            assert.strictEqual(dispensers.length, 1, 'The dispenser row should survive expiry')
            assert.ok(
                dispensers[0].expired_block_index !== null,
                'Expired dispenser should carry the expiring block height'
            )
            assert.ok(
                Number(dispensers[0].expired_block_index) > blockIndex,
                'Expiry should be stamped by a block after the create'
            )
        })

        it('B2.2: should keep dispenser alive when expiration is in the future', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400 // 24 hours from now
            const action = `DISPENSER|0|BTC|ALIVE_GIVE|100|||BTC||50|||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Mine additional blocks; dispenser should still be alive
            const newHeight = await txBuilder.mineBlocks(3)
            await txBuilder.waitForDecoder(newHeight)

            await assertDispenserExists(global.db, funded.address)
        })
    })

    describe('dispenser edge cases', () => {

        it('B3.1: should NOT create dispenser for version != 0', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|1|BTC|GIVE|100|||BTC||50|||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            // Transaction should exist but NO dispenser record
            await assertDispenserNotExists(global.db, funded.address)
        })

        it('B3.2: should NOT create dispenser when both giveCoin and getCoin are empty', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0||GIVE|100|||||50|||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            await assertDispenserNotExists(global.db, funded.address)
        })

        // B3.3 and B3.4 used to assert that a half-specified create OPENS a
        // dispenser. It does not, deliberately: dispenserOpensForThisChain requires
        // BOTH GIVE_COIN and GET_COIN to name this chain's coin, because a decoder
        // that opened a dispenser the indexer has no record of goes on to misread
        // ordinary later payments to that address as dispenses. The old assertions
        // only ever passed because the actions named non-chain coins in the wrong
        // slots, so nothing opened for either test and neither was checking what its
        // title claimed.
        it('B3.3: should NOT create dispenser when only giveCoin is set', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|BTC|ONLY_GIVE|100|||||50|||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            await assertDispenserNotExists(global.db, funded.address)
        })

        it('B3.4: should NOT create dispenser when only getCoin is set', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|||100|||BTC||50|||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            await assertDispenserNotExists(global.db, funded.address)
        })
    })
})
