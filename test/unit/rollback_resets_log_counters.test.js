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
const { resetAfterRollback, leaveReorgHaltPark, parkOrRethrow } = require('../../src/XChainDecoder/sync_loop.js')

// A rolled-back parse pass must not leak its in-memory counts into the next
// pass: the commit log line describes the block that actually committed.

function dirtyLoop() {
  return {
    lastProcessedBlockIndex: 500, lastProcessedTxIndex: 9999, blocksQuantity: 7,
    blocksCount: 36, transactionsCount: 120, validTransactionsCount: 234, outputCount: 88
  }
}

function stubThis(logs) {
  return {
    startBlockIndex: 0,
    blockchainInfoLastBlock: 100,
    sleep: async () => {},
    log: (m) => logs.push(m),
    logWarn: () => {},
    parkOnReorgHalt: () => {},
    resumeFromReorgHaltPark: async () => true,
    db: {
      getLastBlockIndex: async () => 42,
      getLastTxIndex: async () => 1000,
      commitTransaction: async () => true,
      purgeExpiredDispensers: async () => 0,
      readRolledBackAboveTip: async () => 0
    }
  }
}

function assertZeroed(loop) {
  for (const k of ['blocksQuantity', 'blocksCount', 'transactionsCount', 'validTransactionsCount', 'outputCount']) {
    assert.strictEqual(loop[k], 0, k)
  }
}

describe('rollback zeroes the loop log counters', () => {
  it('resetAfterRollback zeroes all counters and re-derives the cursors', async () => {
    const loop = dirtyLoop()
    await resetAfterRollback.call(stubThis([]), loop)
    assertZeroed(loop)
    assert.strictEqual(loop.lastProcessedBlockIndex, 42)
    assert.strictEqual(loop.lastProcessedTxIndex, 1000)
  })

  it('leaveReorgHaltPark zeroes all counters on resume', async () => {
    const loop = dirtyLoop()
    await leaveReorgHaltPark.call(stubThis([]), loop)
    assertZeroed(loop)
    assert.strictEqual(loop.lastProcessedTxIndex, 1000)
  })

  it('parkOrRethrow zeroes all counters when parking on a halt', async () => {
    const loop = dirtyLoop()
    await parkOrRethrow.call(stubThis([]), Object.assign(new Error('halt'), { reorgHalt: true, resetOnly: true }), loop)
    assertZeroed(loop)
  })

  it('a block parsed after a rollback starts its counts from zero', async () => {
    const loop = dirtyLoop()
    await resetAfterRollback.call(stubThis([]), loop)
    loop.blocksCount += 1
    loop.validTransactionsCount += 13
    assert.strictEqual(loop.blocksCount, 1)
    assert.strictEqual(loop.validTransactionsCount, 13)
  })
})
