// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A mempool row is keyed on the txid the node listed in getrawmempool, and the
// parsed tx must hash to that same txid before it is stored. A Litecoin tx in
// its MWEB serialization (real peg-in bytes, opaque MWEB filler) must therefore
// store under its real txid with its witness intact, and a tx whose parse hashes
// to anything else is skipped and counted, never stored under a made-up hash.

const assert = require('assert')
const crypto = require('crypto')
const bitcoinjs = require('bitcoinjs-lib')
const XChainDecoder = require('../../../src/XChainDecoder')
const VECTORS = require('../../fixtures/wire_parse_vectors.json')

const PEGIN = VECTORS.ltcPegin

function mwebForm(hex) {
    const full = Buffer.from(hex, 'hex')
    const bare = bitcoinjs.Transaction.fromBuffer(full)
    bare.ins.forEach(i => { i.witness = [] })
    const legacy = bare.toBuffer()
    const insOuts = legacy.subarray(4, legacy.length - 4)
    const body = Buffer.concat([Buffer.from([0x01]), crypto.createHash('sha512').update('mweb body').digest()])
    return Buffer.concat([full.subarray(0, 4), Buffer.from([0x00, 0x09]), insOuts,
        full.subarray(6 + insOuts.length, full.length - 4), body, full.subarray(full.length - 4)]).toString('hex')
}

function buildDecoder(nodeTxid, nodeHex) {
    const decoder = new XChainDecoder(
        'litecoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    const seen = { rows: [], parsed: [] }
    decoder.mempoolDb = {
        getAllOpenDispenserAddresses: async () => new Set(),
        deleteAndCompareTxsNotInList: async () => ({ transactionsDeleted: 0 }),
        insertMempoolTransaction: async (row) => { seen.rows.push(row); return true },
    }
    decoder.connector = {
        getRawMempool: async () => [nodeTxid],
        getRawTransactions: async () => [nodeHex],
    }
    decoder.parseTransaction = async (tx) => {
        seen.parsed.push(tx)
        return { data: Buffer.from('SEND'), compiledDataLength: 4, source: 'src', destination: null, amount: '0' }
    }
    return { decoder, seen }
}

describe('decoder mempool rows keyed on the node txid @regression', function () {
    describe('an MWEB-form Litecoin tx [REGRESSION P1]', function () {
        it('stores under the node txid with the witness handed to the parser', async function () {
            const { decoder, seen } = buildDecoder(PEGIN.txid, mwebForm(PEGIN.hex))
            await decoder.updateMempool()
            assert.deepStrictEqual(seen.rows.map(r => r.hash), [PEGIN.txid])
            assert.ok(seen.parsed[0].ins[0].witness.length > 0, 'the witness must survive the parse')
        })

        it('skips and counts a tx whose parse does not hash to the node txid', async function () {
            const { decoder, seen } = buildDecoder('ab'.repeat(32), PEGIN.hex)
            const before = decoder.parseErrors
            await decoder.updateMempool()
            assert.deepStrictEqual(seen.rows, [])
            assert.deepStrictEqual(seen.parsed, [])
            assert.strictEqual(decoder.parseErrors, before + 1)
        })
    })
})
