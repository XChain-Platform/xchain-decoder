// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A halt probe that exists but answers with nothing is a fault, not a clear: the
// cached halt must stand, and checked_at must not move, exactly as for a thrown read.

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
}

function haltedThenEmpty(empty) {
    let answer = { halted: true, at: null, reason: 'over-deep rollback' }
    const decoder = makeDecoder()
    decoder.db = { getReorgHaltMarker: async () => answer }
    return { decoder, goEmpty: () => { answer = empty } }
}

describe('XChainDecoder latent REORG_HALT reporting: an empty probe answer', function () {

    for (const empty of [null, undefined]) {
        it('keeps a halt read earlier when getReorgHaltMarker resolves ' + String(empty), async function () {
            const { decoder, goEmpty } = haltedThenEmpty(empty)
            await decoder.checkReorgHalt({ force: true })
            const checkedAt = decoder.getReorgHaltStatus().checked_at
            goEmpty()
            const status = await decoder.checkReorgHalt({ force: true })
            assert.strictEqual(status.halted, true, 'an empty answer must never read as an operator clear')
            assert.strictEqual(status.reason, 'over-deep rollback')
            assert.strictEqual(status.checked_at, checkedAt, 'an empty answer is not a successful probe')
        })
    }

    it('leaves a fresh decoder unchecked when getReorgHaltMarker resolves null', async function () {
        const decoder = makeDecoder()
        decoder.db = { getReorgHaltMarker: async () => null }
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, false)
        assert.strictEqual(status.checked_at, null, '"never answered" must stay distinguishable from "checked and clear"')
    })

    it('keeps a parked decoder parked when the probe starts answering null', async function () {
        const { decoder, goEmpty } = haltedThenEmpty(null)
        decoder.logError = () => {}
        decoder.log = () => {}
        await decoder.checkReorgHalt({ force: true })
        decoder.parkOnReorgHalt('safe-depth window exceeded', 100)
        goEmpty()
        decoder.reorgHaltCheckedAt = 0
        assert.strictEqual(await decoder.resumeFromReorgHaltPark(), false)
        assert.strictEqual(decoder.getReorgHaltStatus().parked, true)
        assert.strictEqual(decoder.getReorgHaltStatus().halted, true)
    })

    it('keeps a halt read earlier when the boolean isReorgHalted probe resolves undefined', async function () {
        let answer = true
        const decoder = makeDecoder()
        decoder.db = { isReorgHalted: async () => answer }
        await decoder.checkReorgHalt({ force: true })
        answer = undefined
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, true)
    })
})
