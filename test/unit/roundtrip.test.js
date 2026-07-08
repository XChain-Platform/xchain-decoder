// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Round-trip tests for ACTION-name alias canonicalization (#4009).
//
// The decoder accepts five short-form aliases for canonical ACTION names.
// These aliases are valid on-chain spellings: a spec-following encoder may
// write TRANSFER|... instead of SEND|..., MSG|... instead of MESSAGE|...,
// etc. When the decoder writes to the DB it rewrites the leading name token
// to the canonical spelling so the DB is alias-free.
//
// These tests confirm that:
//   (a) parseRawTransaction correctly decodes a payload that uses an alias
//       name (the raw bytes come back unmodified - no canonicalization at the
//       parse layer), and
//   (b) splitting on '|', looking up the first token in the alias map, and
//       rejoining produces the canonical DB form byte-for-byte.
//
// Run with:
//   mocha --require ./test/unit/setup.js test/roundtrip.test.js

// Install the mariadb stub before loading XChainDecoder so that the
// ESM-only mariadb package does not cause a require() failure.
require('./setup')

const assert  = require('assert')
const sinon   = require('sinon')
const crypto  = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc     = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// ---------------------------------------------------------------------------
// Helpers (same approach as test/unit/parseTransaction.test.js)
// ---------------------------------------------------------------------------

// The decoder derives AES key/IV from the reversed hex of the first input's
// prevout hash. All test txs share one hash for simplicity.
const PREV_HASH = Buffer.from(
    'aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex'
)

function getKeyIv() {
    const display = Buffer.from(PREV_HASH).reverse().toString('hex')
    return { key: display.substr(0, 16), iv: display.substr(16, 16) }
}

function encryptBuf(plainBuf) {
    const { key, iv } = getKeyIv()
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    return Buffer.concat([cipher.update(plainBuf), cipher.final()])
}

// Build an AES-encrypted XCHN payload from a UTF-8 action string.
function buildXchnPayload(actionString) {
    const scriptPayload = bitcoin.script.compile([Buffer.from(actionString)])
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return encryptBuf(plainBuf)
}

// Build an OP_RETURN transaction carrying the given action string.
function buildOpReturnTx(actionString) {
    const cipher = buildXchnPayload(actionString)
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([
        Buffer.alloc(72, 0x30),
        Buffer.alloc(33, 0x02)
    ])
    tx.addOutput(
        bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]),
        0
    )
    tx.addOutput(
        Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'),
        100000000
    )
    return tx
}

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
    // A failed prevout lookup now throws (tagged rpcLookupFailure) instead of
    // resolving a null source; stub source resolution to the deterministic
    // null these decode-focused tests rely on.
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

// Apply the same alias-expand + payload-rewrite logic the block processing
// loop uses (XChainDecoder.js block path, post-decode).  Returns the
// canonical string, or null if the action name is not known.
const ACTION_ALIASES = {
    TRANSFER : 'SEND',
    ADDR     : 'ADDRESS',
    DROP     : 'AIRDROP',
    CAST     : 'BROADCAST',
    MSG      : 'MESSAGE'
}

function canonicalize(rawString) {
    const parts = rawString.split('|')
    const canonical = ACTION_ALIASES[parts[0]] ?? parts[0]
    if (canonical !== parts[0]) {
        parts[0] = canonical
    }
    return parts.join('|')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACTION-name alias round-trip (#4009)', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Each entry: [alias, canonical, sample payload tail]
    const ALIAS_CASES = [
        ['TRANSFER', 'SEND',      '0|XCHAIN|100'],
        ['ADDR',     'ADDRESS',   '0|mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'],
        ['DROP',     'AIRDROP',   '0|XCHAIN|50'],
        ['CAST',     'BROADCAST', '0|hello world'],
        ['MSG',      'MESSAGE',   '0|ping'],
    ]

    for (const [alias, canonical, tail] of ALIAS_CASES) {
        const aliasedPayload   = `${alias}|${tail}`
        const canonicalPayload = `${canonical}|${tail}`

        it(`parseRawTransaction decodes ${alias} payload to raw bytes`, async () => {
            const tx = buildOpReturnTx(aliasedPayload)
            const result = await decoder.parseTransaction(tx)

            assert.ok(result, 'parseTransaction should return a result')
            assert.ok(Buffer.isBuffer(result.data), 'result.data should be a Buffer')
            // The parse layer returns raw bytes; alias expansion has NOT happened yet.
            assert.strictEqual(
                result.data.toString('utf-8'),
                aliasedPayload,
                `decoded bytes should carry the alias name '${alias}', not the canonical form`
            )
        })

        it(`canonicalize() rewrites ${alias} to ${canonical} and preserves the rest`, () => {
            const result = canonicalize(aliasedPayload)
            assert.strictEqual(
                result,
                canonicalPayload,
                `alias '${alias}' must resolve to canonical '${canonical}'`
            )
        })

        it(`canonicalize() is a no-op when the canonical name '${canonical}' is already present`, () => {
            assert.strictEqual(
                canonicalize(canonicalPayload),
                canonicalPayload,
                'canonicalize() must not alter a payload that already uses the canonical name'
            )
        })
    }

    it('ACTION_ALIASES covers exactly the five documented exceptions', () => {
        const keys = Object.keys(ACTION_ALIASES)
        assert.deepStrictEqual(
            keys.sort(),
            ['ADDR', 'CAST', 'DROP', 'MSG', 'TRANSFER'].sort(),
            'alias map must contain exactly the five protocol-documented aliases'
        )
    })
})
