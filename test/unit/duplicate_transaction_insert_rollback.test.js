// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

// Passes of one block before a test calls the loop wedged and stops it.
const PASS_LIMIT = 8

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}

// Drive the real block loop at height 0 with `insert` deciding each insertTransaction result.
function buildDecoder(insert) {
    const decoder = new XChainDecoder('bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const calls = { passes: 0, wedged: false, commit: 0, endTransaction: 0, outputs: [], insertEvent: [] }
    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash: async () => 'blockA',
        getBlock: async () => ''
    }
    decoder.db = {
        createDatabase: async () => true, verifyDatabase: async () => true,
        verifyTables: async () => true, runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1, getLastTxIndex: async () => 0,
        beginTransaction: async () => {},
        endTransaction: async () => { calls.endTransaction++ },
        commitTransaction: async () => { calls.commit++; decoder.stopFlag = true; return true },
        deleteOpenDispensers: async () => true, purgeExpiredDispensers: async () => true,
        getAllOpenDispenserAddresses: async () => new Set(),
        insertEvent: async (code, data) => { calls.insertEvent.push({ code, data }); return true },
        insertBlock: async () => true,
        insertTransaction: async (tx) => insert(tx),
        insertTransactionOutput: async (output) => { calls.outputs.push(output.txIndex); return true },
        DUPLICATED_TRANSACTION: 1, POISON_ROW: 2
    }
    decoder.xchainBlockDecoder = {
        blockFromHex: () => {
            calls.passes++
            if (calls.passes > PASS_LIMIT){ calls.wedged = true; decoder.stopFlag = true }
            return { prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: [fakeTx('cafe01')] }
        }
    }
    decoder.parseTransaction = async () => ({
        data: Buffer.from('SEND|x'), compiledDataLength: 6, rawData: null,
        source: 'someaddr', destination: null, amount: 0,
        dispenseOutputs: [{ vout: 0, destinationAddress: 'destaddr', amount: 1n }], paymentOutputs: []
    })
    return { decoder, calls }
}

// A duplicate key on the transactions row rolls the block back instead of writing its outputs.
describe('duplicate transaction insert rolls the block back', function () {
    this.timeout(0)

    it('writes no output under a tx_index whose row collided and commits on the clean retry', async function () {
        let attempts = 0
        const { decoder, calls } = buildDecoder(() => (++attempts === 1 ? decoder.db.DUPLICATED_TRANSACTION : true))
        await decoder.start()
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(attempts, 2, 'the block is retried after the duplicate')
        assert.strictEqual(calls.endTransaction, 1, 'the open block transaction is ended on the duplicate')
        assert.deepStrictEqual(calls.outputs, [1], 'the output is written once, on the retry, under the retried tx_index')
        assert.strictEqual(calls.commit, 1, 'the block commits on the retry')
        assert.deepStrictEqual(calls.insertEvent, [], 'a duplicate is never quarantined with PARSE_ERROR')
    })

    it('keeps retrying a persistent duplicate without ever committing or skipping the tx', async function () {
        const { decoder, calls } = buildDecoder(() => decoder.db.DUPLICATED_TRANSACTION)
        await decoder.start()
        assert.strictEqual(calls.wedged, true, 'a persistent duplicate stalls the block')
        assert.strictEqual(calls.commit, 0, 'nothing commits past the collision')
        assert.deepStrictEqual(calls.outputs, [], 'no output is written for a tx whose row collided')
        assert.deepStrictEqual(calls.insertEvent, [], 'the tx is never skipped with PARSE_ERROR')
    })
})
