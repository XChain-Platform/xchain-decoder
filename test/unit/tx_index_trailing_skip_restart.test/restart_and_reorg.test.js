/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * tx_index assignment must not depend on restart or rollback history.
 *
 * A carrier whose ACTION name is unknown consumes a tx_index but writes no
 * row. When it is the last storable carrier of a block, a cursor re-read from
 * MAX(transactions.tx_index) alone hands that consumed index to the next
 * carrier, so a decoder restarted right after such a block numbers every later
 * row one lower than a decoder that never restarted.
 *
 * The blocks below run through the real parse loop step (ingestNextBlock,
 * storeBlock, ingestTransaction and the real storage gate) and the real
 * getLastTxIndex, recordBlockTxIndexEnd and deleteBlockByIndex SQL over an
 * in-memory connection; only the node, the transaction parser and the row
 * writers are stand-ins.
 */

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')
const { ingestNextBlock } = require('../../../src/XChainDecoder/block_ingest.js')
const blockQueries = require('../../../src/db/blocks.js')

const START = 100
const BLOCK_TIME = 1700000000

function blockHash(height){
    return 'a' + String(height).padStart(63, '0')
}

// One carrier: V* are valid BROADCASTs, U* name an ACTION nobody defines.
function carrier(id){
    return { id, outs: [], getId: () => id }
}

function payloadFor(id){
    return id.startsWith('U') ? 'ZZZTEST|' + id : 'BROADCAST|' + id
}

function maxOf(values){
    const present = values.filter(v => v != null)
    return present.length ? BigInt(Math.max(...present)) : null
}

// The rows a statement sees: the open block transaction's copy, else the committed set.
function view(tables){
    return tables.pending || tables.committed
}

// Answer the cursor read in both its unfixed single-MAX form and its fixed two-subselect form,
// so a revert of the fix fails on a tx_index assertion rather than on an unknown query.
function answerCursorRead(v, s){
    const out = { max_tx_index: maxOf(v.transactions.map(t => t.tx_index)) }
    if (/MAX\(tx_index_end\) FROM block_tx_index_end/.test(s)){
        out.max_tx_index_end = maxOf([...v.ends.values()])
    }
    return [out]
}

// Answer the writes the real recordBlockTxIndexEnd and deleteBlockByIndex send.
function answerWrite(v, s, params){
    if (/^INSERT INTO block_tx_index_end \(block_index, tx_index_end\) VALUES \(\?, \?\)/.test(s)){
        v.ends.set(params[0], params[1])
        return { affectedRows: 1 }
    }
    if (/^DELETE FROM block_tx_index_end WHERE block_index = \?;$/.test(s)) return v.ends.delete(params[0]), {}
    if (/^DELETE FROM blocks WHERE block_index = \?;$/.test(s)) return v.blocks.delete(params[0]), {}
    if (/^DELETE FROM transactions WHERE block_index = \?;$/.test(s)){
        v.transactions = v.transactions.filter(t => t.block_index !== params[0])
        return {}
    }
    // The dispenser and output statements of a reorg touch nothing this test stores.
    if (/^(UPDATE dispensers|DELETE FROM (transaction_outputs|dispensers) )/.test(s)) return {}
    return null
}

function answerQuery(tables, sql, params){
    const s = sql.replace(/\s+/g, ' ').trim()
    const v = view(tables)
    if (/MAX\(tx_index\)/.test(s) && /FROM transactions/.test(s)) return answerCursorRead(v, s)
    const written = answerWrite(v, s, params)
    if (written) return written
    throw new Error('unexpected query: ' + s)
}

function copyTables(c){
    return {
        blocks: new Map([...c.blocks].map(([k, b]) => [k, Object.assign({}, b)])),
        transactions: c.transactions.map(t => Object.assign({}, t)),
        ends: new Map(c.ends)
    }
}

function transactionMethods(tables, connection){
    return {
        async beginTransaction(){
            tables.pending = copyTables(tables.committed)
            this.transactionConnection = connection
        },
        async commitTransaction(){
            if (!tables.pending) return false
            tables.committed = tables.pending
            tables.pending = null
            this.transactionConnection = null
            return true
        },
        async endTransaction(){
            tables.pending = null
            this.transactionConnection = null
        }
    }
}

function rowMethods(tables){
    return {
        async insertBlock(block){
            view(tables).blocks.set(block.block_index, {
                block_index: block.block_index,
                block_hash: block.block_hash,
                block_time: block.block_time
            })
            return true
        },
        async getBlockByIndex(height){
            const row = view(tables).blocks.get(height)
            return row ? Object.assign({}, row) : null
        },
        async insertTransaction(tx){
            view(tables).transactions.push({ tx_index: tx.index, hash: tx.hash, block_index: tx.block_index })
            return true
        },
        async getLastBlockIndex(){
            const heights = [...tables.committed.blocks.keys()]
            return heights.length ? Math.max(...heights) : -1
        }
    }
}

function makeStore(){
    const tables = { committed: { blocks: new Map(), transactions: [], ends: new Map() }, pending: null }
    const connection = { query: async (sql, params) => answerQuery(tables, sql, params), release: async () => {} }
    const db = Object.assign(
        {
            transactionConnection: null,
            POISON_ROW: Symbol('poison'),
            DUPLICATED_TRANSACTION: Symbol('dup'),
            sleep: async () => {},
            getConnection: async () => connection,
            deleteOpenDispensers: async () => true,
            getAllOpenDispenserAddresses: async () => [],
            purgeExpiredDispensers: async () => 0,
            restoreDispenserExtensions: async () => {},
            insertEvent: async () => true,
            getLastTxIndex: blockQueries.getLastTxIndex,
            recordBlockTxIndexEnd: blockQueries.recordBlockTxIndexEnd,
            deleteBlockByIndex: blockQueries.deleteBlockByIndex
        },
        transactionMethods(tables, connection),
        rowMethods(tables))
    // Read-only accessors for assertions: always the committed rows.
    const store = {
        get transactions(){ return tables.committed.transactions },
        get ends(){ return tables.committed.ends }
    }
    return { db, store }
}

function stubParser(decoder, chain){
    decoder.xchainBlockDecoder = {
        blockFromHex: (hash) => {
            const height = Number(Object.keys(chain).find(h => chain[h].hash === hash))
            const prev = height === START ? '00'.repeat(32) : chain[height - 1].hash
            return {
                prevHash: Buffer.from(prev, 'hex').reverse(),
                timestamp: BLOCK_TIME + height,
                transactions: chain[height].carriers.map(carrier)
            }
        }
    }
    decoder.parseTransaction = async (tx) => {
        const data = Buffer.from(payloadFor(tx.id))
        return {
            data, source: 'addr-' + tx.id, destination: null, amount: 0,
            compiledDataLength: data.length, dispenseOutputs: [], paymentOutputs: []
        }
    }
}

// chain: height -> { hash, carriers }. Every block commits as soon as it is parsed
// because the test keeps the node tip on the block being parsed.
function makeDecoder(db, chain){
    const decoder = new XChainDecoder(
        'litecoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = START
    decoder.sleep = async () => {}
    decoder.log = () => {}
    decoder.db = db
    decoder.connector = { rpcErrors: 0, getBlockHash: async (h) => chain[h].hash }
    decoder.fetchBlockHex = async (hash) => hash
    stubParser(decoder, chain)
    decoder.resolveOracleFeeAddressesForCommands = async () => []
    return decoder
}

function newLoop(lastBlock, lastTx){
    return {
        txParseRetryCounts: new Map(),
        insertQuarantineCounts: new Map(),
        insertQuarantine: new Set(),
        parseQuarantine: new Set(),
        tipBelowStoredTipRefused: false,
        lastProcessedBlockIndex: lastBlock,
        lastProcessedTxIndex: lastTx,
        blocksQuantity: 0,
        blocksCount: 0,
        transactionsCount: 0,
        validTransactionsCount: 0,
        outputCount: 0,
        startTimeStamp: Date.now()
    }
}

// Parse one block at the node tip (committed at once, as on a caught-up decoder).
async function parse(decoder, loop, height){
    decoder.blockchainInfoLastBlock = height
    const directive = await ingestNextBlock.call(decoder, loop)
    assert.strictEqual(directive, undefined, 'block ' + height + ' parsed and stored')
    assert.strictEqual(loop.lastProcessedBlockIndex, height)
}

// What a restarted process does: rebuild the loop cursors from the database.
async function restart(db){
    return newLoop(await db.getLastBlockIndex(), await db.getLastTxIndex())
}

function txIndexOf(store, id){
    const row = store.transactions.find(t => t.hash === id)
    assert.ok(row, 'row for ' + id)
    return row.tx_index
}

function canonicalChain(){
    return {
        [START]:     { hash: blockHash(START),     carriers: ['V0'] },
        [START + 1]: { hash: blockHash(START + 1), carriers: ['V1', 'U1'] },
        [START + 2]: { hash: blockHash(START + 2), carriers: ['V2'] },
        [START + 3]: { hash: blockHash(START + 3), carriers: ['V3', 'U3'] },
        [START + 4]: { hash: blockHash(START + 4), carriers: ['V4'] }
    }
}

async function runWithoutRestart(){
    const chain = canonicalChain()
    const { db, store } = makeStore()
    const decoder = makeDecoder(db, chain)
    const loop = newLoop(START - 1, -1)
    for (let h = START; h <= START + 4; h++) await parse(decoder, loop, h)
    return store
}

function assertSameIndexes(store, control, history){
    for (const id of ['V0', 'V1', 'V2', 'V3', 'V4']){
        assert.strictEqual(txIndexOf(store, id), txIndexOf(control, id),
            id + ' gets the same tx_index as on a decoder that never ' + history)
    }
}

describe('decoder tx_index assignment does not depend on restart history', function () {

    it('control: a trailing skipped carrier consumes one tx_index on an unrestarted decoder', async function () {
        const store = await runWithoutRestart()
        assert.strictEqual(txIndexOf(store, 'V2'), txIndexOf(store, 'V1') + 2)
        assert.strictEqual(txIndexOf(store, 'V4'), txIndexOf(store, 'V3') + 2)
        assert.strictEqual(store.transactions.some(t => t.hash.startsWith('U')), false, 'skipped carriers write no row')
        assert.strictEqual(store.ends.get(START + 1), txIndexOf(store, 'V1') + 1, 'block end counts U1')
    })

    it('a restart right after a block that ends in a skipped carrier keeps the consumed index', async function () {
        const control = await runWithoutRestart()

        const chain = canonicalChain()
        const { db, store } = makeStore()
        let decoder = makeDecoder(db, chain)
        let loop = newLoop(START - 1, -1)
        for (let h = START; h <= START + 1; h++) await parse(decoder, loop, h)

        // Process stops after [V1, U1] commits and boots again before START + 2.
        decoder = makeDecoder(db, chain)
        loop = await restart(db)
        assert.strictEqual(loop.lastProcessedTxIndex, txIndexOf(store, 'V1') + 1,
            'the re-read cursor counts the index U1 consumed')
        for (let h = START + 2; h <= START + 4; h++) await parse(decoder, loop, h)

        assert.strictEqual(txIndexOf(store, 'V2'), txIndexOf(store, 'V1') + 2)
        assertSameIndexes(store, control, 'restarted')
    })
})

describe('decoder tx_index assignment after a rollback', function () {

    it('a reorg of the trailing-skip block and its re-parse assign the never-rolled-back indexes', async function () {
        const control = await runWithoutRestart()

        // Parse to START + 3 ([V3, U3]), then reorg START + 3 away and re-parse it.
        const chain = canonicalChain()
        const { db, store } = makeStore()
        const decoder = makeDecoder(db, chain)
        let loop = newLoop(START - 1, -1)
        for (let h = START; h <= START + 3; h++) await parse(decoder, loop, h)

        await db.deleteBlockByIndex(START + 3)
        assert.strictEqual(store.ends.has(START + 3), false, 'the reorg deletes the block end with the block')
        loop = await restart(db)
        assert.strictEqual(loop.lastProcessedBlockIndex, START + 2)
        assert.strictEqual(loop.lastProcessedTxIndex, txIndexOf(store, 'V2'))
        for (let h = START + 3; h <= START + 4; h++) await parse(decoder, loop, h)
        assertSameIndexes(store, control, 'rolled back')
    })

    it('a reorg down to a block that ends in a skip keeps that skip', async function () {
        const control = await runWithoutRestart()
        const chain = canonicalChain()
        const { db } = makeStore()
        const decoder = makeDecoder(db, chain)
        const loop = newLoop(START - 1, -1)
        for (let h = START; h <= START + 4; h++) await parse(decoder, loop, h)

        for (const h of [START + 4, START + 3, START + 2]) await db.deleteBlockByIndex(h)
        const reread = await restart(db)
        assert.strictEqual(reread.lastProcessedBlockIndex, START + 1)
        assert.strictEqual(reread.lastProcessedTxIndex, txIndexOf(control, 'V1') + 1)
    })
})
