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
const XChainDecoder = require('../../src/XChainDecoder')

// Regression test for the per-block retry budget in verifyReorg.
//
// Bug: retryCount was declared once before the block-deletion loop and shared
// across every block removed in a reorg. A multi-block reorg with a few transient
// deleteBlockByIndex failures per block could exhaust the 10-attempt budget
// collectively and abort before all orphan blocks were removed, leaving stale
// pre-reorg blocks in the decoder DB that the indexer would treat as valid chain.
//
// Fix: reset retryCount to 0 after each successful delete, so the 10-attempt
// limit is per-block rather than per-reorg-run.
describe('XChainDecoder.verifyReorg retry budget', function () {
  this.timeout(0)

  // Build a decoder with a stubbed db + connector modelling an orphan chain whose
  // top three blocks (102, 101, 100) disagree with the node and must be deleted;
  // height 99 matches the node and ends the backward walk. Each delete fails
  // `failuresPerBlock` times transiently before succeeding.
  function buildDecoder(failuresPerBlock) {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    let top = 102
    const dbHash   = { 102: 'db102', 101: 'db101', 100: 'db100', 99: 'match99' }
    const nodeHash = { 102: 'node102', 101: 'node101', 100: 'node100', 99: 'match99' }
    const failsLeft = { 102: failuresPerBlock, 101: failuresPerBlock, 100: failuresPerBlock }
    const deleted = []
    // Records the (block_index, block_hash) each deleteBlockByIndex call received. The REORG
    // marker is now written atomically inside deleteBlockByIndex, per block, so verifyReorg no
    // longer calls insertEvent once at the end (a crash mid-reorg used to lose the audit trail
    // entirely). Capturing the hash argument proves verifyReorg hands the durable-marker path
    // the right block hash for each deleted block.
    const deleteArgs = []

    decoder.connector = {
      getBlockHash: async (h) => nodeHash[h]
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => (dbHash[h] ? { block_hash: dbHash[h] } : null),
      deleteBlockByIndex: async (h, reorgBlockHash) => {
        if (failsLeft[h] > 0) { failsLeft[h]--; throw new Error('transient DB error') }
        deleted.push(h)
        deleteArgs.push({ block_index: h, block_hash: reorgBlockHash })
        top = h - 1
      },
      // Must never be called at end-of-run any more: a failure here would flag a
      // regression back to the non-crash-durable once-at-end event write.
      insertEvent: async () => { throw new Error('verifyReorg must not write a separate end-of-run REORG event') }
    }

    return { decoder, deleted, getDeleteArgs: () => deleteArgs }
  }

  it('resets the budget per block so a multi-block reorg with per-block transient failures removes every orphan block', async function () {
    // 3 orphan blocks × 4 transient failures = 12 total failures (> the 10-attempt
    // budget) but only 4 per block (< 10). Pre-fix the shared counter hit 10 mid-reorg
    // and aborted; post-fix each block gets its own budget and all three are deleted.
    const { decoder, deleted, getDeleteArgs } = buildDecoder(4)

    const result = await decoder.verifyReorg()

    assert.strictEqual(result, true)
    assert.deepStrictEqual(deleted, [102, 101, 100], 'all three orphan blocks should be deleted')
    // Each deleted block is handed its own block hash so deleteBlockByIndex can write the
    // REORG marker atomically with the delete (one durable marker per rolled-back block).
    assert.deepStrictEqual(getDeleteArgs(), [
      { block_index: 102, block_hash: 'db102' },
      { block_index: 101, block_hash: 'db101' },
      { block_index: 100, block_hash: 'db100' },
    ], 'each delete must carry its block hash for the atomic per-block REORG marker')
  })

  it('still aborts when a single block genuinely fails 10 times in a row', async function () {
    // The per-block reset must not turn the limit into infinite retry: one block
    // that fails 10 consecutive times must still trip the abort guard.
    const { decoder } = buildDecoder(10)
    await assert.rejects(() => decoder.verifyReorg(), /failed after 10 attempts/)
  })
})

// Fail-closed reorg-depth ceiling (parity with xchain-utxo-tracker's UNDO_BLOCKS
// guard): soft-expired dispensers are hard-purged once DISPENSER_EXPIRE_SAFE_DEPTH
// blocks deep, so rolling back past that window can no longer resurrect them and
// verifyReorg must abort loudly instead of silently diverging from a fresh sync.
describe('XChainDecoder.verifyReorg depth guard', function () {
  this.timeout(0)

  const SAFE_DEPTH = XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH

  // Decoder whose DB disagrees with the node for `divergentBlocks` blocks below
  // the tip; below that the hashes match and the backward walk stops.
  function buildDeepReorgDecoder(divergentBlocks) {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const TIP = 10000
    let top = TIP
    const deleted = []
    decoder.connector = {
      getBlockHash: async (h) => (h > TIP - divergentBlocks ? 'node' + h : 'match' + h)
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => ({ block_hash: h > TIP - divergentBlocks ? 'db' + h : 'match' + h }),
      deleteBlockByIndex: async (h) => { deleted.push(h); top = h - 1 },
      insertEvent: async () => { throw new Error('verifyReorg must not write a separate end-of-run REORG event') }
    }
    return { decoder, deleted }
  }

  it('completes a reorg one block shallower than the safe depth', async function () {
    const { decoder, deleted } = buildDeepReorgDecoder(SAFE_DEPTH - 1)
    assert.strictEqual(await decoder.verifyReorg(), true)
    assert.strictEqual(deleted.length, SAFE_DEPTH - 1)
  })

  it('aborts fail-closed once the walk reaches the safe depth instead of deleting past purged dispenser rows', async function () {
    const { decoder, deleted } = buildDeepReorgDecoder(SAFE_DEPTH + 20)
    await assert.rejects(() => decoder.verifyReorg(), /dispenser safe-depth window/)
    assert.strictEqual(deleted.length, SAFE_DEPTH,
      'must stop deleting exactly at DISPENSER_EXPIRE_SAFE_DEPTH blocks')
  })

  it('also guards the above-tip orphan branch', async function () {
    // Blocks stored above the node tip are deleted via a separate branch; a node
    // rollback deeper than the window must trip the same fail-closed abort.
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    let top = 10000
    const deleted = []
    decoder.connector = { getBlockHash: async (h) => 'match' + h }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => ({ block_hash: 'db' + h }),
      deleteBlockByIndex: async (h) => { deleted.push(h); top = h - 1 },
      insertEvent: async () => { throw new Error('no end-of-run REORG event') }
    }
    // Node tip far below the stored tip: every stored block above it is an orphan.
    await assert.rejects(() => decoder.verifyReorg(10000 - SAFE_DEPTH - 50), /dispenser safe-depth window/)
    assert.strictEqual(deleted.length, SAFE_DEPTH)
  })
})

// The safe-depth ceiling is a per-invocation counter, so before the durable-halt
// fix a process restart re-entered verifyReorg with a zeroed counter and silently
// completed an over-deep rollback past the dispenser purge window. A durable
// REORG_HALT marker (isReorgHalted/markReorgHalted) must survive the restart and
// make the second invocation refuse to delete anything further.
describe('XChainDecoder.verifyReorg durable halt (restart-mid-reorg)', function () {
  this.timeout(0)

  const SAFE_DEPTH = XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH

  // Shared, restart-surviving state: the persisted halt flag plus the DB block
  // store. A fresh decoder instance models a process restart (blocksDeleted resets)
  // while both `store` and `dbState` persist, exactly like the real DB across a
  // crash. Every DB block below the node tip disagrees, so the backward walk wants
  // to roll back the full `divergentBlocks` depth.
  function makeShared(divergentBlocks) {
    const TIP = 10000
    const store = { halted: false }
    const dbState = { top: TIP }
    const forkPoint = TIP - divergentBlocks
    return { TIP, store, dbState, forkPoint }
  }

  function buildDecoder(shared) {
    const { TIP, store, dbState, forkPoint } = shared
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const deleted = []
    decoder.connector = {
      getBlockHash: async (h) => (h > forkPoint ? 'node' + h : 'match' + h)
    }
    decoder.db = {
      getLastBlockIndex: async () => dbState.top,
      getBlockByIndex: async (h) => ({ block_hash: h > forkPoint ? 'db' + h : 'match' + h }),
      deleteBlockByIndex: async (h) => { deleted.push(h); dbState.top = h - 1 },
      insertEvent: async () => true,
      isReorgHalted: async () => store.halted,
      markReorgHalted: async () => { store.halted = true }
    }
    return { decoder, deleted }
  }

  it('halts durably on the over-deep abort and a restart refuses to resume the rollback', async function () {
    const shared = makeShared(SAFE_DEPTH + 74) // 200-block-class reorg

    // Run 1: aborts fail-closed exactly at the safe depth and persists the halt marker.
    const first = buildDecoder(shared)
    await assert.rejects(() => first.decoder.verifyReorg(), /dispenser safe-depth window/)
    assert.strictEqual(first.deleted.length, SAFE_DEPTH, 'run 1 stops deleting at the ceiling')
    assert.strictEqual(shared.store.halted, true, 'run 1 must persist a durable halt marker')

    // Run 2 = process restart: fresh decoder (counter reset), same persisted state.
    // Pre-fix it would delete the remaining 74 blocks; now it must delete NONE.
    const second = buildDecoder(shared)
    await assert.rejects(() => second.decoder.verifyReorg(), /HALTED from a prior over-deep reorg abort/)
    assert.strictEqual(second.deleted.length, 0, 'restart must not resume the over-deep rollback')
    assert.ok(shared.dbState.top > shared.forkPoint,
      'blocks past the purge window must remain (rollback did not silently complete)')
  })

  it('a full resync (cleared halt marker) restores normal shallow-reorg operation', async function () {
    const shared = makeShared(SAFE_DEPTH + 74)
    await assert.rejects(() => buildDecoder(shared).decoder.verifyReorg(), /dispenser safe-depth window/)
    assert.strictEqual(shared.store.halted, true)

    // Simulate the operator-driven full resync: rebuilt schema clears the marker and
    // reseeds a healthy chain with only a shallow divergence.
    const fresh = makeShared(3)
    const { decoder, deleted } = buildDecoder(fresh)
    assert.strictEqual(await decoder.verifyReorg(), true)
    assert.strictEqual(deleted.length, 3, 'a shallow reorg rolls back cleanly after resync')
    assert.strictEqual(fresh.store.halted, false)
  })
})

// verifyReorg froze the node tip at call time, so a mid-walk tip
// regression (node restart onto a shorter chain / second reorg) made the stuck
// height fall through to getBlockHash, which throws "Block height out of range",
// and the transient catch retried the same height forever. The catch now best-
// effort re-reads the tip so the above-tip delete branch drains the orphans.
describe('XChainDecoder.verifyReorg mid-walk tip regression', function () {
  this.timeout(0)

  it('refreshes nodeTip on out-of-range so a regressed tip self-heals instead of wedging', async function () {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    // DB stores 100..105; node originally reported tip 105 (call-time nodeTip), but
    // mid-walk regressed to 102. Blocks 103,104,105 are now above the live tip and
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

// getBlockByIndex used to return null both for "no such row" and for a
// caught query error, and the walk guard reads a null row as "table exhausted".
// One failed read therefore ended the rollback and returned true ("reorg
// reconciled") with orphan blocks still stored above the fork point. The helper now
// retries then throws, so null means only "row absent", and the walk retries a
// failed read instead of terminating on it.
describe('XChainDecoder.verifyReorg does not mistake a failed DB read for an exhausted table', function () {
  this.timeout(0)

  // Blocks 102..100 disagree with the node and must be deleted; 99 matches and ends
  // the walk. `readFailures` reads at the top of the walk throw before any succeed.
  function buildDecoder(readFailures) {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    let sleeps = 0
    decoder.sleep = async () => { sleeps++ }

    let top = 102
    let failsLeft = readFailures
    const dbHash   = { 102: 'db102', 101: 'db101', 100: 'db100', 99: 'match99' }
    const nodeHash = { 102: 'node102', 101: 'node101', 100: 'node100', 99: 'match99' }
    const deleted = []

    decoder.connector = { getBlockHash: async (h) => nodeHash[h] }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => {
        if (failsLeft > 0) { failsLeft--; throw new Error('getBlockByIndex(' + h + ') failed after 5 attempts: DB down') }
        return dbHash[h] ? { block_hash: dbHash[h] } : null
      },
      deleteBlockByIndex: async (h) => { deleted.push(h); top = h - 1 },
      insertEvent: async () => { throw new Error('verifyReorg must not write a separate end-of-run REORG event') },
      isReorgHalted: async () => false,
      markReorgHalted: async () => {}
    }
    return { decoder, deleted, getSleeps: () => sleeps }
  }

  it('[REGRESSION P0] retries the walk through failed reads and still rolls every orphan block back', async function () {
    // Pre-fix the first error-null ended the walk at height 102 with all three
    // orphan blocks still stored, and verifyReorg still returned true.
    const { decoder, deleted, getSleeps } = buildDecoder(4)

    const result = await decoder.verifyReorg()

    assert.strictEqual(result, true)
    assert.deepStrictEqual(deleted, [102, 101, 100],
      'a failed read must not terminate the rollback walk early')
    assert.ok(getSleeps() >= 4, 'each failed read sleeps and re-walks rather than breaking out')
  })

  it('still terminates normally when the row is genuinely absent', async function () {
    // The legitimate terminator (empty table: getLastBlockIndex -> -1, so
    // getBlockByIndex(-1) has no row) must behave exactly as before.
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => { throw new Error('must not sleep: an absent row is not a retry') }
    let getBlockHashCalls = 0
    decoder.connector = { getBlockHash: async () => { getBlockHashCalls++; return 'node' } }
    decoder.db = {
      getLastBlockIndex: async () => -1,
      getBlockByIndex: async () => null,
      deleteBlockByIndex: async () => { throw new Error('nothing to delete') },
      insertEvent: async () => { throw new Error('no end-of-run REORG event') }
    }

    assert.strictEqual(await decoder.verifyReorg(), true)
    assert.strictEqual(getBlockHashCalls, 0, 'guard must short-circuit before querying the node')
  })
})
