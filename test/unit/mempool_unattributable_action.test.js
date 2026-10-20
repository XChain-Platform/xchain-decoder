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

// Pin mempool admission to the block path's attribution rule (hasStorableContent).
// The block path skips an ACTION whose source cannot be resolved, so the mempool
// must not publish it as pending; it keeps a blanked row as the seen-set entry.
function runOneMempoolCycle(parseResult, openDispensers = new Set()) {
  const decoder = new XChainDecoder(
    'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
  )
  const inserted = []
  const floors = []
  decoder.mempoolDb = {
    getAllOpenDispenserAddresses: async (floor) => { floors.push(floor); return openDispensers },
    deleteAndCompareTxsNotInList: async () => ({ transactionsDeleted: 0 }),
    insertMempoolTransaction: async (row) => { inserted.push(row); return true },
  }
  decoder.db = {}
  decoder.connector = {
    getRawMempool: async () => ['txid1'],
    getRawTransactions: async () => ['hexdata'],
  }
  decoder.xchainBlockDecoder = { transactionFromHex: () => ({ ins: [{}], getId: () => 'txid1' }) }
  const parseSets = []
  decoder.parseTransaction = async (...args) => {
    const openSet = args[1]
    parseSets.push(openSet)
    return typeof parseResult === 'function' ? parseResult(openSet) : parseResult
  }
  return decoder.updateMempool().then(() => ({ decoder, inserted, floors, parseSets }))
}

function actionResult(source, extra) {
  const payload = Buffer.from('COINPAY|0|abc|def')
  return Object.assign({
    data: payload, compiledDataLength: payload.length + 1, source,
    destination: null, amount: '0', dispenseOutputs: [], paymentOutputs: [],
  }, extra)
}

describe('mempool admission of an ACTION with no resolvable source', function () {
  this.timeout(0)

  it('blanks an unattributable ACTION to an empty string and keeps the row', async () => {
    const { decoder, inserted } = await runOneMempoolCycle(actionResult(null))
    assert.strictEqual(decoder.hasStorableContent(actionResult(null)), false, 'the block path skips this tx')
    assert.strictEqual(inserted.length, 1, 'the row must still be written as the seen-set entry')
    assert.strictEqual(inserted[0].data, '', 'an unattributable ACTION must not be published as pending')
    assert.strictEqual(inserted[0].raw_data, null)
  })

  it('keeps the ACTION text when the source resolves', async () => {
    const { inserted } = await runOneMempoolCycle(actionResult('src'))
    assert.strictEqual(inserted.length, 1)
    assert.strictEqual(inserted[0].data, 'COINPAY|0|abc|def')
  })

  it('still writes a blanked row for an actionless tx with no source', async () => {
    const { inserted } = await runOneMempoolCycle(actionResult(null, { data: Buffer.alloc(0), compiledDataLength: 0 }))
    assert.strictEqual(inserted.length, 1, 'an actionless tx must keep its seen-set row')
    assert.strictEqual(inserted[0].data, '')
  })

  it('keeps the ACTION text for a null source when a dispense output makes the tx storable', async () => {
    const dispense = [{ txIndex: 'txid1', vout: 0, destinationAddress: 'd', amount: 1 }]
    const { inserted } = await runOneMempoolCycle(actionResult(null, { dispenseOutputs: dispense }))
    assert.strictEqual(inserted.length, 1)
    assert.strictEqual(inserted[0].data, 'COINPAY|0|abc|def', 'must match the block path, which stores this tx')
  })

  it('parses against the getAllOpenDispenserAddresses set, so an unattributed ACTION paying an open dispenser keeps its text', async () => {
    const open = new Set(['dispenserAddr'])
    // Classify the payment output the way captureOutputAddress does: a dispense
    // output only when its address is in the open-dispenser set the parse is handed.
    const classify = (openSet) => actionResult(null, {
      dispenseOutputs: (openSet && openSet.has('dispenserAddr'))
        ? [{ txIndex: 'txid1', vout: 1, destinationAddress: 'dispenserAddr', amount: 1 }]
        : [],
    })
    const { inserted, parseSets } = await runOneMempoolCycle(classify, open)
    assert.strictEqual(parseSets[0], open, 'the mempool parse must see the loaded open-dispenser set')
    assert.strictEqual(inserted.length, 1)
    assert.strictEqual(inserted[0].data, 'COINPAY|0|abc|def', 'the block path stores this ACTION on confirm')
  })

  it('loads the open-dispenser set with the cancelGraceFloor for the network', async () => {
    const { floors } = await runOneMempoolCycle(actionResult('src'))
    assert.strictEqual(floors.length, 1, 'one load per cycle')
    assert.ok(floors[0] === null || Number.isFinite(floors[0]), 'the floor is null below the gate or a finite time')
  })

  it('still runs the cycle against an empty set when getAllOpenDispenserAddresses fails', async () => {
    const { inserted, parseSets } = await runOneMempoolCycle(actionResult('src'), null)
    assert.ok(parseSets[0] instanceof Set && parseSets[0].size === 0, 'a failed load classifies against no open dispensers')
    assert.strictEqual(inserted.length, 1, 'pruning and new arrivals must not stall on the failed read')
    assert.strictEqual(inserted[0].data, 'COINPAY|0|abc|def')
  })
})

// The block path sees a gate-skipped tx (oversized or unknown ACTION, no outputs) once.
// The mempool path must too: a stateful seen-set fake runs two polls over the same txid.
describe('mempool admission of a gate-skipped ACTION', function () {
  this.timeout(0)

  async function runTwoMempoolCycles(parseResult) {
    const decoder = new XChainDecoder(
      'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    const stored = new Map()
    let fetched = 0
    decoder.mempoolDb = {
      getAllOpenDispenserAddresses: async () => new Set(),
      // Mirrors the real diff: txids already stored leave the list in place.
      deleteAndCompareTxsNotInList: async (list) => {
        const remaining = list.filter((h) => !stored.has(h))
        list.length = 0
        remaining.forEach((h) => list.push(h))
        return { transactionsDeleted: 0 }
      },
      insertMempoolTransaction: async (row) => { stored.set(row.hash, row); return true },
    }
    decoder.db = {}
    decoder.connector = {
      getRawMempool: async () => ['txid1'],
      getRawTransactions: async (chunk) => { fetched += chunk.length; return chunk.map(() => 'hexdata') },
    }
    decoder.xchainBlockDecoder = { transactionFromHex: () => ({ ins: [{}], getId: () => 'txid1' }) }
    decoder.parseTransaction = async () => parseResult
    await decoder.updateMempool()
    await decoder.updateMempool()
    return { decoder, stored, fetched }
  }

  it('stores an unknown ACTION as a blanked seen-set row, fetched and counted once', async () => {
    const unknown = Buffer.from('NOTANACTION|0|x')
    const { decoder, stored, fetched } = await runTwoMempoolCycles(
      actionResult('src', { data: unknown, compiledDataLength: unknown.length + 1 }))
    assert.strictEqual(fetched, 1, 'the second poll must not re-fetch a tx the first one rejected')
    assert.strictEqual(decoder.parseErrors, 1, 'parse_errors counts the rejection once, as the block path does')
    assert.strictEqual(stored.get('txid1').data, '', 'a rejected ACTION must not be published as pending')
    assert.strictEqual(stored.get('txid1').raw_data, null)
  })

  it('stores an oversized ACTION as a blanked seen-set row, fetched and counted once', async () => {
    const { decoder, stored, fetched } = await runTwoMempoolCycles(
      actionResult('src', { compiledDataLength: 1000000 }))
    assert.strictEqual(fetched, 1, 'the second poll must not re-fetch a tx the first one rejected')
    assert.strictEqual(decoder.parseErrors, 1, 'parse_errors counts the rejection once, as the block path does')
    assert.strictEqual(stored.get('txid1').data, '')
  })
})
