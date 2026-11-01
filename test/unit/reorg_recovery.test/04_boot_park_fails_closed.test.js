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
 * test/unit/reorg_recovery.test/04_boot_park_fails_closed.test.js
 *
 * Verify that a restart on a halted database parks before parsing unless it can
 * prove no rolled-back block remains above the stored tip.
 */

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')

const RESET = /xchain-node reset xchain-decoder <chain> <network> --with-indexer --yes/

// A decoder whose start() reaches the parse loop over a stored tip of 100 and a node
// at 150. fetchBlockHex records any attempt to parse forward; the sixth loop sleep stops it.
function bootingDecoder(db){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.verifyChainGenesis = async () => null
    let sleeps = 0
    decoder.sleep = async () => { if (++sleeps >= 6) decoder.stopFlag = true }
    const fetched = []
    const lines = []
    decoder.logError = (l) => lines.push(String(l))
    decoder.connector = {
        rpcErrors: 0,
        getBlockchainInfo: async () => ({ blocks: 150, headers: 150, verificationprogress: 1, initialblockdownload: false }),
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => ''
    }
    decoder.fetchBlockHex = async (hash, height) => { fetched.push(height); throw new Error('test: stop before parsing') }
    decoder.db = Object.assign({
        createDatabase: async () => true, verifyDatabase: async () => true, verifyTables: async () => true,
        runMigrations: async () => ({ applied: [], pending: [] }), getLastBlockIndex: async () => 100,
        getLastTxIndex: async () => 0, endTransaction: async () => {}, ping: async () => true,
        getReorgHaltMarker: async () => ({ halted: true, at: null, reason: 'depth 127' })
    }, db)
    return { decoder, fetched, lines }
}

describe('a restart on a halted database parks unless it reads no rolled-back block above the tip', function () {
    it('a count that cannot be read parks before the first block', async function () {
        const { decoder, fetched, lines } = bootingDecoder({
            countReorgDeletesAboveTip: async () => { throw new Error('harness: injected fault') } })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.deepStrictEqual(fetched, [], 'not one block fetched on a database that may be condemned')
        assert.ok(lines.some((l) => /an unreadable number of rolled-back block/.test(l) && RESET.test(l)))
    })

    it('a count that answers a non-count parks too', async function () {
        const { decoder, fetched } = bootingDecoder({ countReorgDeletesAboveTip: async () => 'NaN' })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.deepStrictEqual(fetched, [])
    })

    it('a database with no count at all parks and names the reset', async function () {
        const { decoder, fetched, lines } = bootingDecoder({})
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, true)
        assert.deepStrictEqual(fetched, [])
        assert.ok(lines.some((l) => /has no countReorgDeletesAboveTip/.test(l) && RESET.test(l)))
    })

    it('a count of zero parses forward, as a halt with nothing rolled back always has', async function () {
        const { decoder, fetched } = bootingDecoder({ countReorgDeletesAboveTip: async () => 0 })
        await decoder.start()
        assert.strictEqual(decoder.reorgHaltParked, false)
        assert.ok(fetched.includes(101))
    })
})
