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
const { TX_PARSE_MAX_RETRIES, STALL_ALERT_MS, BLOCKCHAIN_INFO_REFRESH_MS } = require('../../src/XChainDecoder/constants.js')

// A block with many poison positions pays TX_PARSE_MAX_RETRIES whole-block rollbacks
// per position before each one quarantines. Those retry counts live only in process
// memory. If a ladder that outlasts STALL_ALERT_MS read as a wedge, the liveness consumer
// would restart the container, the restart would drop the retry counts, and the next
// process would start the ladder over from the first position, so the height would never
// commit. A ladder rung is bounded progress
// toward a commit, so it must keep the stall verdict quiet, while a transient fault that
// retries forever must still read as stalled.

// Fake time advanced per block pass: under twice the tip refresh interval so the tip
// stays fresh, and with enough rungs that the whole ladder lasts past STALL_ALERT_MS.
const STEP_MS = 2 * BLOCKCHAIN_INFO_REFRESH_MS - 5000
const POISON_COUNT = Math.ceil((STALL_ALERT_MS * 2) / (STEP_MS * TX_PARSE_MAX_RETRIES)) + 1
const PASS_LIMIT = POISON_COUNT * (TX_PARSE_MAX_RETRIES + 1) + 40

function fakeTx(id){
    return { getId: () => id, outs: [] }
}

function withFakeClock(fn){
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    const advance = (ms) => { offset += ms }
    return Promise.resolve().then(() => fn(advance)).finally(() => { Date.now = realNow })
}

// Drive the real block loop with block 0 already stored and the node tip at height 2,
// so the decoder working on height 1 is two blocks behind the tip and isStalled() is
// able to trip (a decoder with no stored block is never stalled). Height 1 holds the
// test's transactions; the loop stops at the first commit.
function buildDecoder(txIds){
    const decoder = new XChainDecoder('bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const calls = { passes: 0, wedged: false, commit: 0, rollbacks: 0, insertEvent: [] }
    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 2 }),
        getBlockHash: async (height) => 'block' + height,
        getBlock: async () => ''
    }
    decoder.db = {
        createDatabase: async () => true, verifyDatabase: async () => true,
        verifyTables: async () => true, runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => 0, getLastTxIndex: async () => 0,
        beginTransaction: async () => {}, endTransaction: async () => { calls.rollbacks++ },
        commitTransaction: async () => { calls.commit++; decoder.stopFlag = true; return true },
        deleteOpenDispensers: async () => true, purgeExpiredDispensers: async () => true,
        getAllOpenDispenserAddresses: async () => new Set(),
        insertEvent: async (code, data) => { calls.insertEvent.push({ code, data }); return true },
        insertBlock: async () => true,
        // Stored block 0 links to the all-zero prevHash every stub block carries.
        getBlockByIndex: async (height) => (height === 0
            ? { block_index: 0, block_hash: '0'.repeat(64), block_time: 1700000000 }
            : null),
        insertTransaction: async () => true,
        insertTransactionOutput: async () => true,
        DUPLICATED_TRANSACTION: 1, POISON_ROW: 2
    }
    decoder.xchainBlockDecoder = {
        blockFromHex: () => {
            calls.passes++
            if (calls.passes > PASS_LIMIT){ calls.wedged = true; decoder.stopFlag = true }
            return { prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: txIds.map(fakeTx) }
        }
    }
    return { decoder, calls }
}

function quarantined(calls){
    return calls.insertEvent
        .filter(e => e.code === 'PARSE_ERROR')
        .map(e => e.data.tx_position + ':' + e.data.tx_hash)
}

const poisonIds = Array.from({ length: POISON_COUNT }, (_, i) => 'poison' + i)

describe('quarantine ladder longer than the stall window', function () {
    this.timeout(0)

    it('the ladder lasts past STALL_ALERT_MS (precondition of the scenario)', function () {
        const rungs = POISON_COUNT * TX_PARSE_MAX_RETRIES
        assert.ok(STEP_MS < 2 * BLOCKCHAIN_INFO_REFRESH_MS, 'each step keeps the tip fresh')
        assert.ok(rungs * STEP_MS > STALL_ALERT_MS, 'the ladder outlasts the stall window')
    })

    it('never reads as stalled while ladder rollbacks are advancing, and quarantines every position', async function () {
        const { decoder, calls } = buildDecoder(poisonIds)
        const stalledSamples = []
        await withFakeClock(async (advance) => {
            decoder.parseTransaction = async (tx) => {
                // First position of each pass: one block pass of wall time has gone by.
                if (tx.getId() === poisonIds[0]) advance(STEP_MS)
                stalledSamples.push(decoder.isStalled())
                throw new Error('poison ' + tx.getId())
            }
            await decoder.start()
        })
        assert.strictEqual(calls.wedged, false, 'the block must not wedge')
        assert.strictEqual(calls.commit, 1, 'the height commits')
        assert.strictEqual(calls.rollbacks, POISON_COUNT * TX_PARSE_MAX_RETRIES, 'one rollback per ladder rung')
        assert.deepStrictEqual([...new Set(quarantined(calls).map(q => q.split(':')[1]))].sort(), poisonIds.slice().sort())
        assert.ok(stalledSamples.length > 0)
        assert.strictEqual(stalledSamples.filter(Boolean).length, 0,
            'isStalled() must stay false while the ladder advances, or the liveness consumer restarts it mid-ladder')
    })
})

describe('quarantine ladder longer than the stall window', function () {
    this.timeout(0)

    it('quarantine decisions match a decoder whose clock never crossed the stall window', async function () {
        const slow = buildDecoder(poisonIds)
        await withFakeClock(async (advance) => {
            slow.decoder.parseTransaction = async (tx) => {
                if (tx.getId() === poisonIds[0]) advance(STEP_MS)
                throw new Error('poison ' + tx.getId())
            }
            await slow.decoder.start()
        })
        const fast = buildDecoder(poisonIds)
        fast.decoder.parseTransaction = async (tx) => { throw new Error('poison ' + tx.getId()) }
        await fast.decoder.start()

        assert.strictEqual(fast.calls.commit, 1)
        assert.deepStrictEqual(quarantined(slow.calls), quarantined(fast.calls), 'same positions, same order')
        assert.strictEqual(slow.decoder.quarantinedTxs, fast.decoder.quarantinedTxs)
        assert.strictEqual(slow.calls.rollbacks, fast.calls.rollbacks)
    })
})

describe('quarantine ladder longer than the stall window', function () {
    this.timeout(0)

    it('still reads as stalled when a transient fault retries forever behind a quarantined position', async function () {
        // 'aa' is poison and quarantines, then is skipped on every later pass;
        // 'bb' fails an RPC lookup every pass, which retries without limit and is
        // exactly the wedge the stall verdict exists to surface.
        const { decoder, calls } = buildDecoder(['aa', 'bb'])
        const stalledSamples = []
        await withFakeClock(async (advance) => {
            decoder.parseTransaction = async (tx) => {
                if (tx.getId() === 'aa'){
                    advance(STEP_MS)
                    throw new Error('poison aa')
                }
                stalledSamples.push(decoder.isStalled())
                advance(STEP_MS)
                const err = new Error('rpc lookup failed')
                err.rpcLookupFailure = true
                throw err
            }
            await decoder.start()
        })
        assert.strictEqual(calls.wedged, true, 'the block never commits under a transient fault')
        assert.strictEqual(calls.commit, 0)
        assert.strictEqual(stalledSamples[0], false, 'not stalled right after the quarantine step')
        assert.strictEqual(stalledSamples[stalledSamples.length - 1], true,
            'a quarantined position must not keep the stall verdict quiet')
    })
})
