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
 * Taproot envelope recognition corpus (protocol spec §3.8).
 *
 * Pins, against the frozen golden vectors (xchain-documentation/protocol/
 * test-vectors/taproot_envelope.json, inlined here so this suite runs
 * without the sibling checkout and cross-checked against the file when it
 * is present):
 *  1. golden-vector recognition end to end through parseTransaction:
 *     payload reassembly, commit-based source attribution (§3.4), commit
 *     fee-output resolution through the single prefetched commit (§3.5),
 *     and the per-encoding §4 ceiling routing;
 *  2. the adversarial corpus: bad magic, unknown format byte, annex-bearing
 *     reveal, mixed carriers, multi-envelope, non-ins[0] envelope, foreign
 *     ord-style inscriptions, fuzzed witness stacks -- no crash, no false
 *     positive, no RPC fetch on any non-recognition;
 *  3. pre-vs-post-flag replay: below the recognition height every rule in
 *     §3.8 is inert and a mixed-carrier tx parses exactly as shipped;
 *  4. the §4 ceiling boundary: 390,000 accepted, 390,001 refused, measured
 *     on the REASSEMBLED payload length (a >65,535-byte rawData push is
 *     framed with OP_PUSHDATA4, which the legacy compiledPushSize re-measure
 *     does not model -- the envelope must never route through it);
 *  5. constants conformance: decoder == encoder == documentation for
 *     ENVELOPE_MAX_PAYLOAD and the recognition-height map (skip-if-absent
 *     sibling checkout, matching the compiledPushSizeConformance convention);
 *  6. wire fidelity: a REAL encoder-built, fully signed reveal parses
 *     byte-identically (sibling-gated on xchain-encoder).
 */

'use strict';

const assert = require('assert')
const sinon = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../../src/XChainDecoder')
const CONSTANTS = require('../../../../src/protocol/constants.js')

bitcoin.initEccLib(ecc)

// Frozen golden bytes (taproot_envelope.json). Inlined: recognition tests must
// not depend on a sibling checkout; the conformance block below asserts these
// stay byte-equal to the vector file whenever it is present.
const GOLDEN = {
    action: 'FILE|0|golden.txt|text/plain|Golden vector||||||',
    rawDataUtf8: 'XChain taproot envelope golden vector payload',
    compiledPayloadHex: '3046494c457c307c676f6c64656e2e7478747c746578742f706c61696e7c476f6c64656e20766563746f727c7c7c7c7c7c2d58436861696e20746170726f6f7420656e76656c6f706520676f6c64656e20766563746f72207061796c6f6164',
    envelopeScriptHex: '0063045843484e01004c5f3046494c457c307c676f6c64656e2e7478747c746578742f706c61696e7c476f6c64656e20766563746f727c7c7c7c7c7c2d58436861696e20746170726f6f7420656e76656c6f706520676f6c64656e20766563746f72207061796c6f6164682079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
    commitScriptPubKeyHex: '51201379a29bc4bf67418c7cab7ea02b3c68c2f92381eb1ccd5f4fb3048f5dafca22',
    controlBlockHex: 'c079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    internalPubkeyXonly: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    badMagicScriptHex: '0063045843484d0100291c46494c457c307c6164767c746578742f706c61696e7c7c7c7c7c7c7c0b616476657273617269616c682079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
    unknownFormatScriptHex: '0063045843484e0101291c46494c457c307c6164767c746578742f706c61696e7c7c7c7c7c7c7c0b616476657273617269616c682079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
    annexWitnessHex: [
        '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        '0063045843484e0100291c46494c457c307c6164767c746578742f706c61696e7c7c7c7c7c7c7c0b616476657273617269616c682079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
        'c079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        '50ff00ff00'
    ]
}
const GOLDEN_SCRIPT = Buffer.from(GOLDEN.envelopeScriptHex, 'hex')
const GOLDEN_PAYLOAD = Buffer.from(GOLDEN.compiledPayloadHex, 'hex')
const CONTROL_BLOCK = Buffer.from(GOLDEN.controlBlockHex, 'hex')
const COMMIT_SPK = Buffer.from(GOLDEN.commitScriptPubKeyHex, 'hex')
const XONLY = Buffer.from(GOLDEN.internalPubkeyXonly, 'hex')

// A regtest-valid P2PKH fee destination (same one the parseTransaction suite
// uses for the chunk carrier remap test).
const FEE_ADDR = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'

// Post-flag parse height on regtest (activation is 0 = genesis-active).
const POST_FLAG = 100

// Dummy 64-byte schnorr signature: recognition never verifies it, and its
// first byte must not be 0x50 (the annex marker check reads the LAST item).
const DUMMY_SIG = Buffer.alloc(64, 0x01)

// Manual push framing that never canonicalizes a 1-byte push to a bare opcode
// (bitcoin.script.compile would turn <0x00> into OP_0 and break the format
// byte; the shipped encoder hand-assembles the envelope for the same reason).
function pushData(buf){
    if (buf.length <= 75) return Buffer.concat([Buffer.from([buf.length]), buf])
    if (buf.length <= 255) return Buffer.concat([Buffer.from([0x4c, buf.length]), buf])
    if (buf.length <= 65535){
        const p = Buffer.alloc(3); p[0] = 0x4d; p.writeUInt16LE(buf.length, 1)
        return Buffer.concat([p, buf])
    }
    const p = Buffer.alloc(5); p[0] = 0x4e; p.writeUInt32LE(buf.length, 1)
    return Buffer.concat([p, buf])
}

// 520-byte chunking with the encoder's degenerate-final-chunk rebalance: a
// 1-byte final push whose value decompiles to a bare opcode (0x01-0x10, 0x81)
// would break the grammar walk, so the last two pushes become (n-1, 2).
function chunk520(payload){
    const pushes = []
    for (let off = 0; off < payload.length; off += 520){
        pushes.push(payload.subarray(off, Math.min(off + 520, payload.length)))
    }
    const last = pushes[pushes.length - 1]
    if (pushes.length > 1 && last.length === 1){
        const prev = pushes[pushes.length - 2]
        pushes[pushes.length - 2] = prev.subarray(0, prev.length - 1)
        pushes[pushes.length - 1] = Buffer.concat([prev.subarray(prev.length - 1), last])
    }
    return pushes
}

const OP = bitcoin.opcodes
function makeEnvelopeScript(payload, opts = {}){
    const magic = opts.magic || Buffer.from('XCHN')
    const format = opts.format || Buffer.from([0x00])
    const xonly = opts.xonly || XONLY
    const pushes = opts.pushes || chunk520(payload).map(pushData)
    return Buffer.concat([
        Buffer.from([OP.OP_0, OP.OP_IF]),
        pushData(magic),
        pushData(format),
        ...pushes,
        Buffer.from([OP.OP_ENDIF]),
        pushData(xonly),
        Buffer.from([OP.OP_CHECKSIG])
    ])
}

function addP2pkhOutput(tx, value){
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), value || 100000000)
}

// Funding tx: what the COMMIT's ins[0] spends. Output 0 is P2WPKH so the
// envelope source resolves to a real regtest bech32 address.
const FUNDING_PREV = Buffer.alloc(32, 0xee)
function buildFundingTx(){
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(FUNDING_PREV, 0)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
    tx.addOutput(Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, 0xbb)]), 500000)
    return tx
}

// Commit tx: ins[0] spends the funding tx's vout 0 (segwit-shaped); vout 0 is
// the envelope P2TR output; optional fee-destination outputs at vout >= 1.
function buildCommitTx(fundingTx, opts = {}){
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(Buffer.from(fundingTx.getId(), 'hex').reverse(), opts.fundingVout == null ? 0 : opts.fundingVout)
    tx.ins[0].witness = [Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)]
    tx.addOutput(COMMIT_SPK, 100000)
    for (const fee of (opts.feeOutputs || [])){
        tx.addOutput(bitcoin.address.toOutputScript(fee.address, bitcoin.networks.regtest), fee.amount)
    }
    return tx
}

// Reveal tx: ins[0] spends the commit's vout 0 with the envelope witness.
function buildRevealTx(commitTx, script, opts = {}){
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(Buffer.from(commitTx.getId(), 'hex').reverse(), 0)
    tx.ins[0].witness = opts.witness || [DUMMY_SIG, script, opts.control || CONTROL_BLOCK]
    addP2pkhOutput(tx, 90000)
    return tx
}

function createDecoder(networkName){
    const decoder = new XChainDecoder(
        networkName || 'bitcoin-regtest', null, null, null, null, null,
        ['127', '0', '0', '1'].join('.'), 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false),
        getAddressId: sinon.stub().resolves(null),
        hasPubkey: sinon.stub().resolves(true),
        insertPubkey: sinon.stub().resolves()
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('unit test: unexpected RPC'))
    }
    // Legacy source resolution is stubbed to a deterministic null, exactly
    // like the parseTransaction suite; the envelope path resolves through
    // getEnvelopeSourceFromCommit, which stays real.
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

// Wire the connector to serve exactly the given transactions by txid; any
// other lookup rejects loudly. Returns the stub for call-count assertions.
function wireConnector(decoder, txs){
    const byId = {}
    for (const t of txs) byId[t.getId()] = t.toHex()
    const stub = sinon.stub().callsFake(async (txid) => {
        if (byId[txid]) return byId[txid]
        throw new Error('unit test: unexpected getRawTransaction for ' + txid)
    })
    decoder.connector = { getRawTransaction: stub }
    return stub
}

// AES-128-CTR obfuscation keyed on the DISPLAY txid of ins[0]'s prevout,
// exactly as removeObfuscation derives it (key = txid[0..16), iv = txid[16..32)).
function obfuscate(plainBuf, displayTxid){
    const cipher = crypto.createCipheriv('aes-128-ctr', displayTxid.substr(0, 16), displayTxid.substr(16, 16))
    return Buffer.concat([cipher.update(plainBuf), cipher.final()])
}

// Compiled two-push action stream of an exact target byte length, using an
// OP_PUSHDATA4-framed rawData push (rawLen > 65535): 1+8 (action) + 5+rawLen.
function payloadOfLength(n){
    const raw = Buffer.alloc(n - 14, 0x61)
    const payload = bitcoin.script.compile([Buffer.from('FILE|0|x'), raw])
    assert.strictEqual(payload.length, n, 'payloadOfLength arithmetic')
    return payload
}


module.exports = {
    assert,
    sinon,
    crypto,
    bitcoin,
    ecc,
    XChainDecoder,
    CONSTANTS,
    GOLDEN,
    GOLDEN_SCRIPT,
    GOLDEN_PAYLOAD,
    CONTROL_BLOCK,
    COMMIT_SPK,
    XONLY,
    FEE_ADDR,
    POST_FLAG,
    DUMMY_SIG,
    OP,
    pushData,
    chunk520,
    makeEnvelopeScript,
    addP2pkhOutput,
    FUNDING_PREV,
    buildFundingTx,
    buildCommitTx,
    buildRevealTx,
    createDecoder,
    wireConnector,
    obfuscate,
    payloadOfLength
}
