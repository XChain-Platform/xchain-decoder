'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
const assert = require('assert')
const sinon  = require('sinon')

const Database = require('../../../src/db.js')
const { DISPENSER_CANCEL_GRACE_SECONDS,
        cancelGraceFloor } = require('../../../src/protocol/dispenser_cancel_grace')

const ADDR       = 'bcrt1qgracedispenser'
const EXPIRATION = 1700000000

function makeDb(){ return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p') }
function withConn(queryStub){
    const conn = {
        query: queryStub, release: sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(), commit: sinon.stub().resolves(),
        rollback: sinon.stub().resolves(),
    }
    return { pool: { getConnection: sinon.stub().resolves(conn) } }
}

describe('Database#getAllOpenDispenserAddresses() grace floor', function () {
    afterEach(() => sinon.restore())

    it('runs the unwidened predicate and binds nothing when no floor is given', async () => {
        const db = makeDb()
        const q  = sinon.stub().resolves([{ address: ADDR }])
        db.pool = withConn(q).pool
        await db.getAllOpenDispenserAddresses()
        const [sql, params] = q.firstCall.args
        assert.ok(/expired_block_index IS NULL/.test(sql))
        assert.ok(!/expiration >= \?/.test(sql),
            'the below-gate query must not carry the grace clause')
        assert.strictEqual(params, undefined, 'the below-gate query must bind no parameter')
    })

    it('adds the grace clause and binds the floor when one is given', async () => {
        const db = makeDb()
        const q  = sinon.stub().resolves([{ address: ADDR }])
        db.pool = withConn(q).pool
        const floor = cancelGraceFloor('regtest', EXPIRATION + 1800)
        await db.getAllOpenDispenserAddresses(floor)
        const [sql, params] = q.firstCall.args
        assert.ok(/LEFT JOIN blocks eb ON eb\.block_index = op\.expired_block_index/.test(sql),
            'the above-gate query must join the mark block so its header time is readable')
        assert.ok(/expired_block_index IS NULL\s*\n\s*OR eb\.block_time >= \?\s*\n\s*OR op\.expiration >= \?/.test(sql),
            'the above-gate query must admit rows whose mark time, or expiration, is no older than the floor')
        const expectedFloor = EXPIRATION + 1800 - DISPENSER_CANCEL_GRACE_SECONDS
        assert.deepStrictEqual(params, [expectedFloor, expectedFloor],
            'the floor binds once per disjunct, in the order the clauses appear')
    })
})

describe('Database#getAllOpenDispenserAddresses() grace floor', function () {
    afterEach(() => sinon.restore())

    it('treats a null or non-finite floor as no grace at all', async () => {
        // cancelGraceFloor returns null below the gate, so this is the fail-closed path that
        // keeps an unarmed network on the legacy capture set.
        for (const floor of [null, undefined, NaN, 'soon']){
            const db = makeDb()
            const q  = sinon.stub().resolves([])
            db.pool = withConn(q).pool
            await db.getAllOpenDispenserAddresses(floor)
            const [sql, params] = q.firstCall.args
            assert.ok(!/expiration >= \?/.test(sql), `floor ${String(floor)} must not widen the query`)
            assert.strictEqual(params, undefined)
        }
    })

    it('still returns null on a query fault, with or without a floor', async () => {
        // A failed read and an empty set must stay distinguishable; the grace path must not
        // quietly become an empty-set success.
        for (const floor of [null, EXPIRATION]){
            const db = makeDb()
            db.pool = withConn(sinon.stub().rejects(new Error('fail'))).pool
            assert.strictEqual(await db.getAllOpenDispenserAddresses(floor), null)
        }
    })
})
