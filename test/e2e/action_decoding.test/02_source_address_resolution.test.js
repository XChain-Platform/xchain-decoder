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
const txBuilder = require('../helpers/txBuilder')

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    // ---------------------------------------------------------------
    // A3: Source address resolution across address types
    // ---------------------------------------------------------------
    describe('source address resolution', () => {

        it('A3.1:should resolve Legacy (P2PKH) source address', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|SRCTEST|1|' + global.mainTestAddress + '|legacy'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.source, funded.address)
            // P2PKH addresses start with 'm' or 'n' on regtest
            assert.ok(/^[mn]/.test(tx.source), 'Legacy address should start with m or n')
        })

        it('A3.2:should resolve SegWit (P2WPKH) source address', async () => {
            const funded = await txBuilder.createFundedSegwitAddress()
            const action = 'SEND|0|SRCTEST|1|' + global.mainTestAddress + '|segwit'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.source, funded.address)
            // P2WPKH addresses start with 'bcrt1q' on regtest
            assert.ok(tx.source.startsWith('bcrt1q'), 'SegWit address should start with bcrt1q')
        })
    })
})

describe('E2E: ACTION Decoding', function () {
    this.timeout(0)

    describe('source address resolution', () => {
        it('A3.3:should resolve Taproot (P2TR) source address', async () => {
            const funded = await txBuilder.createFundedTaprootAddress()
            const action = 'SEND|0|SRCTEST|1|' + global.mainTestAddress + '|taproot'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.source, funded.address)
            // P2TR addresses start with 'bcrt1p' on regtest
            assert.ok(tx.source.startsWith('bcrt1p'), 'Taproot address should start with bcrt1p')
        })

        it('A3.4:same ACTION from all three address types produces identical data', async () => {
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
})
