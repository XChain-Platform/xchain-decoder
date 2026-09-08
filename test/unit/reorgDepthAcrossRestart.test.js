// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The safe-depth ceiling must survive a restart that lost the halt marker.
//
// verifyReorg's abort writes a durable REORG_HALT row, and its entry guard reads
// it. That marker is written on the ABORT path, which is exactly the moment the
// database may be the thing failing: markReorgHalted gets two attempts and then
// gives up, recording the halt only in memory and in logs. A restarted decoder
// then found a clean entry guard, started blocksDeleted empty, and finished the
// over-deep rollback past the dispenser purge window.
//
// These pin the second, restart-durable leg: the depth is reconstructed from the
// REORG markers deleteBlockByIndex commits inside each delete's own transaction,
// which no abort-time write failure can lose.

'use strict'

const assert   = require('assert')
const sinon    = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db.js')

const SAFE_DEPTH = 126
// One block above the node tip, so the walk's known above-tip depth never trips
// the pre-delete refusal (a gap the ceiling could not absorb is refused before
// the first delete and is its own test file); the fork below the tip is what
// these cases spend the window on.
const NODE_TIP   = 299

function makeDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
}

// A decoder one block above the node tip whose every stored hash disagrees with
// the node, so verifyReorg deletes the above-tip block and then walks the
// hash-compare back one block per pass until the ceiling fires. `db` overrides
// let each case state only the restart evidence it is about.
function restartedDecoder(db) {
    const decoder = makeDecoder()
    let height = 300
    const deleted = []
    decoder.db = Object.assign({
        getLastBlockIndex:  async () => height,
        getBlockByIndex:    async (i) => (i < 0 ? null : { block_index: i, block_hash: 'aa'.repeat(32) }),
        deleteBlockByIndex: async (i) => { deleted.push(i); height -= 1; return true },
        // A restart that LOST the halt marker: the entry guard sees a clean database,
        // which is the whole premise of the hazard.
        isReorgHalted:      async () => false,
        markReorgHalted:    async () => true
    }, db)
    decoder.connector = { rpcErrors: 0, getBlockHash: async () => 'bb'.repeat(32) }
    // The seed read retries with a 3s sleep; no test may pay for that in wall time.
    decoder.sleep = async () => {}
    return { decoder, deleted }
}

describe('verifyReorg: the safe-depth ceiling survives a lost halt marker', function () {

    it('refuses the FIRST delete when the committed REORG markers already reach the ceiling', async function () {
        const { decoder, deleted } = restartedDecoder({
            countReorgDeletesAboveTip: async () => SAFE_DEPTH
        })

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        assert.strictEqual(deleted.length, 0,
            'a rollback already at the ceiling must not delete one more block after a restart')
        assert.strictEqual(decoder.getReorgHaltStatus().halted, true,
            'the decoder must publish the halt on its health surface')
    })

    it('spends only the depth that is left, then aborts', async function () {
        const { decoder, deleted } = restartedDecoder({
            countReorgDeletesAboveTip: async () => SAFE_DEPTH - 3
        })

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        assert.strictEqual(deleted.length, 3,
            'the remaining budget is the ceiling minus what was already deleted above the tip')
    })

    it('names both halves of the depth in the abort message, so the operator sees the resume', async function () {
        const { decoder } = restartedDecoder({
            countReorgDeletesAboveTip: async () => SAFE_DEPTH - 2
        })

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), (err) => {
            assert.match(err.message, /Already rolled back 126 blocks/)
            assert.match(err.message, /2 in this run/)
            assert.match(err.message, /resumed from 124 already deleted above the tip/)
            return true
        })
    })

    // The pre-fix behaviour, kept explicit: with the marker lost and no durable
    // depth evidence, the run would delete 126 more blocks on top of whatever the
    // aborted one had already taken.
    it('without the durable count, a restart spends a whole fresh budget', async function () {
        const { decoder, deleted } = restartedDecoder({})   // no countReorgDeletesAboveTip

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        assert.strictEqual(deleted.length, SAFE_DEPTH,
            'this is the resume the durable count exists to stop')
    })

    it('deletes nothing at all when the prior depth cannot be read', async function () {
        let attempts = 0
        const { decoder, deleted } = restartedDecoder({
            countReorgDeletesAboveTip: async () => { attempts++; throw new Error('connection lost') }
        })

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP),
            /prior rollback depth could not be read/)

        assert.strictEqual(attempts, 3, 'a transient read fault is retried before the refusal')
        assert.strictEqual(deleted.length, 0,
            'an unknown depth must never be treated as a zero depth')
        // Deliberately NOT a durable halt: a read fault is infrastructure, and a
        // REORG_HALT row would block every later reorg until an operator cleared it.
        assert.strictEqual(decoder.getReorgHaltStatus().halted, false)
    })

    it('recovers when the read fault is transient', async function () {
        let attempts = 0
        const { decoder, deleted } = restartedDecoder({
            countReorgDeletesAboveTip: async () => {
                if (++attempts < 3) throw new Error('connection lost')
                return SAFE_DEPTH - 1
            }
        })

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)
        assert.strictEqual(deleted.length, 1)
    })

    it('still refuses on the halt marker when one DID survive, before counting anything', async function () {
        let counted = false
        const { decoder, deleted } = restartedDecoder({
            isReorgHalted:             async () => true,
            countReorgDeletesAboveTip: async () => { counted = true; return 0 }
        })

        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /HALTED from a prior over-deep reorg abort/)
        assert.strictEqual(counted, false, 'the cheap durable guard still runs first')
        assert.strictEqual(deleted.length, 0)
    })
})

describe('Database#countReorgDeletesAboveTip()', function () {

    afterEach(() => sinon.restore())

    // Answers the two queries the method makes, in order: the tip, then the scan.
    function dbWith(tipRows, eventRows) {
        const db = new Database('127.0.0.1', 3306, 'xchain_btc_mainnet', 'u', 'p')
        const query = sinon.stub().callsFake(async (sql) => {
            if (/MAX\(block_index\)/.test(sql)) return tipRows
            if (/code = 'REORG'/.test(sql))     return eventRows
            throw new Error('unexpected query: ' + sql)
        })
        db.pool = { getConnection: sinon.stub().resolves({ query, release: sinon.stub().resolves() }) }
        return { db, query }
    }

    const marker = (height) => ({ id: height, data: JSON.stringify([{ block_index: height, block_hash: 'bb' }]) })

    it('counts only the marked heights above the current tip', async function () {
        const { db } = dbWith([{ max_height: 200n }], [marker(203), marker(202), marker(201), marker(199)])
        assert.strictEqual(await db.countReorgDeletesAboveTip(), 3)
    })

    it('counts a height once even when it was deleted, re-synced and deleted again', async function () {
        const { db } = dbWith([{ max_height: 200n }], [marker(201), marker(201), marker(202)])
        assert.strictEqual(await db.countReorgDeletesAboveTip(), 2)
    })

    it('returns zero on a database with no REORG markers at all', async function () {
        const { db } = dbWith([{ max_height: 200n }], [])
        assert.strictEqual(await db.countReorgDeletesAboveTip(), 0)
    })

    it('handles the pre-M-12 multi-entry payload shape', async function () {
        const rows = [{ id: 9, data: JSON.stringify([{ block_index: 201 }, { block_index: 202 }, { block_index: 199 }]) }]
        const { db } = dbWith([{ max_height: 200n }], rows)
        assert.strictEqual(await db.countReorgDeletesAboveTip(), 2)
    })

    // "We could not tell" must never arrive at verifyReorg as "no prior rollback".
    it('THROWS on an unparseable marker payload', async function () {
        const { db } = dbWith([{ max_height: 200n }], [{ id: 7, data: '{not json' }])
        await assert.rejects(() => db.countReorgDeletesAboveTip(), /unreadable payload/)
    })

    it('THROWS on a marker payload that is not the expected array', async function () {
        const { db } = dbWith([{ max_height: 200n }], [{ id: 7, data: JSON.stringify({ block_index: 201 }) }])
        await assert.rejects(() => db.countReorgDeletesAboveTip(), /not the expected array payload/)
    })

    it('THROWS on a non-numeric block_index', async function () {
        const { db } = dbWith([{ max_height: 200n }], [{ id: 7, data: JSON.stringify([{ block_index: 'tip' }]) }])
        await assert.rejects(() => db.countReorgDeletesAboveTip(), /non-numeric block_index/)
    })

    it('bounds the scan, and refuses a nonsense bound rather than emitting it as SQL', async function () {
        const { db, query } = dbWith([{ max_height: 200n }], [])
        await db.countReorgDeletesAboveTip(250)
        const scan = query.getCalls().map(c => String(c.args[0])).find(s => /code = 'REORG'/.test(s))
        assert.match(scan, /ORDER BY id DESC LIMIT 250;/)

        await assert.rejects(() => db.countReorgDeletesAboveTip('5; DROP TABLE blocks'),
            /out-of-range scan limit/)
        await assert.rejects(() => db.countReorgDeletesAboveTip(0), /out-of-range scan limit/)
    })

    it('propagates a tip read that could not be answered, rather than counting against a guess', async function () {
        const db = new Database('127.0.0.1', 3306, 'xchain_btc_mainnet', 'u', 'p')
        db.sleep = async () => {}
        const query = sinon.stub().rejects(new Error('connection lost'))
        db.pool = { getConnection: sinon.stub().resolves({ query, release: sinon.stub().resolves() }) }
        await assert.rejects(() => db.countReorgDeletesAboveTip(), /getLastBlockIndex failed/)
    })
})
