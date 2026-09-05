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

// Mempool maintenance must run OUTSIDE the block loop's open transaction.
//
// Regression guard: updateMempool and its parseTransaction pubkey writes once used this.db,
// which resolves every query through getConnection() and hands back the shared block-transaction
// connection whenever a block is mid-commit. Mempool writes therefore landed inside the live
// block transaction, and a failed mempool insert called endTransaction() and rolled the whole
// block back mid-parse. All mempool DB work now runs on a dedicated this.mempoolDb that never
// opens a block transaction, so mempool errors can neither roll back nor block the block loop.
describe('updateMempool DB isolation', function () {
  this.timeout(0)

  // Build a decoder wired with distinct db / mempoolDb spies and just enough connector +
  // decoder stubs to drive one mempool cycle over a single pending tx.
  function buildDecoder(insertResult) {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )

    const calls = { db: [], mempoolDb: [] }
    const spyDb = (label) => ({
      deleteAndCompareTxsNotInList: async () => { calls[label].push('delete'); return { transactionsDeleted: 0 } },
      insertMempoolTransaction:     async () => { calls[label].push('insert'); return insertResult },
      // A block delete/rollback surface: touching these from the mempool path would be the bug.
      endTransaction: async () => { calls[label].push('endTransaction') },
    })

    decoder.db        = spyDb('db')
    decoder.mempoolDb = spyDb('mempoolDb')

    decoder.connector = {
      getRawMempool:      async () => ['txid1'],
      getRawTransactions: async () => ['hexdata'],
    }
    // Bypass real block/tx decoding: yield a tx object shaped like the mempool loop expects.
    decoder.xchainBlockDecoder = { transactionFromHex: () => ({ ins: [{}], getId: () => 'txid1' }) }

    // Record which db handle parseTransaction is handed, and return a decodable SEND action.
    let parseTxDbArg
    decoder.parseTransaction = async (_tx, _openDispensers, db) => {
      parseTxDbArg = db
      return { data: Buffer.from('SEND'), compiledDataLength: 4, source: 'src', destination: null, amount: '0' }
    }

    return { decoder, calls, getParseTxDbArg: () => parseTxDbArg }
  }

  it('routes the mempool DELETE and INSERT to mempoolDb, never to the block db', async () => {
    const { decoder, calls } = buildDecoder(true)
    await decoder.updateMempool()
    assert.deepStrictEqual(calls.mempoolDb, ['delete', 'insert'], 'mempool work must run on mempoolDb')
    assert.deepStrictEqual(calls.db, [], 'the block db must be untouched by mempool maintenance')
  })

  it('hands parseTransaction the mempoolDb handle so pubkey writes stay off the block tx', async () => {
    const { decoder, getParseTxDbArg } = buildDecoder(true)
    await decoder.updateMempool()
    assert.strictEqual(getParseTxDbArg(), decoder.mempoolDb, 'mempool parse must use mempoolDb for pubkey capture')
  })

  it('hands deleteAndCompareTxsNotInList a DEDUPED txid list', async () => {
    // Dedup is the real contract at this seam: db.js deleteAndCompareTxsNotInList
    // seeds the array into a temp table and filters it through a Set, so a repeated
    // txid would be fetched and inserted twice. ORDER is deliberately NOT asserted
    // here: the DB layer runs no binary search over this array (it did once, which
    // is why an older version of this test pinned descending order), so the poll's
    // sort is deterministic output rather than a requirement the consumer imposes.
    const { decoder } = buildDecoder(true)
    let received
    decoder.mempoolDb.deleteAndCompareTxsNotInList = async (list) => {
      received = list.slice(); return { transactionsDeleted: 0 }
    }
    decoder.connector.getRawMempool = async () => ['bbb', 'aaa', 'ccc', 'aaa', 'bbb']
    decoder.connector.getRawTransactions = async () => []
    await decoder.updateMempool()
    assert.strictEqual(received.length, 3, 'rawMempool must carry each txid once')
    assert.deepStrictEqual(received.slice().sort(), ['aaa', 'bbb', 'ccc'],
      'rawMempool must be the deduped txid set the node reported')
  })

  it('a mempool insert failure never rolls back or ends the block transaction', async () => {
    // insertMempoolTransaction returns false (its own rollback path is a no-op with no open
    // tx). The mempool cycle must still complete and must never call endTransaction on the
    // block db.
    const { decoder, calls } = buildDecoder(false)
    decoder.sleep = async () => {}
    await decoder.updateMempool()
    assert.ok(!calls.db.includes('endTransaction'), 'mempool failure must not roll back the block db')
    assert.strictEqual(decoder.mempoolBusy, false, 'the busy flag must be cleared after the cycle')
  })

  // getrawmempool answers with an array of txids, and the JSON-RPC unwrap only checks that a
  // result member is present. A malformed-but-iterable answer is the destructive one: a bare
  // string dedups into per-character "txids", and deleteAndCompareTxsNotInList anti-joins the
  // stored table against that snapshot and deletes every pending row.
  it('a non-array getrawmempool answer skips the poll instead of reaching the delete', async () => {
    const { decoder, calls } = buildDecoder(true)
    decoder.connector.getRawMempool = async () => 'aabbcc'
    await decoder.updateMempool()
    assert.deepStrictEqual(calls.mempoolDb, [], 'a shape fault must not reach the mempool DB at all')
    assert.deepStrictEqual(calls.db, [])
    assert.strictEqual(decoder.mempoolBusy, false, 'the busy flag must be cleared so the next poll runs')
  })

  it('an empty node mempool still reaches the delete, so departed txs are pruned', async () => {
    // [] is a legitimate answer, not a shape fault: the anti-join is exactly what prunes the
    // stored rows when the node's mempool has drained.
    const { decoder } = buildDecoder(true)
    let received = null
    decoder.mempoolDb.deleteAndCompareTxsNotInList = async (list) => {
      received = list.slice(); return { transactionsDeleted: 0 }
    }
    decoder.connector.getRawMempool = async () => []
    await decoder.updateMempool()
    assert.deepStrictEqual(received, [], 'an empty snapshot must still be handed to the diff')
  })

  // deleteAndCompareTxsNotInList empties and refills the caller's array in place, leaving it
  // holding only the new arrivals, so the cycle summary must not read that array for the
  // mempool size: in steady state that reads 0 against a full table, which an operator takes
  // for "mempool tracking has stopped".
  it('the cycle summary reports the node mempool size, not the post-diff new arrivals', async () => {
    const { decoder } = buildDecoder(true)
    decoder.connector.getRawMempool = async () => ['ccc', 'bbb', 'aaa']
    decoder.connector.getRawTransactions = async () => []
    // Steady state: every txid the node reported is already stored, so the diff empties the list.
    decoder.mempoolDb.deleteAndCompareTxsNotInList = async (list) => {
      list.length = 0; return { transactionsDeleted: 0 }
    }
    const lines = []
    const realLog = console.log
    console.log = (...args) => { lines.push(args.join(' ')) }
    try {
      await decoder.updateMempool()
    } finally {
      console.log = realLog
    }
    const summary = lines.find((line) => line.startsWith('Mempool updated!'))
    assert.ok(summary, 'the cycle must emit its summary line')
    assert.match(summary, /3 in mempool/, 'the summary must report the size the node reported')
    assert.match(summary, /0 new/, 'the post-diff length is the new-arrival count and must be labelled so')
  })
})
