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

// getBlockByIndex returns null only for "no such row"; a caught query error
// retries internally and then throws, never returning null for that case.
// The walk guard reads a null row as "table exhausted", so a failed read
// retries instead of ending the rollback early with orphan blocks left
// above the fork point.

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

describe('XChainDecoder.verifyReorg does not mistake a failed DB read for an exhausted table', function () {
  this.timeout(0)

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
