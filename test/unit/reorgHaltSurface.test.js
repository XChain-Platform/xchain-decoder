// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A LATENT REORG_HALT marker must be reported before a reorg trips it.
//
// The durable marker was written by verifyReorg and read only by verifyReorg, so a
// decoder carrying one parsed forward, answered "healthy", and got snapshotted by the
// weekly bootstrap cron as the newest good archive. A halted node sat dormant for a
// week exactly this way. These pin the reporting surface: the cached probe, its TTL,
// its fail-safe behaviour on a DB fault, and the db-level marker read.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db.js')

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
}

describe('XChainDecoder latent REORG_HALT reporting', function () {

    it('reports a dormant marker, with its reason, from the cached probe', async function () {
        const decoder = makeDecoder()
        decoder.db = {
            getReorgHaltMarker: async () => ({
                halted: true,
                at: '2026-07-20T03:30:31.000Z',
                reason: 'reorg depth exceeds the dispenser safe-depth window'
            })
        }
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, true)
        assert.match(status.reason, /safe-depth/)
        assert.strictEqual(status.at, '2026-07-20T03:30:31.000Z')
        assert.ok(status.checked_at > 0, 'a successful probe must stamp checked_at')
        // The cached view must agree with what the probe returned.
        assert.deepStrictEqual(decoder.getReorgHaltStatus(), status)
    })

    it('reports not-halted on a clean decoder', async function () {
        const decoder = makeDecoder()
        decoder.db = { getReorgHaltMarker: async () => ({ halted: false, at: null, reason: null }) }
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, false)
        assert.strictEqual(status.reason, null)
    })

    it('leaves checked_at null until the first probe, so "never looked" is distinguishable', function () {
        const decoder = makeDecoder()
        const status = decoder.getReorgHaltStatus()
        assert.strictEqual(status.halted, false)
        assert.strictEqual(status.checked_at, null)
    })

    it('caches within the TTL so a monitoring burst is not one DB query per request', async function () {
        const decoder = makeDecoder()
        let queries = 0
        decoder.db = {
            getReorgHaltMarker: async () => { queries++; return { halted: false, at: null, reason: null } }
        }
        const t0 = Date.now()
        await decoder.checkReorgHalt({ now: t0 })
        await decoder.checkReorgHalt({ now: t0 + 1000 })
        await decoder.checkReorgHalt({ now: t0 + 59000 })
        assert.strictEqual(queries, 1, 'probes inside the TTL must be served from cache')
        await decoder.checkReorgHalt({ now: t0 + 61000 })
        assert.strictEqual(queries, 2, 'a probe past the TTL must re-query')
    })

    it('force bypasses the TTL', async function () {
        const decoder = makeDecoder()
        let queries = 0
        decoder.db = {
            getReorgHaltMarker: async () => { queries++; return { halted: false, at: null, reason: null } }
        }
        const t0 = Date.now()
        await decoder.checkReorgHalt({ now: t0 })
        await decoder.checkReorgHalt({ now: t0 + 10, force: true })
        assert.strictEqual(queries, 2)
    })

    it('a probe fault keeps the last known halt rather than clearing it', async function () {
        const decoder = makeDecoder()
        let fail = false
        decoder.db = {
            getReorgHaltMarker: async () => {
                if (fail) throw new Error('DB blip')
                return { halted: true, at: null, reason: 'over-deep rollback' }
            }
        }
        await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(decoder.getReorgHaltStatus().halted, true)
        fail = true
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, true, 'a transient read fault must never report a halt as cleared')
        assert.strictEqual(status.reason, 'over-deep rollback')
    })

    it('falls back to the boolean isReorgHalted probe when the detailed reader is absent', async function () {
        const decoder = makeDecoder()
        decoder.db = { isReorgHalted: async () => true }
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, true)
        assert.strictEqual(status.reason, null)
    })

    it('reports not-halted (and does not throw) before the db handle exists', async function () {
        const decoder = makeDecoder()
        decoder.db = null
        const status = await decoder.checkReorgHalt({ force: true })
        assert.strictEqual(status.halted, false)
    })

    it('concurrent probes collapse onto one in-flight query', async function () {
        const decoder = makeDecoder()
        let queries = 0
        // Hold the first query open on a gate this test releases, rather than on a
        // fixed sleep. The window the assertion needs is "query one is still in
        // flight when probes two and three arrive", and a released gate states that
        // window exactly instead of betting it fits inside 10ms of wall clock.
        let releaseQuery
        const queryGate = new Promise(resolve => { releaseQuery = resolve })
        decoder.db = {
            getReorgHaltMarker: async () => {
                queries++
                await queryGate
                return { halted: false, at: null, reason: null }
            }
        }
        const probes = [
            decoder.checkReorgHalt({ force: true }),
            decoder.checkReorgHalt({ force: true }),
            decoder.checkReorgHalt({ force: true })
        ]
        releaseQuery()
        await Promise.all(probes)
        assert.strictEqual(queries, 1)
    })

    // The marker write is best-effort; the health surface must not depend on it.
    it('verifyReorg marks the decoder halted in memory even when the durable write fails', async function () {
        const decoder = makeDecoder()
        decoder.startBlockIndex = 0
        decoder.sleep = async () => {}
        // Deep enough that the safe-depth ceiling fires before the walk runs out of blocks.
        let top = 500
        decoder.connector = { getBlockHash: async () => 'node-hash' }
        decoder.db = {
            isReorgHalted: async () => false,
            markReorgHalted: async () => { throw new Error('marker write failed') },
            getLastBlockIndex: async () => top,
            getBlockByIndex: async (h) => ({ block_hash: 'db-hash-' + h }),
            deleteBlockByIndex: async (h) => { top = h - 1 },
            insertEvent: async () => true
        }
        // Deleting past the safe-depth window aborts; the abort path must leave the
        // in-memory halt state set regardless of the durable write outcome.
        await assert.rejects(() => decoder.verifyReorg(500), /safe-depth/)
        const status = decoder.getReorgHaltStatus()
        assert.strictEqual(status.halted, true)
        assert.match(status.reason, /safe-depth/)
    })

    it('verifyReorg entry guard mirrors a pre-existing durable marker into health state', async function () {
        const decoder = makeDecoder()
        decoder.db = { isReorgHalted: async () => true }
        await assert.rejects(() => decoder.verifyReorg(100), /HALTED/)
        assert.strictEqual(decoder.getReorgHaltStatus().halted, true)
    })
})

describe('Database.getReorgHaltMarker', function () {

    function stubDb(rows) {
        const db = new Database('127.0.0.1', 3306, 'test_db', 'u', 'p')
        let released = false
        db.getConnection = async () => ({
            query: async () => rows,
            release: async () => { released = true }
        })
        return { db, wasReleased: () => released }
    }

    it('returns halted:false when no marker row exists', async function () {
        const { db, wasReleased } = stubDb([])
        const marker = await db.getReorgHaltMarker()
        assert.deepStrictEqual(marker, { halted: false, at: null, reason: null })
        assert.ok(wasReleased(), 'the pooled connection must be released')
    })

    it('parses the JSON payload of the newest marker row', async function () {
        const { db } = stubDb([{ time: '2026-07-26 03:30:31', data: JSON.stringify({ reason: 'over-deep', at: '2026-07-26T03:30:31.000Z' }) }])
        const marker = await db.getReorgHaltMarker()
        assert.strictEqual(marker.halted, true)
        assert.strictEqual(marker.reason, 'over-deep')
        assert.strictEqual(marker.at, '2026-07-26T03:30:31.000Z')
    })

    it('still reports halted when the payload is unreadable', async function () {
        const { db } = stubDb([{ time: '2026-07-26 03:30:31', data: 'not json' }])
        const marker = await db.getReorgHaltMarker()
        assert.strictEqual(marker.halted, true, 'an unparseable payload must never downgrade a real halt')
        assert.strictEqual(marker.reason, null)
        assert.strictEqual(marker.at, '2026-07-26 03:30:31')
    })
})
