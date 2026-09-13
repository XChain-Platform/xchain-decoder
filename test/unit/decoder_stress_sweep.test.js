// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression guards for a batch of decoder stability fixes: the LTC MWEB prevout
// wedge, zero-input transactions, the JSON-RPC batch-size cap, deterministic
// INSERT quarantine, the DOGE large-output bufferutils self-check, and output
// capture on a co-resident invalid ACTION.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db')
const { makeRpcBatchGuard } = require('../../src/api')

// A known-valid Litecoin tx (1 input, OP_RETURN + P2PKH outputs) reused from
// XChainBlockDecoder.test.js. Output index 1 is a P2PKH paying a resolvable address.
const CANONICAL_TX_HEX = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

// The same tx with the LTC MWEB marker (0x00) + flag (0x08) injected after the
// 4-byte version, exactly as a HogEx/MWEB-carrying LTC tx serializes on the wire.
const MWEB_FLAGGED_TX_HEX = '02000000' + '0008' + CANONICAL_TX_HEX.substr(8)

function newDecoder(network){
    return new XChainDecoder(network, 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
}

describe('decoder stability fixes @regression', function () {
    this.timeout(0)

    describe('prevout/funding parse routes through transactionFromHex (LTC MWEB wedge)', function () {
        it('the crafted MWEB-flagged hex is one that vanilla strict fromHex rejects', function () {
            // Guards the test itself: if this ever stops throwing, the fix below is moot.
            assert.throws(() => bitcoin.Transaction.fromHex(MWEB_FLAGGED_TX_HEX))
        })

        it('getSourceFromOutput resolves an MWEB-flagged LTC prevout instead of wedging', async function () {
            const decoder = newDecoder('litecoin-regtest')
            let fetched = 0
            decoder.connector = { rpcErrors: 0, getRawTransaction: async () => { fetched++; return MWEB_FLAGGED_TX_HEX } }

            // Before the fix this threw a deterministic UInt64 range error tagged
            // rpcLookupFailure=true, which the block loop retries FOREVER (permanent
            // fleet-wide LTC wedge). After the fix the MWEB flag is stripped and the
            // P2PKH output at index 1 resolves to a real address.
            const source = await decoder.getSourceFromOutput('deadbeef'.repeat(8), 1)
            assert.strictEqual(fetched, 1)
            assert.ok(source, 'expected a resolved source address, got ' + source)
        })

        it('a normal (unflagged) prevout still resolves unchanged', async function () {
            const decoder = newDecoder('litecoin-regtest')
            decoder.connector = { rpcErrors: 0, getRawTransaction: async () => CANONICAL_TX_HEX }
            const source = await decoder.getSourceFromOutput('deadbeef'.repeat(8), 1)
            assert.ok(source, 'unflagged prevout must still resolve')
        })
    })

    describe('zero-input tx is skipped cleanly instead of throwing', function () {
        it('parseTransaction returns null for a tx with no inputs', async function () {
            const decoder = newDecoder('litecoin-regtest')
            assert.strictEqual(await decoder.parseTransaction({ ins: [] }), null)
        })

        it('parseTransaction returns null when ins is absent', async function () {
            const decoder = newDecoder('litecoin-regtest')
            assert.strictEqual(await decoder.parseTransaction({}), null)
        })
    })

    describe('JSON-RPC batch-size guard', function () {
        function fakeRes(){
            return { _code: null, _json: null, status(c){ this._code = c; return this }, json(o){ this._json = o; return this } }
        }

        it('rejects an over-cap batch array with 400 and does not call next', function () {
            const guard = makeRpcBatchGuard(20)
            const res = fakeRes()
            let nextCalled = false
            guard({ body: new Array(21).fill({ method: 'health' }) }, res, () => { nextCalled = true })
            assert.strictEqual(res._code, 400)
            assert.strictEqual(nextCalled, false)
            assert.ok(res._json && res._json.error, 'expected a JSON-RPC error body')
        })

        it('passes a batch at exactly the cap', function () {
            const guard = makeRpcBatchGuard(20)
            let nextCalled = false
            guard({ body: new Array(20).fill({ method: 'health' }) }, fakeRes(), () => { nextCalled = true })
            assert.strictEqual(nextCalled, true)
        })

        it('passes a single (non-array) request', function () {
            const guard = makeRpcBatchGuard(20)
            let nextCalled = false
            guard({ body: { method: 'health' } }, fakeRes(), () => { nextCalled = true })
            assert.strictEqual(nextCalled, true)
        })
    })

    describe('deterministic INSERT failure is quarantined, not retried forever', function () {
        // Drives the real block loop with a mocked db/connector (one block, one XChain tx),
        // mirroring the rpcLookupFailure.test.js harness.
        function buildDecoder(insertTransaction){
            const decoder = newDecoder('bitcoin-regtest')
            decoder.startBlockIndex = 0
            decoder.sleep = async () => {}
            // parseTransaction yields a valid SEND payload so the loop reaches insertTransaction.
            decoder.parseTransaction = async () => ({
                data: Buffer.from('SEND|x'), compiledDataLength: 6, rawData: null,
                source: 'someaddr', destination: null, amount: 0,
                dispenseOutputs: [], paymentOutputs: []
            })
            const calls = { insertTx: 0, insertEvent: [], commit: 0 }
            decoder.connector = {
                getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
                getBlockHash: async () => 'aabbccdd',
                getBlock: async () => ''
            }
            decoder.db = {
                createDatabase: async () => true, verifyDatabase: async () => true,
                verifyTables: async () => true, runMigrations: async () => ({ applied: [], pending: [] }),
                getLastBlockIndex: async () => -1, getLastTxIndex: async () => 0,
                beginTransaction: async () => {}, endTransaction: async () => {},
                commitTransaction: async () => { calls.commit++; decoder.stopFlag = true; return true },
                deleteOpenDispensers: async () => true, purgeExpiredDispensers: async () => true,
                getAllOpenDispenserAddresses: async () => new Set(),
                insertEvent: async (code, data) => { calls.insertEvent.push({ code, data }); return true },
                insertBlock: async () => true,
                insertTransaction: async (tx) => { calls.insertTx++; return insertTransaction(calls.insertTx, tx) },
                insertTransactionOutput: async () => true,
                DUPLICATED_TRANSACTION: 1, POISON_ROW: 2
            }
            decoder.xchainBlockDecoder = {
                blockFromHex: () => ({ prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: [{ getId: () => 'cafe01', outs: [] }] })
            }
            return { decoder, calls }
        }

        it('a POISON_ROW tx is quarantined after TX_PARSE_MAX_RETRIES, then the block commits', async function () {
            // insertTransaction ALWAYS rejects this row deterministically.
            const { decoder, calls } = buildDecoder(() => decoder.db.POISON_ROW)
            await decoder.start()
            // 4 attempts (counter exceeds TX_PARSE_MAX_RETRIES=3 on the 4th), then the re-parse
            // skips the quarantined position instead of a 5th insert.
            assert.strictEqual(calls.insertTx, 4, 'retries then stops re-attempting the poison insert')
            const parseErrs = calls.insertEvent.filter(e => e.code === 'PARSE_ERROR')
            assert.strictEqual(parseErrs.length, 1, 'exactly one PARSE_ERROR quarantine event')
            assert.strictEqual(calls.commit, 1, 'the block commits (no permanent wedge)')
        })

        it('a transient (false) insert failure is retried indefinitely, never quarantined', async function () {
            // Fail 5 times (beyond TX_PARSE_MAX_RETRIES), then succeed - a transient error must
            // never quarantine (that would skip a tx a healthy instance accepts).
            const { decoder, calls } = buildDecoder((n) => (n <= 5 ? false : true))
            await decoder.start()
            assert.strictEqual(calls.insertTx, 6, 'retried past the quarantine threshold until it succeeded')
            assert.strictEqual(calls.insertEvent.filter(e => e.code === 'PARSE_ERROR').length, 0, 'never quarantined')
            assert.strictEqual(calls.commit, 1)
        })
    })

    describe('insertTransaction error classification', function () {
        function dbWithQueryError(errno){
            const db = new Database('h', '0', 'db', 'u', 'p')
            db.transactionConnection = null
            db.createTransaction = async () => 1
            db.createAddress = async () => 1
            db.getConnection = async () => ({
                query: async () => { const e = new Error('mariadb'); e.errno = errno; throw e },
                release: async () => {}
            })
            return db
        }
        const row = { index: 0, hash: 'a', block_index: 0, source: 's', destination: null, amount: 0, fee: 0, data: 'x' }

        it('errno 1366 (incorrect string value) => POISON_ROW', async function () {
            const db = dbWithQueryError(1366)
            assert.strictEqual(await db.insertTransaction(row), db.POISON_ROW)
        })

        it('errno 1406 (data too long) => POISON_ROW', async function () {
            const db = dbWithQueryError(1406)
            assert.strictEqual(await db.insertTransaction(row), db.POISON_ROW)
        })

        it('errno 1213 (deadlock, transient) => false (retry forever)', async function () {
            const db = dbWithQueryError(1213)
            assert.strictEqual(await db.insertTransaction(row), false)
        })

        it('errno 1062 (duplicate) => DUPLICATED_TRANSACTION', async function () {
            const db = dbWithQueryError(1062)
            assert.strictEqual(await db.insertTransaction(row), db.DUPLICATED_TRANSACTION)
        })
    })

    describe('DOGE large-output bufferutils-patch self-check', function () {
        const { bigIntBufferutilsActive } = require('../../src/XChainDecoder')

        it('reports inactive when the reader throws (stock bitcoinjs, wedge-prone)', function () {
            const throwing = { BufferReader: class { readUInt64(){ throw new Error('RangeError: value out of range') } } }
            assert.strictEqual(bigIntBufferutilsActive(throwing), false)
        })

        it('reports active when the reader tolerates a > 2^53 value (BigInt-safe patch)', function () {
            const working = { BufferReader: class { readUInt64(){ return 9007199254740992n } } }
            assert.strictEqual(bigIntBufferutilsActive(working), true)
        })

        it('reports inactive when the module has no BufferReader (fail-safe)', function () {
            assert.strictEqual(bigIntBufferutilsActive({}), false)
        })
    })

    describe('dispense/payment outputs survive a co-resident invalid/oversized ACTION', function () {
        function buildDecoder(parseResult){
            const decoder = newDecoder('bitcoin-regtest')
            decoder.startBlockIndex = 0
            decoder.sleep = async () => {}
            decoder.parseTransaction = async () => parseResult
            const calls = { insertTx: [], outputs: 0, commit: 0 }
            decoder.connector = {
                getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
                getBlockHash: async () => 'aabbccdd', getBlock: async () => ''
            }
            decoder.db = {
                createDatabase: async () => true, verifyDatabase: async () => true,
                verifyTables: async () => true, runMigrations: async () => ({ applied: [], pending: [] }),
                getLastBlockIndex: async () => -1, getLastTxIndex: async () => 0,
                beginTransaction: async () => {}, endTransaction: async () => {},
                commitTransaction: async () => { calls.commit++; decoder.stopFlag = true; return true },
                deleteOpenDispensers: async () => true, purgeExpiredDispensers: async () => true,
                getAllOpenDispenserAddresses: async () => new Set(),
                insertEvent: async () => true, insertBlock: async () => true,
                insertTransaction: async (tx) => { calls.insertTx.push({ ...tx }); return true },
                insertTransactionOutput: async () => { calls.outputs++; return true },
                DUPLICATED_TRANSACTION: 1, POISON_ROW: 2
            }
            decoder.xchainBlockDecoder = {
                blockFromHex: () => ({ prevHash: Buffer.alloc(32), timestamp: 1700000000, transactions: [{ getId: () => 'cafe01', outs: [] }] })
            }
            return { decoder, calls }
        }
        const dispense = [{ vout: 0, destinationAddress: 'dispenseraddr', amount: 100 }]

        it('unknown ACTION + a dispense output: tx stored as no-action, dispense recorded', async function () {
            const { decoder, calls } = buildDecoder({
                data: Buffer.from('JUNKACTION|x'), compiledDataLength: 12, rawData: Buffer.from('ff', 'hex'),
                source: 'srcaddr', destination: null, amount: 0, dispenseOutputs: dispense, paymentOutputs: []
            })
            await decoder.start()
            assert.strictEqual(calls.insertTx.length, 1, 'the tx must still be inserted (not dropped)')
            assert.strictEqual(calls.insertTx[0].data, '', 'invalid action stored as no-action')
            assert.strictEqual(calls.insertTx[0].raw_data, null, 'raw_data nulled for a no-action settlement')
            assert.strictEqual(calls.outputs, 1, 'the dispense output must be recorded')
        })

        it('oversized ACTION + a dispense output: tx stored as no-action, dispense recorded', async function () {
            const { decoder, calls } = buildDecoder({
                data: Buffer.from('SEND|x'), compiledDataLength: 99999, rawData: null,
                source: 'srcaddr', destination: null, amount: 0, dispenseOutputs: dispense, paymentOutputs: []
            })
            await decoder.start()
            assert.strictEqual(calls.insertTx.length, 1)
            assert.strictEqual(calls.insertTx[0].data, '')
            assert.strictEqual(calls.outputs, 1)
        })

        it('unknown ACTION + NO outputs: still skipped (byte-identical to prior behavior)', async function () {
            const { decoder, calls } = buildDecoder({
                data: Buffer.from('JUNKACTION|x'), compiledDataLength: 12, rawData: null,
                source: 'srcaddr', destination: null, amount: 0, dispenseOutputs: [], paymentOutputs: []
            })
            await decoder.start()
            assert.strictEqual(calls.insertTx.length, 0, 'no outputs to preserve -> tx is skipped as before')
            assert.strictEqual(calls.outputs, 0)
            assert.strictEqual(calls.commit, 1, 'the block still commits')
        })
    })
})
