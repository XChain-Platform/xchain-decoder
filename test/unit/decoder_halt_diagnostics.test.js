// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Row 4 of the proactive-system-watch spec: the decoder's two silent failure
// shapes become records.
//
// The first is a decoder that decides to halt on a db object with no
// markReorgHalted: no marker is written, so without a record the operator has a
// stopped decoder and every health surface reading a marker that does not exist.
// The second is a health route whose probe throws, which makes a halted decoder
// answer /live and /status with reorg_halted false.
//
// Each case drives the REAL code path (verifyReorg's abort, the real /live
// registrar out of src/api.js) rather than a stand-in, because the claim under
// test is that the site is wired, not that a logger works.

const assert  = require('assert')
const http    = require('http')
const express = require('express')
const XChainDecoder = require('../../src/XChainDecoder')
const {
    registerLiveRoute, noteProbeFailure,
    resetProbeLogState, ageProbeLogState, PROBE_LOG_WINDOW_MS
} = require('../../src/api')
const observability = require('../../src/observability')
const registerReorgHaltRecords = require('./decoder_halt_diagnostics.test/01_reorg_halt_records.test')
const registerHealthProbeRecords = require('./decoder_halt_diagnostics.test/02_health_probe_records.test')
const registerDbCleanupRecord = require('./decoder_halt_diagnostics.test/03_db_cleanup_record.test')

// DISPENSER_EXPIRE_SAFE_DEPTH, the rollback ceiling verifyReorg aborts at.
const SAFE_DEPTH = 126

const sink = { lines: [] }

// getLogger() routes to whatever shipper the process installed, so a capture
// sink on that shipper sees the formatted line with its fields.
function installSink() {
    observability._resetObservability()
    sink.lines = []
    const push = (m) => sink.lines.push(m)
    observability.installObservability(null, {
        service: 'xchain-decoder', env: {},
        console: { log: push, warn: push, error: push }
    })
}

// Match the EVENT, not a substring of it. formatTextLine renders
// `<ts> <level> [<service>] <msg> k=v ...`, so REORG_HALT_MARKER contains
// REORG_HALT and a bare includes() would fold the two records into one count.
function linesFor(event) {
    return sink.lines.filter((l) => l.includes('] ' + event + ' ') || l.endsWith('] ' + event))
}

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
}

// A decoder one block above the node's tip whose every stored hash disagrees
// with the node, so verifyReorg deletes the above-tip block and then walks the
// hash-compare back one block per pass until the safe-depth ceiling aborts. (A
// gap the ceiling could not absorb is refused before the first delete and never
// reaches the halt; that is nodeCatchUpWait.test.js.) The db carries only what
// that walk reads, so the halt these cases assert on is the real one and not a
// stubbed shortcut.
const NODE_TIP = 299

function haltingDecoder(db) {
    const decoder = makeDecoder()
    let height = 300
    decoder.db = Object.assign({
        getLastBlockIndex: async () => height,
        getBlockByIndex: async (i) => (i < 0 ? null : { block_index: i, block_hash: 'aa'.repeat(32) }),
        deleteBlockByIndex: async () => { height -= 1; return true }
    }, db)
    decoder.connector = { rpcErrors: 0, getBlockHash: async () => 'bb'.repeat(32) }
    return decoder
}

describe('REORG_HALT: a halt the marker cannot record still leaves a record', function () {

    beforeEach(function () { installSink() })
    afterEach(function () { observability._resetObservability() })

    registerReorgHaltRecords({ assert, haltingDecoder, NODE_TIP, SAFE_DEPTH, linesFor, sink })
})

describe('health probes: a failing probe stops being silent', function () {

    beforeEach(function () { installSink(); resetProbeLogState() })
    afterEach(function () { observability._resetObservability(); resetProbeLogState() })

    function liveApp(decoder, running = true) {
        const app = express()
        registerLiveRoute(app, decoder, () => running)
        return app
    }

    function getLive(app) {
        return new Promise((resolve, reject) => {
            const server = app.listen(0, () => {
                http.get({ port: server.address().port, path: '/live' }, (res) => {
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

    // A decoder that is otherwise entirely healthy, so the only thing a case can
    // be reading is the probe it breaks.
    function probeDecoder() {
        const decoder = makeDecoder()
        decoder.lastProcessedBlockIndex = 150
        decoder.blockchainInfoLastBlock = 150
        decoder.blockchainInfoLastRefreshAt = Date.now()
        decoder.lastAdvanceAt = Date.now()
        decoder.lastPollAt = Date.now()
        decoder.synced = true
        decoder.db = { ping: async () => true }
        decoder.connector = { rpcErrors: 0 }
        return decoder
    }

    registerHealthProbeRecords({
        assert, probeDecoder, getLive, liveApp, linesFor,
        ageProbeLogState, PROBE_LOG_WINDOW_MS, noteProbeFailure
    })
})

// The one db.js catch worth a line. The other nine swallow a failed pool release,
// which happens only when the connection is already gone and always sits beside a
// catch that reported the real cause. This one loses a temp table on a POOLED
// connection, so the consequence lands on an unrelated later query with nothing
// naming the drop that failed.
describe('db: a failed temp-table drop stops being silent', function () {

    const Database = require('../../src/db.js')

    beforeEach(function () { installSink() })
    afterEach(function () { observability._resetObservability() })

    function poolWhoseDropFails() {
        const conn = {
            query: async (sql) => {
                if (/DROP\s+TEMPORARY\s+TABLE/i.test(sql)) throw new Error('lost connection to server')
                if (/SELECT\s+s\.tx_hash/i.test(sql)) return []
                return { affectedRows: 0 }
            },
            release: async () => {}
        }
        return { getConnection: async () => conn }
    }

    registerDbCleanupRecord({ assert, Database, poolWhoseDropFails, linesFor })
})

// api.js registers GET /status inside startApi(), which builds a real decoder and
// opens a listening socket, so the route is not reachable from a unit test. The
// contract is pinned at the source instead, the same way this repo pins the
// getmempool JSON-RPC method (test/unit/mempoolApiSurface.test.js).
//
// What is pinned: reorg_halted never ships without reorg_halt_checked_at.
// xchain-node's BootstrapHealthGate refuses a payload that owns the boolean and
// carries a null/absent timestamp, because a decoder whose fail-soft marker probe
// has NEVER completed publishes exactly what a clean one publishes. That gate probes
// the JSON-RPC health surface first and falls back to GET /status, so the boolean
// must never appear alone in either body.
describe('api.js GET /status halt surface (source pin)', function () {
    const fs   = require('fs')
    const path = require('path')
    const src  = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')

    function statusRouteBody() {
        const at = src.indexOf("app.get('/status'")
        assert.ok(at > -1, 'GET /status route missing from api.js')
        return src.slice(at, at + 3000)
    }

    it('publishes reorg_halt_checked_at beside reorg_halted', function () {
        const body = statusRouteBody()
        assert.ok(/reorg_halted:\s+reorgHalt\.halted/.test(body),
            'GET /status no longer publishes reorg_halted')
        assert.ok(/reorg_halt_checked_at:\s*reorgHalt\.checked_at/.test(body),
            'GET /status publishes reorg_halted without the probe timestamp its consumers ' +
            'need to tell "clean" apart from "never looked"')
    })

    it('spells the key exactly as the JSON-RPC health surface does', function () {
        // The gate reads one key name across both surfaces; a near-miss spelling on
        // the fallback body reads as an absent timestamp and refuses every decoder.
        const occurrences = src.match(/reorg_halt_checked_at/g) || []
        assert.ok(occurrences.length >= 2,
            'reorg_halt_checked_at must appear on both the health result and GET /status')
    })
})
