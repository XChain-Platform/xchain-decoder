// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function registerNamedProbeRecords(context) {
    const { assert, probeDecoder, getLive, liveApp, linesFor } = context

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
}

function registerThrottleAndDefensiveRecords(context) {
    const {
        assert, probeDecoder, getLive, liveApp, linesFor,
        ageProbeLogState, PROBE_LOG_WINDOW_MS, noteProbeFailure
    } = context

    it('throttles a repeating probe failure to one line per window and counts the rest', async function () {
        const decoder = probeDecoder()
        decoder.db = { ping: async () => { throw new Error('pool timeout') } }
        const app = liveApp(decoder)

        for (let i = 0; i < 5; i++) await getLive(app)
        assert.strictEqual(linesFor('HEALTH_PROBE_FAILED').length, 1,
            'a caller-driven route must not turn one outage into one line per request')

        // Age the window rather than sleeping through it, so the suppressed count
        // the next line has to report survives.
        ageProbeLogState()
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
}

function registerSeparateThrottleRecord(context) {
    const { assert, probeDecoder, getLive, liveApp, linesFor } = context

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
}

module.exports = function registerHealthProbeRecords(context) {
    registerNamedProbeRecords(context)
    registerThrottleAndDefensiveRecords(context)
    registerSeparateThrottleRecord(context)
}
