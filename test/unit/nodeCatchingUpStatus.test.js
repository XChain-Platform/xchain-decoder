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
 * The IBD wait, made visible.
 *
 * nodeCatchUpWait.test.js pinned the WAIT: a node reporting
 * initialblockdownload=true with its tip below ours is waited on, never
 * reconciled. That wait is silent, and silence is what it looks like from
 * outside: the decoder's height stops moving, every health surface still reads
 * green, and nothing on the wire says why. An operator watching `xchain-node ps`
 * sees a decoder that has stopped, indistinguishable from a wedge.
 *
 * These pin the surface: `this.nodeCatchingUp` is null unless the loop is inside
 * that wait, carries the two heights and the instant the wait began while it is,
 * clears when the wait ends, and rides every health payload that already carries
 * reorg_halted.
 */

'use strict'

const assert  = require('assert')
const fs      = require('fs')
const http    = require('http')
const path    = require('path')
const express = require('express')

const XChainDecoder = require('../../src/XChainDecoder')
const { registerLiveRoute } = require('../../src/api')

const STORED_TIP = 100

// A decoder whose start() reaches the parse loop against mocks only (the shape
// parseLoopQuarantine.test.js drives), holding STORED_TIP while the node answers
// from `infoQueue`, one entry per poll. The last entry repeats if the loop outlives
// the queue. `onPoll` runs after each answer is handed out, which is how a test
// stops the loop: stopFlag is read at the TOP of the next iteration, so setting it
// here lets the current poll run to completion first.
function buildDecoder(infoQueue, onPoll = () => {}){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0

    const waits = []
    let polls = 0

    // Every wait-branch iteration ends in sleep(), so a snapshot taken here is the
    // state the health surfaces would have published on that poll.
    decoder.sleep = async () => {
        if (decoder.nodeCatchingUp) waits.push(Object.assign({}, decoder.nodeCatchingUp))
    }

    decoder.connector = {
        rpcErrors: 0,
        getBlockchainInfo: async () => {
            const info = infoQueue[Math.min(polls, infoQueue.length - 1)]
            polls++
            onPoll(polls, decoder)
            return Object.assign({ verificationprogress: 1 }, info)
        },
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => ''
    }

    decoder.db = {
        createDatabase:    async () => true,
        verifyDatabase:    async () => true,
        verifyTables:      async () => true,
        runMigrations:     async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => STORED_TIP,
        getLastTxIndex:    async () => 0,
        endTransaction:    async () => {},
        ping:              async () => true
    }

    return { decoder, waits, pollCount: () => polls }
}

// A clock the test advances by hand, so "the timestamp did not move" is a real
// claim: with the wall clock, two polls of a loop whose sleep is a no-op can land
// in the same millisecond and a re-derived `since` would look stable by accident.
function withFrozenClock(run){
    const RealDate = global.Date
    let now = RealDate.UTC(2026, 8, 8, 12, 0, 0)
    class FakeDate extends RealDate {
        constructor(...args){ args.length ? super(...args) : super(now) }
        static now(){ return now }
    }
    global.Date = FakeDate
    const tick = (ms) => { now += ms }
    return Promise.resolve(run(tick)).finally(() => { global.Date = RealDate })
}

describe('the IBD wait is published as node_catching_up', function () {
    this.timeout(0)

    it('is null on a fresh decoder, so no surface has to invent the not-waiting state', function () {
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        assert.strictEqual(decoder.nodeCatchingUp, null)
    })

    it('carries both heights and the instant the wait began while the node is in IBD', async function () {
        await withFrozenClock(async (tick) => {
            // Two IBD polls with the node advancing between them, then stop.
            const { decoder, waits } = buildDecoder(
                [
                    { blocks: 50, initialblockdownload: true },
                    { blocks: 60, initialblockdownload: true }
                ],
                (polls, d) => { tick(5000); if (polls >= 2) d.stopFlag = true }
            )

            await decoder.start()

            assert.strictEqual(waits.length, 2, 'both polls must have waited, not reconciled')
            assert.deepStrictEqual(Object.keys(waits[0]).sort(),
                ['node_height', 'since', 'stored_height'])

            assert.strictEqual(waits[0].node_height, 50)
            assert.strictEqual(waits[0].stored_height, STORED_TIP)
            assert.strictEqual(waits[1].node_height, 60, 'the node height is re-read every poll')
            assert.strictEqual(waits[1].stored_height, STORED_TIP)

            assert.strictEqual(waits[0].since, waits[1].since,
                'since names when THIS wait began; a per-poll rewrite makes every wait look brand new')
            assert.strictEqual(waits[0].since, new Date(waits[0].since).toISOString(),
                'an ISO instant, not a locale string')
        })
    })

    it('clears when the node leaves initial block download, on the same transition as the log', async function () {
        const { decoder, waits } = buildDecoder(
            [
                { blocks: 50, initialblockdownload: true },
                { blocks: 50, initialblockdownload: false }
            ],
            (polls, d) => { if (polls >= 2) d.stopFlag = true }
        )
        // Past the transition the gap is a rollback again; the reconcile itself is
        // nodeCatchUpWait.test.js's subject, not this one's.
        let reconciled = 0
        decoder.verifyReorg = async () => { reconciled++; return true }

        await decoder.start()

        assert.strictEqual(waits.length, 1, 'only the IBD poll waits')
        assert.strictEqual(reconciled, 1, 'control: leaving IBD hands the gap back to the reorg path')
        assert.strictEqual(decoder.nodeCatchingUp, null, 'the wait must not stay latched on the surfaces')
    })

    it('clears above the tip-regression branch, which a caught-up node never enters again', function () {
        const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'XChainDecoder.js'), 'utf8')
        const branch = SRC.indexOf('if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){')
        assert.ok(branch > 0, 'the tip-regression branch must still be there to clear above')

        const before = SRC.slice(Math.max(0, branch - 800), branch)
        assert.ok(/if \(this\.nodeCatchingUp && lastProcessedBlockIndex <= this\.blockchainInfoLastBlock\)\{\s*\n\s*this\.nodeCatchingUp = null/.test(before),
            'the wait must be cleared BEFORE the branch: the usual exit is the node reaching our height, ' +
            'which stops entering the branch at all and would strand a finished wait on ps forever')
        assert.ok(!/nodeCatchingUpProblem/.test(before),
            'the log latch belongs to the branch below and must not be cleared here')
    })

    it('clears when the node overtakes the stored tip without a below-tip poll in between', async function () {
        // The other exit, and the one the leaving-IBD transition structurally cannot
        // see: it only fires while the node tip is STILL below ours.
        const { decoder } = buildDecoder(
            [
                { blocks: 50,  initialblockdownload: true },
                { blocks: 150, initialblockdownload: false }
            ],
            (polls, d) => { if (polls >= 2) d.stopFlag = true }
        )
        // Stop at the block fetch: the exit under test is upstream of the parse path,
        // and a fetch failure is the loop's own sleep-and-retry, not an escape.
        decoder.fetchBlockHex = async () => { throw new Error('test: stop before parsing') }

        await decoder.start()

        assert.strictEqual(decoder.nodeCatchingUp, null)
    })
})

describe('node_catching_up rides the health payloads', function () {
    const API = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api.js'), 'utf8')

    function liveApp(decoder, running = true){
        const app = express()
        registerLiveRoute(app, decoder, () => running)
        return app
    }

    function getLive(app){
        return new Promise((resolve, reject) => {
            const server = app.listen(0, () => {
                http.get({ port: server.address().port, path: '/live' }, (res) => {
                    let body = ''
                    res.on('data', (c) => { body += c })
                    res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(body) }) })
                }).on('error', (e) => { server.close(); reject(e) })
            })
        })
    }

    function probeDecoder(){
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.lastProcessedBlockIndex = STORED_TIP
        decoder.blockchainInfoLastBlock = 50
        decoder.blockchainInfoLastRefreshAt = Date.now()
        decoder.lastAdvanceAt = Date.now()
        decoder.lastPollAt = Date.now()
        decoder.db = { ping: async () => true }
        decoder.connector = { rpcErrors: 0 }
        return decoder
    }

    it('/live publishes the wait verbatim (the real registrar, not a copy of it)', async function () {
        const decoder = probeDecoder()
        decoder.nodeCatchingUp = { node_height: 50, stored_height: STORED_TIP, since: '2026-09-08T12:00:00.000Z' }
        const res = await getLive(liveApp(decoder))
        assert.deepStrictEqual(res.body.node_catching_up, decoder.nodeCatchingUp)
    })

    it('/live publishes null when no wait is running, never an omitted key', async function () {
        const res = await getLive(liveApp(probeDecoder()))
        assert.ok('node_catching_up' in res.body, 'absent reads as "this build cannot tell you", not "not waiting"')
        assert.strictEqual(res.body.node_catching_up, null)
    })

    // /status and the JSON-RPC health method are built inside startApi(), which binds a
    // port and a live decoder, so these two are pinned at source level: the field must
    // ship beside reorg_halted on every payload that carries it, and must read through a
    // null fallback so a payload built without a decoder instance cannot throw.
    it('every payload carrying reorg_halted also carries node_catching_up', function () {
        const sites = []
        for (let at = API.indexOf('reorg_halted:'); at !== -1; at = API.indexOf('reorg_halted:', at + 1)) sites.push(at)
        assert.strictEqual(sites.length, 3, 'three payloads carry reorg_halted: /live, rpc health, /status')

        for (const at of sites){
            const block = API.slice(at, at + 600)
            assert.ok(/node_catching_up:/.test(block),
                'a reorg_halted payload at offset ' + at + ' ships without node_catching_up')
        }
    })

    it('reads the field fail-soft, so an absent decoder cannot throw a payload', function () {
        const reads = API.match(/node_catching_up:\s*\(decoder && decoder\.nodeCatchingUp\) \|\| null/g) || []
        assert.strictEqual(reads.length, 3, 'each site must guard the instance and default to null')
    })
})
