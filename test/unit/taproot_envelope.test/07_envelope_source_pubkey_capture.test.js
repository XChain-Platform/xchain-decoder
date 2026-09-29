/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Envelope source-pubkey capture (protocol spec §3.4 Source attribution).
 *
 * The source of an envelope action is the address funding the COMMIT, so its
 * key is read from the commit's ins[0]. The reveal's ins[0] witness is
 * [sig, tapscript, control block]; a single 20-byte payload push makes the
 * tapscript exactly 65 bytes, the length extractPubkeyFromInput accepts as an
 * uncompressed key, and it must never be recorded as one.
 */

'use strict';

const {
    assert,
    sinon,
    bitcoin,
    FEE_ADDR,
    POST_FLAG,
    makeEnvelopeScript,
    buildFundingTx,
    buildCommitTx,
    buildRevealTx,
    createDecoder,
    wireConnector
} = require('./helpers/taproot_envelope.js')

// A one-push compiled payload of 20 bytes (1-byte push opcode + 19 data bytes).
const PAYLOAD_20 = bitcoin.script.compile([Buffer.alloc(19, 0x41)])

function captureRig(commitWitness) {
    const decoder = createDecoder()
    decoder.feeDestination = FEE_ADDR
    decoder.db.getAddressId = sinon.stub().resolves(42)
    decoder.db.hasPubkey = sinon.stub().resolves(false)
    const fundingTx = buildFundingTx()
    const commitTx = buildCommitTx(fundingTx)
    if (commitWitness) commitTx.ins[0].witness = commitWitness
    const script = makeEnvelopeScript(PAYLOAD_20)
    const revealTx = buildRevealTx(commitTx, script)
    wireConnector(decoder, [fundingTx, commitTx])
    const sourceAddr = bitcoin.address.fromOutputScript(fundingTx.outs[0].script, decoder.network)
    return { decoder, commitTx, script, revealTx, sourceAddr }
}

describe('Taproot envelope source pubkey capture', function () {
    afterEach(() => sinon.restore())

    it('records the commit funder key, never the 65-byte tapscript, for a 20-byte payload', async function () {
        const { decoder, commitTx, script, revealTx, sourceAddr } = captureRig()
        assert.strictEqual(PAYLOAD_20.length, 20)
        assert.strictEqual(script.length, 65, 'precondition: the tapscript is uncompressed-key sized')
        const funderKey = commitTx.ins[0].witness[1].toString('hex')
        const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
        assert.strictEqual(result.envelope, true)
        assert.strictEqual(result.source, sourceAddr)
        assert.strictEqual(result.sourcePubkey, funderKey)
        assert.strictEqual(decoder.db.insertPubkey.callCount, 1)
        assert.deepStrictEqual(decoder.db.insertPubkey.firstCall.args, [42, funderKey])
        assert.notStrictEqual(result.sourcePubkey, script.toString('hex'))
    })

    it('records nothing when the commit input exposes no key (key-path spend)', async function () {
        const { decoder, revealTx, sourceAddr } = captureRig([Buffer.alloc(64, 0x01)])
        const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
        assert.strictEqual(result.source, sourceAddr)
        assert.strictEqual(result.sourcePubkey, null)
        assert.strictEqual(decoder.db.insertPubkey.callCount, 0)
    })
})
