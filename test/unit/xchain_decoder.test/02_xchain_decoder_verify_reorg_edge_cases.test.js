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
const sinon  = require('sinon')
const XChainDecoder = require('../../../src/XChainDecoder')

// ─── verifyReorg edge cases ──────────────────────────────────────────────────
    // Helper: minimal decoder with stubbed db + connector
function makeReorgDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', 3306, 'db', 'u', 'p',
        '127.0.0.1', 18443, 'rpc', 'rpc', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    return decoder
}

describe('XChainDecoder#verifyReorg() edge cases', () => {
    it('should return true immediately when DB is empty (getLastBlockIndex returns -1)', async () => {
        const decoder = makeReorgDecoder()
        decoder.db = {
            getLastBlockIndex: sinon.stub().resolves(-1),
            getBlockByIndex: sinon.stub().resolves(null),
            // Since M-12 the REORG marker is written inside deleteBlockByIndex, atomically with the
            // delete. verifyReorg must NOT write a separate end-of-run event (that once-at-end write
            // was the non-crash-durable path this fix removed).
            insertEvent: sinon.stub().resolves(true)
        }
        decoder.connector = { getBlockHash: sinon.stub().resolves('hash') }

        const result = await decoder.verifyReorg()
        assert.strictEqual(result, true)
        // insertEvent must NOT be called (nothing was deleted)
        assert.strictEqual(decoder.db.insertEvent.called, false)
    })

    it('should stop backward walk when blockIndex drops below startBlockIndex', async () => {
        const decoder = makeReorgDecoder()
        decoder.startBlockIndex = 100

        // DB says block 99 is our last block, but 99 < startBlockIndex 100 → stop
        decoder.db = {
            getLastBlockIndex: sinon.stub().resolves(99),
            getBlockByIndex: sinon.stub().resolves({ block_hash: 'db_hash99' }),
            insertEvent: sinon.stub().resolves(true)
        }
        decoder.connector = { getBlockHash: sinon.stub().resolves('node_hash99') }

        const result = await decoder.verifyReorg()
        assert.strictEqual(result, true)
        // No blocks deleted; insertEvent should NOT be called
        assert.strictEqual(decoder.db.insertEvent.called, false)
    })

    it('should stop when hashes match (no reorg needed)', async () => {
        const decoder = makeReorgDecoder()
        decoder.db = {
            getLastBlockIndex: sinon.stub().resolves(50),
            getBlockByIndex: sinon.stub().resolves({ block_hash: 'samehash' }),
            insertEvent: sinon.stub().resolves(true)
        }
        decoder.connector = { getBlockHash: sinon.stub().resolves('samehash') }

        const result = await decoder.verifyReorg()
        assert.strictEqual(result, true)
        assert.strictEqual(decoder.db.insertEvent.called, false)
    })
})

describe('XChainDecoder#verifyReorg() edge cases', () => {
    it('should retry (continue) when getBlockHash throws an RPC error', async () => {
        const decoder = makeReorgDecoder()
        let callCount = 0

        decoder.db = {
            getLastBlockIndex: sinon.stub().resolves(50),
            getBlockByIndex: sinon.stub().resolves({ block_hash: 'samehash' }),
            insertEvent: sinon.stub().resolves(true)
        }
        decoder.connector = {
            getBlockHash: sinon.stub().callsFake(async () => {
                callCount++
                if (callCount === 1) throw new Error('RPC error')
                return 'samehash' // matches on second call → stop
            })
        }

        const result = await decoder.verifyReorg()
        assert.strictEqual(result, true)
        assert.ok(callCount >= 2, 'should have retried at least once')
    })
})

describe('XChainDecoder#verifyReorg() edge cases', () => {
    it('should delete a single orphan block and write its REORG marker atomically', async () => {
        const decoder = makeReorgDecoder()
        let deletedBlock = null

        // Block 10 disagrees; block 9 matches
        const calls = { getLastBlockIndex: 0, getBlockByIndex: 0 }
        decoder.db = {
            getLastBlockIndex: sinon.stub().callsFake(async () => {
                calls.getLastBlockIndex++
                return calls.getLastBlockIndex === 1 ? 10 : 9
            }),
            getBlockByIndex: sinon.stub().callsFake(async (h) => {
                if (h === 10) return { block_hash: 'stale10' }
                if (h === 9)  return { block_hash: 'good9' }
                return null
            }),
            deleteBlockByIndex: sinon.stub().callsFake(async (h) => {
                deletedBlock = h
            }),
            // The REORG marker is written inside deleteBlockByIndex, atomically with the delete.
            // verifyReorg must NOT write a separate end-of-run event: that once-at-end write was
            // lost entirely when the process died mid-reorg.
            insertEvent: sinon.stub().resolves(true)
        }
        decoder.connector = {
            getBlockHash: sinon.stub().callsFake(async (h) => {
                if (h === 10) return 'node_hash10'  // differs → reorg
                if (h === 9)  return 'good9'         // matches → stop
                return 'match'
            })
        }

        const result = await decoder.verifyReorg()
        assert.strictEqual(result, true)
        assert.strictEqual(deletedBlock, 10)
        assert.ok(decoder.db.insertEvent.notCalled, 'no separate end-of-run REORG event')
        // The deleted block's hash is handed to deleteBlockByIndex so the marker can be written
        // atomically with the delete.
        assert.ok(decoder.db.deleteBlockByIndex.calledOnceWith(10, 'stale10'))
    })
})
