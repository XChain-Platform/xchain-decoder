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
 * E2E tests: Category A - Full-Pipeline ACTION Decoding.
 *
 * Validates the complete path from raw blockchain transaction to correctly
 * structured ACTION data in MariaDB for all ACTION types, encoding methods,
 * and source address types.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const {
    getDecoderBlockData,
    assertRowFields,
    assertTransaction
} = require('./helpers/assertions')

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    // ---------------------------------------------------------------
    // A1: All ACTION types via OP_RETURN
    // ---------------------------------------------------------------
    describe('ACTION types via OP_RETURN', () => {

        it('A1.1: should decode SEND action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|XCHAIN|1000|' + global.mainTestAddress + '|e2e test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('A1.2:should decode ISSUE action with all fields', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ISSUE|0|E2ETOKEN|21000000|1000|8|E2E test token|0||||||||||||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.3:should decode ORDER action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ORDER|0|BTC|XCHAIN|100000000|BTC|E2ETOKEN|50000000||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.4:should decode DESTROY action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'DESTROY|0|E2ETOKEN|500|burn in e2e'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })
})

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    describe('ACTION types via OP_RETURN', () => {

        it('A1.5:should decode SWEEP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SWEEP|0|' + global.mainTestAddress + '|sweep memo'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.6:should decode BATCH action with semicolons preserved', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'BATCH|0|SEND|0|TOKENA|100|' + global.mainTestAddress + '|;SEND|0|TOKENB|200|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.ok(tx.data.includes(';'), 'Semicolons should be preserved in BATCH')
        })

        it('A1.7:should decode DISPENSER action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|GIVECOIN||1000||GETCOIN||500||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.8:should decode BROADCAST action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'BROADCAST|0|Hello from E2E test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })
})

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    describe('ACTION types via OP_RETURN', () => {

        it('A1.9:should decode DIVIDEND action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'DIVIDEND|0|E2ETOKEN|1000|XCHAIN|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.10:should decode MINT action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'MINT|0|E2ETOKEN|500|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.11:should decode FILE action with rawData', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'FILE|0|test.txt'
            const rawData = 'E2E file content payload'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action, rawData)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.12:should decode AIRDROP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'AIRDROP|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })
})

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    describe('ACTION types via OP_RETURN', () => {

        it('A1.13:should decode CALLBACK action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'CALLBACK|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.14:should decode LIST action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'LIST|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.15:should decode LINK action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'LINK|0|E2ETOKEN|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.16:should decode MESSAGE action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'MESSAGE|0|Hello World E2E|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })
})

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    describe('ACTION types via OP_RETURN', () => {

        it('A1.17:should decode SLEEP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SLEEP|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.18:should decode SWAP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SWAP|0|E2ETOKEN|100|XCHAIN|50|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.19:should decode ADDRESS action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ADDRESS|0|' + global.mainTestAddress + '|label|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.20:should decode TRANSFER action and store it under its canonical SEND name', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const params = '|0|E2ETOKEN|500|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, 'TRANSFER' + params)
            await txBuilder.waitForDecoder(blockIndex)

            // TRANSFER is a short-form ALIAS of SEND (XChainDecoder.ACTION_ALIASES).
            // The decoder deliberately rewrites the stored payload to the canonical
            // name so the DB never holds two spellings of one action, so the row
            // reads SEND. Asserting the raw wire string back was asserting the
            // absence of a feature the decoder documents.
            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, 'SEND' + params)
        })
    })
})
