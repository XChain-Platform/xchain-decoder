// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression guard: a DOGE/LTC block whose AuxPoW section skipAuxPow cannot
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

describe('malformed-AuxPoW block reassembly fallback', function () {

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

        it('fetches txs through the bounded batch helper, not serially', async function () {
            const batchCalls = []
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlockVerbose: async () => ({ tx: [TXID, TXID, TXID] }),
                getRawTransactions: async (txids) => { batchCalls.push(txids); return txids.map(() => TX_HEX) },
                getRawTransaction: async () => { throw new Error('serial per-tx path must not be used') },
            })
            const hex = await connector.getBlockReassembled('hash')
            assert.strictEqual(hex, HEADER_HEX + '03' + TX_HEX + TX_HEX + TX_HEX)
            assert.strictEqual(batchCalls.length, 1)
            assert.deepStrictEqual(batchCalls[0], [TXID, TXID, TXID])
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

    describe('BlockchainConnector.probeTxIndex', function () {
        it('returns true when the tip coinbase is retrievable without a blockhash', async function () {
            const connector = makeConnector({
                getBlockchainInfo: async () => ({ blocks: 100, bestblockhash: 'tip' }),
                getBlockVerbose: async () => ({ tx: [TXID] }),
                getRawTransaction: async (txid) => { assert.strictEqual(txid, TXID); return TX_HEX },
            })
            assert.strictEqual(await connector.probeTxIndex(), true)
        })

        it('returns false when getrawtransaction finds nothing (txindex missing)', async function () {
            const connector = makeConnector({
                getBlockchainInfo: async () => ({ blocks: 100, bestblockhash: 'tip' }),
                getBlockVerbose: async () => ({ tx: [TXID] }),
                getRawTransaction: async () => null,
            })
            assert.strictEqual(await connector.probeTxIndex(), false)
        })

        it('returns null on an empty chain (genesis coinbase is never indexed)', async function () {
            const connector = makeConnector({
                getBlockchainInfo: async () => ({ blocks: 0, bestblockhash: 'genesis' }),
                getBlockVerbose: async () => { throw new Error('must not be called for genesis-only chain') },
            })
            assert.strictEqual(await connector.probeTxIndex(), null)
        })

        it('returns null (never throws) when the probe RPCs fail', async function () {
            const connector = makeConnector({
                getBlockchainInfo: async () => { throw new Error('node down') },
            })
            assert.strictEqual(await connector.probeTxIndex(), null)
        })
    })

    describe('XChainDecoder.fetchBlockHex', function () {
        // Select the strip path by NETWORK, not by a flag: the constructor derives
        // auxPow solely from the coin's declared wireFormat, so dogecoin-* is the only
        // way to reach getBlockWithoutAuxPow and litecoin-* the only way to reach plain
        // getBlock. The trailing constructor argument is the now-inert auxPow parameter,
        // passed false to prove it is not consulted.
        function makeDecoder(network, connector) {
            const decoder = new XChainDecoder(network, '127.0.0.1', 3306, 'db', 'u', 'p',
                '127.0.0.1', 0, 'u', 'p', false, null)
            decoder.connector = connector
            return decoder
        }

        it('uses getBlockWithoutAuxPow below the failure threshold', async function () {
            const calls = []
            const decoder = makeDecoder('dogecoin-regtest', {
                getBlockWithoutAuxPow: async () => { calls.push('strip'); return 'aa' },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            decoder._auxPowParseErrorCount = AUXPOW_REASSEMBLE_AFTER - 1
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'aa')
            assert.deepStrictEqual(calls, ['strip'])
        })

        it('falls back to getBlockReassembled at the failure threshold', async function () {
            const calls = []
            const decoder = makeDecoder('dogecoin-regtest', {
                getBlockWithoutAuxPow: async () => { calls.push('strip'); throw new Error('malformed AuxPoW') },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            decoder._auxPowParseErrorCount = AUXPOW_REASSEMBLE_AFTER
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'bb')
            assert.deepStrictEqual(calls, ['reassemble'])
        })

        it('never reassembles on a non-AuxPoW chain', async function () {
            const calls = []
            const decoder = makeDecoder('litecoin-regtest', {
                getBlock: async () => { calls.push('getBlock'); return 'cc' },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            decoder._auxPowParseErrorCount = AUXPOW_REASSEMBLE_AFTER + 10
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'cc')
            assert.deepStrictEqual(calls, ['getBlock'])
        })

        // Transport faults must never reach the escalation counter. A Dogecoin 1.14
        // node that drops the TCP connection when its RPC queue fills
        // surfaces as a bare ECONNRESET; escalating on that pointed getBlockReassembled's
        // per-tx getrawtransaction fan-out at the very node that was already saturated.
        it('does not reassemble when transport faults, not content faults, drove the count', async function () {
            const calls = []
            const decoder = makeDecoder('dogecoin-regtest', {
                getBlockWithoutAuxPow: async () => { calls.push('strip'); return 'aa' },
                getBlockReassembled: async () => { calls.push('reassemble'); return 'bb' },
            })
            // Every consecutive failure at this height was transport, so the all-errors
            // counter is way past the threshold and the content counter is still zero.
            decoder._fetchErrorCount = AUXPOW_REASSEMBLE_AFTER + 20
            decoder._auxPowParseErrorCount = 0
            assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'aa')
            assert.deepStrictEqual(calls, ['strip'], 'a transport-fault streak must not escalate')
        })
    })

    // The classification seam itself. getBlockWithoutAuxPow used to wrap every throw
    // (RPC included) in a bare Error, discarding error.code, so the decoder could not
    // tell node overload from a malformed block.
    describe('getBlockWithoutAuxPow fault classification', function () {
        function connErr(code) {
            const e = new Error(code)
            e.code = code
            return e
        }

        it('propagates an RPC transport fault unwrapped, with error.code intact', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => { throw connErr('ECONNRESET') },
                getBlock: async () => { throw new Error('must not be reached') },
            })
            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('hash'),
                (err) => {
                    assert.strictEqual(err.code, 'ECONNRESET', 'error.code must survive')
                    assert.ok(!err.auxPowParseFailure, 'a transport fault is not a content fault')
                    return true
                }
            )
        })

        it('propagates a getBlock transport fault unwrapped too', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlock: async () => { throw connErr('ECONNREFUSED') },
            })
            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('hash'),
                (err) => {
                    assert.strictEqual(err.code, 'ECONNREFUSED')
                    assert.ok(!err.auxPowParseFailure)
                    return true
                }
            )
        })

        it('tags an untraversable AuxPoW section as a content fault', async function () {
            // AuxPoW version bit set (0x100) but the AuxPoW section is truncated, so
            // skipAuxPow throws inside the strip block.
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlock: async () => '04016200' + '11'.repeat(76) + 'ff',
            })
            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('hash'),
                (err) => {
                    assert.strictEqual(err.auxPowParseFailure, true, 'content fault must be tagged')
                    assert.ok(err.cause, 'the original parse error is preserved as cause')
                    return true
                }
            )
        })
    })
})
