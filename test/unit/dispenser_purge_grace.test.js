'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const sinon = require('sinon')

const Database = require('../../src/db.js')
const { storeBlock } = require('../../src/XChainDecoder/block_store.js')
const {
    DISPENSER_CANCEL_GRACE_SECONDS,
    cancelGraceFloor,
    purgeGraceFloor,
} = require('../../src/protocol/dispenser_cancel_grace.js')

function makeDb(){
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p')
}

function injectQuery(db, query){
    const connection = {
        query,
        release: sinon.stub().resolves(),
    }
    db.pool = { getConnection: sinon.stub().resolves(connection) }
    return connection
}

function blockLoopContext(consensusNetwork){
    const purgeExpiredDispensers = sinon.stub().resolves(true)
    return {
        consensusNetwork,
        blockchainInfoLastBlock: 0,
        startBlockIndex: 0,
        lastProcessedBlockIndex: -1,
        dispenserExpireSafeDepth: 1,
        log: () => {},
        db: {
            beginTransaction: sinon.stub().resolves(),
            insertBlock: sinon.stub().resolves(true),
            deleteOpenDispensers: sinon.stub().resolves(true),
            getAllOpenDispenserAddresses: sinon.stub().resolves(new Set()),
            commitTransaction: sinon.stub().resolves(true),
            purgeExpiredDispensers,
        },
        purgeStub: purgeExpiredDispensers,
    }
}

function emptyLoop(){
    return {
        blocksQuantity: 0,
        blocksCount: 0,
        transactionsCount: 0,
        validTransactionsCount: 0,
        outputCount: 0,
        insertQuarantine: new Set(),
        startTimeStamp: Date.now(),
    }
}

describe('dispenser purge grace decision', function () {
    it('uses a gate independent from capture grace', function () {
        const blockTime = 1700000000
        assert.strictEqual(cancelGraceFloor('mainnet', blockTime),
            blockTime - DISPENSER_CANCEL_GRACE_SECONDS)
        assert.strictEqual(purgeGraceFloor('mainnet', blockTime), null)
        assert.strictEqual(purgeGraceFloor('regtest', blockTime),
            blockTime - DISPENSER_CANCEL_GRACE_SECONDS)
    })

    it('activates at the purge gate boundary and rejects invalid times', function () {
        const activation = 9999999999
        assert.strictEqual(purgeGraceFloor('mainnet', activation - 1), null)
        assert.strictEqual(purgeGraceFloor('mainnet', activation),
            activation - DISPENSER_CANCEL_GRACE_SECONDS)
        assert.strictEqual(purgeGraceFloor('unknown', activation), null)
        assert.strictEqual(purgeGraceFloor('regtest', NaN), null)
    })
})

describe('Database#purgeExpiredDispensers() grace predicate', function () {
    afterEach(() => sinon.restore())

    it('keeps the legacy height-only delete when no purge floor is active', async function () {
        const db = makeDb()
        const query = sinon.stub().resolves([])
        injectQuery(db, query)

        assert.strictEqual(await db.purgeExpiredDispensers(900, null), true)

        const [sql, args] = query.firstCall.args
        assert.match(sql, /DELETE\s+FROM\s+dispensers/i)
        assert.doesNotMatch(sql, /JOIN\s+blocks/i)
        assert.deepStrictEqual(args, [900])
    })

    it('requires both the mark time and expiration to be older than the grace floor', async function () {
        const db = makeDb()
        const query = sinon.stub().resolves([])
        injectQuery(db, query)
        const floor = 1700000000

        assert.strictEqual(await db.purgeExpiredDispensers(900, floor), true)

        const [sql, args] = query.firstCall.args
        assert.match(sql, /DELETE\s+d\s+FROM\s+dispensers\s+d/i)
        assert.match(sql, /LEFT\s+JOIN\s+blocks\s+eb\s+ON\s+eb\.block_index\s*=\s*d\.expired_block_index/i)
        assert.match(sql, /d\.expired_block_index\s*<=\s*\?/i)
        assert.match(sql, /d\.expiration\s*<\s*\?/i)
        assert.match(sql, /eb\.block_time\s+IS\s+NULL\s+OR\s+eb\.block_time\s*<\s*\?/i)
        assert.deepStrictEqual(args, [900, floor, floor])
    })
})

describe('block store purge grace plumbing', function () {
    it('passes a grace floor derived from the committed block protocol time', async function () {
        const context = blockLoopContext('regtest')
        const block = { timestamp: 1700000000, transactions: [] }

        await storeBlock.call(context, emptyLoop(), block, 0, 'block-0', 'previous')

        assert.deepStrictEqual(context.purgeStub.firstCall.args, [
            -1,
            block.timestamp - DISPENSER_CANCEL_GRACE_SECONDS,
        ])
    })

    it('passes no floor below the purge gate', async function () {
        const context = blockLoopContext('mainnet')
        const block = { timestamp: 1700000000, transactions: [] }

        await storeBlock.call(context, emptyLoop(), block, 0, 'block-0', 'previous')

        assert.deepStrictEqual(context.purgeStub.firstCall.args, [-1, null])
    })
})
