// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')

// Pre-built OP_RETURN tx hex from unit test fixtures
const OP_RETURN_TX_HEX = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

function createDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false)
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('mocked'))
    }
    return decoder
}

describe('Smoke: OP_RETURN Transaction Parsing', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should parse an OP_RETURN tx without throwing', async () => {
        const result = await decoder.parseRawTransaction(OP_RETURN_TX_HEX)
        assert.ok(result)
    })

    it('should return non-empty data from a valid OP_RETURN tx', async () => {
        const result = await decoder.parseRawTransaction(OP_RETURN_TX_HEX)
        assert.ok(result.data.length > 0)
    })

    it('should decode the data to a recognizable string', async () => {
        const result = await decoder.parseRawTransaction(OP_RETURN_TX_HEX)
        const decoded = result.data.toString('utf-8')
        assert.strictEqual(decoded, 'Small data test')
    })

    it('should return the expected result structure', async () => {
        const result = await decoder.parseRawTransaction(OP_RETURN_TX_HEX)
        assert.ok('data' in result)
        assert.ok('rawData' in result)
        assert.ok('source' in result)
        assert.ok('destination' in result)
        assert.ok('dispenseOutputs' in result)
        assert.ok(Array.isArray(result.dispenseOutputs))
    })

    it('should return empty dispenseOutputs', async () => {
        const result = await decoder.parseRawTransaction(OP_RETURN_TX_HEX)
        assert.strictEqual(result.dispenseOutputs.length, 0)
    })
})
