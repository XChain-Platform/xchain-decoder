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
 * E2E tests: Category A — Full-Pipeline ACTION Decoding.
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

        it('A1.1 — should decode SEND action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|XCHAIN|1000|' + global.mainTestAddress + '|e2e test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('A1.2 — should decode ISSUE action with all fields', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ISSUE|0|E2ETOKEN|21000000|1000|8|E2E test token|0||||||||||||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.3 — should decode ORDER action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ORDER|0|BTC|XCHAIN|100000000|BTC|E2ETOKEN|50000000||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.4 — should decode DESTROY action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'DESTROY|0|E2ETOKEN|500|burn in e2e'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.5 — should decode SWEEP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SWEEP|0|' + global.mainTestAddress + '|sweep memo'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.6 — should decode BATCH action with semicolons preserved', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'BATCH|0|SEND|0|TOKENA|100|' + global.mainTestAddress + '|;SEND|0|TOKENB|200|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.ok(tx.data.includes(';'), 'Semicolons should be preserved in BATCH')
        })

        it('A1.7 — should decode DISPENSER action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const expiration = Math.floor(Date.now() / 1000) + 86400
            const action = `DISPENSER|0|GIVECOIN||1000||GETCOIN||500||||${expiration}|||`
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.8 — should decode BROADCAST action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'BROADCAST|0|Hello from E2E test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.9 — should decode DIVIDEND action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'DIVIDEND|0|E2ETOKEN|1000|XCHAIN|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.10 — should decode MINT action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'MINT|0|E2ETOKEN|500|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.11 — should decode FILE action with rawData', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'FILE|0|test.txt'
            const rawData = 'E2E file content payload'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action, rawData)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.12 — should decode AIRDROP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'AIRDROP|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.13 — should decode CALLBACK action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'CALLBACK|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.14 — should decode LIST action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'LIST|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.15 — should decode LINK action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'LINK|0|E2ETOKEN|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.16 — should decode MESSAGE action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'MESSAGE|0|Hello World E2E|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.17 — should decode SLEEP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SLEEP|0|E2ETOKEN|100|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.18 — should decode SWAP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SWAP|0|E2ETOKEN|100|XCHAIN|50|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.19 — should decode ADDRESS action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ADDRESS|0|' + global.mainTestAddress + '|label|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A1.20 — should decode TRANSFER action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'TRANSFER|0|E2ETOKEN|500|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })

    // ---------------------------------------------------------------
    // A2: All encoding types (same ACTION, different encoding)
    // ---------------------------------------------------------------
    describe('encoding types', () => {

        it('A2.1 — should decode ACTION via direct OP_RETURN', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|ENCTEST|100|' + global.mainTestAddress + '|opreturn'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A2.2 — should decode ACTION via 1-of-3 multisig', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|ENCTEST|100|' + global.mainTestAddress + '|msig'
            const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('A2.3 — multisig should strip trailing zeros from short payload', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|X|1||'
            const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.ok(!tx.data.includes('\0'), 'No null bytes in decoded data')
        })
    })

    // ---------------------------------------------------------------
    // A3: Source address resolution across address types
    // ---------------------------------------------------------------
    describe('source address resolution', () => {

        it('A3.1 — should resolve Legacy (P2PKH) source address', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|SRCTEST|1|' + global.mainTestAddress + '|legacy'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.source, funded.address)
            // P2PKH addresses start with 'm' or 'n' on regtest
            assert.ok(/^[mn]/.test(tx.source), 'Legacy address should start with m or n')
        })

        it('A3.2 — should resolve SegWit (P2WPKH) source address', async () => {
            const funded = await txBuilder.createFundedSegwitAddress()
            const action = 'SEND|0|SRCTEST|1|' + global.mainTestAddress + '|segwit'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.source, funded.address)
            // P2WPKH addresses start with 'bcrt1q' on regtest
            assert.ok(tx.source.startsWith('bcrt1q'), 'SegWit address should start with bcrt1q')
        })

        it('A3.3 — should resolve Taproot (P2TR) source address', async () => {
            const funded = await txBuilder.createFundedTaprootAddress()
            const action = 'SEND|0|SRCTEST|1|' + global.mainTestAddress + '|taproot'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.source, funded.address)
            // P2TR addresses start with 'bcrt1p' on regtest
            assert.ok(tx.source.startsWith('bcrt1p'), 'Taproot address should start with bcrt1p')
        })

        it('A3.4 — same ACTION from all three address types produces identical data', async () => {
            const fundedLegacy = await txBuilder.createFundedLegacyAddress()
            const fundedSegwit = await txBuilder.createFundedSegwitAddress()
            const fundedTaproot = await txBuilder.createFundedTaprootAddress()

            const action = 'SEND|0|SAME|42|' + global.mainTestAddress + '|'

            const r1 = await txBuilder.broadcastOpReturn(fundedLegacy, action)
            await txBuilder.waitForDecoder(r1.blockIndex)
            const tx1 = await txBuilder.waitForTransaction(r1.txHash)

            const r2 = await txBuilder.broadcastOpReturn(fundedSegwit, action)
            await txBuilder.waitForDecoder(r2.blockIndex)
            const tx2 = await txBuilder.waitForTransaction(r2.txHash)

            const r3 = await txBuilder.broadcastOpReturn(fundedTaproot, action)
            await txBuilder.waitForDecoder(r3.blockIndex)
            const tx3 = await txBuilder.waitForTransaction(r3.txHash)

            // All three should decode to the same ACTION string
            assert.strictEqual(tx1.data, action)
            assert.strictEqual(tx2.data, action)
            assert.strictEqual(tx3.data, action)

            // But each should have a different source address
            assert.notStrictEqual(tx1.source, tx2.source)
            assert.notStrictEqual(tx2.source, tx3.source)
        })
    })

    // ---------------------------------------------------------------
    // A4: Edge cases in ACTION payloads
    // ---------------------------------------------------------------
    describe('ACTION payload edge cases', () => {

        it('A4.1 — should handle ACTION with empty memo field', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TOKEN|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A4.2 — should handle ACTION with many trailing pipe-delimited empty fields', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ISSUE|0|EDGE|1000|100|8|||||||||||||||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A4.3 — should handle ACTION with special characters in memo', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TOKEN|1|' + global.mainTestAddress + '|hello & goodbye < > "'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A4.4 — should handle minimum-length ACTION', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|X|1||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })
})
