// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The AuxPoW strip primitives are duplicated between
// xchain-decoder/src/BlockchainConnector.js and the xchain-utxo-tracker twin, and
// both carry "Keep in sync with ..." comments that nothing used to enforce: the two
// files drifted apart (one repo rewrapped its errors, the other factored its strip
// logic into stripAuxPowFromBlockHex) while the sync comments still claimed
// otherwise. This guard asserts byte identity of the shared function BODIES, the
// parts that must agree because a divergence silently changes which bytes each
// service hashes and decodes.
//
// Deliberately NOT asserted: whole-function identity of getBlockWithoutAuxPow or
// getBlockReassembled. Those differ by design: the decoder fetches the header and
// block outside the try (so an RPC fault is not mislabeled a content fault), tags
// traversal failures with auxPowParseFailure so fetchBlockHex escalates to
// getBlockReassembled, and reassembles via the bounded-concurrency batch helper.
// The strip primitives below are the invariant part.
//
// When the sibling xchain-utxo-tracker checkout is absent (standalone deploy) the
// test skips rather than fails, matching coins-conformance; set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI (with the sibling checked out, or
// XCHAIN_UTXO_TRACKER_DIR pointed at it) so a missing sibling hard-fails instead
// of green-by-skip.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const {
    stripAuxPowFromBlockHex,
    skipAuxPow,
} = require('../../src/BlockchainConnector')

const LOCAL_FILE = path.join(__dirname, '..', '..', 'src', 'BlockchainConnector.js')
const TRACKER_DIR = process.env.XCHAIN_UTXO_TRACKER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-utxo-tracker')
const TWIN_FILE = path.join(TRACKER_DIR, 'src', 'BlockchainConnector.js')
const TWIN_PRESENT = fs.existsSync(TWIN_FILE)
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'

// Functions that must be byte-identical in both repos.
const SHARED_FUNCTIONS = [
    'readVarint',
    'encodeVarintHex',
    'skipAuxPow',
    'stripAuxPowFromBlockHex',
]

// Extract a top-level `function <name>(...) { ... }` declaration's source, from the
// `function` keyword through its closing brace. Top-level declarations in these two
// files start at column 0, so the matching close is the first line that is exactly
// '}', which is unambiguous without a JS parser. Leading comments are excluded on
// purpose: the prose around a function may legitimately differ per repo (the tracker
// mentions its batch path, the decoder does not), only the code must agree.
function extractFunction(source, name) {
    const lines = source.split('\n')
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('))
    assert.notStrictEqual(start, -1, `top-level function ${name} not found`)
    const end = lines.indexOf('}', start)
    assert.notStrictEqual(end, -1, `closing brace for function ${name} not found`)
    return lines.slice(start, end + 1).join('\n')
}

describe('AuxPoW strip parity with xchain-utxo-tracker @regression', function () {

    describe('cross-repo byte identity [REGRESSION P1]', function () {
        const localSource = fs.readFileSync(LOCAL_FILE, 'utf8')

        before(function () {
            if (!TWIN_PRESENT) {
                if (REQUIRE_SIBLINGS) {
                    throw new Error(
                        'XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-utxo-tracker twin is missing at ' +
                        TWIN_FILE + ' (set XCHAIN_UTXO_TRACKER_DIR)')
                }
                this.skip()
            }
        })

        for (const name of SHARED_FUNCTIONS) {
            it(`${name} is byte-identical in both repos`, function () {
                const twinSource = fs.readFileSync(TWIN_FILE, 'utf8')
                assert.strictEqual(
                    extractFunction(localSource, name),
                    extractFunction(twinSource, name),
                    `${name} has drifted between xchain-decoder and xchain-utxo-tracker; ` +
                    'apply the change to both copies')
            })
        }

        it('every shared function carries a Keep-in-sync comment on both sides', function () {
            const twinSource = fs.readFileSync(TWIN_FILE, 'utf8')
            for (const name of SHARED_FUNCTIONS) {
                assert.ok(
                    localSource.includes(
                        'Keep in sync with xchain-utxo-tracker/src/BlockchainConnector.js ' + name),
                    `decoder copy of ${name} lacks its Keep-in-sync comment`)
                assert.ok(
                    twinSource.includes(
                        'Keep in sync with xchain-decoder/src/BlockchainConnector.js ' + name),
                    `utxo-tracker copy of ${name} lacks its Keep-in-sync comment`)
            }
        })
    })

    // The identity check above only proves the two copies agree; these pin what they
    // agree ON, so an identical-but-wrong edit to both still trips the suite.
    describe('stripAuxPowFromBlockHex behavior', function () {
        // 80-byte header, version 0x00620104 little-endian: AuxPoW bit (0x100) SET.
        const AUXPOW_HEADER = '04016200' + '11'.repeat(76)
        // Same header with the AuxPoW bit clear (version 2).
        const PLAIN_HEADER = '02000000' + '11'.repeat(76)
        const TX_COUNT_AND_TXS = '01' + '0a'.repeat(60)

        // Minimal legacy coinbase tx: 1 input, 1 empty-script output.
        const COINBASE =
            '01000000' +
            '01' +
            '00'.repeat(32) + 'ffffffff' + '00' + 'ffffffff' +
            '01' + '0100000000000000' + '00' +
            '00000000'
        // AuxPoW tail: parent hash (32 B) + empty coinbase branch (count 0 + index 4 B)
        // + empty chain branch + parent header (80 B).
        const AUXPOW_TAIL =
            'bb'.repeat(32) +
            '00' + '00000000' +
            '00' + '00000000' +
            'cc'.repeat(80)
        const AUXPOW_SECTION = COINBASE + AUXPOW_TAIL

        it('strips the AuxPoW section parsed from the block hex when the header is 160 chars', function () {
            const blockHex = AUXPOW_HEADER + AUXPOW_SECTION + TX_COUNT_AND_TXS
            assert.strictEqual(
                stripAuxPowFromBlockHex(AUXPOW_HEADER, blockHex),
                AUXPOW_HEADER + TX_COUNT_AND_TXS)
        })

        it('agrees with skipAuxPow on where the AuxPoW section ends', function () {
            const blockHex = AUXPOW_HEADER + AUXPOW_SECTION + TX_COUNT_AND_TXS
            const afterAuxPow = skipAuxPow(Buffer.from(blockHex, 'hex'), 80)
            assert.strictEqual(afterAuxPow * 2, 160 + AUXPOW_SECTION.length)
        })

        it('takes the legacy length-delta path when getblockheader includes AuxPoW bytes', function () {
            const legacyHeader = AUXPOW_HEADER + AUXPOW_SECTION
            const blockHex = AUXPOW_HEADER + AUXPOW_SECTION + TX_COUNT_AND_TXS
            assert.strictEqual(
                stripAuxPowFromBlockHex(legacyHeader, blockHex),
                AUXPOW_HEADER + TX_COUNT_AND_TXS)
        })

        it('passes a non-AuxPoW block through unchanged', function () {
            const blockHex = PLAIN_HEADER + TX_COUNT_AND_TXS
            assert.strictEqual(stripAuxPowFromBlockHex(PLAIN_HEADER, blockHex), blockHex)
        })

        it('passes a hex too short to hold a version through unchanged', function () {
            assert.strictEqual(stripAuxPowFromBlockHex(PLAIN_HEADER, '0401'), '0401')
        })

        it('throws when the AuxPoW section cannot be traversed', function () {
            const truncated = AUXPOW_HEADER + COINBASE.substring(0, 20)
            assert.throws(() => stripAuxPowFromBlockHex(AUXPOW_HEADER, truncated),
                /AuxPoW parse:/)
        })
    })

    // The error wrapping is the one part that deliberately differs from the twin; pin it
    // so a "make the copies identical" refactor cannot quietly drop the tag that
    // fetchBlockHex escalates on.
    describe('getBlockWithoutAuxPow error framing (deliberate divergence)', function () {
        const BlockchainConnector = require('../../src/BlockchainConnector')

        function makeConnector(overrides) {
            const connector = new BlockchainConnector('127.0.0.1', 0, 'user', 'pass')
            return Object.assign(connector, overrides)
        }

        it('tags an untraversable AuxPoW section with auxPowParseFailure', async function () {
            const header = '04016200' + '11'.repeat(76)
            const connector = makeConnector({
                getBlockHeader: async () => header,
                getBlock: async () => header + '01000000' + '01' + '00'.repeat(4),
            })
            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('deadbeef'),
                err => {
                    assert.strictEqual(err.auxPowParseFailure, true)
                    assert.match(err.message, /problems getting a block hex without auxpow/)
                    return true
                })
        })

        it('does not tag an RPC fault as an AuxPoW parse failure', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => { throw new Error('ECONNREFUSED') },
                getBlock: async () => 'unused',
            })
            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('deadbeef'),
                err => {
                    assert.strictEqual(err.auxPowParseFailure, undefined)
                    return true
                })
        })
    })
})
