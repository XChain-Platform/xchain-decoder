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
 * The cursor SQL behind restart-stable tx_index assignment: getLastTxIndex
 * reads the larger of MAX(transactions.tx_index) and the decoder-local block
 * end, and recordBlockTxIndexEnd skips a cursor the NOT NULL column cannot hold.
 */

'use strict'

const assert = require('assert')
const blockQueries = require('../../../src/db/blocks.js')

const START = 100

describe('Database#getLastTxIndex reads the larger of the row and block-end cursors', function () {

    function withRows(rows){
        const seen = []
        const self = {
            transactionConnection: null,
            sleep: async () => {},
            async getConnection(){
                return { query: async (sql) => { seen.push(sql); return rows }, release: async () => {} }
            }
        }
        return { read: () => blockQueries.getLastTxIndex.call(self), seen }
    }

    it('takes a block end above the last stored row', async function () {
        assert.strictEqual(await withRows([{ max_tx_index: 10n, max_tx_index_end: 11n }]).read(), 11)
    })

    it('takes the last stored row when it is the larger', async function () {
        assert.strictEqual(await withRows([{ max_tx_index: 12n, max_tx_index_end: 11n }]).read(), 12)
    })

    it('falls back to the last stored row when no block end is recorded yet', async function () {
        assert.strictEqual(await withRows([{ max_tx_index: 7n, max_tx_index_end: null }]).read(), 7)
    })

    it('uses the block end alone when no row is stored yet', async function () {
        const out = await withRows([{ max_tx_index: null, max_tx_index_end: 0n }]).read()
        assert.strictEqual(out, 0)
        assert.strictEqual(typeof out, 'number')
    })

    it('returns -1 on an empty database', async function () {
        assert.strictEqual(await withRows([{ max_tx_index: null, max_tx_index_end: null }]).read(), -1)
    })

    it('reads both cursors in one statement, the end from the decoder-local table', async function () {
        const probe = withRows([{ max_tx_index: 1n, max_tx_index_end: 1n }])
        await probe.read()
        assert.strictEqual(probe.seen.length, 1)
        assert.ok(/MAX\(tx_index\)[\s\S]*FROM transactions/.test(probe.seen[0]))
        assert.ok(/MAX\(tx_index_end\)[\s\S]*FROM block_tx_index_end/.test(probe.seen[0]))
        assert.ok(!/FROM blocks\b/.test(probe.seen[0]), 'the replicated blocks table is not read')
    })
})

describe('Database#recordBlockTxIndexEnd', function () {

    it('writes nothing for a negative cursor, which the NOT NULL column cannot hold', async function () {
        const seen = []
        const self = {
            transactionConnection: null,
            async getConnection(){
                return { query: async (sql) => { seen.push(sql); return {} }, release: async () => {} }
            }
        }
        assert.strictEqual(await blockQueries.recordBlockTxIndexEnd.call(self, START, -1), true)
        assert.strictEqual(seen.length, 0)
    })
})
