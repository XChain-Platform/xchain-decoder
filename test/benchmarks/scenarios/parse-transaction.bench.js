/**
 * Micro-benchmark: parseTransaction() throughput.
 *
 * Measures full transaction parsing including deobfuscation and source
 * address resolution (via mock connector). Tests both OP_RETURN and
 * multisig encoding types.
 */

const bitcoin = require('bitcoinjs-lib')

const DEFAULT_ITERATIONS = 5000

module.exports = {
    name: 'parse-transaction',
    description: 'parseTransaction() throughput for OP_RETURN and multisig transactions',

    async run(decoder, generator, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const results = {}

        // --- OP_RETURN transactions ---
        {
            // Pre-generate transaction data
            const txData = []
            for (let i = 0; i < iterations; i++) {
                const entry = generator.generateXChainOpReturnTx({
                    action: 'SEND|0|XCHAIN|100|destaddr|memo'
                })
                txData.push(entry)
                // Register funding tx in the mock connector
                decoder.connector.transactions.set(entry.fundingTxId, entry.fundingTxHex)
            }

            // Warm up
            for (let i = 0; i < 10; i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('parse_opreturn', elapsed)

            results.opreturn = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // --- Multisig transactions ---
        {
            const txData = []
            for (let i = 0; i < iterations; i++) {
                const entry = generator.generateXChainMultisigTx({
                    action: 'SEND|0|XCHAIN|100|destaddr|memo'
                })
                txData.push(entry)
                decoder.connector.transactions.set(entry.fundingTxId, entry.fundingTxHex)
            }

            for (let i = 0; i < 10; i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('parse_multisig', elapsed)

            results.multisig = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // --- Plain (non-XChain) transactions (early-exit path) ---
        {
            const txData = []
            for (let i = 0; i < iterations; i++) {
                const entry = generator.generatePlainTx()
                txData.push(entry)
                decoder.connector.transactions.set(entry.fundingTxId, entry.fundingTxHex)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000

            metrics.record('parse_plain', elapsed)

            results.plain = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }
        }

        return {
            scenario: 'parse-transaction',
            results
        }
    }
}
