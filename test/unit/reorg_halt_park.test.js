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
 * A REORG_HALT parks the parse loop; it does not exit the process.
 *
 * Without this, the halt refusal escapes start() and api.js exits 1 so the restart
 * policy would act. But the marker is restart-durable and only an audited clear
 * releases it, so against an uncapped `--restart unless-stopped` one halt became
 * an unbounded restart loop: an operator's testnet decoder restarted 5737 times
 * in three days, one every 45 seconds, and the restart count was the only place
 * the fault was visible. Everything built around a halt (the CLI's restart
 * count, the halt-aware healthcheck, the audited clear) assumes the halted
 * decoder STAYS UP.
 *
 * These pin the state machine: which failures park and which still exit, that a
 * parked loop re-reads the marker rather than trusting the probe cache forever,
 * that a clear resumes it in place with no restart, one log line each way, and
 * that a SIGTERM during a park still drains.
 */

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const XChainDecoder = require('../../src/XChainDecoder')
const { DISPENSER_EXPIRE_SAFE_DEPTH } = XChainDecoder
const { createDecoderDrain } = require('../../src/shutdown')
const observability = require('../../src/observability')

const STORED_TIP = 100
// Below the stored tip, so every poll enters the tip-regression branch and
// reconciles, which is the call site a halt reaches first.
const NODE_TIP = 90

let sink

function installSink(){
    observability._resetObservability()
    sink = { lines: [] }
    const push = (m) => sink.lines.push(m)
    observability.installObservability(null, {
        service: 'xchain-decoder', env: {},
        console: { log: push, warn: push, error: push }
    })
}

function linesMatching(re){
    return sink.lines.filter((l) => re.test(l))
}

// A decoder whose start() reaches the parse loop against mocks only. `sleep` is
// the test's clock and its stop switch: the loop's every park pass ends in one,
// so ticking 61 s there is what lets the marker probe's own TTL expire, and
// stopping after `maxSleeps` keeps a park from running forever.
function buildDecoder({ dbOverrides = {}, nodeTips = [NODE_TIP], maxSleeps = 4 } = {}){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0

    let sleeps = 0
    decoder.sleep = async () => {
        sleeps++
        clock.tick(61000)
        if (sleeps >= maxSleeps) decoder.stopFlag = true
    }

    let polls = 0
    decoder.connector = {
        rpcErrors: 0,
        getBlockchainInfo: async () => {
            const blocks = nodeTips[Math.min(polls, nodeTips.length - 1)]
            polls++
            return { blocks, verificationprogress: 1, initialblockdownload: false }
        },
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => ''
    }
    // The parse path is not this file's subject: stop the loop at the fetch, the
    // way the sibling IBD suite does, so a resumed loop is observable without
    // decoding a block.
    decoder.fetchBlockHex = async () => { throw new Error('test: stop before parsing') }

    decoder.db = Object.assign({
        createDatabase:    async () => true,
        verifyDatabase:    async () => true,
        verifyTables:      async () => true,
        runMigrations:     async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => STORED_TIP,
        getLastTxIndex:    async () => 0,
        endTransaction:    async () => {},
        ping:              async () => true
    }, dbOverrides)

    return { decoder, sleepCount: () => sleeps, lastSleepMs: () => lastSleepMs }
}

// A hand-advanced clock, because the park's re-read cadence IS a duration: with
// the wall clock every park pass lands inside checkReorgHalt's 60 s TTL and the
// probe would answer from cache for the whole test, which is exactly the bug the
// resume path has to avoid.
const clock = (function makeClock(){
    const RealDate = global.Date
    let now = RealDate.UTC(2026, 8, 14, 12, 0, 0)
    class FakeDate extends RealDate {
        constructor(...args){ args.length ? super(...args) : super(now) }
        static now(){ return now }
    }
    return {
        install(){ now = RealDate.UTC(2026, 8, 14, 12, 0, 0); global.Date = FakeDate },
        restore(){ global.Date = RealDate },
        tick(ms){ now += ms }
    }
})()

describe('the parse loop parks on a REORG_HALT instead of exiting', function () {
    this.timeout(0)

    beforeEach(function (){ installSink(); clock.install() })
    afterEach(function (){ clock.restore(); observability._resetObservability() })

    it('parks when a pre-existing marker refuses the rollback, and keeps the loop alive', async function () {
        const { decoder, sleepCount } = buildDecoder({
            dbOverrides: { isReorgHalted: async () => true }
        })

        await decoder.start()

        assert.strictEqual(decoder.reorgHaltParked, true, 'the refusal must park, not escape start()')
        assert.strictEqual(decoder.getReorgHaltStatus().parked, true)
        assert.strictEqual(decoder.getReorgHaltStatus().parked_height, STORED_TIP)
        assert.ok(sleepCount() > 1, 'the parked loop keeps iterating, so /live stays answerable')
    })

    it('parks when the safe-depth ceiling writes the marker on this run', async function () {
        let halted = false
        const { decoder } = buildDecoder({
            dbOverrides: {
                // The ceiling is already spent by a previous process, so the first
                // delete this run would attempt crosses it.
                isReorgHalted:             async () => halted,
                countReorgDeletesAboveTip: async () => DISPENSER_EXPIRE_SAFE_DEPTH,
                getBlockByIndex:           async (h) => ({ block_index: h, block_hash: 'aa'.repeat(32) }),
                markReorgHalted:           async () => { halted = true; return true }
            }
        })

        await decoder.start()

        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.strictEqual(decoder.reorgHalted, true, 'the halt itself is unchanged')
        assert.strictEqual(linesMatching(/REORG_HALT_MARKER/).length, 1,
            'the durable marker is still written before the park')
        assert.match(linesMatching(/PARKED on a REORG_HALT/)[0], /safe-depth/,
            'the park line carries the reason the ceiling gave')
    })

    it('logs ONE park line, naming the height, the clear command and the automatic resume', async function () {
        const { decoder } = buildDecoder({ dbOverrides: { isReorgHalted: async () => true } })

        await decoder.start()

        const parked = linesMatching(/PARKED on a REORG_HALT/)
        assert.strictEqual(parked.length, 1, 'a park is one line, not one per pass: ' + parked.length)
        assert.ok(parked[0].includes('at block height ' + STORED_TIP), parked[0])
        assert.ok(parked[0].includes('clear-reorg-halt'), 'the line must name the recovery command: ' + parked[0])
        assert.ok(/resumes parsing on its own/.test(parked[0]),
            'the line must say the decoder recovers without a restart: ' + parked[0])
        assert.ok(parked[0].includes(' error '), 'a park is an error-level event: ' + parked[0])
    })

})

function reorgHaltError(message){ const error = new Error(message); error.reorgHalt = true; return error }
function buildEqualHeightDecoder({ rpcThrows = false, halt = false, resetTip = STORED_TIP } = {}){
    let initialTipRead = true
    const calls = { verifyReorg: 0 }
    const dbOverrides = {
        getLastBlockIndex: async () => {
            const tip = initialTipRead ? STORED_TIP : resetTip
            initialTipRead = false
            return tip
        },
        getBlockByIndex: async () => ({ block_hash: 'stored-tip-hash' })
    }
    if (halt) dbOverrides.isReorgHalted = async () => true
    const built = buildDecoder({ nodeTips: [STORED_TIP], dbOverrides })
    built.decoder.mempoolInterval = 'test-placeholder'
    built.decoder.connector.getBlockHash = async () => {
        if (rpcThrows) throw new Error('rpc: connection reset')
        return 'node-tip-hash'
    }
    built.decoder.verifyReorg = async () => {
        calls.verifyReorg++
        if (halt) throw reorgHaltError('equal-height refusal')
    }
    return { ...built, calls }
}
describe('REORG_HALT call-site coverage', function () {
    this.timeout(0)
    beforeEach(function (){ installSink(); clock.install() })
    afterEach(function (){ clock.restore(); observability._resetObservability() })
    it('parks and stays alive during a forward hash-mismatch reorg', async function () {
        const { decoder, sleepCount } = buildDecoder({
            nodeTips: [STORED_TIP + 5],
            dbOverrides: {
                getBlockByIndex: async () => ({ block_hash: 'ff'.repeat(32) }),
                isReorgHalted: async () => true
            }
        })
        let verifyReorgCalls = 0
        decoder.fetchBlockHex = async () => 'deadbeef'
        decoder.xchainBlockDecoder = { blockFromHex: () => ({ prevHash: Buffer.alloc(32, 0x11) }) }
        decoder.verifyReorg = async () => { verifyReorgCalls++; throw reorgHaltError('forward refusal') }
        await decoder.start()
        assert.strictEqual(verifyReorgCalls, 1)
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.ok(sleepCount() > 1, 'the parked loop must stay alive')
    })
    it('resets the cursor after an equal-height tip replacement', async function () {
        const { decoder, calls } = buildEqualHeightDecoder({ resetTip: STORED_TIP - 3 })
        await decoder.start()
        assert.strictEqual(calls.verifyReorg, 1)
        assert.strictEqual(decoder.lastProcessedBlockIndex, STORED_TIP - 3)
    })
    it('skips an equal-height reconcile when its RPC read throws', async function () {
        const { decoder, calls } = buildEqualHeightDecoder({ rpcThrows: true })
        await decoder.start()
        assert.strictEqual(calls.verifyReorg, 0)
        assert.strictEqual(decoder.lastProcessedBlockIndex, STORED_TIP)
        assert.ok(linesMatching(/equal-height tip-hash detection reads, skipping/).length > 0)
    })
    it('parks during an equal-height reconcile refusal', async function () {
        const { decoder, calls, sleepCount } = buildEqualHeightDecoder({ halt: true })
        await decoder.start()
        assert.strictEqual(calls.verifyReorg, 1)
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.ok(sleepCount() > 1, 'the parked loop must stay alive')
    })
})

describe('a failure that is not a halt refusal still escapes start()', function () {
    this.timeout(0)

    beforeEach(function (){ installSink(); clock.install() })
    afterEach(function (){ clock.restore(); observability._resetObservability() })

    it('does NOT park on a DB failure, which still escapes start() for the exit path', async function () {
        const { decoder } = buildDecoder({
            dbOverrides: {
                isReorgHalted: async () => false,
                // The prior-depth read is infrastructure, never a halt: it throws out of
                // verifyReorg before any delete and must keep the exit-1 behaviour.
                countReorgDeletesAboveTip: async () => { throw new Error('pool timeout acquiring connection') }
            }
        })

        await assert.rejects(() => decoder.start(), /prior rollback depth could not be read/)
        assert.strictEqual(decoder.reorgHaltParked, false, 'an infrastructure fault must not park')
    })

    it('does NOT park on an unknown throw out of the reconcile', async function () {
        const { decoder } = buildDecoder({ dbOverrides: { isReorgHalted: async () => false } })
        decoder.verifyReorg = async () => { throw new Error('something nobody classified') }

        await assert.rejects(() => decoder.start(), /nobody classified/)
        assert.strictEqual(decoder.reorgHaltParked, false)
    })
})

describe('a parked decoder resumes on the clear, with no restart', function () {
    this.timeout(0)

    beforeEach(function (){ installSink(); clock.install() })
    afterEach(function (){ clock.restore(); observability._resetObservability() })

    it('re-reads the marker on the probe cadence and resumes from the stored tip', async function () {
        let probes = 0
        let halted = true
        const { decoder } = buildDecoder({
            // Once the operator has cleared, the node is also past our tip again, so the
            // resumed loop leaves the reconcile branch and reaches the parse path.
            nodeTips: [NODE_TIP, STORED_TIP + 50],
            maxSleeps: 6,
            dbOverrides: {
                isReorgHalted: async () => { probes++; if (probes >= 3) halted = false; return halted }
            }
        })

        await decoder.start()

        assert.ok(probes >= 3, 'the parked pass must re-read the marker, never serve the cache forever')
        assert.strictEqual(decoder.reorgHaltParked, false, 'a cleared marker must release the park')
        assert.strictEqual(decoder.getReorgHaltStatus().parked, false)
        assert.strictEqual(decoder.getReorgHaltStatus().parked_at, null)

        const resumed = linesMatching(/resuming the parse loop/)
        assert.strictEqual(resumed.length, 1, 'one line on the way out, as on the way in')
        assert.ok(resumed[0].includes('from block height ' + STORED_TIP), resumed[0])
        assert.ok(resumed[0].includes('without a restart'), resumed[0])
    })

    it('never resumes from a halt whose marker could not be persisted', async function () {
        // Nothing durable exists, so the probe reads "no row" and would call the halt
        // cleared on the very first pass, resuming straight back into the same refusal.
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.db = { isReorgHalted: async () => false }
        decoder.reorgHaltMarkerPersisted = false
        decoder.parkOnReorgHalt('safe-depth window exceeded', 500)

        assert.strictEqual(await decoder.resumeFromReorgHaltPark(), false)
        assert.strictEqual(decoder.reorgHaltParked, true)
        const parked = linesMatching(/PARKED on a REORG_HALT/)
        assert.ok(/will NOT end on its own/.test(parked[0]),
            'the line must not promise a resume that cannot happen: ' + parked[0])
    })
})

describe('a park is not a wedge, and a SIGTERM during one still drains', function () {
    this.timeout(0)

    beforeEach(function (){ installSink(); clock.install() })
    afterEach(function (){ clock.restore(); observability._resetObservability() })

    it('keeps isStalled() false, so autoheal cannot restart-loop a parked decoder', function () {
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.lastAdvanceAt = Date.now() - (24 * 60 * 60 * 1000)
        decoder.blockchainInfoLastBlock = 5000
        decoder.lastProcessedBlockIndex = STORED_TIP
        decoder.blockchainInfoLastRefreshAt = Date.now()

        // Control: this decoder is stalled by every other measure.
        assert.strictEqual(decoder.isStalled(), true)
        decoder.db = { isReorgHalted: async () => true }
        decoder.parkOnReorgHalt('safe-depth window exceeded', STORED_TIP)
        assert.strictEqual(decoder.isStalled(), false, 'the park is deliberate, not a wedge a restart repairs')
    })

    it('breaks the parked loop on stopFlag and lets the drain complete', async function () {
        // buildDecoder's sleep stub raises stopFlag a few passes in, which is the
        // SIGTERM landing while the loop is parked.
        const { decoder } = buildDecoder({ dbOverrides: { isReorgHalted: async () => true } })
        const loopSettled = decoder.start()

        // RESOLVES, never rejects: a stop during a park is a clean exit, so api.js
        // reports not-running and the drain exits 0 instead of the crash path.
        await loopSettled
        assert.strictEqual(decoder.reorgHaltParked, true, 'the loop must have been parked when the stop arrived')

        await createDecoderDrain({
            decoder,
            server: null,
            loopSettled,
            log: { log(){}, warn(){}, error(){} }
        })()

        assert.strictEqual(decoder.stopFlag, true, 'the drain stopped the decoder')
    })

    it('ticks far below the shutdown budget, so a SIGTERM is not waited out', function () {
        const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'XChainDecoder', 'constants.js'), 'utf8')
        const match = SRC.match(/const REORG_HALT_PARK_TICK_MS = (\d+)/)
        assert.ok(match, 'the park tick must be a named constant')
        assert.ok(Number(match[1]) <= 5000,
            'a park pass has to return to the stopFlag check quickly; the drain budget is finite')
    })
})

describe('the park rides every health payload', function () {
    // The /live route lives in the probe_routes part, so the payload sites span both files.
    const API = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api.js'), 'utf8')
        + fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api', 'probe_routes.js'), 'utf8')

    it('publishes reorg_halt_parked on /live, the JSON-RPC health method and /status', function () {
        const sites = API.match(/reorg_halt_parked:/g) || []
        assert.strictEqual(sites.length, 3,
            'a parked decoder must be distinguishable from a latent-but-parsing one on every surface')
    })

    it('reads it off the halt status, never off a second source of truth', function () {
        const reads = API.match(/reorg_halt_parked:\s+reorgHalt\.parked === true/g) || []
        assert.strictEqual(reads.length, 3)
    })
})
