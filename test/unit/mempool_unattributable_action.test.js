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
function runOneMempoolCycle(parseResult) {
  const decoder = new XChainDecoder(
    'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
  )
  const inserted = []
  decoder.mempoolDb = {
    deleteAndCompareTxsNotInList: async () => ({ transactionsDeleted: 0 }),
    insertMempoolTransaction: async (row) => { inserted.push(row); return true },
  }
  decoder.db = {}
  decoder.connector = {
    getRawMempool: async () => ['txid1'],
    getRawTransactions: async () => ['hexdata'],
  }
  decoder.xchainBlockDecoder = { transactionFromHex: () => ({ ins: [{}], getId: () => 'txid1' }) }
  decoder.parseTransaction = async () => parseResult
  return decoder.updateMempool().then(() => ({ decoder, inserted }))
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
})
