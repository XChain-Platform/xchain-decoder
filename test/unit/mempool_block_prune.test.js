// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// An action moves from mempool to confirmed exactly once. mempool_transactions was
// reconciled only by the 60 s mempool poll, so after a block confirmed a pending SEND
// the row stayed in the getmempool window for up to a full poll interval while the
// confirmed row already existed: one action read as pending and confirmed at once.
// These tests ingest a block through ingestNextBlock against the real mempool DB
// methods over an in-memory mempool_transactions table and read the window straight
// after the block, with no mempool poll in between.

'use strict'

const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db.js')
const { ingestNextBlock } = require('../../src/XChainDecoder/block_ingest.js')
const { createMempoolMethods } = require('../../src/api')

const HEIGHT = 11
const TX_A = 'a'.repeat(64)
const TX_B = 'b'.repeat(64)
const TX_C = 'c'.repeat(64)

// A fake pooled connection holding mempool_transactions as a Map keyed by tx_hash.
// It answers the statements mempool.js issues: INSERT, the window SELECT, COUNT and
// the confirmed-tx DELETE ... IN (...).
function makeMempoolTable(seed, { failDelete = false } = {}) {
    const rows = new Map()
    for (const r of seed) rows.set(r.tx_hash, r)
    const conn = {
        async query(sql, params) {
            if (/^\s*DELETE FROM mempool_transactions WHERE tx_hash IN/i.test(sql)) {
                if (failDelete) throw new Error('simulated mempool DB outage')
                let affectedRows = 0
                for (const h of params) if (rows.delete(h)) affectedRows++
                return { affectedRows }
            }
            if (/INSERT INTO mempool_transactions/i.test(sql)) {
                const [tx_hash, source, destination, amount, fee, data, raw_data] = params
                if (rows.has(tx_hash)) { const e = new Error('dup'); e.errno = 1062; throw e }
                rows.set(tx_hash, { tx_hash, source, destination, amount, fee, data, raw_data, first_seen: 1 })
                return { affectedRows: 1 }
            }
            if (/SELECT COUNT\(\*\) AS count FROM mempool_transactions/i.test(sql)) {
                return [{ count: [...rows.values()].filter((r) => r.data).length }]
            }
            if (/FROM mempool_transactions/i.test(sql)) {
                return [...rows.values()].filter((r) => r.data)
                    .sort((x, y) => (x.tx_hash < y.tx_hash ? -1 : 1))
                    .map((r) => ({ tx_hash: r.tx_hash, source: r.source, data: r.data, first_seen: r.first_seen }))
            }
            throw new Error('unexpected SQL in mempool fake: ' + sql)
        },
        release: sinon.stub().resolves(),
    }
    return { rows, pool: { getConnection: sinon.stub().resolves(conn) } }
}

function makeMempoolDb(table) {
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p')
    db.pool = table.pool
    return db
}

function buildDecoder(blockTxIds, mempoolDb) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.consensusNetwork = 'testnet'
    decoder.startBlockIndex = HEIGHT
    decoder.blockchainInfoLastBlock = HEIGHT
    decoder.synced = true
    decoder.sleep = async () => {}
    decoder.connector = {
        getBlockHash: async () => 'block-' + HEIGHT,
        getBlock: async () => '00',
    }
    decoder.fetchBlockHex = async () => ''
    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({
            prevHash: Buffer.alloc(32),
            timestamp: 500,
            transactions: blockTxIds.map((id) => ({ getId: () => id, outs: [], ins: [{}] })),
        }),
    }
    // Non-XChain txs keep the block path minimal; the prune keys on the block's txids.
    decoder.parseTransaction = async () => ({
        data: Buffer.alloc(0), source: null, destination: null, amount: 0,
        dispenseOutputs: [], paymentOutputs: [], compiledDataLength: 0, rawData: null,
    })
    decoder.db = {
        getLastBlockIndex: async () => HEIGHT - 1,
        getLastTxIndex: async () => 0,
        getBlockByIndex: async (height) => ({ block_time: 100 + height, block_hash: 'h' + height }),
        beginTransaction: async () => {},
        endTransaction: async () => {},
        commitTransaction: async () => true,
        insertBlock: async () => true,
        deleteOpenDispensers: async () => true,
        getAllOpenDispenserAddresses: async () => new Set(),
        purgeExpiredDispensers: async () => true,
        insertTransaction: async () => true,
        insertTransactionOutput: async () => true,
        insertEvent: async () => true,
        DUPLICATED_TRANSACTION: 1,
        POISON_ROW: 2,
    }
    decoder.mempoolDb = mempoolDb
    return decoder
}

function makeLoop() {
    return {
        lastProcessedBlockIndex: HEIGHT - 1,
        lastProcessedTxIndex: 0,
        blocksQuantity: 0,
        blocksCount: 0,
        transactionsCount: 0,
        validTransactionsCount: 0,
        outputCount: 0,
        startTimeStamp: Date.now(),
        // Per-block retry state the start() loop owns (see startup.js).
        txParseRetryCounts: new Map(),
        insertQuarantineCounts: new Map(),
        insertQuarantine: new Set(),
        parseQuarantine: new Set(),
    }
}

const pendingRow = (tx_hash, data) => ({ tx_hash, source: 'src', destination: 'dst', amount: 0, fee: 0, data, raw_data: null, first_seen: 1 })

describe('mempool rows of block-confirmed txs are pruned at block ingest', function () {
    this.timeout(0)

    it('drops a confirmed SEND from the mempool window straight after its block, keeping unrelated pending rows', async () => {
        const table = makeMempoolTable([pendingRow(TX_A, 'SEND|0|TICK|7|dst|memo'), pendingRow(TX_B, 'SEND|0|TICK|1|dst|')])
        const mempoolDb = makeMempoolDb(table)
        const decoder = buildDecoder([TX_A], mempoolDb)
        const loop = makeLoop()

        const result = await ingestNextBlock.call(decoder, loop)

        assert.notStrictEqual(result, 'rollback')
        assert.notStrictEqual(result, 'continue')
        assert.strictEqual(loop.lastProcessedBlockIndex, HEIGHT, 'the block committed')
        assert.strictEqual(table.rows.has(TX_A), false, 'the confirmed tx must leave mempool_transactions with its block')
        assert.strictEqual(table.rows.has(TX_B), true, 'a still-pending tx stays')
        const window = await mempoolDb.getMempoolTransactions(500)
        assert.deepStrictEqual(window.map((r) => r.tx_hash), [TX_B])
        assert.strictEqual(await mempoolDb.getMempoolTransactionCount(), 1)
        // The JSON-RPC route remote explorers read; a fresh method set has a cold cache.
        const api = await createMempoolMethods(decoder).getmempool({})
        assert.deepStrictEqual(api.rows.map((r) => r.tx_hash), [TX_B])
        assert.strictEqual(api.total, 1)
    })

    it('refuses a late insert of a just-confirmed tx from a mempool poll that snapshotted before the block', async () => {
        const table = makeMempoolTable([])
        const mempoolDb = makeMempoolDb(table)
        const decoder = buildDecoder([TX_A], mempoolDb)
        await ingestNextBlock.call(decoder, makeLoop())

        const res = await mempoolDb.insertMempoolTransaction({ hash: TX_A, source: 'src', destination: 'dst', amount: 0, fee: 0, data: 'SEND|0|TICK|7|dst|memo' })
        assert.ok(res, 'the poll treats the refusal as already stored, not as a DB failure')
        assert.deepStrictEqual((await mempoolDb.getMempoolTransactions(500)).map((r) => r.tx_hash), [])
        // An unrelated tx still inserts normally.
        assert.strictEqual(await mempoolDb.insertMempoolTransaction({ hash: TX_C, source: 's', destination: 'd', amount: 0, fee: 0, data: 'SEND|x' }), true)
    })
})

describe('mempool prune at block ingest never disturbs the block loop', function () {
    this.timeout(0)

    it('deletes nothing and does not throw for a block whose txs were never in the mempool', async () => {
        const table = makeMempoolTable([pendingRow(TX_B, 'SEND|0|TICK|1|dst|')])
        const decoder = buildDecoder([TX_C], makeMempoolDb(table))
        const loop = makeLoop()
        await ingestNextBlock.call(decoder, loop)
        assert.strictEqual(loop.lastProcessedBlockIndex, HEIGHT)
        assert.deepStrictEqual([...table.rows.keys()], [TX_B])
    })

    it('a mempool DB delete failure does not abort block ingest', async () => {
        const table = makeMempoolTable([pendingRow(TX_A, 'SEND|0|TICK|7|dst|memo')], { failDelete: true })
        const decoder = buildDecoder([TX_A], makeMempoolDb(table))
        const loop = makeLoop()
        const result = await ingestNextBlock.call(decoder, loop)
        assert.notStrictEqual(result, 'rollback')
        assert.notStrictEqual(result, 'continue')
        assert.strictEqual(loop.lastProcessedBlockIndex, HEIGHT, 'the block still committed and advanced')
    })

    it('does not prune when the block rolls back', async () => {
        const table = makeMempoolTable([pendingRow(TX_A, 'SEND|0|TICK|7|dst|memo')])
        const decoder = buildDecoder([TX_A], makeMempoolDb(table))
        decoder.db.insertBlock = async () => false
        const result = await ingestNextBlock.call(decoder, makeLoop())
        assert.strictEqual(result, 'rollback')
        assert.strictEqual(table.rows.has(TX_A), true, 'a tx whose block did not commit is still pending')
    })
})
