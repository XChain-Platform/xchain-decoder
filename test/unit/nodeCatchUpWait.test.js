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
 * A node tip below the stored tip is not always a rollback.
 *
 * Measured on an operator's fresh BTC mainnet node (2026-09-07): the node was
 * still in initial block download at 962304 while the decoder held 964970. The
 * tip-regression branch called it orphans, verifyReorg deleted 126 valid blocks
 * to the safe-depth ceiling, wrote the durable REORG_HALT and the container
 * crash-looped 279 times, over a reorg that never happened. Two guards close it:
 *
 *  1. the parse loop reads initialblockdownload from the reply it already holds
 *     and WAITS while it is true, instead of reconciling;
 *  2. verifyReorg's above-tip branch, which knows its depth before the first
 *     delete, refuses up front when that depth cannot fit the window, with
 *     nothing deleted and no durable halt (nothing was lost).
 */

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')
const XChainDecoder = require('../../src/XChainDecoder')
const { nodeStillCatchingUp, DISPENSER_EXPIRE_SAFE_DEPTH } = XChainDecoder

const SAFE_DEPTH = DISPENSER_EXPIRE_SAFE_DEPTH

function makeDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    return decoder
}

// Stored tip at `top`; the node agrees with every stored hash, so once the walk
// reaches the node tip it ends. `priorDepth` is what a previous process already
// rolled back above the tip (the restart-durable count).
function decoderAbove(top, { priorDepth = 0 } = {}) {
    const decoder = makeDecoder()
    const deleted = []
    let marked = 0
    decoder.connector = { rpcErrors: 0, getBlockHash: async (h) => 'hash' + h }
    decoder.db = {
        getLastBlockIndex:         async () => top,
        getBlockByIndex:           async (h) => (h < 0 ? null : { block_index: h, block_hash: 'hash' + h }),
        deleteBlockByIndex:        async (h) => { deleted.push(h); top = h - 1; return true },
        isReorgHalted:             async () => false,
        countReorgDeletesAboveTip: async () => priorDepth,
        markReorgHalted:           async () => { marked++; return true }
    }
    return { decoder, deleted, marked: () => marked }
}

describe('nodeStillCatchingUp(): the IBD read off getblockchaininfo', function () {
    it('is true only for a literal initialblockdownload=true', function () {
        assert.strictEqual(nodeStillCatchingUp({ initialblockdownload: true }), true)
        assert.strictEqual(nodeStillCatchingUp({ initialblockdownload: false }), false)
    })

    it('fails open on an absent, null or non-boolean field (older node, trimmed proxy)', function () {
        assert.strictEqual(nodeStillCatchingUp({ blocks: 10 }), false)
        assert.strictEqual(nodeStillCatchingUp({ initialblockdownload: null }), false)
        assert.strictEqual(nodeStillCatchingUp({ initialblockdownload: 'true' }), false)
        assert.strictEqual(nodeStillCatchingUp({ initialblockdownload: 1 }), false)
        assert.strictEqual(nodeStillCatchingUp(null), false)
        assert.strictEqual(nodeStillCatchingUp(undefined), false)
    })
})

describe('verifyReorg: an above-tip gap the window cannot absorb is refused before the first delete', function () {

    it('deletes nothing and writes no halt when the known depth alone exceeds the ceiling', async function () {
        const { decoder, deleted, marked } = decoderAbove(300)

        await assert.rejects(() => decoder.verifyReorg(300 - SAFE_DEPTH - 1), (err) => {
            assert.strictEqual(err.tipBelowStoredTip, true, 'tagged so the parse loop can wait on it')
            assert.match(err.message, /127 blocks below the stored tip/)
            assert.match(err.message, /no REORG_HALT marker was written/)
            assert.match(err.message, /needs no resync/)
            return true
        })

        assert.strictEqual(deleted.length, 0, 'the whole point: not one block before the refusal')
        assert.strictEqual(marked(), 0, 'no durable halt: nothing was rolled back')
        assert.strictEqual(decoder.getReorgHaltStatus().halted, false)
    })

    it('a gap of exactly the ceiling still reconciles (the ceiling is a budget, not a fence)', async function () {
        const { decoder, deleted } = decoderAbove(300)

        assert.strictEqual(await decoder.verifyReorg(300 - SAFE_DEPTH), true)
        assert.strictEqual(deleted.length, SAFE_DEPTH)
        assert.strictEqual(decoder.getReorgHaltStatus().halted, false)
    })

    it('counts what a previous process already rolled back toward the refusal', async function () {
        // 10 above the tip would fit a fresh window; it does not fit the 120 a
        // killed process already spent, and a restart must not delete the 6 that
        // remain just to abort on the 7th.
        const { decoder, deleted } = decoderAbove(300, { priorDepth: SAFE_DEPTH - 6 })

        await assert.rejects(() => decoder.verifyReorg(290), (err) => {
            assert.strictEqual(err.tipBelowStoredTip, true)
            assert.match(err.message, /with 120 block\(s\) already rolled back/)
            return true
        })
        assert.strictEqual(deleted.length, 0)
    })

    it('a prior depth already AT the ceiling still takes the durable halt, not the refusal', async function () {
        // Blocks past the window are already gone from this database: that is the
        // halt's case, and the refusal must not soften it.
        const { decoder, deleted, marked } = decoderAbove(300, { priorDepth: SAFE_DEPTH })

        await assert.rejects(() => decoder.verifyReorg(299), /safe-depth/)
        assert.strictEqual(deleted.length, 0)
        assert.strictEqual(marked(), 1)
        assert.strictEqual(decoder.getReorgHaltStatus().halted, true)
    })
})

describe('the parse loop waits on a node in initial block download instead of reconciling', function () {
    const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'XChainDecoder.js'), 'utf8')

    // The branch under test needs a live node whose tip sits below the stored tip
    // and a full start() loop to reach, so this is a source-level drift guard in
    // the shape of chainIdentityGate.test.js: the IBD check has to sit between
    // the tip-regression detection and the verifyReorg call, and it has to wait.
    const branchStart = SRC.indexOf('is still behind the starting block')
    const reconcile   = SRC.indexOf('Reconciling orphan blocks...')

    it('the tip-regression branch exists in the order the guard relies on', function () {
        assert.ok(branchStart > 0 && reconcile > branchStart)
    })

    it('reads initialblockdownload off the reply it already holds, before the reconcile', function () {
        const between = SRC.slice(branchStart, reconcile)
        assert.ok(/nodeStillCatchingUp\(lastBlockchainInfo\)/.test(between),
            'the IBD check must precede the orphan reconcile in the tip-regression branch')
    })

    it('waits (sleep + continue) rather than calling verifyReorg while IBD is true', function () {
        const between = SRC.slice(branchStart, reconcile)
        const at = between.indexOf('nodeStillCatchingUp(lastBlockchainInfo)')
        const after = between.slice(at, at + 900)
        assert.ok(/await this\.sleep\(\d+\)/.test(after), 'the IBD branch must sleep')
        assert.ok(/continue/.test(after), 'the IBD branch must re-poll, not fall through')
        assert.ok(!/verifyReorg/.test(after), 'the IBD branch must never reconcile')
    })

    it('a pre-delete refusal from verifyReorg is waited on, not thrown out of the loop', function () {
        const after = SRC.slice(reconcile, reconcile + 2200)
        assert.ok(/err\.tipBelowStoredTip/.test(after),
            'the tip-regression call site must recognise the tagged refusal')
        const at = after.indexOf('err.tipBelowStoredTip')
        const handler = after.slice(at, at + 500)
        assert.ok(/await this\.sleep\(\d+\)/.test(handler) && /continue/.test(handler),
            'the refusal handler must sleep and re-poll the tip')
    })
})
