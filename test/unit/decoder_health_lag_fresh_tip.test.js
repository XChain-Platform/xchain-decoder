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
 * lag_blocks is cached node tip minus processed height. While the decoder
 * is far behind, a tip cached for the full 30 s window hid a burst of new
 * blocks and under-reported the gap to the bootstrap gate. The refresh
 * decision must re-read the tip on a short interval while behind, and make
 * no extra RPC when caught-up or fresh.
 */

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const startup = require('../../src/XChainDecoder/startup.js')
const { BLOCKCHAIN_INFO_REFRESH_MS, BLOCKCHAIN_INFO_BEHIND_REFRESH_MS } = require('../../src/XChainDecoder/constants.js')

// Minimal model of the loop: a fake node whose tip jumps, one RPC per refresh.
function simulate({ nodeTipAt, processed, cachedTip, refreshedAt, now }) {
    const decoder = { blockchainInfoLastBlock: cachedTip, chainTipRefreshDue: startup.chainTipRefreshDue }
    const loop = { lastBlockchainInfo: { blocks: cachedTip }, lastProcessedBlockIndex: processed, lastBlockchainInfoRefreshAt: refreshedAt }
    let rpcs = 0
    if (decoder.chainTipRefreshDue(loop, now)) {
        rpcs++
        decoder.blockchainInfoLastBlock = nodeTipAt
        loop.lastBlockchainInfoRefreshAt = now
    }
    return { lagBlocks: decoder.blockchainInfoLastBlock - processed, rpcs }
}

describe('decoder lag_blocks tracks the live node tip while behind', () => {
    it('refreshes a 2 s old cache when far behind, so lag equals the true gap', () => {
        const now = 1_000_000
        const r = simulate({ nodeTipAt: 148371, processed: 148281, cachedTip: 148288, refreshedAt: now - 2000, now })
        assert.strictEqual(r.rpcs, 1)
        assert.strictEqual(r.lagBlocks, 90)
        const big = simulate({ nodeTipAt: 148500, processed: 148281, cachedTip: 148288, refreshedAt: now - 2000, now })
        assert.ok(big.lagBlocks > 100)
        assert.ok(BLOCKCHAIN_INFO_BEHIND_REFRESH_MS < BLOCKCHAIN_INFO_REFRESH_MS)
    })

    it('makes no extra RPC while the cache is fresher than the behind interval', () => {
        const now = 1_000_000
        const r = simulate({ nodeTipAt: 999, processed: 100, cachedTip: 500, refreshedAt: now - 10, now })
        assert.strictEqual(r.rpcs, 0)
        assert.strictEqual(r.lagBlocks, 400)
    })

    it('still refreshes when caught up or with no info yet', () => {
        const now = 1_000_000
        assert.strictEqual(simulate({ nodeTipAt: 600, processed: 500, cachedTip: 500, refreshedAt: now, now }).rpcs, 1)
        const d = { blockchainInfoLastBlock: 0 }
        assert.strictEqual(startup.chainTipRefreshDue.call(d, { lastBlockchainInfo: null, lastProcessedBlockIndex: 0, lastBlockchainInfoRefreshAt: now }, now), true)
    })

    it('the sync loop uses the predicate', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/XChainDecoder/startup.js'), 'utf8')
        assert.ok(src.includes('this.chainTipRefreshDue(loop, Date.now())'))
    })
})
