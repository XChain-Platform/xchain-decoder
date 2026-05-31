const assert = require('assert')
const util = require('../../src/util')

describe('util', () => {

    describe('#uint8ArrayToHex()', () => {
        it('should convert a known byte array to hex', () => {
            const input = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
            assert.strictEqual(util.uint8ArrayToHex(input), 'deadbeef')
        })

        it('should return empty string for empty array', () => {
            assert.strictEqual(util.uint8ArrayToHex(new Uint8Array([])), '')
        })

        it('should zero-pad single-digit hex bytes', () => {
            const input = new Uint8Array([0x0a])
            assert.strictEqual(util.uint8ArrayToHex(input), '0a')
        })

        it('should handle 0x00 bytes', () => {
            const input = new Uint8Array([0x00, 0x00, 0xff])
            assert.strictEqual(util.uint8ArrayToHex(input), '0000ff')
        })

        it('should handle all 0xff bytes', () => {
            const input = new Uint8Array([0xff, 0xff])
            assert.strictEqual(util.uint8ArrayToHex(input), 'ffff')
        })
    })

    describe('#getDataHash()', () => {
        it('should return a deterministic SHA256 hex string', () => {
            const hash1 = util.getDataHash({ foo: 'bar' })
            const hash2 = util.getDataHash({ foo: 'bar' })
            assert.strictEqual(hash1, hash2)
            assert.strictEqual(hash1.length, 64) // SHA256 = 64 hex chars
        })

        it('should produce different hashes for different objects', () => {
            const hash1 = util.getDataHash({ a: 1 })
            const hash2 = util.getDataHash({ a: 2 })
            assert.notStrictEqual(hash1, hash2)
        })

        it('should handle an empty object', () => {
            const hash = util.getDataHash({})
            assert.strictEqual(typeof hash, 'string')
            assert.strictEqual(hash.length, 64)
        })
    })

    describe('#millisecondsToTimeString()', () => {
        it('should return empty string for 0ms', () => {
            assert.strictEqual(util.millisecondsToTimeString(0), '')
        })

        it('should format seconds correctly', () => {
            const result = util.millisecondsToTimeString(5200) // 5.2 seconds
            assert.ok(result.includes('05.2s'))
        })

        it('should format minutes and seconds', () => {
            const result = util.millisecondsToTimeString(125000) // 2m 5s
            assert.ok(result.includes('02m'))
            assert.ok(result.includes('05.0s'))
        })

        it('should format hours, minutes, seconds', () => {
            const result = util.millisecondsToTimeString(3661000) // 1h 1m 1s
            assert.ok(result.includes('01h'))
            assert.ok(result.includes('01m'))
            assert.ok(result.includes('01.0s'))
        })

        it('should format days', () => {
            const result = util.millisecondsToTimeString(90061000) // 1d 1h 1m 1s
            assert.ok(result.includes('1d'))
        })
    })

    describe('#throwError()', () => {
        it('should throw an Error with the given message', () => {
            // throwError re-throws whatever is passed; pass an Error so .message is set.
            assert.throws(() => {
                util.throwError(new Error('test error'))
            }, {
                message: 'test error'
            })
        })
    })

    describe('#sleep()', () => {
        it('should resolve after the given delay', async () => {
            const start = Date.now()
            await util.sleep(50)
            const elapsed = Date.now() - start
            assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`)
        })
    })
})
