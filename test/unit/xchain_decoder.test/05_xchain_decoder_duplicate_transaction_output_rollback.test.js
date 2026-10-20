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
const XChainDecoder = require('../../../src/XChainDecoder')

// Passes of one block before a test calls the loop wedged and stops it.
const PASS_LIMIT = 8

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}

// Drive the real block loop at height 0 with `output` deciding each insertTransactionOutput result.
function buildDecoder(output, parsed) {
    const decoder = new XChainDecoder('bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const calls = { passes: 0, wedged: false, commit: 0, endTransaction: 0, outputs: 0, insertEvent: [] }
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
        insertTransaction: async () => true,
        insertTransactionOutput: async () => { calls.outputs++; return output(calls.outputs) },
        DUPLICATED_TRANSACTION: 1, POISON_ROW: 2
    }
    decoder.xchainBlockDecoder = {
        blockFromHex: () => {
            calls.passes++
            if (calls.passes > PASS_LIMIT){ calls.wedged = true; decoder.stopFlag = true }
            return { prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: [fakeTx('cafe01')] }
        }
    }
    decoder.parseTransaction = async () => Object.assign({
        data: Buffer.from('SEND|x'), compiledDataLength: 6, rawData: null,
        source: 'someaddr', destination: null, amount: 0
    }, parsed)
    return { decoder, calls }
}

// The payment output is captured because it pays the protocol fee destination.
const PATHS = [
    { kind: 'dispense', feeDestination: null, parsed: {
        dispenseOutputs: [{ vout: 0, destinationAddress: 'destaddr', amount: 1n }], paymentOutputs: [] } },
    { kind: 'payment', feeDestination: 'feeaddr', parsed: {
        dispenseOutputs: [], paymentOutputs: [{ vout: 1, destinationAddress: 'feeaddr', amount: 2n }] } },
]

function build(path, output) {
    const built = buildDecoder(output, path.parsed)
    if (path.feeDestination) built.decoder.feeDestination = path.feeDestination
    return built
}

// A duplicate key on a transaction_outputs row rolls the block back, as it does on the parent row.
describe('duplicate transaction output insert rolls the block back', function () {
    this.timeout(0)

    for (const p of PATHS) {
        it('rolls back a ' + p.kind + ' output collision and commits on the clean retry', async function () {
            const { decoder, calls } = build(p, n => (n === 1 ? 1 : true))
            await decoder.start()
            assert.strictEqual(calls.wedged, false, 'the block must not wedge')
            assert.strictEqual(calls.outputs, 2, 'the output insert is retried after the duplicate')
            assert.strictEqual(calls.endTransaction, 1, 'the open block transaction is ended on the duplicate')
            assert.strictEqual(calls.commit, 1, 'the block commits on the retry')
            assert.deepStrictEqual(calls.insertEvent, [], 'a duplicate is never quarantined with PARSE_ERROR')
        })

        it('never commits past a persistent ' + p.kind + ' output collision', async function () {
            const { decoder, calls } = build(p, () => 1)
            await decoder.start()
            assert.strictEqual(calls.wedged, true, 'a persistent duplicate stalls the block')
            assert.strictEqual(calls.commit, 0, 'nothing commits past the collision')
            assert.deepStrictEqual(calls.insertEvent, [], 'the tx is never skipped with PARSE_ERROR')
        })
    }
})
