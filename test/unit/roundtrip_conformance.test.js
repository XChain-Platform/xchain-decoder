// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Decoder half of the shared encoder->decoder roundtrip conformance fixture.
//
// WHAT THIS PINS: the encoder-built golden bytes are assembled into real
// transactions and driven through the DECODER'S PRODUCTION ENTRY POINTS -
// parseTransaction, then hasStorableContent and buildStoredActionRecord, the two
// halves of the storage gate the block and mempool loops both call. The
// assertion is on the STORED RECORD: the ACTION string and raw_data the row
// INSERT receives. This suite used to stop one step short, feeding the fixture
// through a test-local `gateOutcome` reimplementation of the decoder's arbiter,
// so 73 green assertions pinned byte primitives and nothing about what history
// actually holds; the ceiling, the alias rewrite and the VALID_ACTION_NAMES gate
// were all downstream of where it stopped looking.
//
// WHAT "ROUNDTRIP" MEANS HERE: the expected stored ACTION string is derived from
// the fixture's own `inputDataHex` (the string the ENCODER was handed) rather
// than hand-copied into this file, so a green run means the encoder's input
// survived compile -> obfuscate -> carrier -> deobfuscate -> reassemble ->
// decompile -> canonicalize -> decode to the row unchanged. Alias cases assert
// the canonical rewrite instead, which is the one place the stored record is
// deliberately NOT the input.
//
// PLACEMENT: needs no database, since the storage gate is a pure function
// of a parse result; only the node RPC is faked, at the connector seam.
// The docker-gated integration tier covers the row landing in MariaDB.
//
// The fixture is authored in the sibling xchain-encoder repo (single source of
// truth) and VENDORED byte-identically into test/fixtures/ here. The vendored
// copy is loaded unconditionally so these assertions always run in single-repo
// CI; a separate byte-identity guard (below) catches drift against the encoder
// original when the sibling checkout is present, or hard-fails under
// XCHAIN_REQUIRE_SIBLINGS=1. Resolving the fixture from the sibling and
// skipping when it was absent once made single-repo CI report green having
// executed zero assertions.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../src/XChainDecoder')

const VENDORED = path.join(__dirname, '..', 'fixtures', 'roundtrip-conformance.json')
const fixture = JSON.parse(fs.readFileSync(VENDORED, 'utf8'))

// Regtest P2PKH address the faked prevout pays, i.e. the source every case
// resolves to through the real getSourceFromOutput.
const SOURCE_ADDRESS = 'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q'

// Deterministic spend-side filler so the redeem/witness script lands at the exact
// position parseTransaction reads: scriptSig push [2] / witness [2].
const DUMMY_SIG = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(70, 0xab)])
const DUMMY_PUBKEY = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xcd)])

// Block height these cases parse at. bitcoin-regtest's Taproot-envelope
// recognition height is 0 (ENVELOPE_RECOGNITION_ACTIVATION in
// src/protocol/constants.js: testnet and regtest are genesis-active, the flag
// day only ever applied to mainnet) and the predicate is
// `blockHeight >= activationHeight`, so the envelope surface is ACTIVE here.
// The envelope lane below needs that; the legacy carriers are unaffected,
// because recognition is a pure witness pattern match and none of their
// spend-side fillers match the grammar.
//
// This constant was called PRE_ENVELOPE_HEIGHT and documented as sitting below
// every chain's recognition height. It never did on this decoder: the comment
// described an inert surface while the suite ran against a live one, so a
// regression that pulled a legacy carrier into the envelope branch would have
// read as impossible here rather than being caught.
const PARSE_HEIGHT = 0

// Only the node RPC is faked. getSourceFromOutput, the pubkey extraction and
// every gate stay on the production path; the connector returns a real
// serialized transaction whose vout 0 pays SOURCE_ADDRESS.
function createDecoder () {
  const decoder = new XChainDecoder(
    'bitcoin-regtest', null, null, null, null, null,
    '127.0.0.1', 18443, 'rpc', 'rpc', false
  )
  const prevout = new bitcoin.Transaction()
  prevout.addInput(Buffer.alloc(32, 0x99), 0)
  prevout.addOutput(bitcoin.address.toOutputScript(SOURCE_ADDRESS, decoder.network), 5000)
  const prevoutHex = prevout.toHex()
  decoder.connector.getRawTransaction = async () => prevoutHex
  return decoder
}

// Explicit DB stub for the parse's pubkey-capture writes, so those calls are
// visible to the tests instead of disappearing into the tier's mariadb mock.
function createDbStub () {
  const calls = { getAddressId: [], hasPubkey: [], insertPubkey: [] }
  return {
    calls,
    getAddressId: async (address) => { calls.getAddressId.push(address); return null },
    hasPubkey: async (id) => { calls.hasPubkey.push(id); return false },
    insertPubkey: async (id, pubkey) => { calls.insertPubkey.push([id, pubkey]); return true }
  }
}

function reversedTxid (hex) {
  return Buffer.from(hex, 'hex').reverse()
}

function opReturnScript (hex) {
  return bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(hex, 'hex')])
}

// The three carrier shapes, assembled as real bitcoinjs transactions so
// parseTransaction sees exactly what the block loop hands it.
function buildOpReturnTransaction (c) {
  const tx = new bitcoin.Transaction()
  tx.addInput(reversedTxid(c.firstInputTxid), 0)
  tx.addOutput(opReturnScript(c.obfuscatedOpReturnHex), 0)
  return tx
}

function buildMultisignTransaction (c) {
  const tx = new bitcoin.Transaction()
  tx.addInput(reversedTxid(c.firstInputTxid), 0)
  for (const slot of c.slots) tx.addOutput(Buffer.from(slot.outputScriptHex, 'hex'), 1000)
  return tx
}

// Reveal transaction: the encoding-marker OP_RETURN plus one spend per chunk,
// carrying the chunk in the redeem script (P2SH) or the witness (P2WSH).
function buildP2shTransaction (c, chunkCount) {
  const scripts = c.redeemScriptsHex.slice(0, chunkCount == null ? c.redeemScriptsHex.length : chunkCount)
  const tx = new bitcoin.Transaction()
  scripts.forEach((hex, i) => {
    const redeemScript = Buffer.from(hex, 'hex')
    if (c.encoding === 'P2SH') {
      tx.addInput(reversedTxid(c.firstInputTxid), i, undefined,
        bitcoin.script.compile([DUMMY_SIG, DUMMY_PUBKEY, redeemScript]))
    } else {
      tx.addInput(reversedTxid(c.firstInputTxid), i)
      tx.ins[i].witness = [DUMMY_SIG, DUMMY_PUBKEY, redeemScript]
    }
  })
  tx.addOutput(opReturnScript(c.markerOpReturnHex), 0)
  return tx
}

// Taproot-envelope reveal: ins[0] spends the commit output, and its witness is
// the BIP341 script-path stack the envelope grammar is matched against, indexed
// from the END - [..., <envelope tapscript>, <control block>]. The control
// block is leaf version 0xc0 (parity in the low bit) followed by the 32-byte
// internal key, with no merkle path, which is what a single-leaf commit spends.
// No annex: an annex-bearing stack is never an envelope (spec §3.8).
//
// ins[0] MUST be the envelope input (§3.5) and no other carrier may be present,
// or the parse rejects the whole envelope deterministically, so this builder
// pays to a plain address rather than adding an OP_RETURN marker the way the
// P2SH lane does.
function buildEnvelopeTransaction (decoder, c) {
  const envelopeScript = Buffer.from(c.envelopeScriptHex, 'hex')
  const controlBlock = Buffer.concat([Buffer.from([0xc0]), Buffer.from(c.internalPubkeyHex, 'hex')])
  const tx = new bitcoin.Transaction()
  tx.addInput(reversedTxid(c.firstInputTxid), 0)
  tx.ins[0].witness = [DUMMY_SIG, envelopeScript, controlBlock]
  tx.addOutput(bitcoin.address.toOutputScript(SOURCE_ADDRESS, decoder.network), 1000)
  return tx
}

// Expected fate of each fixture case once it reaches the storage gate. Only the
// FATE is pinned here; the stored bytes themselves are always derived from the
// fixture's own encoder inputs below, so this table can never drift into being a
// second copy of the payloads.
//   storable:false  -> no ACTION survived the parse, so no row is written
//   skip:true       -> the gate rejected the ACTION and the tx has no outputs to
//                      record either, so the block loop drops it
//   skip:false      -> the row is written and holds the derived ACTION string
const STORED_FATE = {
  // OP_RETURN
  'action-only (SEND)': { storable: true, skip: true, why: 'JSON blob is not a VALID_ACTION_NAME' },
  'BET place-bet (OP_RETURN sized)': { storable: true, skip: false },
  'action + rawData (ISSUE + metadata)': { storable: true, skip: false },
  'action + binary rawData (high bytes)': { storable: true, skip: false },
  'rawData-only OP_0 leading push (currently dropped)': { storable: false, why: 'empty leading push blanks the payload; the paid-for rawData is lost' },
  '1-byte minimal-op data 0x05 (currently dropped)': { storable: false, why: 'compile canonicalized 0x05 to a bare OP_5 the arbiter drops' },
  '1-byte non-minimal data 0x41 (safe single push)': { storable: true, skip: true, why: "'A' survives the arbiter but is not a VALID_ACTION_NAME" },
  'empty data-only (payment-only / no-ACTION, OP_0)': { storable: false },
  // MULTISIGN
  'MULTISIGN single slot with pad (SEND)': { storable: true, skip: true, why: 'JSON blob is not a VALID_ACTION_NAME' },
  'MULTISIGN three slots + rawData': { storable: true, skip: false },
  'MULTISIGN exact slot boundary (no pad)': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  // P2SH / P2WSH
  'P2SH two chunks (no rebalance)': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2SH final-chunk rebalance boundary (last byte 0x05)': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2WSH two chunks + rawData': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2WSH BET create at the DETAILS cap': { storable: true, skip: false },
  // alias rewrite
  'alias rewrite TRANSFER -> SEND': { storable: true, skip: false },
  'alias rewrite MSG -> MESSAGE': { storable: true, skip: false },
  'alias rewrite CAST -> BROADCAST at the compiled ceiling': { storable: true, skip: false },
  // TAPROOT envelope
  'envelope action-only (SEND)': { storable: true, skip: false },
  'envelope action + rawData (ISSUE + metadata)': { storable: true, skip: false },
  'envelope multi-chunk BROADCAST': { storable: true, skip: false },
  'envelope final-chunk rebalance boundary (last byte 0x05)': { storable: true, skip: false }
}

// The stored ACTION string this case must produce: the encoder's own input,
// except where the decoder is required to rewrite an alias to its canonical name.
function expectedStoredData (c) {
  if (c.expected.canonicalDataHex != null) return Buffer.from(c.expected.canonicalDataHex, 'hex').toString('utf8')
  return Buffer.from(c.inputDataHex, 'hex').toString('utf8')
}

function expectedStoredRawDataHex (c) {
  return c.inputRawDataHex == null ? null : c.inputRawDataHex
}

// Drive one fixture case all the way to the record the row INSERT receives.
async function storedRecordFor (decoder, db, transaction) {
  const parseResult = await decoder.parseTransaction(transaction, new Set(), db, PARSE_HEIGHT)
  const storable = decoder.hasStorableContent(parseResult)
  const record = storable
    ? decoder.buildStoredActionRecord(parseResult, transaction.getId(), false)
    : null
  return { parseResult, storable, record }
}

// Shared body for all four lanes: parse -> storage gate -> assert the row.
async function assertCase (decoder, db, c, transaction) {
  const fate = STORED_FATE[c.name]
  assert.ok(fate, `${c.name}: no stored-record expectation pinned (add one to STORED_FATE)`)

  const { parseResult, storable, record } = await storedRecordFor(decoder, db, transaction)
  assert.ok(parseResult != null, `${c.name}: parseTransaction returned null`)

  // The parse-side seam: the payload the production extraction recovered must be
  // the arbiter outcome the encoder pinned, byte for byte.
  const expectedParsedHex = (c.expected.gate === 'dropped') ? '' : c.expected.dataHex
  assert.strictEqual(Buffer.from(parseResult.data).toString('hex'), expectedParsedHex,
    `${c.name}: parsed ACTION payload diverges from the encoder`)
  const parsedRawHex = parseResult.rawData == null ? null : Buffer.from(parseResult.rawData).toString('hex')
  if (c.expected.rawDataHex !== undefined) {
    assert.strictEqual(parsedRawHex, c.expected.rawDataHex, `${c.name}: parsed rawData`)
  }

  assert.strictEqual(storable, fate.storable, `${c.name}: hasStorableContent`)
  if (!fate.storable) return

  assert.strictEqual(record.skip, fate.skip, `${c.name}: storage-gate skip`)
  if (fate.skip) {
    // A rejected ACTION must not leave a partial record behind.
    assert.strictEqual(record.data, '', `${c.name}: rejected ACTION must blank the data column`)
    assert.strictEqual(record.rawData, null, `${c.name}: rejected ACTION must blank raw_data`)
    return
  }

  assert.strictEqual(record.data, expectedStoredData(c),
    `${c.name}: stored ACTION string diverges from the encoder's input`)
  const storedRawHex = record.rawData == null ? null : Buffer.from(record.rawData).toString('hex')
  assert.strictEqual(storedRawHex, expectedStoredRawDataHex(c), `${c.name}: stored raw_data`)
  assert.strictEqual(parseResult.source, SOURCE_ADDRESS, `${c.name}: stored source`)
}

describe('roundtrip conformance fixture: every case reaches the stored record', function () {
  let decoder
  let db

  beforeEach(function () {
    decoder = createDecoder()
    db = createDbStub()
  })

  it('pins a stored-record expectation for every fixture case, and no stale ones', function () {
    const fixtureNames = []
    for (const key of ['cases', 'multisignCases', 'p2shCases', 'aliasCases', 'envelopeCases']) {
      assert.ok(fixture[key].length > 0, `fixture.${key} is empty`)
      for (const c of fixture[key]) fixtureNames.push(c.name)
    }
    for (const name of fixtureNames) {
      assert.ok(STORED_FATE[name], `fixture case '${name}' has no stored-record expectation`)
    }
    for (const name of Object.keys(STORED_FATE)) {
      assert.ok(fixtureNames.includes(name), `stale stored-record expectation '${name}' matches no fixture case`)
    }
  })

  it('drives every OP_RETURN case to the record the row INSERT receives', async function () {
    for (const c of fixture.cases) await assertCase(decoder, db, c, buildOpReturnTransaction(c))
  })

  it('drives every MULTISIGN case to the record the row INSERT receives', async function () {
    for (const c of fixture.multisignCases) await assertCase(decoder, db, c, buildMultisignTransaction(c))
  })

  it('drives every P2SH/P2WSH case to the record the row INSERT receives', async function () {
    for (const c of fixture.p2shCases) await assertCase(decoder, db, c, buildP2shTransaction(c))
  })

  it('drives every alias case to the record the row INSERT receives', async function () {
    for (const c of fixture.aliasCases) await assertCase(decoder, db, c, buildOpReturnTransaction(c))
  })

  it('drives every TAPROOT envelope case to the record the row INSERT receives', async function () {
    for (const c of fixture.envelopeCases) {
      await assertCase(decoder, db, c, buildEnvelopeTransaction(decoder, c))
    }
  })

  it('recognizes each envelope as the carrier, with the envelope ceiling', async function () {
    // The lane's own routing, not shared with any other group: recognition must
    // actually fire (a witness that stopped matching would silently fall back to
    // "no carrier", and assertCase's dropped-gate branch would pass on an empty
    // payload for the wrong reason), and the per-encoding ceiling must be the
    // envelope one rather than the 8,192-byte legacy cap.
    for (const c of fixture.envelopeCases) {
      const tx = buildEnvelopeTransaction(decoder, c)
      const parseResult = await decoder.parseTransaction(tx, new Set(), db, PARSE_HEIGHT)
      assert.strictEqual(parseResult.envelope, true, `${c.name}: not recognized as an envelope carrier`)
      assert.strictEqual(parseResult.payloadCeiling, XChainDecoder.ENVELOPE_MAX_PAYLOAD,
        `${c.name}: envelope must carry the envelope payload ceiling`)
    }
  })

  it('reassembles the envelope payload as the encoder compiled it, chunk boundaries included', async function () {
    // The envelope payload is raw (spec §3.3), so the decoder's reassembly is a
    // plain concat of the leaf's payload pushes. Assert against the fixture's
    // compiled stream rather than against the parsed ACTION, so a chunk dropped
    // or reordered at a 520-byte boundary fails here even when the surviving
    // prefix would still decompile to something.
    for (const c of fixture.envelopeCases) {
      const detected = decoder.detectEnvelopeWitness([
        DUMMY_SIG,
        Buffer.from(c.envelopeScriptHex, 'hex'),
        Buffer.concat([Buffer.from([0xc0]), Buffer.from(c.internalPubkeyHex, 'hex')])
      ])
      assert.ok(detected != null, `${c.name}: witness did not match the envelope grammar`)
      assert.strictEqual(detected.payload.toString('hex'), c.compiledHex,
        `${c.name}: reassembled envelope payload diverges from the encoder's compiled stream`)
    }
  })
})

describe('roundtrip conformance fixture: stored-record invariants', function () {
  let decoder
  let db

  beforeEach(function () {
    decoder = createDecoder()
    db = createDbStub()
  })

  it('stores the CANONICAL action name, never the on-wire alias', async function () {
    for (const c of fixture.aliasCases) {
      const { record } = await storedRecordFor(decoder, db, buildOpReturnTransaction(c))
      assert.strictEqual(record.data.split('|')[0], c.expected.actionName,
        `${c.name}: stored record must carry the canonical name`)
      assert.ok(!record.data.startsWith(c.expected.rawActionName + '|'),
        `${c.name}: alias spelling '${c.expected.rawActionName}' reached the row`)
    }
  })

  it('lets an alias expansion push the stored record PAST the compiled wire ceiling', async function () {
    // The size gate bounds the WIRE (alias) form; canonicalization runs after it,
    // so a CAST at exactly the ceiling stores as a longer BROADCAST record. If the
    // gate is ever moved after the rewrite, this case starts being dropped.
    const c = fixture.aliasCases.find((x) => x.expected.actionName === 'BROADCAST')
    assert.ok(c, 'expected the ceiling alias case in the fixture')
    const { parseResult, record } = await storedRecordFor(decoder, db, buildOpReturnTransaction(c))
    assert.strictEqual(parseResult.compiledDataLength, XChainDecoder.MAX_ACTION_DATA_LENGTH,
      'the ceiling case must sit exactly on the wire cap')
    assert.strictEqual(record.skip, false, 'the ceiling case must still be stored')
    assert.ok(Buffer.byteLength(record.data, 'utf8') > XChainDecoder.MAX_ACTION_DATA_LENGTH,
      'the canonical record must be longer than the wire cap it was measured against')
  })

  it('captures the spender pubkey through the real extraction on a P2WSH reveal', async function () {
    // The witness stack's second element is the spender pubkey; parseTransaction
    // must look it up against the resolved source rather than skipping the write.
    const c = fixture.p2shCases.find((x) => x.encoding === 'P2WSH')
    assert.ok(c, 'expected a P2WSH case in the fixture')
    await storedRecordFor(decoder, db, buildP2shTransaction(c))
    assert.deepStrictEqual(db.calls.getAddressId, [SOURCE_ADDRESS],
      'the pubkey capture must resolve the source address exactly once')
  })

  it('has teeth: a one-byte perturbation of the ciphertext destroys the stored record', async function () {
    const c = fixture.cases.find((x) => STORED_FATE[x.name].skip === false)
    assert.ok(c, 'expected at least one stored OP_RETURN case')
    const tampered = { ...c, obfuscatedOpReturnHex: null }
    const bytes = Buffer.from(c.obfuscatedOpReturnHex, 'hex')
    bytes[bytes.length - 1] ^= 0xff
    tampered.obfuscatedOpReturnHex = bytes.toString('hex')
    const { storable, record } = await storedRecordFor(decoder, db, buildOpReturnTransaction(tampered))
    const stored = storable && !record.skip ? record.data : null
    assert.notStrictEqual(stored, expectedStoredData(c),
      'perturbed ciphertext must not produce the golden stored record')
  })

  it('has teeth: dropping an interior chunk destroys the stored record', async function () {
    // The fail-loud contract's premise: a reveal missing one of its chunk inputs
    // must never reassemble into the golden ACTION string.
    const c = fixture.p2shCases.find((x) => STORED_FATE[x.name].skip === false && x.redeemScriptsHex.length >= 2)
    assert.ok(c, 'expected a stored multi-chunk case')
    const { storable, record } = await storedRecordFor(decoder, db,
      buildP2shTransaction(c, c.redeemScriptsHex.length - 1))
    const stored = storable && !record.skip ? record.data : null
    assert.notStrictEqual(stored, expectedStoredData(c),
      'a truncated chunk set must not produce the golden stored record')
  })

  it('has teeth: the fixture still covers the 1-byte final-chunk rebalance boundary', function () {
    assert.ok(fixture.p2shCases.some((c) =>
      c.chunkLengths.length >= 2 && c.chunkLengths[c.chunkLengths.length - 1] === 2
    ), 'no case pins the rebalanced final chunk')
  })

  it('has teeth: every reveal marker routes through the real deobfuscation', async function () {
    // A marker that no longer deobfuscates to XCHN+p2sh/p2wsh would send the whole
    // chunk lane down the plain OP_RETURN branch and silently store nothing.
    const magic = Buffer.from(fixture.magicWord, 'utf8')
    for (const c of fixture.p2shCases) {
      const marker = await decoder.removeObfuscation(Buffer.from(c.markerOpReturnHex, 'hex'), c.firstInputTxid)
      assert.ok(marker != null, `${c.name}: marker deobfuscation returned null`)
      assert.ok(marker.equals(Buffer.concat([magic, Buffer.from(c.encoding.toLowerCase(), 'utf8')])),
        `${c.name}: marker must deobfuscate to XCHN+${c.encoding.toLowerCase()}`)
    }
  })
})

// IDENTITY: the vendored copy must match the canonical encoder fixture (skip
// when the sibling xchain-encoder is not checked out, matching the
// ActionManifestConformance convention; hard-fail under XCHAIN_REQUIRE_SIBLINGS).
describe('roundtrip conformance fixture: byte-identity to encoder original', function () {
  const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-encoder')
  const CANON = path.join(ENCODER, 'test', 'fixtures', 'roundtrip-conformance.json')

  before(function () {
    if (!fs.existsSync(CANON)) {
      if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical roundtrip-conformance.json not found at ' + CANON)
      }
      this.skip()
    }
  })

  it('vendored test/fixtures/roundtrip-conformance.json is byte-identical to the encoder original', function () {
    assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
      'vendored roundtrip-conformance.json drifted from the encoder original; ' +
      're-run the encoder fixture generator and re-vendor the copy here.')
  })
})
