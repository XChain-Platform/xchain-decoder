/**
 * Micro-benchmark: AES-128-CTR deobfuscation throughput.
 *
 * Measures raw decryption performance at varying payload sizes,
 * isolating the crypto operation from all other decoder logic.
 */

const crypto = require('crypto')

const PAYLOAD_SIZES = [100, 500, 1024, 4096, 8192]
const DEFAULT_ITERATIONS = 50000

module.exports = {
    name: 'deobfuscation',
    description: 'AES-128-CTR deobfuscation throughput at varying payload sizes',

    async run(decoder, generator, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const results = {}

        for (const size of PAYLOAD_SIZES) {
            // Pre-generate encrypted payloads
            const txid = crypto.randomBytes(32).toString('hex')
            const plaintext = crypto.randomBytes(size)
            const key = txid.substr(0, 16)
            const iv = txid.substr(16, 16)
            const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
            const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

            const label = `deobfuscate_${size}B`

            // Warm up
            for (let i = 0; i < 100; i++) {
                await decoder.removeObfuscation(encrypted, txid)
            }

            // Timed run
            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await decoder.removeObfuscation(encrypted, txid)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6 // ms
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000 // microseconds

            metrics.record(label, elapsed)

            results[`${size}B`] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        return {
            scenario: 'deobfuscation',
            payloadSizes: PAYLOAD_SIZES,
            results
        }
    }
}
