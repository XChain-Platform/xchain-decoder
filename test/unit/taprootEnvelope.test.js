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
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')
const CONSTANTS = require('../../src/protocol/constants.js')

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
// uses for the chunk-lane remap test).
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
        '127.0.0.1', 18443, 'rpc', 'rpc', false
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
    // Legacy-lane source resolution stubbed to a deterministic null, exactly
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

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())

    // detectEnvelopeWitness: pure pattern matching, never throws
    describe('detectEnvelopeWitness()', function () {
        let decoder
        beforeEach(() => { decoder = createDecoder() })

        it('recognizes the golden witness and reassembles the exact payload bytes', function () {
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK])
            assert.ok(hit, 'golden envelope recognized')
            assert.deepStrictEqual(hit.payload, GOLDEN_PAYLOAD, 'byte-identical reassembly')
            assert.deepStrictEqual(hit.script, GOLDEN_SCRIPT)
        })

        it('recognizes a multi-push envelope and concatenates pushes in order', function () {
            const payload = bitcoin.script.compile([Buffer.from('FILE|0|chunks'), crypto.randomBytes(1200)])
            const script = makeEnvelopeScript(payload)
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK])
            assert.ok(hit)
            assert.deepStrictEqual(hit.payload, payload)
        })

        it('recognition is framing-agnostic: a fat-framed (PUSHDATA1) payload push reassembles identically', function () {
            // A foreign encoder may frame a small chunk non-minimally; the
            // reassembled payload counts data bytes only.
            const fat = Buffer.concat([Buffer.from([0x4c, GOLDEN_PAYLOAD.length]), GOLDEN_PAYLOAD])
            const script = makeEnvelopeScript(null, { pushes: [fat] })
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK])
            assert.ok(hit)
            assert.deepStrictEqual(hit.payload, GOLDEN_PAYLOAD)
        })

        it('accepts the odd-parity control block first byte (0xc1)', function () {
            const control = Buffer.concat([Buffer.from([0xc1]), CONTROL_BLOCK.subarray(1)])
            assert.ok(decoder.detectEnvelopeWitness([DUMMY_SIG, GOLDEN_SCRIPT, control]))
        })

        it('[ADVERSARIAL] bad magic is not recognized', function () {
            const script = Buffer.from(GOLDEN.badMagicScriptHex, 'hex')
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] unknown format byte (0x01) is invisible by design', function () {
            const script = Buffer.from(GOLDEN.unknownFormatScriptHex, 'hex')
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] an annex-bearing reveal is never recognized (BIP341 end-indexed parsing)', function () {
            const witness = GOLDEN.annexWitnessHex.map(h => Buffer.from(h, 'hex'))
            assert.strictEqual(decoder.detectEnvelopeWitness(witness), null)
        })

        it('[ADVERSARIAL] structural violations are all rejected without throwing', function () {
            const cases = [
                // key-path spend (single signature)
                [DUMMY_SIG],
                // empty / missing witness
                [], null, undefined,
                // control block with a non-tapscript leaf version
                [DUMMY_SIG, GOLDEN_SCRIPT, Buffer.concat([Buffer.from([0xc2]), CONTROL_BLOCK.subarray(1)])],
                // control block length not 33 + 32k
                [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK.subarray(0, 32)],
                [DUMMY_SIG, GOLDEN_SCRIPT, Buffer.concat([CONTROL_BLOCK, Buffer.alloc(31, 0x00)])],
                // zero payload pushes
                [DUMMY_SIG, makeEnvelopeScript(null, { pushes: [] }), CONTROL_BLOCK],
                // internal key push not 32 bytes
                [DUMMY_SIG, makeEnvelopeScript(GOLDEN_PAYLOAD, { xonly: Buffer.alloc(33, 0x02) }), CONTROL_BLOCK],
                // trailing junk after OP_CHECKSIG
                [DUMMY_SIG, Buffer.concat([GOLDEN_SCRIPT, Buffer.from([OP.OP_1])]), CONTROL_BLOCK],
                // OP_ENDIF missing (truncated before the tail)
                [DUMMY_SIG, GOLDEN_SCRIPT.subarray(0, GOLDEN_SCRIPT.length - 35), CONTROL_BLOCK],
                // non-buffer script item
                [DUMMY_SIG, 42, CONTROL_BLOCK]
            ]
            for (const witness of cases){
                assert.strictEqual(decoder.detectEnvelopeWitness(witness), null)
            }
        })

        it('recognition reads only the top two stack items: the signature slot is opaque to it', function () {
            // The first witness item is script input (the schnorr signature);
            // recognition never inspects it, so even a degenerate value there
            // cannot mask an otherwise well-formed envelope.
            const hit = decoder.detectEnvelopeWitness([42, GOLDEN_SCRIPT, CONTROL_BLOCK])
            assert.ok(hit)
            assert.deepStrictEqual(hit.payload, GOLDEN_PAYLOAD)
        })

        it('[ADVERSARIAL] a payload push that canonicalizes to a bare opcode breaks the walk (encoder rebalance exists for this)', function () {
            // Hand-assembled: payload pushes are <519 bytes> then OP_7 where a
            // naive encoder would have compiled a 1-byte 0x07 final chunk.
            const script = Buffer.concat([
                Buffer.from([OP.OP_0, OP.OP_IF]),
                pushData(Buffer.from('XCHN')),
                pushData(Buffer.from([0x00])),
                pushData(Buffer.alloc(519, 0x61)),
                Buffer.from([OP.OP_7]),
                Buffer.from([OP.OP_ENDIF]),
                pushData(XONLY),
                Buffer.from([OP.OP_CHECKSIG])
            ])
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] the rebalanced form of the same payload IS recognized and reassembles identically', function () {
            const payload = Buffer.concat([Buffer.alloc(520, 0x61), Buffer.from([0x07])])
            const script = makeEnvelopeScript(payload)   // chunk520 rebalances (519, 2)
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK])
            assert.ok(hit, 'rebalanced envelope recognized')
            assert.deepStrictEqual(hit.payload, payload)
        })

        it('[ADVERSARIAL] foreign ord-style inscriptions are not recognized', function () {
            // Real ord grammar: <pubkey> OP_CHECKSIG OP_FALSE OP_IF "ord" ... OP_ENDIF
            const ord = Buffer.concat([
                pushData(XONLY),
                Buffer.from([OP.OP_CHECKSIG]),
                Buffer.from([OP.OP_0, OP.OP_IF]),
                pushData(Buffer.from('ord')),
                pushData(Buffer.from([0x01])),
                pushData(Buffer.from('text/plain;charset=utf-8')),
                Buffer.from([OP.OP_0]),
                pushData(Buffer.from('Hello, world!')),
                Buffer.from([OP.OP_ENDIF])
            ])
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, ord, CONTROL_BLOCK]), null)
            // OP_FALSE OP_IF head but wrong interior grammar
            const notQuite = Buffer.concat([
                Buffer.from([OP.OP_0, OP.OP_IF]),
                pushData(Buffer.from('XCHN')),
                Buffer.from([OP.OP_ENDIF]),     // no format byte, no payload
                pushData(XONLY),
                Buffer.from([OP.OP_CHECKSIG])
            ])
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, notQuite, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] fuzzed witness stacks never throw and never false-positive', function () {
            for (let i = 0; i < 300; i++){
                const items = []
                const count = i % 6
                for (let j = 0; j < count; j++){
                    const len = crypto.randomBytes(1)[0] + (j === count - 1 ? 33 : 0)
                    items.push(crypto.randomBytes(len))
                }
                let result
                assert.doesNotThrow(() => { result = decoder.detectEnvelopeWitness(items) })
                if (result !== null){
                    // The only way a random stack is "recognized" is by actually
                    // containing the full grammar, which randomness cannot hit.
                    assert.fail('fuzzed witness stack recognized as an envelope')
                }
            }
        })
    })

    // Activation gating
    describe('envelopeRecognitionHeight() / envelopeActiveAt()', function () {
        it('BTC regtest is genesis-active (height 0)', function () {
            const decoder = createDecoder()
            assert.strictEqual(decoder.envelopeRecognitionHeight(), 0)
            assert.strictEqual(decoder.envelopeActiveAt(0), true)
            assert.strictEqual(decoder.envelopeActiveAt(POST_FLAG), true)
        })

        it('an omitted blockHeight resolves to INACTIVE (shipped behavior), even on regtest', function () {
            const decoder = createDecoder()
            assert.strictEqual(decoder.envelopeActiveAt(undefined), false)
            assert.strictEqual(decoder.envelopeActiveAt(null), false)
        })

        it('DOGE has no envelope on any network, at any height (null = never)', function () {
            const decoder = createDecoder()
            decoder.coinTick = 'DOGE'
            for (const net of ['mainnet', 'testnet', 'regtest']){
                decoder.consensusNetwork = net
                assert.strictEqual(decoder.envelopeRecognitionHeight(), null)
                assert.strictEqual(decoder.envelopeActiveAt(1000000000), false)
            }
        })

        // This was the disarmed-sentinel case; it is kept as a boundary test on the
        // real heights, because the off-by-one at a flag height is a fleet fork.
        // The heights come from CONSTANTS rather than literals ON PURPOSE: this
        // test asserts the BOUNDARY PROPERTY, which holds at whatever height is
        // armed, and the heights have already moved once (961000/3160000 pulled in
        // to 960850/3153500 on 2026-08-02). The literal values are pinned once, in
        // the parity test below, which is where a surprise change should trip.
        it('BTC/LTC mainnet activate at their armed cohort heights, exclusive below', function () {
            const decoder = createDecoder()
            decoder.consensusNetwork = 'mainnet'
            for (const tick of ['BTC', 'LTC']){
                const height = CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION[tick].mainnet
                decoder.coinTick = tick
                assert.strictEqual(decoder.envelopeRecognitionHeight(), height)
                assert.strictEqual(decoder.envelopeActiveAt(height - 1), false)
                assert.strictEqual(decoder.envelopeActiveAt(height), true)
                assert.strictEqual(decoder.envelopeActiveAt(height + 1), true)
            }
        })

        it('an unknown coin or network can only disable recognition, never enable it', function () {
            const decoder = createDecoder()
            decoder.coinTick = 'FOO'
            assert.strictEqual(decoder.envelopeRecognitionHeight(), null)
            decoder.coinTick = 'BTC'
            decoder.consensusNetwork = 'no-such-net'
            assert.strictEqual(decoder.envelopeRecognitionHeight(), null)
            assert.strictEqual(decoder.envelopeActiveAt(1000000000), false)
        })
    })

    // Golden end-to-end parse
    describe('parseTransaction: golden envelope reveal', function () {
        let decoder, fundingTx, commitTx, revealTx, rpc, sourceAddr

        beforeEach(() => {
            decoder = createDecoder()
            decoder.feeDestination = FEE_ADDR
            fundingTx = buildFundingTx()
            sourceAddr = bitcoin.address.fromOutputScript(fundingTx.outs[0].script, decoder.network)
            commitTx = buildCommitTx(fundingTx, { feeOutputs: [{ address: FEE_ADDR, amount: 4321 }] })
            revealTx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('decodes the golden action byte-identically with the envelope ceiling', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.ok(result)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
            assert.strictEqual(result.rawData.toString('utf-8'), GOLDEN.rawDataUtf8)
            // §4 measurand: the reassembled payload length, before parse.
            assert.strictEqual(result.compiledDataLength, GOLDEN_PAYLOAD.length)
        })

        it('attributes the source to the address funding the COMMIT (§3.4)', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.source, sourceAddr)
            // The legacy ins[0]-prevout walk must NOT run for an envelope.
            assert.strictEqual(decoder.getSourceFromOutput.callCount, 0)
        })

        it('resolves commit fee outputs through the prefetched commit: ONE commit fetch total (§3.5/§3.8)', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            const fees = result.paymentOutputs.filter(o => o.destinationAddress === FEE_ADDR)
            assert.strictEqual(fees.length, 1)
            assert.strictEqual(Number(fees[0].vout), XChainDecoder.FUNDING_VOUT_BASE + 1)
            assert.strictEqual(Number(fees[0].amount), 4321)
            // Exactly two RPC round trips: the commit (once) and the commit's
            // funding prevout (attribution). The fee resolver reuses the
            // prefetched commit instead of fetching it again.
            assert.strictEqual(rpc.callCount, 2)
            const asked = rpc.args.map(a => a[0]).sort()
            assert.deepStrictEqual(asked, [commitTx.getId(), fundingTx.getId()].sort())
        })

        it('is invisible below the flag height: no data, no RPC, legacy ceiling', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set())
            assert.ok(result)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.MAX_ACTION_DATA_LENGTH)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)
        })

        it('a commit-funding output with no representable address yields a null source, not a crash', async function () {
            // Rebuild the funding tx with an OP_RETURN at the spent vout.
            const oddFunding = buildFundingTx()
            oddFunding.outs[0].script = bitcoin.script.compile([OP.OP_RETURN, Buffer.from('nothing')])
            const oddCommit = buildCommitTx(oddFunding)
            const oddReveal = buildRevealTx(oddCommit, GOLDEN_SCRIPT)
            wireConnector(decoder, [oddFunding, oddCommit])
            const result = await decoder.parseTransaction(oddReveal, new Set(), null, POST_FLAG)
            assert.strictEqual(result.source, null)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
        })

        it('a commit ins[0] prevout index out of bounds yields a null source', async function () {
            const shortFunding = buildFundingTx()
            const oobCommit = buildCommitTx(shortFunding, { fundingVout: 7 })
            const oobReveal = buildRevealTx(oobCommit, GOLDEN_SCRIPT)
            wireConnector(decoder, [shortFunding, oobCommit])
            const result = await decoder.parseTransaction(oobReveal, new Set(), null, POST_FLAG)
            assert.strictEqual(result.source, null)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
        })

        it('a failed commit fetch throws tagged rpcLookupFailure (retry, never a silent no-action)', async function () {
            decoder.connector = { getRawTransaction: sinon.stub().rejects(new Error('node down')) }
            await assert.rejects(
                decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG),
                (err) => err.rpcLookupFailure === true
            )
        })

        it('an EMPTY commit fetch result throws tagged rpcLookupFailure (lookup failure, never absence)', async function () {
            decoder.connector = { getRawTransaction: sinon.stub().resolves(null) }
            await assert.rejects(
                decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG),
                (err) => err.rpcLookupFailure === true
            )
        })
    })

    // §4 ceiling boundary (the OP_PUSHDATA4 measurand trap)
    describe('per-encoding §4 ceiling', function () {
        let decoder
        beforeEach(() => {
            decoder = createDecoder()
            // No fee destination and a pre-wired commit: these tests only pin
            // the measurand, so attribution resolves against a plain funding.
        })

        function wireFor(script){
            const fundingTx = buildFundingTx()
            const commitTx = buildCommitTx(fundingTx)
            const revealTx = buildRevealTx(commitTx, script)
            wireConnector(decoder, [fundingTx, commitTx])
            return revealTx
        }

        it('a payload of exactly ENVELOPE_MAX_PAYLOAD (390,000) measures at the ceiling and passes the guard', async function () {
            this.timeout(20000)
            const payload = payloadOfLength(CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            const revealTx = wireFor(makeEnvelopeScript(payload))
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.compiledDataLength, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.ok(result.compiledDataLength <= result.payloadCeiling, 'block/mempool guards accept at the ceiling')
            assert.strictEqual(result.data.toString('utf-8'), 'FILE|0|x')
        })

        it('[ADVERSARIAL] a 390,001-byte payload measures OVER the ceiling: the guard drops it in both paths', async function () {
            this.timeout(20000)
            // The rawData push inside this payload is OP_PUSHDATA4-framed; the
            // legacy compiledPushSize re-measure would under-count it by 2
            // bytes and let it slip under the ceiling. The envelope measurand
            // is the reassembled length, pinned here at exactly 390,001.
            const payload = payloadOfLength(CONSTANTS.ENVELOPE_MAX_PAYLOAD + 1)
            const revealTx = wireFor(makeEnvelopeScript(payload))
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.compiledDataLength, CONSTANTS.ENVELOPE_MAX_PAYLOAD + 1)
            assert.ok(result.compiledDataLength > result.payloadCeiling,
                'the exact comparison both the block and mempool guards apply must reject')
        })

        it('legacy lanes keep MAX_ACTION_DATA_LENGTH: an OP_RETURN action reports the 8192 ceiling', async function () {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(FUNDING_PREV, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            const display = Buffer.from(FUNDING_PREV).reverse().toString('hex')
            const cipher = obfuscate(Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from('SEND|0|XCHAIN|1000')])]), display)
            tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
            addP2pkhOutput(tx)
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.MAX_ACTION_DATA_LENGTH)
            assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
        })
    })

    // Carrier arbitration + replay across the flag boundary
    describe('carrier arbitration (§3.8), height-gated', function () {
        let decoder, fundingTx, commitTx, rpc

        beforeEach(() => {
            decoder = createDecoder()
            fundingTx = buildFundingTx()
            commitTx = buildCommitTx(fundingTx)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        // Envelope reveal + an obfuscated OP_RETURN XCHN action in one tx.
        function buildMixedOpReturnTx(action){
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            const cipher = obfuscate(
                Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from(action)])]),
                commitTx.getId()
            )
            tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
            return tx
        }

        it('[ADVERSARIAL] envelope + OP_RETURN action: no action post-flag, RPC-free rejection', async function () {
            const tx = buildMixedOpReturnTx('SEND|0|XCHAIN|1000')
            const before = decoder.parseErrors
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(decoder.parseErrors, before + 1)
            assert.strictEqual(rpc.callCount, 0, 'deterministic rejection never fetches the commit')
        })

        it('[REPLAY] the same mixed tx below the flag height parses EXACTLY as shipped: the OP_RETURN action', async function () {
            const tx = buildMixedOpReturnTx('SEND|0|XCHAIN|1000')
            const result = await decoder.parseTransaction(tx, new Set())
            assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.MAX_ACTION_DATA_LENGTH)
        })

        it('[REPLAY] the flag boundary is exact: height H-1 replays shipped, height H rejects', async function () {
            sinon.stub(decoder, 'envelopeRecognitionHeight').returns(100)
            const tx = buildMixedOpReturnTx('SEND|0|XCHAIN|1000')
            const pre = await decoder.parseTransaction(tx, new Set(), null, 99)
            assert.strictEqual(pre.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
            const post = await decoder.parseTransaction(tx, new Set(), null, 100)
            assert.strictEqual(post.data.length, 0)
        })

        it('[ADVERSARIAL] envelope + MULTISIGN outputs: no action post-flag, the multisig action pre-flag', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            // Genuine obfuscated MULTISIGN chunk keyed on ins[0]'s prevout txid
            // (the commit), zero-padded to the full 64-byte slot pair.
            const plain = Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from('Multisig data')])])
            const padded = Buffer.concat([plain, Buffer.alloc(64 - plain.length, 0x00)])
            const cipher = obfuscate(padded, commitTx.getId())
            const multisigScript = bitcoin.script.compile([
                OP.OP_1,
                Buffer.concat([Buffer.from([0x02]), cipher.subarray(0, 32)]),
                Buffer.concat([Buffer.from([0x02]), cipher.subarray(32, 64)]),
                Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 0x03)]),
                OP.OP_3,
                OP.OP_CHECKMULTISIG
            ])
            tx.addOutput(multisigScript, 1000)

            const post = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(post.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)

            const pre = await decoder.parseTransaction(tx, new Set())
            assert.strictEqual(pre.data.toString('utf-8'), 'Multisig data')
        })

        it('[ADVERSARIAL] envelope + chunk-lane marker: no action post-flag', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            // Marker output whose payload decrypts to the P2WSH sentinel.
            const cipher = obfuscate(Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2wsh')]), commitTx.getId())
            tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)
        })

        it('[ADVERSARIAL] two envelope inputs: no action, RPC-free', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            tx.addInput(Buffer.alloc(32, 0xcd), 0)
            tx.ins[1].witness = [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK]
            const before = decoder.parseErrors
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(decoder.parseErrors, before + 1)
            assert.strictEqual(rpc.callCount, 0)
        })

        it('[ADVERSARIAL] an envelope anywhere but ins[0]: no action (§3.5 pins the commit outpoint at input 0)', async function () {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(FUNDING_PREV, 1)  // ordinary first input
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            tx.addInput(Buffer.from(commitTx.getId(), 'hex').reverse(), 0)
            tx.ins[1].witness = [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK]
            addP2pkhOutput(tx, 90000)
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)
        })

        it('a rejected envelope clears the ACTION only: dispense outputs stay recorded', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            tx.addInput(Buffer.alloc(32, 0xcd), 0)
            tx.ins[1].witness = [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK]
            const dispenserAddr = bitcoin.address.fromOutputScript(tx.outs[0].script, decoder.network)
            const result = await decoder.parseTransaction(tx, new Set([dispenserAddr]), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(result.dispenseOutputs.length, 1)
        })

        it('additional reveal inputs (index >= 1) and change outputs are legal and ignored (§3.5)', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            tx.addInput(Buffer.alloc(32, 0xab), 3)   // fee-topup input, not an envelope
            tx.ins[1].witness = [Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)]
            addP2pkhOutput(tx, 12345)                // change
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
        })
    })

    // Constants conformance (decoder == encoder == documentation)
    describe('constants conformance', function () {
        it('the decoder exports the vendored constants unchanged', function () {
            assert.strictEqual(XChainDecoder.ENVELOPE_MAX_PAYLOAD, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.strictEqual(CONSTANTS.ENVELOPE_MAX_PAYLOAD, 390000)
            assert.deepStrictEqual(XChainDecoder.ENVELOPE_RECOGNITION_ACTIVATION, CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION)
        })

        // Pins the ARMED map exactly (operator §7 cohort call, 2026-08-01). Every value
        // here is consensus-visible: a decoder that flips at a different height than its
        // peers forks the fleet on the first envelope, so this assertion is deliberately
        // literal rather than derived. DOGE stays null forever (no segwit, no Taproot).
        it('the recognition map is exactly the §7 shape: BTC/LTC armed mainnet cohorts, genesis-active test networks, DOGE never', function () {
            assert.deepStrictEqual(CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION, {
                BTC:  { mainnet: 960850, testnet: 0, regtest: 0 },
                LTC:  { mainnet: 3153500, testnet: 0, regtest: 0 },
                DOGE: { mainnet: null, testnet: null, regtest: null },
            })
        })

        describe('parity with the canonical xchain-documentation copy', function () {
            const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
                path.join(__dirname, '..', '..', '..', 'xchain-documentation')
            const DOCS_CONSTANTS = path.join(DOCS, 'protocol', 'constants.js')
            before(function () { if (!fs.existsSync(DOCS_CONSTANTS)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-documentation sibling not found at ' + DOCS_CONSTANTS + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } })

            it('ENVELOPE_MAX_PAYLOAD and the activation map are byte-equal to the canonical copy', function () {
                const docs = require(DOCS_CONSTANTS)
                assert.strictEqual(docs.ENVELOPE_MAX_PAYLOAD, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
                assert.deepStrictEqual(docs.ENVELOPE_RECOGNITION_ACTIVATION, CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION)
            })

            it('the inlined golden bytes match the frozen vector file', function () {
                const vectors = require(path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json'))
                assert.strictEqual(vectors.envelope_grammar.envelope_script_hex, GOLDEN.envelopeScriptHex)
                assert.strictEqual(vectors.envelope_grammar.compiled_payload_hex, GOLDEN.compiledPayloadHex)
                assert.strictEqual(vectors.envelope_grammar.control_block_hex, GOLDEN.controlBlockHex)
                assert.strictEqual(vectors.envelope_grammar.commit_scriptPubKey_hex, GOLDEN.commitScriptPubKeyHex)
                assert.strictEqual(vectors.envelope_grammar.action_string, GOLDEN.action)
                assert.strictEqual(vectors.envelope_grammar.raw_data_utf8, GOLDEN.rawDataUtf8)
                assert.strictEqual(vectors._meta.ceiling.value, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
                for (const adv of vectors.adversarial){
                    if (adv.name === 'bad_magic') assert.strictEqual(adv.envelope_script_hex, GOLDEN.badMagicScriptHex)
                    if (adv.name === 'unknown_format_byte') assert.strictEqual(adv.envelope_script_hex, GOLDEN.unknownFormatScriptHex)
                    if (adv.name === 'annex_bearing_reveal') assert.deepStrictEqual(adv.witness_stack_hex, GOLDEN.annexWitnessHex)
                }
            })

            it('the golden tapleaf hash reproduces from the frozen script bytes', function () {
                const vectors = require(path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json'))
                const script = Buffer.from(vectors.envelope_grammar.envelope_script_hex, 'hex')
                const lenPrefix = script.length < 253
                    ? Buffer.from([script.length])
                    : (() => { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(script.length, 1); return b })()
                const leaf = bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([Buffer.from([0xc0]), lenPrefix, script]))
                assert.strictEqual(leaf.toString('hex'), vectors.envelope_grammar.tapleaf_hash)
            })
        })

        describe('parity with the encoder validator', function () {
            const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
                path.join(__dirname, '..', '..', '..', 'xchain-encoder')
            const VALIDATOR = path.join(ENCODER, 'src', 'validator.js')
            before(function () { if (!fs.existsSync(VALIDATOR)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-encoder sibling not found at ' + VALIDATOR + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } })

            it('ENVELOPE_MAX_PAYLOAD stays equal across the two services', function () {
                const v = require(VALIDATOR)
                assert.strictEqual(v.ENVELOPE_MAX_PAYLOAD, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            })
        })
    })

    // Wire fidelity: a REAL encoder-built, signed reveal through parseTransaction
    describe('wire fidelity with the shipped encoder (sibling-gated)', function () {
        const ENCODER_DIR = process.env.XCHAIN_ENCODER_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-encoder')
        const ENCODER_MAIN = path.join(ENCODER_DIR, 'src', 'XChainEncoder.js')
        before(function () { if (!fs.existsSync(ENCODER_MAIN)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-encoder sibling not found at ' + ENCODER_MAIN + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } })

        it('an encoder-built signed commit/reveal pair decodes byte-identically', async function () {
            this.timeout(20000)
            const XChainEncoder = require(ENCODER_MAIN)

            // Deterministic caller key; its compressed pubkey doubles as the
            // envelope internal key, exactly as the encoder's own suite does.
            const priv = Buffer.alloc(32, 7)
            const pub = Buffer.from(ecc.pointFromScalar(priv, true))

            const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
            encoder.connector = {
                getFeePerKilobyte: async () => 0.00001,
                getTransactionHex: async () => { throw new Error('unit test: no node') }
            }
            encoder.utxoTrackerConnector = {
                getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
            }
            const network = encoder.network
            const caller = bitcoin.payments.p2wpkh({ pubkey: pub, network }).address
            const callerSpk = bitcoin.payments.p2wpkh({ pubkey: pub, network }).output
            const FUNDING_TXID = 'a'.repeat(64)
            const utxos = [{ txid: FUNDING_TXID, vout: 0, value: 10000000, confirmations: 6, scriptPubKey: callerSpk.toString('hex') }]

            const action = 'FILE|0|wire-fidelity.bin|application/octet-stream|||||||'
            const raw = crypto.randomBytes(9000).toString('binary')
            const result = await encoder.createTransaction(
                utxos, caller, null, action, raw,
                null, false, 'TAPROOT', caller, null, null, pub.toString('hex'))

            // Sign both halves the way a wallet does.
            result.psbt.signAllInputs({ publicKey: pub, sign: (h) => Buffer.from(ecc.sign(h, priv)) })
            result.psbt.finalizeAllInputs()
            const commitTx = result.psbt.extractTransaction()
            result.revealPsbt.signInput(0, { publicKey: pub, signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, priv)) })
            result.revealPsbt.finalizeAllInputs()
            const revealTx = result.revealPsbt.extractTransaction()

            // Decoder side: serve the commit by txid, plus a synthetic
            // commit-funding tx whose vout 0 pays the caller (the connector is
            // keyed by REQUESTED txid, so the synthetic tx's own id is moot).
            const decoder = createDecoder()
            const syntheticFunding = new bitcoin.Transaction()
            syntheticFunding.version = 2
            syntheticFunding.addInput(Buffer.alloc(32, 0xef), 0)
            syntheticFunding.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            syntheticFunding.addOutput(callerSpk, 10000000)
            const served = { [commitTx.getId()]: commitTx.toHex(), [FUNDING_TXID]: syntheticFunding.toHex() }
            const rpc = sinon.stub().callsFake(async (txid) => {
                if (served[txid]) return served[txid]
                throw new Error('unit test: unexpected getRawTransaction for ' + txid)
            })
            decoder.connector = { getRawTransaction: rpc }

            const parseTx = decoder.xchainBlockDecoder.transactionFromHex(revealTx.toHex())
            const parsed = await decoder.parseTransaction(parseTx, new Set(), null, POST_FLAG)

            assert.ok(parsed)
            assert.strictEqual(parsed.envelope, true)
            assert.strictEqual(parsed.payloadCeiling, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.strictEqual(parsed.data.toString('utf-8'), action, 'action string byte-identical')
            assert.deepStrictEqual(parsed.rawData, Buffer.from(raw, 'binary'), 'rawData byte-identical across the wire')
            assert.strictEqual(parsed.source, caller, 'source = the address funding the commit (§3.4)')
            const expectedPayload = bitcoin.script.compile([Buffer.from(action), Buffer.from(raw, 'binary')])
            assert.strictEqual(parsed.compiledDataLength, expectedPayload.length, '§4 measurand = reassembled payload length')
            assert.strictEqual(rpc.callCount, 2, 'one commit fetch + one attribution fetch, nothing else')
        })
    })
})
