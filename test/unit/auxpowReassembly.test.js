// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

//  regression: a DOGE/LTC block whose AuxPoW section skipAuxPow cannot
// traverse used to retry at the same height forever (a permanent wedge). The
// decoder now falls back, after AUXPOW_REASSEMBLE_AFTER consecutive fetch
// failures at one height, to reassembling the pure block from getblockheader
// + verbose getblock + per-txid getrawtransaction, which never reads the
// AuxPoW bytes at all.

const assert = require('assert')
const BlockchainConnector = require('../../src/BlockchainConnector')
const { encodeVarintHex } = require('../../src/BlockchainConnector')
const XChainDecoder = require('../../src/XChainDecoder')
const { AUXPOW_REASSEMBLE_AFTER } = require('../../src/XChainDecoder')
const XChainBlockDecoder = require('../../src/XChainBlockDecoder')

// Minimal legacy tx (1 coinbase-style input, 1 empty-script output).
const TX_HEX =
    '01000000' +
    '01' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    'ffffffff' + '00' + 'ffffffff' +
    '01' + '0100000000000000' + '00' +
    '00000000'
const TXID = 'a'.repeat(64)
// 80-byte header (160 hex chars); content is irrelevant to reassembly.
const HEADER_HEX = '04016200' + '11'.repeat(76)

function makeConnector(overrides) {
    const connector = new BlockchainConnector('127.0.0.1', 0, 'user', 'pass')
    return Object.assign(connector, overrides)
}

describe('malformed-AuxPoW block reassembly fallback ', function () {

    describe('encodeVarintHex', function () {
        it('encodes each varint width and refuses >2^32-1', function () {
            assert.strictEqual(encodeVarintHex(0), '00')
            assert.strictEqual(encodeVarintHex(0xFC), 'fc')
            assert.strictEqual(encodeVarintHex(0xFD), 'fdfd00')
            assert.strictEqual(encodeVarintHex(0xFFFF), 'fdffff')
            assert.strictEqual(encodeVarintHex(0x10000), 'fe00000100')
            assert.strictEqual(encodeVarintHex(0xFFFFFFFF), 'feffffffff')
            assert.throws(() => encodeVarintHex(0x100000000), /out of supported range/)
        })
    })

    describe('BlockchainConnector.getBlockReassembled', function () {
        it('rebuilds header + tx-count varint + raw txs, parseable as a block', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlockVerbose: async () => ({ tx: [TXID, TXID] }),
                getRawTransaction: async () => TX_HEX,
            })
            const hex = await connector.getBlockReassembled('hash')
            assert.strictEqual(hex, HEADER_HEX + '02' + TX_HEX + TX_HEX)
            const block = new XChainBlockDecoder('dogecoin-mainnet').blockFromHex(hex)
            assert.strictEqual(block.transactions.length, 2)
        })

        it('uses only the first 80 header bytes when getblockheader appends AuxPoW bytes', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX + 'ab'.repeat(40),
                getBlockVerbose: async () => ({ tx: [TXID] }),
                getRawTransaction: async () => TX_HEX,
            })
            assert.strictEqual(await connector.getBlockReassembled('hash'), HEADER_HEX + '01' + TX_HEX)
        })

        it('fails loudly when an in-block tx cannot be fetched', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlockVerbose: async () => ({ tx: [TXID] }),
                getRawTransaction: async () => null,
            })
            await assert.rejects(() => connector.getBlockReassembled('hash'), /no raw tx for in-block txid/)
        })
    })

    describe('XChainDecoder.fetchBlockHex', function () {
        function makeDecoder(auxPow, connector) {
            // litecoin so the constructor's force-auxPow-for-dogecoin rule does not
            // override the auxPow argument in the non-AuxPoW case.
            const decoder = new XChainDecoder('litecoin-regtest', '127.0.0.1', 3306, 'db', 'u', 'p',
                '127.0.0.1', 0, 'u', 'p', auxPow, null)
            decoder.connector = connector
            return decoder
        }

        it('uses getBlockWithoutAuxPow below the failure threshold', async function () {
            const calls = []
            const decoder = makeDecoder(true, {
                getBlockWithoutAuxPow: async () => { calls.push('strip'); return 'aa' },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            decoder._fetchErrorCount = AUXPOW_REASSEMBLE_AFTER - 1
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'aa')
            assert.deepStrictEqual(calls, ['strip'])
        })

        it('falls back to getBlockReassembled at the failure threshold', async function () {
            const calls = []
            const decoder = makeDecoder(true, {
                getBlockWithoutAuxPow: async () => { calls.push('strip'); throw new Error('malformed AuxPoW') },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            decoder._fetchErrorCount = AUXPOW_REASSEMBLE_AFTER
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'bb')
            assert.deepStrictEqual(calls, ['reassemble'])
        })

        it('never reassembles on a non-AuxPoW chain', async function () {
            const calls = []
            const decoder = makeDecoder(false, {
                getBlock: async () => { calls.push('getBlock'); return 'cc' },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            decoder._fetchErrorCount = AUXPOW_REASSEMBLE_AFTER + 10
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'cc')
            assert.deepStrictEqual(calls, ['getBlock'])
        })
    })
})
