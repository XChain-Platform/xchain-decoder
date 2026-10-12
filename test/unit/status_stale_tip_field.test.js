/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * GET /status is the node bootstrap gate's fallback when JSON-RPC health is
 * unavailable. It built its body field by field and carried lag without the
 * stale-tip flag, so a frozen tip read as a trustworthy lag of zero there.
 * These drive the real registrar, as the /live tests do.
 */

'use strict'

const assert = require('assert')
const http = require('http')
const express = require('express')
const XChainDecoder = require('../../src/XChainDecoder')
const { registerStatusRoute } = require('../../src/api')

// src/XChainDecoder.js BLOCKCHAIN_INFO_REFRESH_MS; stale is > 2x this.
const REFRESH_MS = 30000

// A caught-up decoder with a fresh tip and a reachable DB.
function statusDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.lastProcessedBlockIndex = 150
    decoder.blockchainInfoLastBlock = 150
    decoder.blockchainInfoLastRefreshAt = Date.now()
    decoder.lastAdvanceAt = Date.now()
    decoder.db = { ping: async () => true }
    decoder.connector = { rpcErrors: 0 }
    return decoder
}

function getStatus(decoder, running = true) {
    const app = express()
    registerStatusRoute(app, decoder, () => running)
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: '/status' }, (res) => {
                let body = ''
                res.on('data', (c) => { body += c })
                res.on('end', () => {
                    server.close()
                    resolve({ status: res.statusCode, body: JSON.parse(body) })
                })
            }).on('error', (e) => { server.close(); reject(e) })
        })
    })
}

describe('/status reports the stale tip without gating on it', function () {
    it('answers 200 on a stale tip but flags its zero lag as untrustworthy', async function () {
        const decoder = statusDecoder()
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS)
        const res = await getStatus(decoder)
        assert.strictEqual(res.status, 200, 'the HTTP code stays keyed on running+db')
        assert.strictEqual(res.body.lag, 0)
        assert.strictEqual(res.body.node_height_stale, true,
            'the bootstrap gate refuses on this flag; without it a frozen tip passes as caught up')
    })

    it('reports the flag as a stable boolean, not an absent key, when the tip is fresh', async function () {
        const res = await getStatus(statusDecoder())
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.node_height_stale, false)
    })

    it('keeps 503 on a stopped decoder whatever the tip says', async function () {
        const res = await getStatus(statusDecoder(), false)
        assert.strictEqual(res.status, 503)
        assert.strictEqual(res.body.node_height_stale, false)
    })
})
