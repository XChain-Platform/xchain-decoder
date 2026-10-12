'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// A failed post-commit expired-dispenser purge is counted and exported, never thrown: the batch
// has already committed, so the loop must carry on and the failure must reach monitoring.

const assert = require('assert')
const sinon = require('sinon')

const { storeBlock } = require('../../src/XChainDecoder/block_store.js')
const { registerDecoderMetrics } = require('../../src/metrics/decoder_metrics')
const { Registry } = require('../../src/observability/metrics')

function blockLoopContext(purgeResult){
    return {
        consensusNetwork: 'regtest',
        blockchainInfoLastBlock: 0,
        startBlockIndex: 0,
        lastProcessedBlockIndex: -1,
        dispenserExpireSafeDepth: 1,
        parseErrors: 0,
        dispenserPurgeFailures: 0,
        log: () => {},
        db: {
            beginTransaction: sinon.stub().resolves(),
            insertBlock: sinon.stub().resolves(true),
            deleteOpenDispensers: sinon.stub().resolves(true),
            getAllOpenDispenserAddresses: sinon.stub().resolves(new Set()),
            commitTransaction: sinon.stub().resolves(true),
            purgeExpiredDispensers: sinon.stub().resolves(purgeResult),
        },
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
        txParseRetryCounts: new Map(),
        insertQuarantineCounts: new Map(),
        startTimeStamp: Date.now(),
    }
}

async function commitOneBlock(context){
    const loop = emptyLoop()
    await storeBlock.call(context, loop, { timestamp: 1700000000, transactions: [] }, 0, 'block-0', 'previous')
    return loop
}

describe('post-commit dispenser purge failure count', function () {
    it('counts a purge that returns false and still finishes the batch', async function () {
        const context = blockLoopContext(false)
        const loop = await commitOneBlock(context)

        assert.strictEqual(context.db.commitTransaction.callCount, 1)
        assert.strictEqual(context.db.purgeExpiredDispensers.callCount, 1)
        assert.strictEqual(context.dispenserPurgeFailures, 1)
        assert.strictEqual(context.parseErrors, 0, 'a purge failure is not a parse error')
        assert.strictEqual(loop.blocksCount, 0, 'the post-commit batch reset still ran')
    })

    it('leaves the count at zero when the purge succeeds', async function () {
        const context = blockLoopContext(true)
        await commitOneBlock(context)

        assert.strictEqual(context.db.purgeExpiredDispensers.callCount, 1)
        assert.strictEqual(context.dispenserPurgeFailures, 0)
    })

    it('exports the count as a Prometheus counter', function () {
        const registry = new Registry()
        registerDecoderMetrics(registry, { parseErrors: 0, rpcErrors: 0, dispenserPurgeFailures: 4 })

        assert.match(registry.render(), /^xchain_decoder_dispenser_purge_failures_total 4$/m)
    })
})
