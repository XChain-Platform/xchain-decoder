const assert = require('assert')
const crypto = require('crypto')
const XChainDecoder = require('../../src/XChainDecoder')

function createDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
}

function encrypt(plaintext, txid) {
    const key = txid.substr(0, 16)
    const iv = txid.substr(16, 16)
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    let encrypted = cipher.update(Buffer.from(plaintext))
    return Buffer.concat([encrypted, cipher.final()])
}

const VALID_TXID = 'aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011'

describe('Security: Deobfuscation Robustness', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    // --- AES-128-CTR key/IV derivation ---

    describe('Key/IV derivation from txid', () => {
        it('should use first 16 chars of txid as key', async () => {
            const plaintext = 'XCHNtest'
            const encrypted = encrypt(plaintext, VALID_TXID)
            const result = await decoder.removeObfuscation(encrypted, VALID_TXID)

            assert.strictEqual(result.toString('utf-8'), plaintext)
        })

        it('should produce different output for txids that differ only in key portion', async () => {
            const txid1 = 'aaaaaaaaaaaaaaaa' + VALID_TXID.substr(16)
            const txid2 = 'bbbbbbbbbbbbbbbb' + VALID_TXID.substr(16)
            const encrypted = encrypt('XCHNtest', txid1)

            const result = await decoder.removeObfuscation(encrypted, txid2)
            assert.notStrictEqual(result.toString('utf-8'), 'XCHNtest')
        })

        it('should produce different output for txids that differ only in IV portion', async () => {
            const txid1 = VALID_TXID.substr(0, 16) + 'aaaaaaaaaaaaaaaa' + VALID_TXID.substr(32)
            const txid2 = VALID_TXID.substr(0, 16) + 'bbbbbbbbbbbbbbbb' + VALID_TXID.substr(32)
            const encrypted = encrypt('XCHNtest', txid1)

            const result = await decoder.removeObfuscation(encrypted, txid2)
            assert.notStrictEqual(result.toString('utf-8'), 'XCHNtest')
        })
    })

    // --- Corrupted ciphertext ---

    describe('Corrupted ciphertext handling', () => {
        it('should return a buffer (not crash) for corrupted ciphertext', async () => {
            const corrupted = crypto.randomBytes(100)
            const result = await decoder.removeObfuscation(corrupted, VALID_TXID)

            assert.ok(Buffer.isBuffer(result))
        })

        it('should return a buffer for a single zero byte', async () => {
            const result = await decoder.removeObfuscation(Buffer.from([0x00]), VALID_TXID)
            assert.ok(Buffer.isBuffer(result))
            assert.strictEqual(result.length, 1)
        })

        it('should return a buffer for all-zero ciphertext', async () => {
            const zeros = Buffer.alloc(64, 0)
            const result = await decoder.removeObfuscation(zeros, VALID_TXID)

            assert.ok(Buffer.isBuffer(result))
            assert.strictEqual(result.length, 64)
        })

        it('should return a buffer for all-0xFF ciphertext', async () => {
            const maxBytes = Buffer.alloc(64, 0xff)
            const result = await decoder.removeObfuscation(maxBytes, VALID_TXID)

            assert.ok(Buffer.isBuffer(result))
            assert.strictEqual(result.length, 64)
        })

        it('should handle very large ciphertext without crashing', async () => {
            const largeData = crypto.randomBytes(100000)
            const result = await decoder.removeObfuscation(largeData, VALID_TXID)

            assert.ok(Buffer.isBuffer(result))
            assert.strictEqual(result.length, 100000)
        })
    })

    // --- XCHN magic word collision probability ---

    describe('Magic word false positive resistance', () => {
        it('should not produce XCHN prefix from random data (100 iterations)', async () => {
            let falsePositives = 0

            for (let i = 0; i < 100; i++) {
                const randomData = crypto.randomBytes(32)
                const randomTxid = crypto.randomBytes(32).toString('hex')
                const result = await decoder.removeObfuscation(randomData, randomTxid)

                if (result && result.length >= 4 && result.subarray(0, 4).equals(Buffer.from('XCHN'))) {
                    falsePositives++
                }
            }

            // The probability of a 4-byte match is ~1/4.3 billion, so 0 expected in 100 trials
            assert.strictEqual(falsePositives, 0, 'Should not have XCHN false positives in 100 random trials')
        })
    })

    // --- Non-buffer inputs ---

    describe('Non-buffer input rejection', () => {
        it('should return null for string input', async () => {
            const result = await decoder.removeObfuscation('XCHN payload', VALID_TXID)
            assert.strictEqual(result, null)
        })

        it('should return null for number input', async () => {
            const result = await decoder.removeObfuscation(42, VALID_TXID)
            assert.strictEqual(result, null)
        })

        it('should return null for array input', async () => {
            const result = await decoder.removeObfuscation([0x58, 0x43, 0x48, 0x4e], VALID_TXID)
            assert.strictEqual(result, null)
        })

        it('should return null for object input', async () => {
            const result = await decoder.removeObfuscation({ data: 'test' }, VALID_TXID)
            assert.strictEqual(result, null)
        })

        it('should return null for boolean input', async () => {
            const result = await decoder.removeObfuscation(true, VALID_TXID)
            assert.strictEqual(result, null)
        })
    })
})
