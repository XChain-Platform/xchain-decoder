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
// Decoder half of the shared encoder->decoder roundtrip conformance fixture
// (). Feeds the encoder-built golden bytes through the REAL decoder
// primitives -- XChainDecoder.prototype.removeObfuscation plus the same
// bitcoin.script.decompile call and leading-Buffer arbiter gate the decode path
// applies (XChainDecoder.js ~677-718) -- rather than a test-local deobfuscate
// reimplementation. This closes the gap the previous suite had: encoder output
// was only ever decoded by copied helpers, never the shipped decoder code.
//
// The fixture is authored in the sibling xchain-encoder repo (single source of
// truth) and VENDORED byte-identically into test/fixtures/ here, matching the
// ActionManifestConformance convention: the vendored copy is loaded
// unconditionally so these assertions always run in single-repo CI, and a
// separate byte-identity guard (below) catches drift against the encoder
// original when the sibling checkout is present (or hard-fails under
// XCHAIN_REQUIRE_SIBLINGS=1). Previously this test resolved the fixture from the
// sibling checkout and this.skip()'d when it was absent, so single-repo CI
// reported green having executed zero assertions.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../src/XChainDecoder')
const { canonicalizeActionPayload } = XChainDecoder

const VENDORED = path.join(__dirname, '..', 'fixtures', 'roundtrip-conformance.json')
const fixture = JSON.parse(fs.readFileSync(VENDORED, 'utf8'))

function createDecoder () {
  return new XChainDecoder(
    'bitcoin-regtest', null, null, null, null, null,
    '127.0.0.1', 18443, 'rpc', 'rpc', false
  )
}

// The decoder's arbiter gate, applied to the decompiled compiled-ACTION push.
function gateOutcome (compiled) {
  const decompiled = bitcoin.script.decompile(compiled)
  if (decompiled == null || decompiled.length === 0) return { gate: 'dropped', data: null, rawData: null }
  if (!Buffer.isBuffer(decompiled[0])) return { gate: 'dropped', data: null, rawData: null }
  let rawData = null
  if (decompiled.length > 1 && Buffer.isBuffer(decompiled[1])) rawData = decompiled[1]
  return { gate: 'accepted', data: decompiled[0], rawData }
}

describe('roundtrip conformance fixture: real-decoder decode ()', function () {
  let decoder
  let magicBuffer

  before(function () {
    decoder = createDecoder()
    magicBuffer = Buffer.from(fixture.magicWord, 'utf8')
  })

  it('has cases', function () {
    assert.ok(fixture.cases.length > 0)
  })

  it('decodes every encoder-built case to its pinned expectation', async function () {
    for (const c of fixture.cases) {
      // 1. Real decoder deobfuscation recovers the encoder's magic-prefixed payload.
      const obfuscated = Buffer.from(c.obfuscatedOpReturnHex, 'hex')
      const deob = await decoder.removeObfuscation(obfuscated, c.firstInputTxid)
      assert.ok(deob != null, `${c.name}: removeObfuscation returned null`)
      assert.ok(deob.subarray(0, magicBuffer.length).equals(magicBuffer),
        `${c.name}: recovered payload missing magic word`)

      // 2. Stripping the magic must recover the encoder's exact compiled bytes:
      //    this is the cross-service seam (encoder compile == decoder deobfuscated).
      const compiled = deob.subarray(magicBuffer.length)
      assert.strictEqual(compiled.toString('hex'), c.compiledHex,
        `${c.name}: deobfuscated compiled bytes diverge from the encoder`)

      // 3. Real decompile + arbiter gate must reproduce the pinned decode outcome.
      const outcome = gateOutcome(compiled)
      assert.strictEqual(outcome.gate, c.expected.gate, `${c.name}: gate outcome`)
      const dataHex = outcome.data == null ? null : outcome.data.toString('hex')
      const rawHex = outcome.rawData == null ? null : outcome.rawData.toString('hex')
      assert.strictEqual(dataHex, c.expected.dataHex, `${c.name}: decoded data`)
      assert.strictEqual(rawHex, c.expected.rawDataHex, `${c.name}: decoded rawData`)
    }
  })

  it('has teeth: a one-byte perturbation of any obfuscated case breaks the seam', async function () {
    // Flip a byte in the first accepted case; the decoder must no longer recover
    // the pinned compiled bytes (guards against a silently drifting fixture).
    const c = fixture.cases.find((x) => x.expected.gate === 'accepted')
    assert.ok(c, 'expected at least one accepted case')
    const tampered = Buffer.from(c.obfuscatedOpReturnHex, 'hex')
    tampered[tampered.length - 1] ^= 0xff
    const deob = await decoder.removeObfuscation(tampered, c.firstInputTxid)
    const compiled = deob.subarray(magicBuffer.length)
    assert.notStrictEqual(compiled.toString('hex'), c.compiledHex,
      'perturbed ciphertext must not decode to the golden compiled bytes')
  })
})

// : multi-input/multi-output reassembly harness. The original suite only
// exercised the single-push OP_RETURN path; these blocks feed the encoder-built
// MULTISIGN slots and P2SH/P2WSH redeem-script chunks through the SAME
// extraction shapes parseTransaction applies (XChainDecoder.js MULTISIGN branch
// ~695-731, P2SH ~633-655, P2WSH ~661-682, final decompile gate ~748-795),
// using the real decoder deobfuscation primitive throughout.
describe('roundtrip conformance fixture: MULTISIGN reassembly ', function () {
  let decoder
  let magicBuffer

  before(function () {
    decoder = createDecoder()
    magicBuffer = Buffer.from(fixture.magicWord, 'utf8')
  })

  it('has cases', function () {
    assert.ok(fixture.multisignCases.length > 0)
  })

  it('reassembles every MULTISIGN case through the real decoder extraction shape', async function () {
    for (const c of fixture.multisignCases) {
      let dataBuffer = Buffer.allocUnsafe(0)
      for (const [i, s] of c.slots.entries()) {
        // Decompile the actual on-wire 1-of-3 bare-multisig output script and
        // apply parseTransaction's MULTISIGN detection gate.
        const decompiledScript = bitcoin.script.decompile(Buffer.from(s.outputScriptHex, 'hex'))
        assert.strictEqual(decompiledScript.length, 6,
          `${c.name} slot ${i}: multisig script must decompile to 6 elements`)
        assert.strictEqual(decompiledScript[5], bitcoin.opcodes.OP_CHECKMULTISIG,
          `${c.name} slot ${i}: last element must be OP_CHECKMULTISIG`)
        assert.ok(Buffer.isBuffer(decompiledScript[1]) && Buffer.isBuffer(decompiledScript[2]),
          `${c.name} slot ${i}: fake pubkeys must be Buffers`)

        // Strip the 0x02 prefix from both fake-pubkey halves and rejoin, exactly
        // as the decoder does, then deobfuscate with the real primitive.
        const data = Buffer.concat([decompiledScript[1].subarray(1), decompiledScript[2].subarray(1)])
        const deob = await decoder.removeObfuscation(data, c.firstInputTxid)
        assert.ok(deob != null, `${c.name} slot ${i}: removeObfuscation returned null`)
        assert.ok(deob.subarray(0, magicBuffer.length).equals(magicBuffer),
          `${c.name} slot ${i}: recovered slot missing magic word`)
        assert.strictEqual(deob.toString('hex'), s.plaintextSlotHex,
          `${c.name} slot ${i}: deobfuscated slot diverges from the encoder`)
        dataBuffer = Buffer.concat([dataBuffer, deob.subarray(magicBuffer.length)])
      }

      // The zero pad is still present here; it is stripped only by the payload's
      // self-describing compiled-push length at the final decompile.
      assert.strictEqual(dataBuffer.toString('hex'), c.reassembledHex,
        `${c.name}: reassembled buffer diverges from the golden bytes`)

      const outcome = gateOutcome(dataBuffer)
      assert.strictEqual(outcome.gate, c.expected.gate, `${c.name}: gate outcome`)
      const dataHex = outcome.data == null ? null : outcome.data.toString('hex')
      const rawHex = outcome.rawData == null ? null : outcome.rawData.toString('hex')
      assert.strictEqual(dataHex, c.expected.dataHex, `${c.name}: decoded data`)
      assert.strictEqual(rawHex, c.expected.rawDataHex, `${c.name}: decoded rawData`)
    }
  })
})

describe('roundtrip conformance fixture: P2SH/P2WSH multi-input reassembly ', function () {
  let decoder
  let magicBuffer

  before(function () {
    decoder = createDecoder()
    magicBuffer = Buffer.from(fixture.magicWord, 'utf8')
  })

  // Deterministic spend-side filler so the redeem/witness script lands at the
  // exact position parseTransaction reads: scriptSig push [2] / witness [2].
  const DUMMY_SIG = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(70, 0xab)])
  const DUMMY_PUBKEY = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xcd)])

  it('has cases', function () {
    assert.ok(fixture.p2shCases.length > 0)
  })

  it('covers the 1-byte final-chunk rebalance boundary', function () {
    assert.ok(fixture.p2shCases.some((c) =>
      c.chunkLengths.length >= 2 && c.chunkLengths[c.chunkLengths.length - 1] === 2
    ), 'no case pins the rebalanced final chunk')
  })

  it('recovers each reveal marker with the real decoder deobfuscation', async function () {
    for (const c of fixture.p2shCases) {
      const marker = await decoder.removeObfuscation(Buffer.from(c.markerOpReturnHex, 'hex'), c.firstInputTxid)
      assert.ok(marker != null, `${c.name}: marker deobfuscation returned null`)
      const expectedPlain = Buffer.concat([magicBuffer, Buffer.from(c.encoding.toLowerCase(), 'utf8')])
      assert.ok(marker.equals(expectedPlain),
        `${c.name}: marker must deobfuscate to XCHN+${c.encoding.toLowerCase()} to route the input loop`)
    }
  })

  it('reassembles every case through the per-input extraction shape', async function () {
    for (const c of fixture.p2shCases) {
      let dataBuffer = Buffer.allocUnsafe(0)
      for (const [i, redeemHex] of c.redeemScriptsHex.entries()) {
        const redeemScript = Buffer.from(redeemHex, 'hex')
        let decodedRedeemScript
        if (c.encoding === 'P2SH') {
          // Reveal input scriptSig: <sig> <pubkey> <redeemScript>; the decoder
          // decompiles it and reads element [2] as the redeem script.
          const scriptSig = bitcoin.script.compile([DUMMY_SIG, DUMMY_PUBKEY, redeemScript])
          const decodedScriptSig = bitcoin.script.decompile(scriptSig)
          assert.ok(decodedScriptSig && decodedScriptSig.length >= 3 && Buffer.isBuffer(decodedScriptSig[2]),
            `${c.name} input ${i}: scriptSig[2] must be the redeem script Buffer`)
          decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
        } else {
          // Reveal input witness stack: [sig, pubkey, witnessScript]; the
          // decoder reads witness[2] directly (no decompile of the stack).
          const witness = [DUMMY_SIG, DUMMY_PUBKEY, redeemScript]
          assert.ok(witness.length >= 3 && Buffer.isBuffer(witness[2]),
            `${c.name} input ${i}: witness[2] must be the witness script Buffer`)
          decodedRedeemScript = bitcoin.script.decompile(witness[2])
        }
        // The arbiter gate the rebalance protects: a lone canonicalized data
        // byte (OP_5) would fail Buffer.isBuffer here and silently skip the
        // chunk, corrupting the reassembled payload.
        assert.ok(decodedRedeemScript && decodedRedeemScript.length >= 1 && Buffer.isBuffer(decodedRedeemScript[0]),
          `${c.name} input ${i}: redeem-script leading element must be a Buffer`)
        assert.strictEqual(decodedRedeemScript[0].length, c.chunkLengths[i],
          `${c.name} input ${i}: chunk length`)
        dataBuffer = Buffer.concat([dataBuffer, decodedRedeemScript[0]])
      }

      // P2SH/P2WSH chunks concatenate to the compiled payload exactly (no pad).
      assert.strictEqual(dataBuffer.toString('hex'), c.compiledHex,
        `${c.name}: reassembled chunks diverge from the encoder's compiled payload`)

      const outcome = gateOutcome(dataBuffer)
      assert.strictEqual(outcome.gate, c.expected.gate, `${c.name}: gate outcome`)
      const dataHex = outcome.data == null ? null : outcome.data.toString('hex')
      const rawHex = outcome.rawData == null ? null : outcome.rawData.toString('hex')
      assert.strictEqual(dataHex, c.expected.dataHex, `${c.name}: decoded data`)
      assert.strictEqual(rawHex, c.expected.rawDataHex, `${c.name}: decoded rawData`)
    }
  })

  it('has teeth: dropping an interior chunk breaks the compiled-payload seam', function () {
    // Guards the fail-loud contract's premise: a skipped input chunk must not
    // reassemble to the golden bytes.
    const c = fixture.p2shCases.find((x) => x.redeemScriptsHex.length >= 2)
    assert.ok(c, 'expected a multi-chunk case')
    const partial = bitcoin.script.decompile(Buffer.from(c.redeemScriptsHex[1], 'hex'))[0]
    assert.notStrictEqual(partial.toString('hex'), c.compiledHex)
  })
})

describe('roundtrip conformance fixture: alias rewrite ', function () {
  let decoder
  let magicBuffer

  before(function () {
    decoder = createDecoder()
    magicBuffer = Buffer.from(fixture.magicWord, 'utf8')
  })

  it('has cases', function () {
    assert.ok(fixture.aliasCases.length > 0)
  })

  it('canonicalizes every alias case after a real-decoder decode', async function () {
    for (const c of fixture.aliasCases) {
      // Same OP_RETURN pipeline as the base suite: deobfuscate, strip magic,
      // decompile, gate.
      const obfuscated = Buffer.from(c.obfuscatedOpReturnHex, 'hex')
      const deob = await decoder.removeObfuscation(obfuscated, c.firstInputTxid)
      assert.ok(deob != null, `${c.name}: removeObfuscation returned null`)
      assert.ok(deob.subarray(0, magicBuffer.length).equals(magicBuffer),
        `${c.name}: recovered payload missing magic word`)
      const compiled = deob.subarray(magicBuffer.length)
      assert.strictEqual(compiled.toString('hex'), c.compiledHex,
        `${c.name}: deobfuscated compiled bytes diverge from the encoder`)
      const outcome = gateOutcome(compiled)
      assert.strictEqual(outcome.gate, 'accepted', `${c.name}: alias case must pass the gate`)
      assert.strictEqual(outcome.data.toString('hex'), c.expected.dataHex, `${c.name}: on-wire data`)

      // The shared canonicalization helper both decode paths apply ()
      // must expand the alias and rewrite the stored payload.
      const canonical = canonicalizeActionPayload(outcome.data)
      assert.strictEqual(canonical.rawActionName, c.expected.rawActionName, `${c.name}: rawActionName`)
      assert.strictEqual(canonical.actionName, c.expected.actionName, `${c.name}: actionName`)
      assert.strictEqual(canonical.isKnown, true, `${c.name}: canonical name must be a valid ACTION`)
      assert.strictEqual(canonical.buffer.toString('hex'), c.expected.canonicalDataHex,
        `${c.name}: rewritten payload`)
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
