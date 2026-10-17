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
const sinon = require('sinon')
const Database = require('../../src/db.js')
const XChainDecoder = require('../../src/XChainDecoder')
const { TX_PARSE_MAX_RETRIES } = require('../../src/XChainDecoder/constants.js')
const { ABOVE_GATE, DELEGATE_A, DELEGATE_B, DispenserModel, SOURCE, buildDecoder, create } = require('./batch_dispenser_registration.test/support/helpers.js')

function lockWait() {
    return Object.assign(new Error('Lock wait timeout exceeded'), { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' })
}

// A Database inside a block transaction whose connection fails every statement `failWhen` matches.
function dbInTransaction(failWhen) {
    const db = new Database('127.0.0.1', 3306, 'test_db', 'u', 'p')
    const statements = []
    db.transactionConnection = {
        query: sinon.stub().callsFake(async (sql, params) => {
            statements.push({ sql: String(sql).trim(), params })
            if (failWhen(String(sql))) throw lockWait()
            if (/^SELECT id FROM/.test(String(sql).trim())) return [{ id: 7 }]
            return []
        }),
        release: sinon.stub().resolves(),
        rollback: sinon.stub().resolves(),
        commit: sinon.stub().resolves(),
    }
    db._transactionLock = true
    return { db, statements }
}

// A failed id lookup inside the block transaction rolls the block back instead of committing a NULL id.
describe('DB lookup failure inside the block transaction', () => {
    afterEach(() => sinon.restore())

    it('insertTransaction rolls back and writes no row when the source address lookup fails', async () => {
        const { db, statements } = dbInTransaction(sql => /FROM index_addresses/.test(sql))
        const result = await db.insertTransaction({ index: 1, hash: 'ab'.repeat(32), block_index: 5, source: 'srcaddr', destination: null, amount: 0, fee: 0, data: 'SEND|x' })
        assert.strictEqual(result, false, 'a transient lookup failure retries the block')
        assert.ok(!statements.some(s => /^INSERT INTO transactions/.test(s.sql)), 'no transactions row is written with a NULL source_id')
        assert.strictEqual(db.transactionConnection, null, 'the block transaction was rolled back')
    })

    it('insertBlock rolls back and writes no row when the block hash lookup fails', async () => {
        const { db, statements } = dbInTransaction(sql => /FROM index_transactions/.test(sql))
        const result = await db.insertBlock({ block_index: 5, block_hash: 'cd'.repeat(32), previous_block_hash: 'ef'.repeat(32), block_time: 1 })
        assert.strictEqual(result, false)
        assert.ok(!statements.some(s => /INSERT INTO blocks/.test(s.sql)), 'no blocks row is written with a NULL block_hash_id')
        assert.strictEqual(db.transactionConnection, null)
    })

    it('insertPubkey keeps swallowing a deterministic content error inside the transaction', async () => {
        const db = new Database('127.0.0.1', 3306, 'test_db', 'u', 'p')
        db.transactionConnection = { query: sinon.stub().rejects(Object.assign(new Error('Data too long'), { errno: 1406 })), release: sinon.stub().resolves() }
        assert.strictEqual(await db.insertPubkey(7, 'aa'), false)
    })
})

describe('DB lookup failure inside the block transaction', function () {
    this.timeout(0)

    it('retries the block past the parse retry budget instead of quarantining the transaction', async function () {
        const decoder = new XChainDecoder('bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
        decoder.startBlockIndex = 0
        decoder.sleep = async () => {}
        const events = []
        let parses = 0
        decoder.connector = { getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }), getBlockHash: async () => 'blockA', getBlock: async () => '' }
        decoder.db = {
            createDatabase: async () => true, verifyDatabase: async () => true, verifyTables: async () => true,
            runMigrations: async () => ({ applied: [], pending: [] }), getLastBlockIndex: async () => -1, getLastTxIndex: async () => 0,
            beginTransaction: async () => {}, endTransaction: async () => {},
            commitTransaction: async () => { decoder.stopFlag = true; return true },
            deleteOpenDispensers: async () => true, purgeExpiredDispensers: async () => true,
            getAllOpenDispenserAddresses: async () => new Set(), insertBlock: async () => true,
            insertEvent: async (code, data) => { events.push({ code, data }); return true },
        }
        decoder.xchainBlockDecoder = { blockFromHex: () => ({ prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: [{ getId: () => 'cafe01', outs: [] }] }) }
        decoder.parseTransaction = async () => {
            parses++
            if (parses <= TX_PARSE_MAX_RETRIES + 2) throw Object.assign(lockWait(), { dbLookupFailure: true })
            return null
        }
        await decoder.start()
        assert.strictEqual(parses, TX_PARSE_MAX_RETRIES + 3, 'the block kept retrying until the lookup recovered')
        assert.deepStrictEqual(events, [], 'a DB lookup failure is never quarantined with PARSE_ERROR')
        assert.strictEqual(decoder.quarantinedTxs || 0, 0)
    })

    it('rolls the block back when a dispenser address lookup fails during the collapse', async function () {
        const model = new DispenserModel()
        // Two operating addresses, so the address-id collapse has to look both up.
        const action = 'BATCH|0|' + create({ getAddress: DELEGATE_A }) + ';' + create({ getAddress: DELEGATE_B })
        const decoder = buildDecoder([{ id: 'tx01', action, source: SOURCE, outputs: [] }], model, ABOVE_GATE)
        let lookups = 0
        let rollbacks = 0
        decoder.db.createAddress = async () => { lookups++; if (lookups === 1) throw Object.assign(lockWait(), { dbLookupFailure: true }); return 40 + lookups }
        decoder.db.endTransaction = async () => { rollbacks++ }
        await decoder.start()
        assert.strictEqual(rollbacks, 1, 'the failed collapse rolled the block back once')
        assert.deepStrictEqual(model.rows.map(r => r.address).sort(), [DELEGATE_A, DELEGATE_B].sort(), 'each dispenser is registered once, on the retry')
    })
})
