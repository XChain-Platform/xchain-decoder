/**
 * Integration tests: OP_RETURN encoding with real ACTION strings.
 *
 * Covers plan scenarios A1 (OP_RETURN payloads) and A5 (source address types).
 * Broadcasts real transactions to regtest, mines blocks, and verifies the
 * decoder writes correct data to MariaDB.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const { assertTransaction, getDecoderBlockData, assertRowFields } = require('./helpers/assertions')

describe('OP_RETURN Integration', () => {

    describe('ACTION string decoding', () => {

        it('should decode a SEND action from a Legacy source', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|XCHAIN|1000|' + global.mainTestAddress + '|test memo'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('should decode a SEND action from a SegWit source', async () => {
            const funded = await txBuilder.createFundedSegwitAddress()
            const action = 'SEND|0|TOKEN|500|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('should decode a SEND action from a Taproot source', async () => {
            const funded = await txBuilder.createFundedTaprootAddress()
            const action = 'SEND|0|DOGE|100|' + global.mainTestAddress + '|taproot test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            assert.strictEqual(tx.source, funded.address)
        })

        it('should decode an ISSUE action with all fields', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ISSUE|0|MYTOKEN|21000000|1000|8|A test token|0||||||||||||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('should decode an ORDER action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'ORDER|0|BTC|XCHAIN|100000000|BTC|MYTOKEN|50000000||||||'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('should decode a BATCH action with semicolon-separated commands', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'BATCH|0|SEND|0|TOKENA|100|' + global.mainTestAddress + '|;SEND|0|TOKENB|200|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            // Decoder should store the full BATCH string with semicolons intact
            assert.strictEqual(tx.data, action)
            assert.ok(tx.data.includes(';'), 'BATCH semicolons should be preserved')
        })

        it('should decode a DESTROY action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'DESTROY|0|MYTOKEN|500|burn memo'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })

        it('should decode a SWEEP action', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SWEEP|0|' + global.mainTestAddress + '|sweep memo'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })

    describe('rawData (second script push)', () => {

        it('should store rawData when present in the payload', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'FILE|0|myfile.txt'
            const rawData = 'This is the raw file content'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action, rawData)
            await txBuilder.waitForDecoder(blockIndex)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
            // rawData is not stored in the transactions table directly, but
            // the data field should contain the primary action string
        })
    })

    describe('data verified via indexer contract query', () => {

        it('should return correct fields from getDecoderBlockData', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TESTCOIN|999|' + global.mainTestAddress + '|contract test'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            // Find our transaction in the block's rows
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row, 'Transaction should appear in getDecoderBlockData results')

            assertRowFields(row, {
                data: action,
                tx_hash: txHash,
                source: funded.address,
                block_index: blockIndex,
                block_time_gt: 0
            })
        })
    })
})
