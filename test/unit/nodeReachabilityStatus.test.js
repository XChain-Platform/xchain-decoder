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
 * A node that never answered, made visible.
 *
 * An operator ran a decoder whose coin node answered no RPC at all: the log
 * carried "Getting timeout trying to get blockchain info, trying again..." 2099
 * times over five and a half days, the restart count stayed 0 and the container
 * healthcheck read healthy throughout. Nothing on any surface said the service had
 * never reached its node.
 *
 * The healthy VERDICT is deliberately unchanged: isStalled() reports a
 * never-polled decoder as not stale on purpose, because a restart cannot fix an
 * upstream outage and gating on it re-opens the autoheal restart flap. What these
 * pin is the VISIBILITY: the connector records when the node last answered and
 * when it last failed, nodeReachability() reduces those to node_last_ok_at and
 * node_unreachable, and both ride every payload that already carries
 * node_catching_up.
 */

'use strict'

const assert = require('assert')
const fs     = require('fs')
const http   = require('http')
const path   = require('path')
const express = require('express')

const BlockchainConnector = require('../../src/BlockchainConnector')
const { nodeReachabilityFrom } = BlockchainConnector
const XChainDecoder = require('../../src/XChainDecoder')
const { registerLiveRoute, nodeReachabilityFields } = require('../../src/api')

const T0   = Date.parse('2026-09-09T12:00:00.000Z')  // connector construction
const OK   = Date.parse('2026-09-09T12:10:00.000Z')
const FAIL = Date.parse('2026-09-09T12:20:00.000Z')
const NOW  = Date.parse('2026-09-09T13:00:00.000Z')

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('nodeReachabilityFrom() (the reducer both fields are derived from)', function () {
    it('reports nothing wrong before any attempt has been made', function () {
        const r = nodeReachabilityFrom(T0, 0, 0, NOW)
        assert.deepStrictEqual(r, { node_last_ok_at: null, node_unreachable: null })
    })

    it('reports the last success and no outage while the latest attempt succeeded', function () {
        const r = nodeReachabilityFrom(T0, OK, 0, NOW)
        assert.strictEqual(r.node_last_ok_at, '2026-09-09T12:10:00.000Z')
        assert.strictEqual(r.node_unreachable, null)
    })

    it('dates an outage from the last success when there was one', function () {
        const r = nodeReachabilityFrom(T0, OK, FAIL, NOW)
        assert.deepStrictEqual(Object.keys(r.node_unreachable).sort(),
            ['last_ok_at', 'seconds', 'since'])
        assert.strictEqual(r.node_unreachable.since, '2026-09-09T12:10:00.000Z')
        assert.strictEqual(r.node_unreachable.last_ok_at, '2026-09-09T12:10:00.000Z')
        assert.strictEqual(r.node_unreachable.seconds, 3000)
        assert.strictEqual(r.node_last_ok_at, '2026-09-09T12:10:00.000Z')
    })

    it('dates an outage from connector start when the node NEVER answered', function () {
        // The reported defect: no success to date the outage from, so the age is the
        // life of the connector, and last_ok_at stays null rather than inventing one.
        const r = nodeReachabilityFrom(T0, 0, FAIL, NOW)
        assert.strictEqual(r.node_last_ok_at, null)
        assert.strictEqual(r.node_unreachable.since, '2026-09-09T12:00:00.000Z')
        assert.strictEqual(r.node_unreachable.last_ok_at, null)
        assert.strictEqual(r.node_unreachable.seconds, 3600)
    })

    it('clears the outage as soon as one attempt succeeds again', function () {
        // Failure at FAIL, success after it: the LATEST attempt is what decides.
        const later = FAIL + 60000
        const r = nodeReachabilityFrom(T0, later, FAIL, NOW)
        assert.strictEqual(r.node_unreachable, null,
            'a recovered node must not stay latched as unreachable')
        assert.strictEqual(r.node_last_ok_at, new Date(later).toISOString())
    })

    it('treats a failure at the same instant as the last success as recovered', function () {
        // Strictly-newer, not newer-or-equal: two events in one millisecond must not
        // flip a node that is answering into an outage with a zero-second age.
        assert.strictEqual(nodeReachabilityFrom(T0, OK, OK, NOW).node_unreachable, null)
    })

    it('floors the age to whole seconds and never publishes a negative one', function () {
        assert.strictEqual(nodeReachabilityFrom(T0, 0, FAIL, T0 + 1999).node_unreachable.seconds, 1)
        assert.strictEqual(nodeReachabilityFrom(T0, 0, FAIL, T0 - 5000).node_unreachable.seconds, 0,
            'a probe racing the recorded instant must not report a negative outage')
    })

    it('emits ISO instants, not locale strings or epoch numbers', function () {
        const r = nodeReachabilityFrom(T0, OK, FAIL, NOW)
        assert.match(r.node_last_ok_at, ISO)
        assert.match(r.node_unreachable.since, ISO)
        assert.strictEqual(new Date(r.node_unreachable.since).toISOString(), r.node_unreachable.since)
    })

    it('defaults `now` to the wall clock, so a caller cannot forget to pass one', function () {
        const r = nodeReachabilityFrom(Date.now() - 10000, 0, Date.now())
        assert.ok(r.node_unreachable.seconds >= 9 && r.node_unreachable.seconds <= 11,
            'expected roughly a ten second outage, got ' + r.node_unreachable.seconds)
    })
})

describe('the connector records both instants at its single POST choke point', function () {
    function newConnector(){
        return new BlockchainConnector('127.0.0.1', '18443', 'u', 'p')
    }

    it('starts with never-succeeded, never-failed and a start time', function () {
        const c = newConnector()
        assert.strictEqual(c.lastNodeOkAt, 0)
        assert.strictEqual(c.lastNodeFailAt, 0)
        assert.ok(c.startedAt > 0, 'the outage of a node that never answered is dated from here')
        assert.deepStrictEqual(c.nodeReachability(),
            { node_last_ok_at: null, node_unreachable: null })
    })

    it('a successful POST stamps lastNodeOkAt and clears the verdict', async function () {
        const c = newConnector()
        c.lastNodeFailAt = Date.now() - 1000
        // rpcPost is the choke point every RPC method funnels through, so stubbing the
        // transport under it exercises the real recording path.
        const axios = require('axios')
        const realPost = axios.post
        axios.post = async () => ({ data: { result: 'ok' } })
        try {
            await c.rpcPost({ method: 'getblockchaininfo' })
        } finally {
            axios.post = realPost
        }
        assert.ok(c.lastNodeOkAt > 0)
        assert.strictEqual(c.nodeReachability().node_unreachable, null)
    })

    it('a failing POST stamps lastNodeFailAt and rethrows the original error', async function () {
        const c = newConnector()
        const axios = require('axios')
        const realPost = axios.post
        const boom = new Error('timeout of 30000ms exceeded')
        boom.code = 'ECONNABORTED'
        axios.post = async () => { throw boom }
        try {
            await assert.rejects(() => c.rpcPost({ method: 'getblockchaininfo' }),
                (err) => err.code === 'ECONNABORTED')
        } finally {
            axios.post = realPost
        }
        assert.ok(c.lastNodeFailAt > 0)
        const r = c.nodeReachability()
        assert.strictEqual(r.node_last_ok_at, null, 'this node has never answered')
        assert.ok(r.node_unreachable, 'the timeout the operator saw 2099 times must show here')
        assert.strictEqual(r.node_unreachable.last_ok_at, null)
    })

    it('every RPC method reaches the recording site through rpcPost', function () {
        // Source-level: instrumenting per method is how the next added method silently
        // escapes the surface. Nothing in this class may POST around the choke point.
        const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'BlockchainConnector.js'), 'utf8')
        const posts = SRC.match(/axios\.post\(/g) || []
        assert.strictEqual(posts.length, 1, 'axios.post must appear only inside rpcPost')
    })
})

describe('the reachability fields ride the health payloads', function () {
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

    function probeDecoder(connector){
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.lastProcessedBlockIndex = 100
        decoder.blockchainInfoLastBlock = 100
        decoder.blockchainInfoLastRefreshAt = Date.now()
        decoder.lastAdvanceAt = Date.now()
        decoder.lastPollAt = Date.now()
        decoder.db = { ping: async () => true }
        decoder.connector = connector || { rpcErrors: 0 }
        return decoder
    }

    it('/live publishes the outage of a node that has never answered', async function () {
        const connector = new BlockchainConnector('127.0.0.1', '18443', 'u', 'p')
        connector.rpcErrors = 0
        connector.startedAt = Date.now() - 3600000
        connector.lastNodeFailAt = Date.now()
        const res = await getLive(liveApp(probeDecoder(connector)))
        assert.strictEqual(res.body.node_last_ok_at, null)
        assert.ok(res.body.node_unreachable, 'the field the operator had no way to see')
        assert.strictEqual(res.body.node_unreachable.last_ok_at, null)
        assert.ok(res.body.node_unreachable.seconds >= 3599)
        assert.match(res.body.node_unreachable.since, ISO)
    })

    it('/live still answers 200 while the node is unreachable, by design', async function () {
        // The visibility is new; the verdict is not. A restart cannot fix an upstream
        // outage, so gating here would restart-flap a decoder that is doing its job.
        const connector = new BlockchainConnector('127.0.0.1', '18443', 'u', 'p')
        connector.rpcErrors = 0
        connector.lastNodeFailAt = Date.now()
        const res = await getLive(liveApp(probeDecoder(connector)))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.status, 'healthy')
        assert.ok(res.body.node_unreachable)
    })

    it('/live publishes both keys as null when the node is answering', async function () {
        const connector = new BlockchainConnector('127.0.0.1', '18443', 'u', 'p')
        connector.rpcErrors = 0
        connector.lastNodeOkAt = Date.now()
        const res = await getLive(liveApp(probeDecoder(connector)))
        assert.ok('node_last_ok_at' in res.body, 'an omitted key reads as "this build cannot tell you"')
        assert.ok('node_unreachable' in res.body)
        assert.match(res.body.node_last_ok_at, ISO)
        assert.strictEqual(res.body.node_unreachable, null)
    })

    it('/live carries both keys against a decoder whose connector is an old stub', async function () {
        const res = await getLive(liveApp(probeDecoder()))
        assert.strictEqual(res.body.node_last_ok_at, null)
        assert.strictEqual(res.body.node_unreachable, null)
    })

    // /status and the JSON-RPC health method are built inside startApi(), which binds a
    // port and a live decoder, so those two are pinned at source level, the shape
    // nodeCatchingUpStatus.test.js uses for the same reason.
    it('every payload carrying node_catching_up also spreads the reachability fields', function () {
        const sites = []
        for (let at = API.indexOf('node_catching_up:'); at !== -1; at = API.indexOf('node_catching_up:', at + 1)) sites.push(at)
        assert.strictEqual(sites.length, 3, 'three payloads carry node_catching_up: /live, rpc health, /status')

        for (const at of sites){
            assert.ok(/\.\.\.nodeReachabilityFields\(decoder\),/.test(API.slice(at, at + 500)),
                'a node_catching_up payload at offset ' + at + ' ships without the reachability fields')
        }
    })

    it('reads the fields fail-soft, so a payload built without a connector cannot throw', function () {
        assert.deepStrictEqual(nodeReachabilityFields(undefined),
            { node_last_ok_at: null, node_unreachable: null })
        assert.deepStrictEqual(nodeReachabilityFields({}),
            { node_last_ok_at: null, node_unreachable: null })
        assert.deepStrictEqual(nodeReachabilityFields({ connector: { rpcErrors: 0 } }),
            { node_last_ok_at: null, node_unreachable: null })
        assert.deepStrictEqual(
            nodeReachabilityFields({ connector: { nodeReachability(){ throw new Error('boom') } } }),
            { node_last_ok_at: null, node_unreachable: null })
    })
})
