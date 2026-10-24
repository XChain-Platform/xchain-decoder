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
 * test/unit/reorg_recovery.test/02_halted_walk_hostile_node.test.js
 *
 * Verify that a halted rollback requires stable node evidence and never crosses
 * the fork point, while unreadable durable state keeps the parse loop parked.
 */

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')
const { DISPENSER_EXPIRE_SAFE_DEPTH } = XChainDecoder
const { parkOrRethrow } = require('../../../src/XChainDecoder/sync_loop.js')

const SAFE_DEPTH = DISPENSER_EXPIRE_SAFE_DEPTH
const TOP = 300

function makeDecoder(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    decoder.verifyChainGenesis = async () => null
    return decoder
}

// Stored chain 0..TOP with hashes 'hash<h>'. The honest node holds the same blocks
// up to forkPoint and its own 'node<h>' above it, with its tip at nodeTip. `hostile`
// sees every getBlockHash call with the honest answer and whether the durable marker
// stands yet; it returns a replacement hash, 'ERR' to fail the call, or null. The
// node held every stored block: getblockheader reports one at or below both the fork
// point and its tip on its active chain, and every other one off it (-1).
function hostileDecoder({ forkPoint, nodeTip = TOP, hostile = null, lowTipAfterError = null, priorDepth = 0 }){
    const decoder = makeDecoder()
    const deleted = []
    let top = TOP
    let halted = false
    let failedOnce = false
    const tipNow = () => (failedOnce && lowTipAfterError !== null) ? lowTipAfterError : nodeTip
    decoder.connector = {
        rpcErrors: 0,
        getBlockHash: async (h) => {
            const honest = h > nodeTip ? null : (h > forkPoint ? 'node' + h : 'hash' + h)
            const swap = hostile ? hostile(h, honest, halted) : null
            if (swap === 'ERR' || honest === null){ failedOnce = true; throw new Error('connect ECONNREFUSED') }
            return swap || honest
        },
        getBlockHeader: async (hash) => {
            const h = Number(hash.slice(4))
            return { confirmations: h <= Math.min(forkPoint, nodeTip) ? nodeTip - h + 1 : -1 }
        },
        getBlockchainInfo: async () => ({ chain: 'regtest', blocks: tipNow(), headers: nodeTip, verificationprogress: 1, initialblockdownload: false })
    }
    decoder.db = {
        getLastBlockIndex:         async () => top,
        getBlockByIndex:           async (h) => (h < 0 || h > top ? null : { block_index: h, block_hash: 'hash' + h }),
        deleteBlockByIndex:        async (h) => { deleted.push(h); top = h - 1; return true },
        isReorgHalted:             async () => halted,
        countReorgDeletesAboveTip: async () => priorDepth,
        markReorgHalted:           async () => { halted = true; return true }
    }
    // Heights the node still holds on its own chain: at or below the fork point,
    // and at or below its tip.
    const validDeleted = () => deleted.filter((h) => h <= Math.min(forkPoint, nodeTip))
    return { decoder, deleted, validDeleted, tip: () => top, halted: () => halted }
}

// A fork 127 deep under a node at the same height: the walk spends the window on
// 300..175 and halts at the ceiling with 174, the last abandoned block, still stored.
const DEEP_FORK = TOP - SAFE_DEPTH - 1

describe('a halted walk stops on a node that lies or drops out after the marker', function () {
    it('one wrong hash after the marker stops the walk, deleting no valid block', async function () {
        let lies = 1
        const { decoder, validDeleted, tip, halted } = hostileDecoder({ forkPoint: DEEP_FORK,
            hostile: (h, honest, isHalted) => (isHalted && lies >= 1) ? (lies--, 'fake' + h) : null })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.strictEqual(halted(), true)
        assert.deepStrictEqual(validDeleted(), [], 'no block the node still holds is deleted')
        assert.ok(tip() >= DEEP_FORK, 'the walk never passes the fork point')
    })

    it('a node answering a wrong hash for every height deletes nothing past the halt', async function () {
        const { decoder, deleted, validDeleted, tip } = hostileDecoder({ forkPoint: DEEP_FORK,
            hostile: (h, honest, isHalted) => isHalted ? 'fake' + h : null })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.deepStrictEqual(validDeleted(), [])
        assert.strictEqual(deleted.length, SAFE_DEPTH, 'the window the halt spent, and no block after it')
        assert.strictEqual(tip(), DEEP_FORK + 1)
    })

    it('alternating wrong and right hashes stop the walk', async function () {
        let k = 0
        const { decoder, validDeleted, tip } = hostileDecoder({ forkPoint: DEEP_FORK,
            hostile: (h, honest, isHalted) => (isHalted && (k++ % 2 === 0)) ? 'fake' + h : null })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.deepStrictEqual(validDeleted(), [])
        assert.ok(tip() >= DEEP_FORK)
    })

    it('a failed read then a lower node tip after the marker deletes nothing below the fork', async function () {
        let armed = false
        const { decoder, validDeleted, tip } = hostileDecoder({ forkPoint: DEEP_FORK, lowTipAfterError: 40,
            hostile: (h, honest, isHalted) => (isHalted && !armed) ? (armed = true, 'ERR') : null })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.deepStrictEqual(validDeleted(), [], 'a tip below the one the walk halted on is never taken')
        assert.ok(tip() >= DEEP_FORK)
    })

    it('an honest fork deeper than two windows deletes nothing past the halt', async function () {
        // The finish may spend one more window and no more: with the fork point 260
        // below the stored tip, no fork point is found within it and the walk stops.
        const { decoder, deleted, tip } = hostileDecoder({ forkPoint: TOP - 260 })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.strictEqual(deleted.length, SAFE_DEPTH, 'the window the halt spent, and no block after it')
        assert.strictEqual(tip(), TOP - SAFE_DEPTH)
    })
})

describe('a halted walk ends at the fork point the node shows, and no lower', function () {
    it('a false node-tip hash cannot halt while the stored block remains active', async function () {
        const behind = TOP - SAFE_DEPTH - 1
        let lies = 2
        const { decoder, deleted, halted } = hostileDecoder({ forkPoint: 1000, nodeTip: behind,
            hostile: (h) => (h === behind && lies >= 1) ? (lies--, 'fake' + h) : null })
        await assert.rejects(() => decoder.verifyReorg(behind), (err) => {
            assert.strictEqual(err.reorgWait, true)
            assert.strictEqual(err.refusalClass, 'same-chain')
            return true
        })
        assert.strictEqual(halted(), false)
        assert.deepStrictEqual(deleted, [])
    })

    it('a node that holds the stored block at its tip keeps every stored block above it', async function () {
        // Halted on entry by the depth already rolled back, against a node 5 behind on
        // the same chain that even reports the 5 stored blocks above its tip off its
        // active chain, on more work: the fork point is the node tip, so nothing above it goes.
        const { decoder, deleted, halted } = hostileDecoder({ forkPoint: 1000, nodeTip: TOP - 5, priorDepth: SAFE_DEPTH })
        await assert.rejects(() => decoder.verifyReorg(TOP - 5), (err) => err.refusalClass === 'node_behind')
        assert.strictEqual(halted(), false)
        assert.deepStrictEqual(deleted, [])
    })

    it('one wrong hash at the fork point itself stops the walk instead of deleting it', async function () {
        // A single stray answer at the one height that decides where the rollback
        // ends: the second, separate reading disagrees, so the walk stops.
        let lies = 1
        const { decoder, validDeleted, tip } = hostileDecoder({ forkPoint: DEEP_FORK,
            hostile: (h, honest, isHalted) => (isHalted && h === DEEP_FORK && lies >= 1) ? (lies--, 'fake' + h) : null })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.deepStrictEqual(validDeleted(), [])
        assert.strictEqual(tip(), DEEP_FORK + 1, 'nothing past the halt, with the fork point unconfirmed')
    })

    it('the honest deep fork still finishes at the fork point', async function () {
        const { decoder, validDeleted, tip } = hostileDecoder({ forkPoint: DEEP_FORK })
        await assert.rejects(() => decoder.verifyReorg(TOP), /dispenser safe-depth window/)
        assert.deepStrictEqual(validDeleted(), [])
        assert.strictEqual(tip(), DEEP_FORK)
    })
})

// A decoder whose start() reaches the parse loop over a stored tip of 100 and a node
// at 150. fetchBlockHex records any attempt to parse forward, and `onSleep` runs on
// each loop sleep, which is also the stop switch.
function bootingDecoder({ db, onSleep = null, maxSleeps = 6 }){
    const decoder = makeDecoder()
    let sleeps = 0
    const fetched = []
    decoder.sleep = async () => {
        sleeps++
        if (onSleep) await onSleep(sleeps, decoder)
        if (sleeps >= maxSleeps) decoder.stopFlag = true
    }
    decoder.connector = {
        rpcErrors: 0,
        getBlockchainInfo: async () => ({ blocks: 150, verificationprogress: 1, initialblockdownload: false }),
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

// A marker probe that throws on its first `faults` reads, then answers `marker`.
function faultyMarker(faults, marker){
    let left = faults
    return async () => {
        if (left >= 1){ left--; throw new Error('harness: injected read fault') }
        return marker
    }
}

describe('a boot that cannot read the halt marker parks instead of parsing', function () {
    it('one read fault on the boot probe of a halted database parses nothing', async function () {
        const { decoder, fetched } = bootingDecoder({ db: {
            getReorgHaltMarker: faultyMarker(1, { halted: true, at: null, reason: 'depth 127' }),
            isReorgHalted: async () => true, countReorgDeletesAboveTip: async () => 126 } })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.strictEqual(decoder.reorgHalted, true, 'the re-read found the halt')
        assert.deepStrictEqual(fetched, [], 'not one block fetched on a database that may be condemned')
    })

    it('stays parked while the probe keeps failing', async function () {
        let reads = 0
        const failing = faultyMarker(1000, null)
        const { decoder, fetched } = bootingDecoder({ db: {
            getReorgHaltMarker: () => { reads++; return failing() }, countReorgDeletesAboveTip: async () => 0 } })
        await decoder.start()
        assert.ok(reads >= 2, 'the park re-read the marker after the boot probe and that read failed too')
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.deepStrictEqual(fetched, [])
    })

    it('resumes on its own once the marker reads with no halt', async function () {
        const { decoder, fetched } = bootingDecoder({ db: {
            getReorgHaltMarker: faultyMarker(1, { halted: false, at: null, reason: null }),
            countReorgDeletesAboveTip: async () => 0 } })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, false)
        assert.ok(fetched.includes(101), 'parsing resumed after the marker read clean')
    })

    it('a probe that answers with nothing parks too', async function () {
        const { decoder, fetched } = bootingDecoder({ db: {
            getReorgHaltMarker: async () => null, countReorgDeletesAboveTip: async () => 0 } })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.deepStrictEqual(fetched, [])
    })

    it('parks the loop when a later probe first sees a halt with rolled-back blocks above the tip', async function () {
        let marker = { halted: false, at: null, reason: null }
        const { decoder, fetched } = bootingDecoder({ maxSleeps: 8,
            db: { getReorgHaltMarker: async () => marker, countReorgDeletesAboveTip: async () => 126 },
            onSleep: async (n, d) => {
                if (n === 2){
                    marker = { halted: true, at: null, reason: 'restored from a halted snapshot' }
                    await d.checkReorgHalt({ force: true })
                }
            } })
        await decoder.start()
        const before = fetched.length
        assert.ok(before >= 1, 'it parsed while no halt was known')
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.ok(fetched.length <= 2, 'and stopped once the probe saw the halt')
    })
})

describe('the park line names the height it knows', function () {
    it('on an emptied table it names the stored tip and the start height, not "unknown"', async function () {
        const decoder = makeDecoder()
        const lines = []
        decoder.logError = (l) => lines.push(String(l))
        decoder.db = { getLastBlockIndex: async () => -1, getLastTxIndex: async () => 0 }
        const err = new Error('halt'); err.reorgHalt = true; err.resetOnly = true
        await parkOrRethrow.call(decoder, err, { lastProcessedBlockIndex: 199, lastProcessedTxIndex: 66 })
        const park = lines.find((l) => /PARKED on a REORG_HALT/.test(l))
        assert.ok(park)
        assert.doesNotMatch(park, /block height unknown/)
        assert.match(park, /block height -1 \(no block is stored, so parsing would resume at the start height 0\)/)
    })
})
