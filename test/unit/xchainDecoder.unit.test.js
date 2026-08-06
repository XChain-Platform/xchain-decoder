// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Unit tests for XChainDecoder methods not covered by parseTransaction.test.js:
//   - isSynced / getSyncStatus / stop
//   - millisecondsToTimeString
//   - extractPubkeyFromInput
//   - findFundingFeeOutputs
//   - verifyReorg edge cases (empty DB, below-start guard, getBlockHash RPC error)
//   - MAX_ACTION_DATA_LENGTH export constant

const assert = require('assert')
const sinon  = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc    = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// ─── helpers ────────────────────────────────────────────────────────────────

function createDecoder(feeDestination) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', 3306, 'db', 'u', 'p',
        '127.0.0.1', 18443, 'rpc', 'rpc', false, feeDestination || null
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false),
        getAddressId:   sinon.stub().resolves(null),
        hasPubkey:      sinon.stub().resolves(false),
        insertPubkey:   sinon.stub().resolves(true),
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('mocked'))
    }
    // A failed prevout lookup now throws (tagged rpcLookupFailure) instead of
    // resolving a null source; stub source resolution to the deterministic
    // null the parse-focused tests rely on. findFundingFeeOutputs tests call
    // that method directly, so this stub does not shadow them.
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

// Build a tx whose first input's hash is PREV_HASH (same convention used in parseTransaction.test.js)
const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

// ─── isSynced / getSyncStatus / stop ────────────────────────────────────────

describe('XChainDecoder status methods', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => { sinon.restore() })

    it('isSynced() returns false initially', () => {
        assert.strictEqual(decoder.isSynced(), false)
    })

    it('isSynced() returns true after synced flag is set', () => {
        decoder.synced = true
        assert.strictEqual(decoder.isSynced(), true)
    })

    it('getSyncStatus() returns null fields before any block is processed', () => {
        const status = decoder.getSyncStatus()
        assert.strictEqual(status.last_processed_block, null)
        assert.strictEqual(status.node_height, null)
        assert.strictEqual(status.lag, null)
    })

    it('getSyncStatus() returns real fields once a block is processed', () => {
        decoder.lastProcessedBlockIndex = 100
        decoder.blockchainInfoLastBlock = 110
        const status = decoder.getSyncStatus()
        assert.strictEqual(status.last_processed_block, 100)
        assert.strictEqual(status.node_height, 110)
        assert.strictEqual(status.lag, 10)
    })

    it('getSyncStatus() lag is zero when fully caught up', () => {
        decoder.lastProcessedBlockIndex = 200
        decoder.blockchainInfoLastBlock = 200
        const status = decoder.getSyncStatus()
        assert.strictEqual(status.lag, 0)
    })

    it('stop() sets stopFlag to true', () => {
        assert.strictEqual(decoder.stopFlag, false)
        decoder.stop()
        assert.strictEqual(decoder.stopFlag, true)
    })
})

// ─── isStalled (the liveness signal /live reports) ───────────────────────────
//
// The block loop never skips a block on a fetch/parse fault, so a deterministic
// fault at one height retries forever with the process alive and the DB
// reachable. /status cannot see that; isStalled() is what /live adds.

describe('XChainDecoder#isStalled()', () => {
    let decoder
    const STALL_MS = 900000   // must track STALL_ALERT_MS in XChainDecoder.js

    beforeEach(() => {
        decoder = createDecoder()
    })

    // A wedged decoder: tip fresh and 50 blocks ahead, no advance in 16 minutes.
    function wedged() {
        decoder.lastProcessedBlockIndex = 100
        decoder.blockchainInfoLastBlock = 150
        decoder.blockchainInfoLastRefreshAt = Date.now()
        decoder.lastAdvanceAt = Date.now() - (STALL_MS + 60000)
    }

    it('is false before the block loop has started', () => {
        assert.strictEqual(decoder.lastAdvanceAt, 0)
        assert.strictEqual(decoder.isStalled(), false)
    })

    it('is true when the tip is fresh and ahead but nothing advanced', () => {
        wedged()
        assert.strictEqual(decoder.isStalled(), true)
    })

    it('is false while the loop is still advancing', () => {
        wedged()
        decoder.lastAdvanceAt = Date.now()
        assert.strictEqual(decoder.isStalled(), false)
    })

    it('is false when caught up (no blocks to advance to)', () => {
        wedged()
        decoder.blockchainInfoLastBlock = 100
        assert.strictEqual(decoder.isStalled(), false)
    })

    it('is false during a node outage (frozen tip): a restart fixes nothing', () => {
        wedged()
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * 30000)
        assert.strictEqual(decoder.isStalled(), false)
    })

    it('is true once one height has failed to fetch enough times in a row', () => {
        // The self-resetting counter is a FASTER path to the same verdict, not a
        // bypass: it still requires a started loop and a tip that is fresh and ahead,
        // and it then flags the wedge without waiting out the elapsed-time window.
        wedged()
        decoder.lastAdvanceAt = Date.now()  // too recent for the elapsed-time path
        decoder._fetchErrorCount = 20
        assert.strictEqual(decoder.isStalled(), true)
        decoder._fetchErrorCount = 0        // a successful fetch clears it
        assert.strictEqual(decoder.isStalled(), false)
    })

    // Regression guard for . The counter is bumped by the catch around
    // getBlockHash/fetchBlockHex, which a TRANSPORT fault also trips (that catch's own
    // comment records a Dogecoin 1.14 node under RPC-queue pressure arriving as a bare
    // ECONNRESET). While such a fault lasts the tip goes stale, and the healthcheck
    // this feeds is autoheal-armed, so a counter ranked ABOVE the freshness gate would
    // restart the container roughly every two minutes for the whole outage and fix
    // nothing. These two cases pin the ordering.
    it('is false during a node outage even with the fetch counter maxed', () => {
        wedged()
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * 30000)   // frozen tip
        decoder._fetchErrorCount = 20
        assert.strictEqual(decoder.isStalled(), false)
    })

    it('is false before the loop has started even with the fetch counter maxed', () => {
        decoder._fetchErrorCount = 20
        assert.strictEqual(decoder.lastAdvanceAt, 0)
        assert.strictEqual(decoder.isStalled(), false)
    })
})

// ─── millisecondsToTimeString ────────────────────────────────────────────────

describe('XChainDecoder#millisecondsToTimeString()', () => {
    let decoder

    before(() => {
        decoder = createDecoder()
    })

    it('should format 0ms as "0d00h00m00.0s"', () => {
        // 0ms → days=0, hours=0, minutes=0, seconds=0
        const result = decoder.millisecondsToTimeString(0)
        assert.strictEqual(result, '0d00h00m00.0s')
    })

    it('should format 1 second (1000ms)', () => {
        const result = decoder.millisecondsToTimeString(1000)
        assert.ok(result.includes('01.0s'), `Expected "01.0s" in "${result}"`)
    })

    it('should format 1 minute (60000ms)', () => {
        const result = decoder.millisecondsToTimeString(60000)
        assert.ok(result.includes('01m'), `Expected "01m" in "${result}"`)
        assert.ok(result.includes('00.0s'), `Expected "00.0s" in "${result}"`)
    })

    it('should format 1 hour (3600000ms)', () => {
        const result = decoder.millisecondsToTimeString(3600000)
        assert.ok(result.includes('01h'), `Expected "01h" in "${result}"`)
    })

    it('should format 1 day (86400000ms)', () => {
        const result = decoder.millisecondsToTimeString(86400000)
        assert.ok(result.includes('1d'), `Expected "1d" in "${result}"`)
    })

    it('should format 90 seconds (1m 30s)', () => {
        const result = decoder.millisecondsToTimeString(90000)
        assert.ok(result.includes('01m'), `Expected "01m" in "${result}"`)
        assert.ok(result.includes('30.0s'), `Expected "30.0s" in "${result}"`)
    })

    it('should format mixed hours, minutes, seconds', () => {
        // 2h 3m 4s = 7384000ms
        const result = decoder.millisecondsToTimeString(7384000)
        assert.ok(result.includes('02h'), `Expected "02h" in "${result}"`)
        assert.ok(result.includes('03m'), `Expected "03m" in "${result}"`)
        assert.ok(result.includes('04.0s'), `Expected "04.0s" in "${result}"`)
    })

    it('should return a string', () => {
        assert.strictEqual(typeof decoder.millisecondsToTimeString(5000), 'string')
    })
})

// ─── extractPubkeyFromInput ──────────────────────────────────────────────────

describe('XChainDecoder#extractPubkeyFromInput()', () => {
    let decoder

    before(() => {
        decoder = createDecoder()
    })

    it('should return compressed pubkey (33 bytes) from P2WPKH witness', () => {
        const pubkey = Buffer.alloc(33, 0x02)
        const input = {
            witness: [Buffer.alloc(71, 0x30), pubkey],
            script: Buffer.alloc(0)
        }
        const result = decoder.extractPubkeyFromInput(input)
        assert.strictEqual(result, pubkey.toString('hex'))
    })

    it('should return uncompressed pubkey (65 bytes) from P2WPKH witness', () => {
        const pubkey = Buffer.alloc(65, 0x04)
        const input = {
            witness: [Buffer.alloc(71, 0x30), pubkey],
            script: Buffer.alloc(0)
        }
        const result = decoder.extractPubkeyFromInput(input)
        assert.strictEqual(result, pubkey.toString('hex'))
    })

    it('should return null for witness with only one element (no pubkey slot)', () => {
        const input = {
            witness: [Buffer.alloc(33, 0x02)],
            script: Buffer.alloc(0)
        }
        const result = decoder.extractPubkeyFromInput(input)
        assert.strictEqual(result, null)
    })

    it('should extract pubkey from P2PKH scriptSig', () => {
        const pubkey = Buffer.alloc(33, 0x02)
        const sig    = Buffer.alloc(71, 0x30)
        const scriptSig = bitcoin.script.compile([sig, pubkey])
        const input = {
            witness: [],
            script: scriptSig
        }
        const result = decoder.extractPubkeyFromInput(input)
        assert.strictEqual(result, pubkey.toString('hex'))
    })

    it('should return null for an input with empty witness and empty script', () => {
        const input = { witness: [], script: Buffer.alloc(0) }
        const result = decoder.extractPubkeyFromInput(input)
        assert.strictEqual(result, null)
    })

    it('should return null when witness second element is wrong length', () => {
        const input = {
            witness: [Buffer.alloc(71, 0x30), Buffer.alloc(10, 0x02)], // 10 bytes (not 33 or 65)
            script: Buffer.alloc(0)
        }
        const result = decoder.extractPubkeyFromInput(input)
        assert.strictEqual(result, null)
    })

    it('should return null when scriptSig decompiles to only 1 element', () => {
        const scriptSig = bitcoin.script.compile([Buffer.alloc(33, 0x02)])
        const input = {
            witness: [],
            script: scriptSig
        }
        const result = decoder.extractPubkeyFromInput(input)
        // Last element is the 33-byte buffer but length === 1, so >= 2 fails
        assert.strictEqual(result, null)
    })
})

// ─── findFundingFeeOutputs ───────────────────────────────────────────────────

describe('XChainDecoder#findFundingFeeOutputs()', () => {
    const FEE_ADDR = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'  // regtest-style, not real

    afterEach(() => { sinon.restore() })

    it('should return [] when feeDestination is null (disabled)', async () => {
        const decoder = createDecoder(null)
        const result = await decoder.findFundingFeeOutputs('anytxid')
        assert.deepStrictEqual(result, [])
    })

    it('should return [] when fundingTxId is null', async () => {
        const decoder = createDecoder(FEE_ADDR)
        const result = await decoder.findFundingFeeOutputs(null)
        assert.deepStrictEqual(result, [])
    })

    it('should throw a tagged rpcLookupFailure when getRawTransaction throws (H-6: fee presence must not depend on RPC health)', async () => {
        const decoder = createDecoder(FEE_ADDR)
        decoder.connector.getRawTransaction = sinon.stub().rejects(new Error('not found'))
        await assert.rejects(
            () => decoder.findFundingFeeOutputs('sometxid'),
            (err) => err.rpcLookupFailure === true
        )
        assert.strictEqual(decoder.rpcErrors, 1)
    })

    it('should throw a tagged rpcLookupFailure when getRawTransaction returns null (a confirmed funding tx always exists)', async () => {
        const decoder = createDecoder(FEE_ADDR)
        decoder.connector.getRawTransaction = sinon.stub().resolves(null)
        await assert.rejects(
            () => decoder.findFundingFeeOutputs('sometxid'),
            (err) => err.rpcLookupFailure === true
        )
    })

    it('should return [] when no output matches feeDestination', async () => {
        // Build a simple tx with a P2PKH output to a non-fee address
        const tx = new bitcoin.Transaction()
        tx.version = 2
        tx.addInput(PREV_HASH, 0)
        // P2PKH output with all-0xaa hash (decodes to some address, but not FEE_ADDR)
        tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 50000)

        const decoder = createDecoder(FEE_ADDR)
        decoder.connector.getRawTransaction = sinon.stub().resolves(tx.toHex())

        const result = await decoder.findFundingFeeOutputs('sometxid')
        assert.deepStrictEqual(result, [])
    })
})

// ─── verifyReorg edge cases ──────────────────────────────────────────────────

describe('XChainDecoder#verifyReorg() edge cases', () => {
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

    it('should return true immediately when DB is empty (getLastBlockIndex returns -1)', async () => {
        const decoder = makeReorgDecoder()
        decoder.db = {
            getLastBlockIndex: sinon.stub().resolves(-1),
            getBlockByIndex: sinon.stub().resolves(null),
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

    it('should delete a single orphan block and write its REORG marker atomically (M-12)', async () => {
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
            // Since M-12 the REORG marker is written inside deleteBlockByIndex, atomically with the
            // delete. verifyReorg must NOT write a separate end-of-run event (that once-at-end write
            // was the non-crash-durable path this fix removed).
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

// ─── DOGE auxPow forcing ────────────────────────────────────────────────────

describe('XChainDecoder auxPow chain-identity forcing', () => {
    function makeDecoder(network, auxPow) {
        return new XChainDecoder(
            network, 'h', 3306, 'db', 'u', 'p',
            '127.0.0.1', 18443, 'rpc', 'rpc', auxPow, null
        )
    }

    it('forces auxPow=true for a dogecoin network even when AUX_POW is unset (false)', () => {
        assert.strictEqual(makeDecoder('dogecoin-regtest', false).auxPow, true)
        assert.strictEqual(makeDecoder('dogecoin-mainnet', false).auxPow, true)
    })

    it('leaves the env-driven value untouched for non-DOGE chains', () => {
        assert.strictEqual(makeDecoder('bitcoin-regtest', false).auxPow, false)
        assert.strictEqual(makeDecoder('litecoin-regtest', false).auxPow, false)
        assert.strictEqual(makeDecoder('bitcoin-regtest', true).auxPow, true)
    })
})

// ─── MAX_ACTION_DATA_LENGTH export ──────────────────────────────────────────

describe('XChainDecoder.MAX_ACTION_DATA_LENGTH', () => {
    it('should be exported as a numeric constant', () => {
        assert.strictEqual(typeof XChainDecoder.MAX_ACTION_DATA_LENGTH, 'number')
    })

    it('should equal 8192 (protocol canonical value)', () => {
        assert.strictEqual(XChainDecoder.MAX_ACTION_DATA_LENGTH, 8192)
    })
})
