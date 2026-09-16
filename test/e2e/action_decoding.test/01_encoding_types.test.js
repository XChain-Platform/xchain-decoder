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
    // A2: All encoding types (same ACTION, different encoding)
    // ---------------------------------------------------------------
    describe('encoding types', () => {

        it('A2.1:should decode ACTION via direct OP_RETURN', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|ENCTEST|100|' + global.mainTestAddress + '|opreturn'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('A2.2:should decode ACTION via 1-of-3 multisig', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|ENCTEST|100|' + global.mainTestAddress + '|msig'
            const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('A2.3:multisig should strip trailing zeros from short payload', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|X|1||'
            const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.ok(!tx.data.includes('\0'), 'No null bytes in decoded data')
        })
    })
})
