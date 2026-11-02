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

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}


// Quarantine retry state belongs to one tx position in one exact block.
// A second tx in the same block, or a sibling block that replaced the tried
// one at the same height, must get its own full retry budget and must never
// inherit a quarantine it was not tried for: either would make this instance
// skip a tx its peers store, shifting every later tx_index.

const { TX_PARSE_MAX_RETRIES } = require('../../../src/XChainDecoder/constants.js')

// Stop the loop after this many block passes so a wedge fails instead of hanging.
const PASS_LIMIT = 60

// Drive the real block loop at height 0. `chain.hash` and `chain.txs` are read on
// every pass, so a test swaps the block by mutating them.
function buildChainDecoder(chain){
    const decoder = new XChainDecoder('bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const calls = { passes: 0, wedged: false, commit: 0, inserted: [], insertEvent: [] }
    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash: async () => chain.hash,
        getBlock: async () => ''
    }
    decoder.db = {
        createDatabase: async () => true, verifyDatabase: async () => true,
        verifyTables: async () => true, runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1, getLastTxIndex: async () => 0,
        beginTransaction: async () => {}, endTransaction: async () => {},
        commitTransaction: async () => { calls.commit++; decoder.stopFlag = true; return true },
        deleteOpenDispensers: async () => true, purgeExpiredDispensers: async () => true,
        getAllOpenDispenserAddresses: async () => new Set(),
        insertEvent: async (code, data) => { calls.insertEvent.push({ code, data }); return true },
        insertBlock: async () => true,
        insertTransaction: async (tx) => {
            const result = chain.insert ? chain.insert(tx.hash) : true
            if (result === true) calls.inserted.push(tx.hash)
            return result
        },
        insertTransactionOutput: async () => true,
        DUPLICATED_TRANSACTION: 1, POISON_ROW: 2
    }
    decoder.xchainBlockDecoder = {
        blockFromHex: () => {
            calls.passes++
            if (calls.passes > PASS_LIMIT){ calls.wedged = true; decoder.stopFlag = true }
            return { prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: chain.txs.map(fakeTx) }
        }
    }
    return { decoder, calls }
}

// A parse result that reaches insertTransaction (a valid SEND payload).
function storableParse(){
    return {
        data: Buffer.from('SEND|x'), compiledDataLength: 6, rawData: null,
        source: 'someaddr', destination: null, amount: 0,
        dispenseOutputs: [], paymentOutputs: []
    }
}

function quarantinedHashes(calls){
    return calls.insertEvent.filter(e => e.code === 'PARSE_ERROR').map(e => e.data.tx_hash)
}

// Count calls per tx hash and throw for the hashes `shouldThrow` names.
function countingParse(parseCalls, shouldThrow){
    return async (tx) => {
        const id = tx.getId()
        parseCalls[id] = (parseCalls[id] || 0) + 1
        if (shouldThrow(id, parseCalls[id])) throw new Error('parse failure ' + id)
        return null
    }
}

describe('quarantine retry state is per tx position and per block', function () {
    this.timeout(0)

    it('a transient parse throw on a second tx after a quarantine in the same block is still retried', async function () {
        const chain = { hash: 'blockA', txs: ['aa', 'bb'] }
        const { decoder, calls } = buildChainDecoder(chain)
        const parseCalls = {}
        decoder.parseTransaction = countingParse(parseCalls, (id, n) => id === 'aa' || (id === 'bb' && n === 1))
        await decoder.start()
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(calls.commit, 1, 'the block commits')
        assert.deepStrictEqual([...new Set(quarantinedHashes(calls))], ['aa'], 'only the poison tx is quarantined')
        assert.ok(parseCalls.bb >= 2, 'the transiently failing tx is parsed again')
    })

    it('two poison txs in one block each get their own parse retries and the block commits', async function () {
        const chain = { hash: 'blockA', txs: ['aa', 'bb'] }
        const { decoder, calls } = buildChainDecoder(chain)
        const parseCalls = {}
        decoder.parseTransaction = countingParse(parseCalls, () => true)
        await decoder.start()
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(calls.commit, 1, 'the block commits')
        assert.deepStrictEqual([...new Set(quarantinedHashes(calls))].sort(), ['aa', 'bb'])
        assert.strictEqual(parseCalls.bb, TX_PARSE_MAX_RETRIES + 1, 'the second poison tx is tried the full number of times')
    })

    it('a sibling block at the same height does not inherit the parse retry count', async function () {
        const chain = { hash: 'blockA', txs: ['cafe01'] }
        const { decoder, calls } = buildChainDecoder(chain)
        const parseCalls = {}
        decoder.parseTransaction = countingParse(parseCalls, (id, n) => {
            if (id === 'cafe01' && n === TX_PARSE_MAX_RETRIES){ chain.hash = 'blockB'; chain.txs = ['beef02'] }
            return id === 'cafe01' || n === 1
        })
        await decoder.start()
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(calls.commit, 1, 'the sibling block commits')
        assert.deepStrictEqual(quarantinedHashes(calls), [], 'the sibling tx was never quarantined')
        assert.strictEqual(parseCalls.beef02, 2, 'the sibling tx got a retry of its own')
    })
})

describe('quarantine retry state is per tx position and per block', function () {
    this.timeout(0)

    it('a sibling block at the same height does not inherit an INSERT quarantine', async function () {
        const chain = { hash: 'blockA', txs: ['cafe01'] }
        const { decoder, calls } = buildChainDecoder(chain)
        decoder.parseTransaction = async () => storableParse()
        let poisonHits = 0
        chain.insert = (hash) => {
            if (hash !== 'cafe01') return true
            poisonHits++
            if (poisonHits > TX_PARSE_MAX_RETRIES){ chain.hash = 'blockB'; chain.txs = ['beef02'] }
            return decoder.db.POISON_ROW
        }
        await decoder.start()
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(calls.commit, 1, 'the sibling block commits')
        assert.deepStrictEqual(calls.inserted, ['beef02'], 'the sibling tx is inserted, not skipped')
        assert.deepStrictEqual(quarantinedHashes(calls), [], 'no PARSE_ERROR names a tx that was never tried')
    })

    it('a one-off INSERT rejection on a second tx after a quarantine in the same block is still retried', async function () {
        const chain = { hash: 'blockA', txs: ['cafe01', 'beef02'] }
        const { decoder, calls } = buildChainDecoder(chain)
        decoder.parseTransaction = async () => storableParse()
        let beefHits = 0
        chain.insert = (hash) => {
            if (hash === 'cafe01') return decoder.db.POISON_ROW
            beefHits++
            return beefHits === 1 ? decoder.db.POISON_ROW : true
        }
        await decoder.start()
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(calls.commit, 1, 'the block commits')
        assert.deepStrictEqual([...new Set(quarantinedHashes(calls))], ['cafe01'], 'only the poison row is quarantined')
        assert.deepStrictEqual(calls.inserted, ['beef02'], 'the second tx is inserted on its retry')
        assert.ok(decoder.quarantinedTxs >= 1, 'an INSERT quarantine is counted as a skip')
        assert.strictEqual(decoder.quarantinedTxs, quarantinedHashes(calls).length, 'one count per recorded PARSE_ERROR')
        assert.strictEqual(decoder.lastQuarantinedTxHash, 'cafe01')
    })
})
