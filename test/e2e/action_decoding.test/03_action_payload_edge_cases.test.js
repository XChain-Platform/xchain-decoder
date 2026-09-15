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
    // A4: Edge cases in ACTION payloads
    // ---------------------------------------------------------------
    describe('ACTION payload edge cases', () => {

        it('A4.1:should handle ACTION with empty memo field', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TOKEN|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A4.2:should handle ACTION with many trailing pipe-delimited empty fields', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ISSUE|0|EDGE|1000|100|8|||||||||||||||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A4.3:should handle ACTION with special characters in memo', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TOKEN|1|' + global.mainTestAddress + '|hello & goodbye < > "'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A4.4:should handle minimum-length ACTION', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|X|1||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })
})
