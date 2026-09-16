// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')

// verifyReorg froze the node tip at call time, so a mid-walk tip
// regression (node restart onto a shorter chain / second reorg) made the stuck
// height fall through to getBlockHash, which throws "Block height out of range",
// and the transient catch retried the same height forever. The catch now best-
// effort re-reads the tip so the above-tip delete branch drains the orphans.

// The mid-walk tip refresh is the SECOND path a node tip reaches nodeTip, and
// nodeTip is exactly what the above-tip branch deletes valid local blocks against.
// The tier gate alone cannot separate a same-tier foreign chain (BTC-mainnet and
// DOGE-mainnet both report chain="main") from ours, so on a NODE_URL_FALLBACK
// failover onto a same-tier foreign endpoint the refresh must also re-prove chain
// identity with the block-0 pin, exactly as the block loop does, before it trusts
// the refreshed tip. Otherwise it accepts the foreign height and deletes valid
// local blocks against another chain's tip.

// Our pinned block-0 hash (real BTC mainnet genesis, used only as a sample value).
const OUR_GENESIS     = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
// A same-tier foreign chain's block-0 hash (Dogecoin mainnet), the case the tier
// gate cannot refuse because it too reports chain="main".
const FOREIGN_GENESIS = '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691'

describe('XChainDecoder.verifyReorg mid-walk tip regression', function () {
  this.timeout(0)

  it('refreshes nodeTip on out-of-range so a regressed tip self-heals instead of wedging', async function () {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    // DB stores 100..105; the node reports tip 105 at call time (call-time nodeTip), but
    // the tip regresses to 102 mid-walk. Blocks 103,104,105 sit above the live tip and
    // must be deleted via the above-tip branch; 102 and below still hash-match.
    const REGRESSED_TIP = 102
    let top = 105
    const deleted = []
    const dbHash = { 105: 'db105', 104: 'db104', 103: 'db103', 102: 'match102', 101: 'match101', 100: 'match100' }
    decoder.connector = {
      // Live node: any height above the regressed tip is out of range.
      getBlockHash: async (h) => {
        if (h > REGRESSED_TIP) throw new Error('Block height out of range')
        return 'match' + h
      },
      getBlockchainInfo: async () => ({ blocks: REGRESSED_TIP })
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => ({ block_hash: dbHash[h] }),
      deleteBlockByIndex: async (h) => { deleted.push(h); top = h - 1 },
      insertEvent: async () => true,
      isReorgHalted: async () => false,
      markReorgHalted: async () => {}
    }

    // Called with the STALE higher tip (105). Without the refresh, height 105 is not
    // above nodeTip=105, getBlockHash(105) throws out-of-range, and the walk spins
    // forever. With the refresh it re-reads tip=102 and drains 103,104,105.
    const result = await decoder.verifyReorg(105)
    assert.strictEqual(result, true)
    assert.deepStrictEqual(deleted, [105, 104, 103],
      'blocks above the regressed tip are deleted via the above-tip branch after the tip refresh')
  })
})

describe('XChainDecoder.verifyReorg mid-walk tip regression', function () {
  this.timeout(0)

  it('refuses a same-tier foreign endpoint tip refresh (genesis pin mismatch) and deletes no local blocks', async function () {
    const decoder = new XChainDecoder(
      'bitcoin-mainnet', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.chainGenesisHash = OUR_GENESIS

    // DB stores 100..105; call-time tip is 105. The endpoint answering the mid-walk
    // refresh is a SAME-TIER FOREIGN chain: it reports chain="main" (passes the tier
    // gate) and blocks=102, but its block 0 is a different chain's genesis. If that
    // foreign tip were accepted, 103,104,105 would look above-tip and be deleted.
    let top = 105
    const deleted = []
    let genesisReads = 0
    let sleeps = 0
    decoder.sleep = async () => {
      // The refusal correctly leaves the walk stuck (it will not delete against a
      // foreign tip and will not accept the foreign height). Break out deterministically
      // after a few refusals by exhausting the table, then assert nothing was deleted.
      if (++sleeps >= 3) { top = -1 }
    }
    decoder.connector = {
      getBlockHash: async (h) => {
        if (h === 0) { genesisReads++; return FOREIGN_GENESIS }
        if (h > 102) throw new Error('Block height out of range')
        return 'match' + h
      },
      getBlockchainInfo: async () => ({ blocks: 102, chain: 'main' })
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => (h < 0 ? null : { block_hash: 'db' + h }),
      deleteBlockByIndex: async (h) => { deleted.push(h); top = h - 1 },
      insertEvent: async () => true,
      isReorgHalted: async () => false,
      markReorgHalted: async () => {}
    }

    const result = await decoder.verifyReorg(105)
    assert.strictEqual(result, true)
    assert.deepStrictEqual(deleted, [],
      'a same-tier foreign endpoint tip must never drive deleteBlockByIndex over valid local blocks')
    assert.ok(genesisReads >= 1, 'the tip refresh must re-prove chain identity via the block-0 pin')
    assert.strictEqual(decoder.chainGenesisCheckedAt, 0,
      'a refused foreign endpoint must not count as a verified check')
  })
})

describe('XChainDecoder.verifyReorg mid-walk tip regression', function () {
  this.timeout(0)

  it('still accepts the refreshed tip when block 0 agrees, so the self-heal happy path is unchanged', async function () {
    const decoder = new XChainDecoder(
      'bitcoin-mainnet', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.chainGenesisHash = OUR_GENESIS
    decoder.sleep = async () => {}

    // Identical shape to the refusal case, but the refreshing endpoint is OURS: its
    // block 0 matches the pin, so the regressed tip (102) is accepted and the orphan
    // blocks above it (103,104,105) drain via the above-tip branch, exactly as before
    // the genesis gate was added.
    const REGRESSED_TIP = 102
    let top = 105
    const deleted = []
    const dbHash = { 105: 'db105', 104: 'db104', 103: 'db103', 102: 'match102', 101: 'match101', 100: 'match100' }
    decoder.connector = {
      getBlockHash: async (h) => {
        if (h === 0) return OUR_GENESIS
        if (h > REGRESSED_TIP) throw new Error('Block height out of range')
        return 'match' + h
      },
      getBlockchainInfo: async () => ({ blocks: REGRESSED_TIP, chain: 'main' })
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => ({ block_hash: dbHash[h] }),
      deleteBlockByIndex: async (h) => { deleted.push(h); top = h - 1 },
      insertEvent: async () => true,
      isReorgHalted: async () => false,
      markReorgHalted: async () => {}
    }

    const result = await decoder.verifyReorg(105)
    assert.strictEqual(result, true)
    assert.deepStrictEqual(deleted, [105, 104, 103],
      'an agreeing endpoint still self-heals a regressed tip via the above-tip branch')
  })
})

describe('XChainDecoder.verifyReorg mid-walk tip regression', function () {
  this.timeout(0)

  it('keeps retrying (does not crash) when the node is fully unreachable', async function () {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    let sleeps = 0
    decoder.sleep = async () => {
      // Break the intentional retry-forever loop after a few passes to prove the
      // catch tolerates a fully-down node (both getBlockHash and getBlockchainInfo
      // failing) exactly as before, then stop the test deterministically.
      if (++sleeps >= 3) { top = -1 } // exhaust the table so the walk terminates
    }
    let top = 100
    decoder.connector = {
      getBlockHash: async () => { throw new Error('ECONNREFUSED') },
      getBlockchainInfo: async () => { throw new Error('ECONNREFUSED') }
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => (h < 0 ? null : { block_hash: 'db' + h }),
      deleteBlockByIndex: async () => { throw new Error('should not delete while node is down') },
      insertEvent: async () => true,
      isReorgHalted: async () => false,
      markReorgHalted: async () => {}
    }
    // nodeTip null (legacy caller): the out-of-range path is not taken; getBlockHash
    // simply errors, the catch best-effort-refreshes (also fails), sleeps, retries.
    const result = await decoder.verifyReorg()
    assert.strictEqual(result, true)
    assert.ok(sleeps >= 3, 'retries through the node outage instead of crashing')
  })
})
