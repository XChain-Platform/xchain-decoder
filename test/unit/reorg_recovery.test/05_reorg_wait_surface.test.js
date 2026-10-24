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
 * Publish reorg-proof waits so deliberate pauses are not mistaken for stalls.
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const express = require('express')
const XChainDecoder = require('../../../src/XChainDecoder')
const { parkOrRethrow } = require('../../../src/XChainDecoder/sync_loop.js')
const { ingestNextBlock } = require('../../../src/XChainDecoder/block_ingest.js')
const { buildHealthResult, registerLiveRoute, registerReadyRoute, registerStatusRoute } = require('../../../src/api')

function makeDecoder(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    return decoder
}

function waitError(){
    const err = new Error('waiting for fork proof')
    err.reorgWait = true
    err.tipBelowStoredTip = true
    err.refusalClass = 'node_behind'
    err.reorgWaitState = { stored_height: 100, stored_hash: 'hash100', class: 'node_behind' }
    return err
}

describe('the shared reconcile catch publishes reorg_wait', function () {
    it('starts null and keeps one since timestamp across repeated polls', async function () {
        const decoder = makeDecoder()
        assert.strictEqual(decoder.reorgWait, null)
        const loop = { tipBelowStoredTipRefused: false }
        await parkOrRethrow.call(decoder, waitError(), loop)
        const first = Object.assign({}, decoder.reorgWait)
        await parkOrRethrow.call(decoder, waitError(), loop)
        assert.deepStrictEqual(decoder.reorgWait, first)
        assert.deepStrictEqual(Object.keys(first).sort(), ['class', 'since', 'stored_hash', 'stored_height'])
        assert.strictEqual(first.since, new Date(first.since).toISOString())
    })
})

function laggingLoopDecoder(){
    const decoder = makeDecoder()
    let sleeps = 0
    decoder.sleep = async () => { if (++sleeps >= 3) decoder.stopFlag = true }
    decoder.connector = {
        rpcErrors: 0,
        getBlockchainInfo: async () => ({ chain: 'regtest', blocks: 98, headers: 100,
            verificationprogress: 1, initialblockdownload: false }),
        getBlockHash: async (height) => {
            if (height > 98) throw new Error('Block height out of range')
            return 'hash' + height
        },
        getBlockHeader: async (hash) => ({ confirmations: Number(hash.slice(4)) > 98 ? -1 : 1 }),
        getBlock: async () => ''
    }
    decoder.db = {
        createDatabase: async () => true,
        verifyDatabase: async () => true,
        verifyTables: async () => true,
        runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => 100,
        getBlockByIndex: async (height) => ({ block_index: height, block_hash: 'hash' + height }),
        getLastTxIndex: async () => 0,
        endTransaction: async () => {},
        ping: async () => true,
        isReorgHalted: async () => false,
        countReorgDeletesAboveTip: async () => 0
    }
    return decoder
}

describe('the tip-regression catch publishes reorg_wait', function () {
    this.timeout(0)

    it('surfaces a non-IBD node that is behind the stored chain', async function () {
        const decoder = laggingLoopDecoder()
        await decoder.start()
        assert.deepStrictEqual(
            { ...decoder.reorgWait, since: null },
            { stored_height: 100, stored_hash: 'hash100', class: 'node_behind', since: null }
        )
        assert.strictEqual(decoder.reorgHalted, false)
    })
})

describe('successful reconciles clear reorg_wait with the refusal latch', function () {
    it('clears at all three reconcile completion sites', function () {
        const files = [
            '../../../src/XChainDecoder/block_ingest.js',
            '../../../src/XChainDecoder/sync_loop.js',
            '../../../src/XChainDecoder/tip_refresh.js'
        ]
        for (const file of files){
            const source = fs.readFileSync(require.resolve(file), 'utf8')
            assert.match(source, /this\.reorgWait = null\s+loop\.tipBelowStoredTipRefused = false/,
                file + ' must clear the public wait with its private refusal latch')
        }
    })
})

function probeDecoder(){
    const decoder = makeDecoder()
    decoder.lastProcessedBlockIndex = 100
    decoder.blockchainInfoLastBlock = 150
    decoder.blockchainInfoLastRefreshAt = Date.now()
    decoder.lastAdvanceAt = Date.now()
    decoder.lastPollAt = Date.now()
    decoder.synced = true
    decoder.reorgWait = { stored_height: 100, stored_hash: 'hash100', class: 'node_behind',
        since: '2026-10-23T12:00:00.000Z' }
    decoder.db = {
        ping: async () => true,
        getReorgHaltMarker: async () => ({ halted: false, reason: null, at: null })
    }
    decoder.connector = { rpcErrors: 0 }
    return decoder
}

function request(decoder, path){
    const app = express()
    registerStatusRoute(app, decoder, () => true)
    registerLiveRoute(app, decoder, () => true)
    registerReadyRoute(app, decoder, () => true)
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            http.get({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => {
                let body = ''
                res.on('data', (chunk) => { body += chunk })
                res.on('end', () => { server.close(); resolve(JSON.parse(body)) })
            }).on('error', (err) => { server.close(); reject(err) })
        })
    })
}

describe('reorg_wait rides every health payload', function () {
    it('publishes the same wait on status, live and ready', async function () {
        const decoder = probeDecoder()
        for (const path of ['/status', '/live', '/ready']){
            const body = await request(decoder, path)
            assert.deepStrictEqual(body.reorg_wait, decoder.reorgWait, path)
        }
    })

    it('publishes the same wait on the JSON-RPC health result', function () {
        const decoder = probeDecoder()
        const state = {
            syncStatus: decoder.getSyncStatus(),
            dbOk: true,
            dbPhase: 'running',
            reorgHalt: { halted: false, reason: null, at: null, checked_at: 1 }
        }
        assert.deepStrictEqual(buildHealthResult(decoder, state, true, null).reorg_wait, decoder.reorgWait)
    })

    it('publishes null when no proof wait is active', async function () {
        const decoder = probeDecoder()
        decoder.reorgWait = null
        assert.strictEqual((await request(decoder, '/live')).reorg_wait, null)
    })
})

describe('a reorg proof wait does not trigger autoheal', function () {
    it('returns not stalled while the wait is set', function () {
        const decoder = probeDecoder()
        decoder.lastAdvanceAt = Date.now() - (60 * 60 * 1000)
        assert.strictEqual(decoder.isStalled(), false)
        decoder.reorgWait = null
        assert.strictEqual(decoder.isStalled(), true, 'control: the same decoder without the wait is stalled')
    })
})

describe('a reorg proof wait ends once the node holds the stored tip', function () {
    this.timeout(0)

    it('a node_behind wait clears when the node reaches the stored tip, and stall detection resumes', async function () {
        const decoder = laggingLoopDecoder()
        let nodeTip = 98
        let sawWait = false
        let sleeps = 0
        decoder.sleep = async () => {
            if (decoder.reorgWait) sawWait = true
            // The node catches up to the stored tip on the same chain.
            if (++sleeps === 6) nodeTip = 100
            if (sleeps >= 40) decoder.stopFlag = true
        }
        decoder.connector.getBlockchainInfo = async () => ({ chain: 'regtest', blocks: nodeTip, headers: 100,
            verificationprogress: 1, initialblockdownload: false })
        decoder.connector.getBlockHash = async (height) => {
            if (height > nodeTip) throw new Error('Block height out of range')
            return 'hash' + height
        }
        decoder.connector.getRawMempool = async () => []
        decoder.verifyChainGenesis = async () => null
        await decoder.start()
        assert.ok(sawWait, 'the wait is published while the node is behind')
        assert.strictEqual(decoder.reorgHalted, false)
        assert.strictEqual(decoder.reorgWait, null)
        decoder.lastAdvanceAt = Date.now() - (60 * 60 * 1000)
        decoder.blockchainInfoLastBlock = decoder.lastProcessedBlockIndex + 50
        assert.strictEqual(decoder.isStalled(), true, 'a resolved wait no longer suppresses autoheal')
    })
})

describe('a reorg proof wait ends when the next block extends the stored tip', function () {
    const storedTip = 'aa'.repeat(32)

    function ingestDecoder(previousHash){
        const decoder = makeDecoder()
        decoder.startBlockIndex = 0
        decoder.blockchainInfoLastBlock = 101
        decoder.fetchBlockHex = async () => '00'
        decoder.xchainBlockDecoder = { blockFromHex: () => ({ prevHash: Buffer.from(previousHash, 'hex').reverse() }) }
        decoder.connector = { rpcErrors: 0, getBlockHash: async (h) => 'next' + h }
        decoder.db = {
            getBlockByIndex: async (h) => ({ block_index: h, block_hash: storedTip }),
            endTransaction: async () => {},
            // The insert itself is out of scope: stop at its first write.
            beginTransaction: async () => { throw new Error('insert reached') }
        }
        decoder.reorgWait = { stored_height: 100, stored_hash: storedTip, class: 'node_behind', since: '2026-10-23T12:00:00.000Z' }
        return decoder
    }

    it('clears the wait and the refusal latch before the insert', async function () {
        const decoder = ingestDecoder(storedTip)
        const loop = { lastProcessedBlockIndex: 100, blocksQuantity: 0, tipBelowStoredTipRefused: 'node_behind' }
        await assert.rejects(() => ingestNextBlock.call(decoder, loop), /insert reached/)
        assert.strictEqual(decoder.reorgWait, null)
        assert.strictEqual(loop.tipBelowStoredTipRefused, false)
    })

    it('keeps the wait while the next block still does not extend the stored tip', async function () {
        const decoder = ingestDecoder('bb'.repeat(32))
        const before = Object.assign({}, decoder.reorgWait)
        decoder.verifyReorg = async () => { throw waitError() }
        const loop = { lastProcessedBlockIndex: 100, blocksQuantity: 0, tipBelowStoredTipRefused: 'node_behind' }
        assert.strictEqual(await ingestNextBlock.call(decoder, loop), 'continue')
        assert.notStrictEqual(decoder.reorgWait, null)
        assert.strictEqual(decoder.reorgWait.class, before.class)
    })
})
