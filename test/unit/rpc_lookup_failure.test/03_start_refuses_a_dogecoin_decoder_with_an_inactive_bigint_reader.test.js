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
const { buildDecoder } = require('./helpers/decoder_harness')

const OUTER_TITLE = 'XChainDecoder RPC-lookup + rollback-signal hardening'

// Quarantine is parity-safe only for a fault every instance shares. An inactive
// BigInt-safe bufferutils reader makes a DOGE output > 2^53-1 sat undecodable on
// THIS instance alone, so after the change above it would quarantine a transaction
// healthy instances decode. Refusing to start is the only convergent answer.
describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe('start() refuses a Dogecoin decoder with an inactive BigInt reader', function () {
        const bufferutils = require('bitcoinjs-lib/src/bufferutils')

        function withInactiveReader(run) {
            const originalReadUInt64 = bufferutils.BufferReader.prototype.readUInt64
            bufferutils.BufferReader.prototype.readUInt64 = function () {
                throw new Error('RangeError: value out of range')
            }
            return (async () => {
                try {
                    await run()
                } finally {
                    bufferutils.BufferReader.prototype.readUInt64 = originalReadUInt64
                }
            })()
        }

        it('throws instead of warning and running on', async function () {
            await withInactiveReader(async () => {
                const { decoder } = buildDecoder()
                decoder.xchainBlockDecoder.coin = 'dogecoin'
                await assert.rejects(() => decoder.start(), /BigInt-safe 64-bit reader is NOT active/)
            })
        })

        it('leaves a non-Dogecoin decoder alone', async function () {
            await withInactiveReader(async () => {
                const { decoder, calls } = buildDecoder()
                await decoder.start()
                assert.strictEqual(calls.commitTransaction, 1, 'a BTC decoder still starts')
            })
        })
    })
})
