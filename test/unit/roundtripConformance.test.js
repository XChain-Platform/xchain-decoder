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
// truth); this test skips when that checkout is absent, matching the
// compiledPushSizeConformance / ActionManifestConformance convention.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../src/XChainDecoder')

const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
  path.join(__dirname, '..', '..', '..', 'xchain-encoder')
const FIXTURE = path.join(ENCODER, 'test', 'fixtures', 'roundtrip-conformance.json')

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
  let fixture
  let decoder
  let magicBuffer

  before(function () {
    if (!fs.existsSync(FIXTURE)) this.skip()
    fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
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
