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
    _resetProbeLogState, _ageProbeLogState, PROBE_LOG_WINDOW_MS
} = require('../../src/api')
const observability = require('../../src/observability')

// DISPENSER_EXPIRE_SAFE_DEPTH, the rollback ceiling verifyReorg aborts at.
const SAFE_DEPTH = 126

let sink

// getLogger() routes to whatever shipper the process installed, so a capture
// sink on that shipper sees the formatted line with its fields.
function installSink() {
    observability._resetObservability()
    sink = { lines: [] }
    const push = (m) => sink.lines.push(m)
    observability.installObservability(null, {
        service: 'xchain-decoder', env: {},
        console: { log: push, warn: push, error: push }
    })
}

function linesFor(event) {
    return sink.lines.filter((l) => l.includes(event))
}

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
}

// A decoder holding blocks far above the node's tip, so verifyReorg takes its
// above-tip delete branch and rolls back one block per pass until the
// safe-depth ceiling aborts. The db carries only what that walk reads, so the
// halt these cases assert on is the real one and not a stubbed shortcut.
const NODE_TIP = 100

function haltingDecoder(db) {
    const decoder = makeDecoder()
    let height = 300
    decoder.db = Object.assign({
        getLastBlockIndex: async () => height,
        getBlockByIndex: async (i) => (i < 0 ? null : { block_index: i, block_hash: 'aa'.repeat(32) }),
        deleteBlockByIndex: async () => { height -= 1; return true }
    }, db)
    decoder.connector = { rpcErrors: 0 }
    return decoder
}

describe('REORG_HALT: a halt the marker cannot record still leaves a record', function () {

    beforeEach(function () { installSink() })
    afterEach(function () { observability._resetObservability() })

    it('emits REORG_HALT with reason and depth when db.markReorgHalted is missing', async function () {
        // The db deliberately has no markReorgHalted: this is the bare return.
        const decoder = haltingDecoder({})
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        const halts = linesFor('REORG_HALT')
        assert.strictEqual(halts.length, 1, 'the halt must produce exactly one record')
        const line = halts[0]
        assert.ok(line.includes(' error '), 'REORG_HALT is an error-level event: ' + line)
        assert.ok(line.includes('coin=BTC'), 'the record must name the coin: ' + line)
        assert.ok(line.includes('network=regtest'), 'the record must name the network: ' + line)
        assert.ok(line.includes('depth=' + SAFE_DEPTH),
            'the record must carry the depth it was about to persist: ' + line)
        assert.ok(/reason="[^"]*safe-depth[^"]*"/.test(line),
            'the record must carry the reason it was about to persist: ' + line)
        assert.ok(line.includes('marker_persisted=false'),
            'the record must say the marker could not be written: ' + line)
        assert.ok(line.includes('/status') && line.includes('/live'),
            'the record must say which surfaces will NOT report the halt: ' + line)
    })

    it('still emits REORG_HALT on the normal path, and says the marker was written', async function () {
        let marked = null
        const decoder = haltingDecoder({ markReorgHalted: async (r) => { marked = r } })
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        const halts = linesFor('REORG_HALT')
        assert.strictEqual(halts.length, 1)
        assert.ok(halts[0].includes('marker_persisted=true'), halts[0])
        assert.ok(marked && /safe-depth/.test(marked), 'the durable marker is still written')
    })

    it('reports the halt in memory even when nothing durable can be written', async function () {
        const decoder = haltingDecoder({})
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)
        assert.strictEqual(decoder.reorgHalted, true)
        assert.match(decoder.reorgHaltReason, /safe-depth/)
    })
})

describe('health probes: a failing probe stops being silent', function () {

    beforeEach(function () { installSink(); _resetProbeLogState() })
    afterEach(function () { observability._resetObservability(); _resetProbeLogState() })

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

    it('names the db_ping probe on /live when the ping throws', async function () {
        const decoder = probeDecoder()
        decoder.db = { ping: async () => { throw new Error('pool timeout acquiring connection') } }

        const res = await getLive(liveApp(decoder))
        // Control: the route still answers, with the code it always answered.
        assert.strictEqual(res.status, 503)
        assert.strictEqual(res.body.db, false)

        const warned = linesFor('HEALTH_PROBE_FAILED')
        assert.strictEqual(warned.length, 1, 'the failure must produce one record')
        assert.ok(warned[0].includes(' warn '), warned[0])
        assert.ok(warned[0].includes('probe=db_ping'), warned[0])
        assert.ok(warned[0].includes('route=/live'), warned[0])
        assert.ok(warned[0].includes('pool timeout'), 'the cause rides the record: ' + warned[0])
    })

    it('names the reorg_halt probe on /live, the failure that makes a halted decoder read clean', async function () {
        const decoder = probeDecoder()
        decoder.checkReorgHalt = async () => { throw new Error('events table is gone') }

        const res = await getLive(liveApp(decoder))
        // The wrong-but-alive shape this exists for: the route reports no halt
        // because it could not ask, and that is now the difference between a
        // silent lie and a warned one.
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.reorg_halted, false)

        const warned = linesFor('HEALTH_PROBE_FAILED')
        assert.strictEqual(warned.length, 1)
        assert.ok(warned[0].includes('probe=reorg_halt'), warned[0])
        assert.ok(warned[0].includes('route=/live'), warned[0])
        assert.ok(warned[0].includes('events table is gone'), warned[0])
    })

    it('throttles a repeating probe failure to one line per window and counts the rest', async function () {
        const decoder = probeDecoder()
        decoder.db = { ping: async () => { throw new Error('pool timeout') } }
        const app = liveApp(decoder)

        for (let i = 0; i < 5; i++) await getLive(app)
        assert.strictEqual(linesFor('HEALTH_PROBE_FAILED').length, 1,
            'a caller-driven route must not turn one outage into one line per request')

        // Age the window rather than sleeping through it, so the suppressed count
        // the next line has to report survives.
        _ageProbeLogState()
        await getLive(app)
        const warned = linesFor('HEALTH_PROBE_FAILED')
        assert.strictEqual(warned.length, 2)
        assert.ok(warned[1].includes('suppressed=4'),
            'a throttled flood must stay countable, not merely quiet: ' + warned[1])
        assert.ok(PROBE_LOG_WINDOW_MS > 0, 'the window is a real duration, not a disabled guard')
    })

    it('carries a cause even when the probe threw something that is not an Error', function () {
        noteProbeFailure('db_ping', '/status', 'ECONNREFUSED')
        const warned = linesFor('HEALTH_PROBE_FAILED')
        assert.strictEqual(warned.length, 1)
        assert.ok(warned[0].includes('err=ECONNREFUSED'), warned[0])
    })

    it('answers null instead of throwing when the error itself cannot be read', function () {
        // A diagnostic that throws inside a health route would turn a reportable
        // probe failure into a 500 on the route the healthcheck polls.
        const hostile = { get message() { throw new Error('unreadable') } }
        assert.strictEqual(noteProbeFailure('db_ping', '/live', hostile), null)
        assert.strictEqual(linesFor('HEALTH_PROBE_FAILED').length, 0)
    })

    it('keeps the two probes on separate throttles, so one failure cannot mask the other', async function () {
        const decoder = probeDecoder()
        decoder.db = { ping: async () => { throw new Error('pool timeout') } }
        decoder.checkReorgHalt = async () => { throw new Error('events table is gone') }

        await getLive(liveApp(decoder))
        // db_ping fails first, so dbOk is false and the halt probe is not reached
        // on this route. Drive the halt probe with a working ping.
        decoder.db = { ping: async () => true }
        await getLive(liveApp(decoder))

        const warned = linesFor('HEALTH_PROBE_FAILED')
        assert.strictEqual(warned.length, 2)
        assert.ok(warned.some((l) => l.includes('probe=db_ping')))
        assert.ok(warned.some((l) => l.includes('probe=reorg_halt')))
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

    it('records the drop failure with the table and the cause', async function () {
        const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p')
        db.pool = poolWhoseDropFails()

        // Control: the drop is cleanup, so the call still returns its result.
        const r = await db.deleteAndCompareTxsNotInList([])
        assert.strictEqual(r.transactionsDeleted, 0)

        const warned = linesFor('DB_TEMP_TABLE_DROP_FAILED')
        assert.strictEqual(warned.length, 1)
        assert.ok(warned[0].includes('table=_mempool_node_snapshot'), warned[0])
        assert.ok(warned[0].includes('lost connection to server'), warned[0])
    })
})
