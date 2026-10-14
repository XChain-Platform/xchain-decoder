// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A decoder carrying a live REORG_HALT marker answered /live with 200 and the
// container read healthy for as long as the marker stood. That 200 is deliberate:
// /live drives autoheal, and a restart does not clear the marker, so gating it there
// would restart-loop the container. GET /ready is the surface that answers 503 for
// it, and /live carries the same verdict as ready / not_ready_reasons without
// changing its own status code.
//
// Drives the REAL registrars out of src/api.js against a REAL XChainDecoder; only
// the database round-trips are stubbed.

'use strict'

const assert = require('assert')
const http = require('http')
const express = require('express')
const XChainDecoder = require('../../../src/XChainDecoder')
const { registerLiveRoute, registerReadyRoute } = require('../../../src/api')
const { decoderNotReadyReasons } = require('../../../src/api/probe_routes')

// A caught-up decoder whose halt marker read answers `marker`.
function decoderWithMarker(marker, dbOk = true) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.lastProcessedBlockIndex = 150
    decoder.blockchainInfoLastBlock = 150
    decoder.blockchainInfoLastRefreshAt = Date.now()
    decoder.lastAdvanceAt = Date.now()
    decoder.lastPollAt = Date.now()
    decoder.synced = true
    decoder.db = { ping: async () => dbOk, getReorgHaltMarker: async () => marker }
    decoder.connector = { rpcErrors: 0 }
    return decoder
}

function get(decoder, path) {
    const app = express()
    registerLiveRoute(app, decoder, () => true)
    registerReadyRoute(app, decoder, () => true)
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            http.get({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => {
                let body = ''
                res.on('data', (c) => { body += c })
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(body) }) })
            }).on('error', (e) => { server.close(); reject(e) })
        })
    })
}

const CLEAN = { halted: false, at: null, reason: null }
const HALTED = { halted: true, at: '2026-10-12T21:00:00.000Z', reason: 'reorg deeper than the safe rewind window' }

describe('GET /ready answers the REORG_HALT that /live must not gate on', function () {
    it('answers 200 on /live and /ready for a clean, caught-up decoder', async function () {
        const live = await get(decoderWithMarker(CLEAN), '/live')
        const ready = await get(decoderWithMarker(CLEAN), '/ready')
        assert.strictEqual(live.status, 200)
        assert.strictEqual(ready.status, 200)
        assert.strictEqual(ready.body.ready, true)
        assert.deepStrictEqual(ready.body.not_ready_reasons, [])
    })

    it('keeps /live at 200 on a latent halt and reports it not ready', async function () {
        const live = await get(decoderWithMarker(HALTED), '/live')
        assert.strictEqual(live.status, 200, 'autoheal reads /live; a restart cannot clear the marker')
        assert.strictEqual(live.body.reorg_halted, true)
        assert.strictEqual(live.body.ready, false)
        assert.deepStrictEqual(live.body.not_ready_reasons, ['reorg_halt'])
    })

    it('answers 503 on /ready while the marker stands', async function () {
        const ready = await get(decoderWithMarker(HALTED), '/ready')
        assert.strictEqual(ready.status, 503)
        assert.deepStrictEqual(ready.body.not_ready_reasons, ['reorg_halt'])
        assert.strictEqual(ready.body.reorg_halt_reason, HALTED.reason)
    })

    it('fails closed when the marker has never been read', async function () {
        const ready = await get(decoderWithMarker(CLEAN, false), '/ready')
        assert.strictEqual(ready.status, 503)
        assert.deepStrictEqual(ready.body.not_ready_reasons, ['db_unreachable', 'reorg_halt_unchecked'])
    })
})

describe('decoderNotReadyReasons()', function () {
    const base = { decoderRunning: true, dbOk: true, stalled: false, pollSilent: false,
        reorgHalt: { halted: false, parked: false, checked_at: 1 } }

    it('names a parked halt beside the halt itself', function () {
        const state = { ...base, reorgHalt: { halted: true, parked: true, checked_at: 1 } }
        assert.deepStrictEqual(decoderNotReadyReasons(state), ['reorg_halt', 'reorg_halt_parked'])
    })

    it('names a frozen node tip, which /live reports but never gates on', function () {
        const state = { ...base, syncStatus: { node_height_stale: true } }
        assert.deepStrictEqual(decoderNotReadyReasons(state), ['node_height_stale'])
    })

    it('carries every liveness fault as a readiness fault', function () {
        const state = { ...base, decoderRunning: false, stalled: true, pollSilent: true }
        assert.deepStrictEqual(decoderNotReadyReasons(state), ['not_running', 'stalled', 'poll_silent'])
    })
})
