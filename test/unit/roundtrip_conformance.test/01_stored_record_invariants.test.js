// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../../src/XChainDecoder')

const VENDORED = path.join(__dirname, '..', '..', 'fixtures', 'roundtrip-conformance.json')
const fixture = JSON.parse(fs.readFileSync(VENDORED, 'utf8'))

const SOURCE_ADDRESS = 'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q'
const DUMMY_SIG = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(70, 0xab)])
const DUMMY_PUBKEY = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xcd)])
const PARSE_HEIGHT = 0

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

function buildOpReturnTransaction (c) {
  const tx = new bitcoin.Transaction()
  tx.addInput(reversedTxid(c.firstInputTxid), 0)
  tx.addOutput(opReturnScript(c.obfuscatedOpReturnHex), 0)
  return tx
}

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

const STORED_FATE = {
  'action-only (SEND)': { storable: true, skip: true, why: 'JSON blob is not a VALID_ACTION_NAME' },
  'BET place-bet (OP_RETURN sized)': { storable: true, skip: false },
  'action + rawData (ISSUE + metadata)': { storable: true, skip: false },
  'action + binary rawData (high bytes)': { storable: true, skip: false },
  'rawData-only OP_0 leading push (currently dropped)': { storable: false, why: 'empty leading push blanks the payload; the paid-for rawData is lost' },
  '1-byte minimal-op data 0x05 (currently dropped)': { storable: false, why: 'compile canonicalized 0x05 to a bare OP_5 the arbiter drops' },
  '1-byte non-minimal data 0x41 (safe single push)': { storable: true, skip: true, why: "'A' survives the arbiter but is not a VALID_ACTION_NAME" },
  'empty data-only (payment-only / no-ACTION, OP_0)': { storable: false },
  'MULTISIGN single slot with pad (SEND)': { storable: true, skip: true, why: 'JSON blob is not a VALID_ACTION_NAME' },
  'MULTISIGN three slots + rawData': { storable: true, skip: false },
  'MULTISIGN exact slot boundary (no pad)': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2SH two chunks (no rebalance)': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2SH final-chunk rebalance boundary (last byte 0x05)': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2WSH two chunks + rawData': { storable: true, skip: true, why: 'filler payload is not a VALID_ACTION_NAME' },
  'P2WSH BET create at the DETAILS cap': { storable: true, skip: false },
  'alias rewrite TRANSFER -> SEND': { storable: true, skip: false },
  'alias rewrite MSG -> MESSAGE': { storable: true, skip: false },
  'alias rewrite CAST -> BROADCAST at the compiled ceiling': { storable: true, skip: false },
  'envelope action-only (SEND)': { storable: true, skip: false },
  'envelope action + rawData (ISSUE + metadata)': { storable: true, skip: false },
  'envelope multi-chunk BROADCAST': { storable: true, skip: false },
  'envelope final-chunk rebalance boundary (last byte 0x05)': { storable: true, skip: false }
}

function expectedStoredData (c) {
  if (c.expected.canonicalDataHex != null) return Buffer.from(c.expected.canonicalDataHex, 'hex').toString('utf8')
  return Buffer.from(c.inputDataHex, 'hex').toString('utf8')
}

async function storedRecordFor (decoder, db, transaction) {
  const parseResult = await decoder.parseTransaction(transaction, new Set(), db, PARSE_HEIGHT)
  const storable = decoder.hasStorableContent(parseResult)
  const record = storable
    ? decoder.buildStoredActionRecord(parseResult, transaction.getId(), false)
    : null
  return { parseResult, storable, record }
}

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
})

describe('roundtrip conformance fixture: stored-record invariants', function () {
  let decoder
  let db

  beforeEach(function () {
    decoder = createDecoder()
    db = createDbStub()
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
    // chunk path down the plain OP_RETURN branch and silently store nothing.
    const magic = Buffer.from(fixture.magicWord, 'utf8')
    for (const c of fixture.p2shCases) {
      const marker = await decoder.removeObfuscation(Buffer.from(c.markerOpReturnHex, 'hex'), c.firstInputTxid)
      assert.ok(marker != null, `${c.name}: marker deobfuscation returned null`)
      assert.ok(marker.equals(Buffer.concat([magic, Buffer.from(c.encoding.toLowerCase(), 'utf8')])),
        `${c.name}: marker must deobfuscate to XCHN+${c.encoding.toLowerCase()}`)
    }
  })
})
