const assert = require('assert')
const XChainBlockDecoder = require('../../src/XChainBlockDecoder')

// 80-byte block header: version=2, prevHash=0xaa*32, merkleRoot=0xbb*32, timestamp=1700000000, bits, nonce
const HEADER_HEX = '02000000' +
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
    '00f15365' +
    'ffff001d' +
    '39300000'

describe('Smoke: XChainBlockDecoder', () => {
    it('should parse a bitcoin header-only block', () => {
        const decoder = new XChainBlockDecoder('bitcoin-regtest')
        const block = decoder.blockFromHex(HEADER_HEX)

        assert.ok(block)
        assert.strictEqual(block.version, 2)
        assert.strictEqual(block.prevHash.length, 32)
        assert.ok(block.timestamp > 0)
    })

    it('should parse a litecoin header-only block', () => {
        const decoder = new XChainBlockDecoder('litecoin-mainnet')
        const block = decoder.blockFromHex(HEADER_HEX)

        assert.ok(block)
        assert.strictEqual(block.version, 2)
        assert.strictEqual(block.prevHash.length, 32)
        assert.ok(block.timestamp > 0)
    })

    it('should parse a dogecoin header-only block', () => {
        const decoder = new XChainBlockDecoder('dogecoin-mainnet')
        const block = decoder.blockFromHex(HEADER_HEX)

        assert.ok(block)
        assert.strictEqual(block.version, 2)
        assert.ok(block.timestamp > 0)
    })

    it('should parse a standard bitcoin transaction hex', () => {
        const decoder = new XChainBlockDecoder('bitcoin-regtest')
        const txHex = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

        const tx = decoder.transactionFromHex(txHex)
        assert.ok(tx)
        assert.strictEqual(tx.ins.length, 1)
        assert.strictEqual(tx.outs.length, 2)
    })

    it('should throw on empty hex', () => {
        const decoder = new XChainBlockDecoder('bitcoin-regtest')
        assert.throws(() => decoder.blockFromHex(''))
    })

    it('should throw on truncated hex (< 80 bytes)', () => {
        const decoder = new XChainBlockDecoder('bitcoin-regtest')
        assert.throws(() => decoder.blockFromHex(HEADER_HEX.substring(0, 100)))
    })
})
