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
 * Verify recovery, durable halts, and operator guidance around the dispenser
 * safe-depth window.
 */

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')
const { DISPENSER_EXPIRE_SAFE_DEPTH } = XChainDecoder
const { run: runClearTool } = require('../../../src/clear_reorg_halt.js')
const { parkOrRethrow } = require('../../../src/XChainDecoder/sync_loop.js')

const SAFE_DEPTH = DISPENSER_EXPIRE_SAFE_DEPTH
// The xchain-node CLI names its argument <chain>, and every recovery line says it the same way.
const RESET = /xchain-node reset xchain-decoder <chain> <network> --with-indexer --yes/

function makeDecoder(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    return decoder
}

// A stored chain 0..top whose blocks above `forkPoint` the node replaced, against a
// node whose tip is passed to verifyReorg. `atHalt` records how many blocks were gone
// when the halt marker was written; `persists` decides whether that write reads back.
// The node held every stored block, so it reports each one above its tip or fork
// point with getblockheader confirmations -1.
function forkedDecoder({ top = 300, forkPoint, nodeTip = top + 1, priorDepth = 0, persists = true, nodeHash } = {}){
    const decoder = makeDecoder()
    const deleted = []
    const atHalt = []
    let halted = false
    decoder.connector = {
        rpcErrors: 0,
        getBlockHash: nodeHash || (async (h) => {
            if (h > nodeTip) throw new Error('Block height out of range')
            return h > forkPoint ? 'node' + h : 'hash' + h
        }),
        getBlockHeader: async (hash) => ({ confirmations: Number(hash.slice(4)) > forkPoint ? -1 : 1 })
    }
    decoder.db = {
        getLastBlockIndex:         async () => top,
        getBlockByIndex:           async (h) => (h < 0 || h > top ? null : { block_index: h, block_hash: 'hash' + h }),
        deleteBlockByIndex:        async (h) => { deleted.push(h); top = h - 1; return true },
        isReorgHalted:             async () => halted,
        countReorgDeletesAboveTip: async () => priorDepth,
        markReorgHalted:           async () => { atHalt.push(deleted.length); halted = persists; return persists }
    }
    return { decoder, deleted, atHalt, tip: () => top }
}

describe('F1: a halt that rolled blocks back names the reset, not the clear', function () {
    it('the clear tool help says which halts it cannot clear and names the reset', async function () {
        const out = []
        assert.strictEqual(await runClearTool({ db: {}, argv: ['--help'], log: (l) => out.push(l) }), 0)
        assert.match(out.join('\n'), RESET)
        assert.match(out.join('\n'), /--force\s+cannot override/)
    })

    it('the safe-depth halt names the reset and says the clear refuses it', async function () {
        const { decoder } = forkedDecoder({ forkPoint: 0, priorDepth: SAFE_DEPTH })
        await assert.rejects(() => decoder.verifyReorg(299), (err) => {
            assert.match(err.message, RESET)
            assert.match(err.message, /clear-reorg-halt refuses this halt/)
            assert.doesNotMatch(err.message, /full resync from a known-good snapshot/)
            return true
        })
    })

    it('the park line for a halt with rolled-back blocks above the tip names the reset and promises no resume', async function () {
        const decoder = makeDecoder()
        const lines = []
        decoder.logError = (l) => lines.push(l)
        decoder.db = { getLastBlockIndex: async () => 50, getLastTxIndex: async () => 7, countReorgDeletesAboveTip: async () => 5 }
        const err = new Error('verifyReorg: decoder is HALTED'); err.reorgHalt = true
        await parkOrRethrow.call(decoder, err, { lastProcessedBlockIndex: 60 })
        assert.match(lines[0], RESET)
        assert.doesNotMatch(lines[0], /resumes parsing on its own/)
    })
})

describe('F2: an above-tip rollback is decided by fork depth, not the height gap', function () {
    it('a fork under a gap past the window halts durably before the first delete', async function () {
        const { decoder, deleted, atHalt, tip } = forkedDecoder({ forkPoint: 160, nodeTip: 170 })
        await assert.rejects(() => decoder.verifyReorg(170), (err) => {
            assert.strictEqual(err.reorgHalt, true, 'a proven fork past the window is a halt, never a wait')
            assert.notStrictEqual(err.tipBelowStoredTip, true)
            return true
        })
        assert.deepStrictEqual(atHalt, [0], 'nothing is spent on the window first')
        assert.strictEqual(tip(), 160, 'then the halted walk rolls back to the fork point')
        assert.strictEqual(deleted.length, 140)
    })

    it('a gap of exactly the window with a fork under it halts instead of deleting 126 blocks first', async function () {
        const { decoder, atHalt, tip } = forkedDecoder({ forkPoint: 170, nodeTip: 300 - SAFE_DEPTH })
        await assert.rejects(() => decoder.verifyReorg(300 - SAFE_DEPTH), /dispenser safe-depth window/)
        assert.deepStrictEqual(atHalt, [SAFE_DEPTH])
        assert.strictEqual(tip(), 170)
    })

    it('confirmations -1 proves the reorg without a chain-work comparison', async function () {
        const { decoder, deleted, atHalt } = forkedDecoder({ forkPoint: 160, nodeTip: 170 })
        await assert.rejects(() => decoder.verifyReorg(170), (err) => {
            assert.strictEqual(err.reorgHalt, true)
            return true
        })
        assert.strictEqual(deleted.length, 140)
        assert.deepStrictEqual(atHalt, [0])
    })

    it('a gap of exactly the window with confirmed reorged blocks rolls back and completes', async function () {
        const nodeTip = 300 - SAFE_DEPTH
        const { decoder, deleted, atHalt } = forkedDecoder({ top: 299, forkPoint: nodeTip - 1, nodeTip })
        assert.strictEqual(await decoder.verifyReorg(300 - SAFE_DEPTH), true)
        assert.strictEqual(deleted.length, SAFE_DEPTH)
        assert.deepStrictEqual(atHalt, [])
    })

    it('a not-found stored tip waits even when the height gap fits the window', async function () {
        const { decoder, deleted, atHalt } = forkedDecoder({ top: 20, forkPoint: 18, nodeTip: 19 })
        decoder.connector.getBlockHeader = async () => {
            const err = new Error('Block not found')
            err.rpcCode = -5
            throw err
        }
        await assert.rejects(() => decoder.verifyReorg(19), (err) => {
            assert.strictEqual(err.reorgWait, true)
            assert.strictEqual(err.refusalClass, 'unproven-fork')
            assert.match(err.message, /waiting without deleting stored block 19/)
            return true
        })
        assert.deepStrictEqual(deleted, [])
        assert.deepStrictEqual(atHalt, [])
    })
})

describe('F3: a halted database serves nothing above the fork point', function () {
    it('with the marker confirmed, the halted walk rolls back to the fork point', async function () {
        const { decoder, atHalt, tip } = forkedDecoder({ top: 10000, forkPoint: 10000 - SAFE_DEPTH - 74 })
        await assert.rejects(() => decoder.verifyReorg(10001), /dispenser safe-depth window/)
        assert.deepStrictEqual(atHalt, [SAFE_DEPTH], 'the ceiling still decides when the halt is written')
        assert.strictEqual(tip(), 10000 - SAFE_DEPTH - 74)
    })

    it('without a confirmed marker, the walk stops at the ceiling as before', async function () {
        const { decoder, deleted, tip } = forkedDecoder({ top: 10000, forkPoint: 10000 - SAFE_DEPTH - 74, persists: false })
        await assert.rejects(() => decoder.verifyReorg(10001), /dispenser safe-depth window/)
        assert.strictEqual(deleted.length, SAFE_DEPTH)
        assert.ok(tip() > 10000 - SAFE_DEPTH - 74)
    })
})

// A decoder whose start() reaches the parse loop, with the node at `nodeTip`. The
// sleep stub is the stop switch; fetchBlockHex records any attempt to parse forward.
function bootingDecoder({ nodeTip, db }){
    const decoder = makeDecoder()
    let sleeps = 0
    const fetched = []
    decoder.sleep = async () => { if (++sleeps >= 6) decoder.stopFlag = true }
    decoder.connector = {
        rpcErrors: 0,
        getBlockchainInfo: async () => ({ blocks: nodeTip, headers: nodeTip, verificationprogress: 1, initialblockdownload: false }),
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => ''
    }
    decoder.fetchBlockHex = async (hash, height) => { fetched.push(height); throw new Error('test: stop before parsing') }
    decoder.db = Object.assign({
        createDatabase: async () => true, verifyDatabase: async () => true, verifyTables: async () => true,
        runMigrations: async () => ({ applied: [], pending: [] }), getLastBlockIndex: async () => 100,
        getLastTxIndex: async () => 0, endTransaction: async () => {}, ping: async () => true
    }, db)
    return { decoder, fetched }
}

describe('F3: a restart does not parse forward on a halt that rolled blocks back', function () {
    it('parks before the first block when a live halt has rolled-back blocks above the tip', async function () {
        const { decoder, fetched } = bootingDecoder({ nodeTip: 150, db: {
            isReorgHalted: async () => true, countReorgDeletesAboveTip: async () => 140 } })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.strictEqual(decoder.getReorgHaltStatus().parked_height, 100)
        assert.deepStrictEqual(fetched, [], 'not one block fetched on a condemned database')
    })

    it('parses forward on a live halt with nothing rolled back above the tip', async function () {
        const { decoder, fetched } = bootingDecoder({ nodeTip: 150, db: {
            isReorgHalted: async () => true, countReorgDeletesAboveTip: async () => 0 } })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, false)
        assert.ok(fetched.includes(101))
    })
})

describe('F4: the park height and the latent-marker line say what is true', function () {
    it('parks at the stored tip after the rollback, not the cursor from before it', async function () {
        const decoder = makeDecoder()
        decoder.logError = () => {}
        decoder.db = { getLastBlockIndex: async () => 73, getLastTxIndex: async () => 24 }
        const err = new Error('halt'); err.reorgHalt = true; err.resetOnly = true
        const loop = { lastProcessedBlockIndex: 199, lastProcessedTxIndex: 66 }
        await parkOrRethrow.call(decoder, err, loop)
        assert.strictEqual(decoder.getReorgHaltStatus().parked_height, 73)
        assert.strictEqual(loop.lastProcessedBlockIndex, 73)
        assert.strictEqual(loop.lastProcessedTxIndex, 24)
    })

    it('the safe-depth park through start() lands at the fork point', async function () {
        let halted = false
        let tip = 100
        const { decoder } = bootingDecoder({ nodeTip: 90, db: {
            isReorgHalted: async () => halted, countReorgDeletesAboveTip: async () => SAFE_DEPTH,
            getLastBlockIndex: async () => tip, getBlockByIndex: async (h) => ({ block_index: h, block_hash: 'hash' + h }),
            deleteBlockByIndex: async (h) => { tip = h - 1; return true },
            markReorgHalted: async () => { halted = true; return true } } })
        decoder.connector.getBlockHash = async (h) => (h <= 80 ? 'hash' + h : 'node' + h)
        decoder.connector.getBlockHeader = async (hash) => ({ confirmations: Number(hash.slice(4)) > 80 ? -1 : 1 })
        decoder.connector.getBlockchainInfo = async () => ({ blocks: 90, headers: 90, verificationprogress: 1, initialblockdownload: false })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.strictEqual(tip, 80)
        assert.strictEqual(decoder.getReorgHaltStatus().parked_height, 80)
    })

    it('the latent-marker line does not call a halted decoder healthy, and names the reset', async function () {
        const logged = []
        const constants = require('../../../src/XChainDecoder/constants.js')
        const original = constants.logger.error
        constants.logger.error = (l) => logged.push(String(l))
        try {
            const decoder = makeDecoder()
            decoder.db = { getReorgHaltMarker: async () => ({ halted: true, at: null, reason: 'r' }) }
            await decoder.checkReorgHalt({ force: true })
        } finally {
            constants.logger.error = original
        }
        const line = logged.find((l) => /LATENT REORG_HALT MARKER PRESENT/.test(l))
        assert.ok(line, 'the transition logs the latent marker')
        assert.doesNotMatch(line, /look healthy/)
        assert.match(line, /reorg_halted=true/)
        assert.match(line, RESET)
    })
})
