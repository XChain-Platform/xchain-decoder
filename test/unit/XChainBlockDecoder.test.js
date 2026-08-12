// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const { Transaction } = require('bitcoinjs-lib')
const XChainBlockDecoder = require('../../src/XChainBlockDecoder')

// 80-byte block header: version=2, prevHash=0xaa*32, merkleRoot=0xbb*32, timestamp=1700000000, bits, nonce
const HEADER_HEX = '02000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00f15365ffff001d39300000'

describe('XChainBlockDecoder', () => {

    describe('constructor', () => {
        it('should parse coin name from "bitcoin-regtest"', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            assert.strictEqual(decoder.coin, 'bitcoin')
        })

        it('should parse coin name from "litecoin-mainnet"', () => {
            const decoder = new XChainBlockDecoder('litecoin-mainnet')
            assert.strictEqual(decoder.coin, 'litecoin')
        })

        it('should parse coin name from "dogecoin-testnet"', () => {
            const decoder = new XChainBlockDecoder('dogecoin-testnet')
            assert.strictEqual(decoder.coin, 'dogecoin')
        })

        // Wire-format family is resolved from the canonical coin registry
        // (src/coins) rather than a hardcoded coin-name list, so onboarding a
        // chain declares its parse shape in one place.
        it('resolves wireFormat from the coin registry', () => {
            assert.strictEqual(new XChainBlockDecoder('bitcoin-regtest').wireFormat, 'default')
            assert.strictEqual(new XChainBlockDecoder('litecoin-mainnet').wireFormat, 'mweb')
            assert.strictEqual(new XChainBlockDecoder('dogecoin-testnet').wireFormat, 'auxpow')
        })

        // An unknown coin used to fall through silently to the strict bitcoinjs
        // default parser and wedge/misparse at its first AuxPoW/MWEB block; the
        // decoder now refuses at construction so onboarding a new chain must
        // consciously declare its wire shape.
        it('throws for a coin with no declared wire-format contract', () => {
            assert.throws(() => new XChainBlockDecoder('some-extra-dashed-name'),
                /no block\/tx wire-format contract declared for coin "some"/)
            assert.throws(() => new XChainBlockDecoder('namecoin-mainnet'),
                /namecoin/)
        })
    })

    describe('#doubleSha256AndReverse()', () => {
        it('should return a deterministic result for known input', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const input = Buffer.from('hello world')
            const result = decoder.doubleSha256AndReverse(input)

            // double SHA256 of "hello world" is known
            const first = crypto.createHash('sha256').update(input).digest()
            const second = crypto.createHash('sha256').update(first).digest()
            const expected = Buffer.from(second).reverse()

            assert.ok(result.equals(expected))
        })

        it('should return a 32-byte buffer', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const result = decoder.doubleSha256AndReverse(Buffer.from('test'))
            assert.strictEqual(result.length, 32)
        })

        it('should produce different results for different inputs', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const r1 = decoder.doubleSha256AndReverse(Buffer.from('a'))
            const r2 = decoder.doubleSha256AndReverse(Buffer.from('b'))
            assert.ok(!r1.equals(r2))
        })

        it('should handle empty buffer', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const result = decoder.doubleSha256AndReverse(Buffer.alloc(0))
            assert.strictEqual(result.length, 32)
        })
    })

    describe('#blockFromHex()', () => {
        it('should parse a header-only block (80 bytes, no transactions)', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const block = decoder.blockFromHex(HEADER_HEX)

            assert.strictEqual(block.version, 2)
            assert.strictEqual(block.timestamp, 1700000000)
        })

        it('should return prevHash as a 32-byte buffer', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const block = decoder.blockFromHex(HEADER_HEX)

            assert.strictEqual(block.prevHash.length, 32)
        })

        it('should return merkleRoot as a 32-byte buffer', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const block = decoder.blockFromHex(HEADER_HEX)

            assert.strictEqual(block.merkleRoot.length, 32)
        })

        it('should throw for buffer smaller than 80 bytes', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const shortHex = HEADER_HEX.substring(0, 100) // 50 bytes

            assert.throws(() => {
                decoder.blockFromHex(shortHex)
            })
        })

        it('should throw for empty hex', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            assert.throws(() => {
                decoder.blockFromHex('')
            })
        })

        it('should use default (bitcoinjs) parser for non-litecoin coins', () => {
            // bitcoin and dogecoin both use the default path
            const btcDecoder = new XChainBlockDecoder('bitcoin-regtest')
            const dogeDecoder = new XChainBlockDecoder('dogecoin-mainnet')

            const btcBlock = btcDecoder.blockFromHex(HEADER_HEX)
            const dogeBlock = dogeDecoder.blockFromHex(HEADER_HEX)

            assert.strictEqual(btcBlock.version, dogeBlock.version)
            assert.strictEqual(btcBlock.timestamp, dogeBlock.timestamp)
        })
    })

    describe('#blockFromBuffer()', () => {
        it('should parse a buffer the same as blockFromHex', () => {
            const decoder = new XChainBlockDecoder('bitcoin-regtest')
            const buf = Buffer.from(HEADER_HEX, 'hex')

            const block1 = decoder.blockFromHex(HEADER_HEX)
            const block2 = decoder.blockFromBuffer(buf)

            assert.strictEqual(block1.version, block2.version)
            assert.strictEqual(block1.timestamp, block2.timestamp)
        })
    })

    describe('#transactionFromHex()', () => {
        it('should parse a standard bitcoin transaction', () => {
            const btcDecoder = new XChainBlockDecoder('bitcoin-regtest')
            const txHex = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'
            const tx = btcDecoder.transactionFromHex(txHex)

            assert.ok(tx)
            assert.strictEqual(tx.ins.length, 1)
            assert.strictEqual(tx.outs.length, 2)
        })

        it('[REGRESSION P2] R-NET-002: should strip MWEB flag (0x08) from litecoin transactions', () => {
            const ltcDecoder = new XChainBlockDecoder('litecoin-mainnet')
            // Build a v2 tx with marker=0x00, flag=0x08 (MWEB)
            // version(4) + marker(1) + flag(1) + varint inputs(1)=0 + varint outputs(1)=0 + locktime(4)
            const txHex = '02000000' + '00' + '08' + '00' + '00' + '00000000'
            // After stripping marker+flag: 02000000 + 00 + 00 + 00000000
            // This is a tx with 0 inputs, 0 outputs
            const tx = ltcDecoder.transactionFromHex(txHex)
            assert.ok(tx)
            assert.strictEqual(tx.ins.length, 0)
        })

        it('[REGRESSION P2] R-NET-002: should strip MWEB+segwit flag (0x09) from litecoin transactions', () => {
            const ltcDecoder = new XChainBlockDecoder('litecoin-mainnet')
            const txHex = '02000000' + '00' + '09' + '00' + '00' + '00000000'
            const tx = ltcDecoder.transactionFromHex(txHex)
            assert.ok(tx)
            assert.strictEqual(tx.ins.length, 0)
        })

        it('[REGRESSION P2] R-NET-002: should not strip flags for bitcoin transactions', () => {
            const btcDecoder = new XChainBlockDecoder('bitcoin-regtest')
            // A v1 tx with no special flags, just 0 inputs/outputs
            const txHex = '01000000' + '00' + '00' + '00000000'
            const tx = btcDecoder.transactionFromHex(txHex)
            assert.ok(tx)
        })

        it('[REGRESSION P2] R-NET-002: should not strip non-MWEB flags on litecoin (flag != 0x08 or 0x09)', () => {
            const ltcDecoder = new XChainBlockDecoder('litecoin-mainnet')

            // Build a genuinely valid segwit litecoin tx: marker 0x00, flag 0x01
            // (ordinary segwit, NOT MWEB). Only flags 0x08/0x09 must be stripped, so
            // this tx's marker+flag and its witness data must survive decode intact.
            const witnessTx = new Transaction()
            witnessTx.version = 2
            witnessTx.addInput(Buffer.alloc(32, 1), 0)
            witnessTx.addOutput(Buffer.from('0014' + '00'.repeat(20), 'hex'), 1000)
            witnessTx.setWitness(0, [Buffer.from('deadbeef', 'hex')])
            const txHex = witnessTx.toHex()

            // Sanity: the fixture really is a flag-0x01 segwit tx.
            assert.strictEqual(txHex.substr(8, 2), '00', 'fixture marker byte should be 0x00')
            assert.strictEqual(txHex.substr(10, 2), '01', 'fixture flag byte should be 0x01')

            const parsed = ltcDecoder.transactionFromHex(txHex)

            // If the strip logic were widened to catch flag 0x01, the marker+flag
            // bytes would be removed and this would fail: the tx would lose its
            // witness structure and no longer round-trip to the original hex.
            assert.ok(parsed.hasWitnesses(), 'non-MWEB segwit witness data must be preserved')
            assert.strictEqual(parsed.toHex(), txHex, 'non-MWEB flag tx must round-trip unchanged (not stripped)')
        })
    })

    describe('Litecoin-specific parsing', () => {
        it('should parse a litecoin header-only block identically to bitcoin', () => {
            const ltcDecoder = new XChainBlockDecoder('litecoin-mainnet')
            const btcDecoder = new XChainBlockDecoder('bitcoin-regtest')

            const ltcBlock = ltcDecoder.blockFromHex(HEADER_HEX)
            const btcBlock = btcDecoder.blockFromHex(HEADER_HEX)

            assert.strictEqual(ltcBlock.version, btcBlock.version)
            assert.strictEqual(ltcBlock.timestamp, btcBlock.timestamp)
        })

        it('should handle litecoin blocks where last tx has no HogEx flag', () => {
            const ltcDecoder = new XChainBlockDecoder('litecoin-regtest')
            // Header-only is safe: no transactions means no HogEx check
            const block = ltcDecoder.blockFromHex(HEADER_HEX)
            assert.ok(block)
        })
    })
})
