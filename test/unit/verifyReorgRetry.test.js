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
    let reorgEvent = null

    decoder.connector = {
      getBlockHash: async (h) => nodeHash[h]
    }
    decoder.db = {
      getLastBlockIndex: async () => top,
      getBlockByIndex: async (h) => (dbHash[h] ? { block_hash: dbHash[h] } : null),
      deleteBlockByIndex: async (h) => {
        if (failsLeft[h] > 0) { failsLeft[h]--; throw new Error('transient DB error') }
        deleted.push(h)
        top = h - 1
      },
      insertEvent: async (type, payload) => { reorgEvent = { type, payload } }
    }

    return { decoder, deleted, getReorgEvent: () => reorgEvent }
  }

  it('resets the budget per block so a multi-block reorg with per-block transient failures removes every orphan block', async function () {
    // 3 orphan blocks × 4 transient failures = 12 total failures (> the 10-attempt
    // budget) but only 4 per block (< 10). Pre-fix the shared counter hit 10 mid-reorg
    // and aborted; post-fix each block gets its own budget and all three are deleted.
    const { decoder, deleted, getReorgEvent } = buildDecoder(4)

    const result = await decoder.verifyReorg()

    assert.strictEqual(result, true)
    assert.deepStrictEqual(deleted, [102, 101, 100], 'all three orphan blocks should be deleted')
    const ev = getReorgEvent()
    assert.ok(ev, 'a REORG event should be written')
    assert.strictEqual(ev.type, 'REORG')
    assert.strictEqual(ev.payload.length, 3)
  })

  it('still aborts when a single block genuinely fails 10 times in a row', async function () {
    // The per-block reset must not turn the limit into infinite retry: one block
    // that fails 10 consecutive times must still trip the abort guard.
    const { decoder } = buildDecoder(10)
    await assert.rejects(() => decoder.verifyReorg(), /failed after 10 attempts/)
  })
})
