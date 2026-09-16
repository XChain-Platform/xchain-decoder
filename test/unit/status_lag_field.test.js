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
 * GET /status carried no lag field, so xchain-node's
 * BootstrapHealthGate refused every payload it fell back to reading from this
 * decoder (lagKeys checked there: lag_blocks, blockLag, lag - see
 * BootstrapHealthGate.js). RULED 2026-09-01: publish a lag field on /status,
 * Proposal B (a bespoke computation) not adopted; reuse the same
 * decoder.getSyncStatus().lag the JSON-RPC health method and /live already
 * publish, so all three surfaces report the identical gap.
 *
 * api.js registers GET /status inside startApi(), which opens a real listening
 * socket and is not reachable from a unit test (see decoderHaltDiagnostics.test.js's
 * "api.js GET /status halt surface (source pin)" block, which pins reorg_halted
 * the same way). This file pins the lag field at the source for the same reason.
 */

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')

function statusRouteBody() {
    const at = src.indexOf("app.get('/status'")
    assert.ok(at > -1, 'GET /status route missing from api.js')
    return src.slice(at, at + 3000)
}

describe('api.js GET /status publishes a lag field', function () {
    it('reads sync status via decoder.getSyncStatus() before building the response', function () {
        const body = statusRouteBody()
        assert.ok(/const\s+syncStatus\s*=\s*decoder\.getSyncStatus\(\)/.test(body),
            'GET /status must call decoder.getSyncStatus() to know its own lag')
    })

    it('publishes lag on the JSON body, matching one of the keys BootstrapHealthGate checks', function () {
        const body = statusRouteBody()
        // BootstrapHealthGate.js lagKeys = ['lag_blocks', 'blockLag', 'lag']; any one
        // satisfies the gate, and this route uses the same 'lag' name getSyncStatus()
        // and the JSON-RPC health method already publish.
        assert.ok(/lag:\s*syncStatus\.lag/.test(body),
            'GET /status still has no lag key, so BootstrapHealthGate refuses its fallback payload')
    })

    it('computes syncStatus before the res.json() call, not after', function () {
        const body = statusRouteBody()
        const syncAt   = body.search(/const\s+syncStatus\s*=\s*decoder\.getSyncStatus\(\)/)
        const statusAt = body.search(/status:\s*healthy\s*\?\s*'healthy'/)
        assert.ok(syncAt > -1 && statusAt > -1 && syncAt < statusAt,
            'syncStatus must be computed before it is spread into the response body')
    })
})
