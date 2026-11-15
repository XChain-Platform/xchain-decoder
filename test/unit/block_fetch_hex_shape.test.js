// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The block fetch boundary: every path that hands node hex to the parser first checks
// the answer is whole hex, so a wire or proxy fault retries as a fetch error rather than
// reaching the parser as an undecodable block or building a block from a bad header.

const assert = require('assert')
const BlockchainConnector = require('../../src/chain/blockchain_connector')
const XChainDecoder = require('../../src/XChainDecoder')

const HEADER_HEX = '04016200' + '11'.repeat(76)
const TXID = 'aa'.repeat(32)

function makeConnector(overrides) {
    return Object.assign(new BlockchainConnector('127.0.0.1', 0, 'user', 'pass'), overrides)
}

function makeDecoder(network, connector) {
    const decoder = new XChainDecoder(network, '127.0.0.1', 3306, 'db', 'u', 'p',
        '127.0.0.1', 0, 'u', 'p', false, null)
    decoder.connector = connector
    return decoder
}

describe('getBlockReassembled header shape', function () {
    const badHeaders = [
        ['a non-string answer', { not: 'hex' }, /malformed block hex.*object/],
        ['a short hex string', HEADER_HEX.slice(0, 100), /malformed block hex.*string length 100/],
        ['a non-hex string', 'zz'.repeat(80), /malformed block hex.*string length 160/],
        ['an odd-length hex string', HEADER_HEX + 'a', /malformed block hex.*string length 161/],
    ]

    for (const [label, header, pattern] of badHeaders) {
        it('rejects ' + label + ' before any verbose getblock or per-tx fetch', async function () {
            const calls = []
            const connector = makeConnector({
                getBlockHeader: async () => header,
                getBlockVerbose: async () => { calls.push('verbose'); return { tx: [TXID] } },
                getRawTransactions: async () => { calls.push('raw'); return ['00'] },
            })
            await assert.rejects(() => connector.getBlockReassembled('hash'), pattern)
            assert.deepStrictEqual(calls, [], 'no node call may follow a malformed header')
            assert.strictEqual(connector.rpcErrors, 1, 'the fault is counted as an RPC error')
        })
    }

    it('rejects with the reassembly wrapper and no auxPowParseFailure tag', async function () {
        const connector = makeConnector({ getBlockHeader: async () => 'abcd' })
        await assert.rejects(() => connector.getBlockReassembled('hash'), (err) => {
            assert.match(err.message, /There were problems reassembling a block without auxpow\. getblockheader returned/)
            assert.strictEqual(err.auxPowParseFailure, undefined)
            return true
        })
    })

    it('still builds from a header carrying appended AuxPoW bytes', async function () {
        const connector = makeConnector({
            getBlockHeader: async () => HEADER_HEX + 'ab'.repeat(40),
            getBlockVerbose: async () => ({ tx: [TXID] }),
            getRawTransactions: async () => ['0100'],
        })
        assert.strictEqual(await connector.getBlockReassembled('hash'), HEADER_HEX + '01' + '0100')
    })
})

describe('fetchBlockHex on a non-AuxPoW chain', function () {
    const badAnswers = [
        ['an object', { hex: 'aa' }, /getblock returned malformed block hex.*object/],
        ['an empty string', '', /getblock returned malformed block hex.*string length 0/],
        ['a non-hex string', 'not hex!', /getblock returned malformed block hex.*string length 8/],
        ['an odd-length string', 'abc', /getblock returned malformed block hex.*string length 3/],
        ['a number', 5, /getblock returned malformed block hex.*number/],
    ]

    for (const [label, answer, pattern] of badAnswers) {
        it('refuses ' + label + ' as a fetch fault, before the parser sees it', async function () {
            const connector = { rpcErrors: 0, getBlock: async () => answer }
            const decoder = makeDecoder('litecoin-regtest', connector)
            await assert.rejects(() => decoder.fetchBlockHex('hash', 100), pattern)
            assert.strictEqual(connector.rpcErrors, 1)
        })
    }

    it('passes a whole-hex answer through unchanged', async function () {
        const decoder = makeDecoder('litecoin-regtest', { rpcErrors: 0, getBlock: async () => 'cc' })
        assert.strictEqual(await decoder.fetchBlockHex('hash', 100), 'cc')
    })

    it('refuses a bad answer from a connector that keeps no error counter', async function () {
        const decoder = makeDecoder('litecoin-regtest', { getBlock: async () => null })
        await assert.rejects(() => decoder.fetchBlockHex('hash', 100), /malformed block hex.*object/)
    })
})
