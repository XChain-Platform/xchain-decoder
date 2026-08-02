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
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')

// THE FIXTURE THIS FILE USED COULD NEVER HAVE DECODED. The tail of its
// first data-carrying pubkey and the whole of its second were zero-filled
// where the ciphertext belongs (only the third, an all-0x03 filler key,
// matched the real one), so deobfuscation returned bytes that do not start
// with XCHN and the two tests below asserted 'Multisig data' against an
// empty buffer. That is a placeholder, not a redaction: no decoder change
// could have satisfied it.
//
// This is now the same hex the unit suite's [REGRESSION P0] R-SCR-004 case
// decodes, documented there as a genuine AES-128-CTR encryption of
// 'XCHN' + compile(['Multisig data']) padded to a full 64-byte chunk.
const MULTISIG_TX_HEX = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff02e803000000000000695121025ed141846dc8d3e27dce7b3c6cab14fb07115cbb7a04d9341aadaaa5268635642102e71ca15723d902414e2d1eabfe0fbd6380eb928110bbec51127fce0de72f14652103030303030303030303030303030303030303030303030303030303030303030353ae00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

// The prevout the fixture spends (input index 1), output 1 a standard P2PKH.
const PREVOUT_TX_HEX = '020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff020000000000000000076a0548656c6c6f0065cd1d000000001976a914bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb88ac00000000'

function createDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    // See parseOpReturn.smoke.js for why the prevout lookup must resolve:
    // a failed one is tagged `rpcLookupFailure` and rethrown by design, so
    // a rejecting stub tests the retry contract rather than the decode.
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false),
        getAddressId: sinon.stub().resolves(null),
        hasPubkey: sinon.stub().resolves(false),
        insertPubkey: sinon.stub().resolves()
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().resolves(PREVOUT_TX_HEX)
    }
    return decoder
}

describe('Smoke: Multisig Transaction Parsing', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should parse a 1-of-3 multisig tx without throwing', async () => {
        const result = await decoder.parseRawTransaction(MULTISIG_TX_HEX)
        assert.ok(result)
    })

    it('should return non-empty data from a multisig tx', async () => {
        const result = await decoder.parseRawTransaction(MULTISIG_TX_HEX)
        assert.ok(result.data.length > 0)
    })

    it('should decode the multisig data to a recognizable string', async () => {
        const result = await decoder.parseRawTransaction(MULTISIG_TX_HEX)
        const decoded = result.data.toString('utf-8')
        assert.strictEqual(decoded, 'Multisig data')
    })

    it('should not have trailing zero bytes in the decoded data', async () => {
        const result = await decoder.parseRawTransaction(MULTISIG_TX_HEX)
        assert.notStrictEqual(result.data[result.data.length - 1], 0)
    })

    it('should return empty dispenseOutputs', async () => {
        const result = await decoder.parseRawTransaction(MULTISIG_TX_HEX)
        assert.strictEqual(result.dispenseOutputs.length, 0)
    })
})
