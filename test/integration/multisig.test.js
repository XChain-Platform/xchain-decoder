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
 * Integration tests: Multisig encoding.
 *
 * Covers plan scenario A2. Verifies the decoder correctly extracts
 * XCHN data from 1-of-3 multisig outputs, strips trailing zeros,
 * and writes the decoded ACTION string to the database.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const { getDecoderBlockData } = require('./helpers/assertions')

describe('Multisig Integration', () => {

    it('should decode an ACTION from a 1-of-3 multisig output', async () => {
        const funded = await txBuilder.createFundedLegacyAddress()
        const action = 'SEND|0|MULTI|100|' + global.mainTestAddress + '|msig'
        const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
        await txBuilder.waitForDecoder(blockIndex)

        const tx = await txBuilder.waitForTransaction(txHash)
        assert.strictEqual(tx.data, action)
        assert.strictEqual(tx.source, funded.address)
    })

    it('should strip trailing zeros from multisig payload', async () => {
        const funded = await txBuilder.createFundedLegacyAddress()
        // Short action string — will have many trailing zeros in the 64-byte multisig space
        const action = 'SEND|0|X|1||'
        const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
        await txBuilder.waitForDecoder(blockIndex)

        const tx = await txBuilder.waitForTransaction(txHash)
        assert.strictEqual(tx.data, action)
        // Verify no trailing nulls leaked into the data
        assert.ok(!tx.data.includes('\0'), 'No null bytes in decoded data')
    })

    it('should appear correctly in the indexer contract query', async () => {
        const funded = await txBuilder.createFundedLegacyAddress()
        const action = 'ISSUE|0|MSIGTOKEN|1000|100|8|||||||||||||||||||'
        const { txHash, blockIndex } = await txBuilder.broadcastMultisig(funded, action)
        await txBuilder.waitForDecoder(blockIndex)
        await txBuilder.waitForTransaction(txHash)

        const rows = await getDecoderBlockData(global.db, blockIndex)
        const row = rows.find(r => r.tx_hash === txHash)
        assert.ok(row, 'Multisig tx should appear in getDecoderBlockData')
        assert.strictEqual(row.data, action)
        assert.strictEqual(row.source, funded.address)
        assert.ok(row.block_time > 0)
    })
})
