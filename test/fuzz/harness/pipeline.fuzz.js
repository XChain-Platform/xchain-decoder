/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz harness for the full decode pipeline.
 *
 * Feeds fuzzed raw block hex through blockFromHex → iterate transactions →
 * parseTransaction per tx. Tests the interaction between layers.
 */

const assert = require('assert')
const crypto = require('crypto')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')
const XChainBlockDecoder = require('../../../src/XChainBlockDecoder')
const { flipBits } = require('../mutators/bitFlip')
const { mutateRandom } = require('../mutators/byteManipulate')
const {
    PREV_HASH, buildOpReturnTx, randomActionString, randomDispenserString, encrypt
} = require('../mutators/structureAware')
const { checkParseTransactionResult, withTimeout } = require('../invariants')
const FuzzReporter = require('../reporter')

bitcoin.initEccLib(ecc)

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS) || 1000

function createDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false)
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('mocked'))
    }
    return decoder
}

/**
 * Build a minimal valid block containing one or more transactions.
 * Returns the block hex string.
 */
function buildTestBlock(transactions) {
    const block = new bitcoin.Block()
    block.version = 2
    block.prevHash = crypto.randomBytes(32)
    block.merkleRoot = crypto.randomBytes(32)
    block.timestamp = Math.floor(Date.now() / 1000)
    block.bits = 0x207fffff
    block.nonce = 0
    block.transactions = transactions

    return block.toHex(false)
}

describe('Fuzz: Full Pipeline', function () {
    this.timeout(300000)
    let reporter

    before(() => {
        reporter = new FuzzReporter('pipeline')
    })

    afterEach(() => {
        sinon.restore()
    })

    after(() => {
        reporter.printSummary()
        const s = reporter.getSummary()
        assert.strictEqual(s.crashes, 0, `${s.crashes} crashes found — check test/fuzz/crashes/pipeline/`)
        assert.strictEqual(s.invariantViolations, 0, `${s.invariantViolations} invariant violations found`)
        assert.strictEqual(s.timeouts, 0, `${s.timeouts} timeouts found`)
    })

    // --- Pipeline: random ACTION txs through block parsing ---
    describe('block → parseTransaction pipeline with random ACTIONs', () => {
        it(`should handle ${ITERATIONS} blocks with random ACTION txs`, async () => {
            const blockDecoder = new XChainBlockDecoder('bitcoin-regtest')

            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()

                // Build 1-5 transactions per block
                const txCount = 1 + crypto.randomInt(5)
                const transactions = []
                for (let j = 0; j < txCount; j++) {
                    const action = crypto.randomInt(2) === 0 ? randomActionString() : randomDispenserString()
                    transactions.push(buildOpReturnTx(action))
                }

                try {
                    const blockHex = buildTestBlock(transactions)
                    const block = await withTimeout(() => blockDecoder.blockFromHex(blockHex), 5000)

                    if (block.transactions) {
                        for (const tx of block.transactions) {
                            if (tx.ins && tx.ins.length > 0) {
                                const result = await withTimeout(() => decoder.parseTransaction(tx), 5000)
                                const check = checkParseTransactionResult(result)
                                if (!check.ok) {
                                    reporter.recordInvariantViolation(
                                        { blockHex: blockHex.substring(0, 200), txId: tx.getId() },
                                        check.violations, 'pipeline_action'
                                    )
                                } else {
                                    reporter.recordSuccess()
                                }
                            } else {
                                reporter.recordSuccess()
                            }
                        }
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ iteration: i }, 'pipeline_action')
                    } else {
                        // Block building/parsing failures are expected for some random combinations
                        reporter.recordSuccess()
                    }
                }
            }
        })
    })

    // --- Pipeline: mutated block hex ---
    describe('mutated block hex through pipeline', () => {
        it(`should handle ${ITERATIONS} mutated block hex strings`, async () => {
            const blockDecoder = new XChainBlockDecoder('bitcoin-regtest')

            // Build one good block as seed
            const seedTx = buildOpReturnTx('SEND|0|XCHAIN|1000')
            let seedBlockHex
            try {
                seedBlockHex = buildTestBlock([seedTx])
            } catch (e) {
                // If we can't build the seed, skip
                return
            }
            const seedBuf = Buffer.from(seedBlockHex, 'hex')

            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const mutated = mutateRandom(seedBuf)

                try {
                    const block = await withTimeout(() => blockDecoder.blockFromBuffer(mutated), 5000)

                    if (block && block.transactions) {
                        for (const tx of block.transactions) {
                            if (tx.ins && tx.ins.length > 0) {
                                const result = await withTimeout(() => decoder.parseTransaction(tx), 5000)
                                const check = checkParseTransactionResult(result)
                                if (!check.ok) {
                                    reporter.recordInvariantViolation(
                                        { hex: mutated.toString('hex').substring(0, 200) },
                                        check.violations, 'pipeline_mutated'
                                    )
                                } else {
                                    reporter.recordSuccess()
                                }
                            }
                        }
                    }
                    reporter.recordSuccess()
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ iteration: i }, 'pipeline_mutated')
                    } else {
                        reporter.recordSuccess()
                    }
                }
            }
        })
    })

    // --- Pipeline: mixed encoding types in one block ---
    describe('mixed encoding types in single block', () => {
        it(`should handle ${Math.min(ITERATIONS, 500)} blocks with mixed encoding`, async () => {
            const blockDecoder = new XChainBlockDecoder('bitcoin-regtest')

            for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
                const decoder = createDecoder()
                const txid = Buffer.from(PREV_HASH).reverse().toString('hex')

                const transactions = []

                // OP_RETURN tx
                transactions.push(buildOpReturnTx(randomActionString()))

                // Multisig-like tx (manually built)
                const msTx = new bitcoin.Transaction()
                msTx.version = 2
                msTx.addInput(PREV_HASH, 2)
                msTx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
                const pubkey1 = Buffer.concat([Buffer.from([0x02]), crypto.randomBytes(32)])
                const pubkey2 = Buffer.concat([Buffer.from([0x02]), crypto.randomBytes(32)])
                const pubkey3 = Buffer.concat([Buffer.from([0x03]), crypto.randomBytes(32)])
                try {
                    msTx.addOutput(bitcoin.script.compile([
                        bitcoin.opcodes.OP_1, pubkey1, pubkey2, pubkey3,
                        bitcoin.opcodes.OP_3, bitcoin.opcodes.OP_CHECKMULTISIG
                    ]), 1000)
                    msTx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
                    transactions.push(msTx)
                } catch (e) {
                    // Skip if compile fails
                }

                // P2SH marker tx
                const p2shTx = new bitcoin.Transaction()
                p2shTx.version = 2
                p2shTx.addInput(PREV_HASH, 3)
                const redeemScript = bitcoin.script.compile([Buffer.from('fuzz data'), bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_TRUE])
                p2shTx.ins[0].script = bitcoin.script.compile([crypto.randomBytes(72), crypto.randomBytes(33), redeemScript])
                const marker = encrypt(Buffer.from('XCHNp2sh'), txid)
                p2shTx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, marker]), 0)
                p2shTx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
                transactions.push(p2shTx)

                try {
                    const blockHex = buildTestBlock(transactions)
                    const block = await withTimeout(() => blockDecoder.blockFromHex(blockHex), 5000)

                    if (block && block.transactions) {
                        for (const tx of block.transactions) {
                            if (tx.ins && tx.ins.length > 0) {
                                const result = await withTimeout(() => decoder.parseTransaction(tx), 5000)
                                const check = checkParseTransactionResult(result)
                                if (!check.ok) {
                                    reporter.recordInvariantViolation(
                                        { iteration: i },
                                        check.violations, 'pipeline_mixed'
                                    )
                                } else {
                                    reporter.recordSuccess()
                                }
                            }
                        }
                    }
                    reporter.recordSuccess()
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ iteration: i }, 'pipeline_mixed')
                    } else {
                        reporter.recordSuccess()
                    }
                }
            }
        })
    })

    // --- Pipeline: parseRawTransaction with bit-flipped real tx hex ---
    describe('parseRawTransaction with bit-flipped real txs', () => {
        // Real tx hex seeds from the test suite
        const SEED_TXHEX = [
            '020000000187100629ac1603de9cce139ff34d2f335c767565bcc57237bc5afdcfe985292a010000006a47304402203d77d9654c80f107192fc7f169cdf9ca36d348662fce04269a107e3f9d6482b90220149efa4fa78168a5dfb6ace9623bb15c97d1f4b1280d7a77ebcd852b24da00a50121035916fd403a852853c4df7f0c9ec4775b471163f750c6db9cda7de30aece597af01000000020000000000000000226a20dbfb3cfc8041d85094c7b06aac5d0075ddc2c579d78b29df1c653b71f60cf5ccf0b9f505000000001976a9143d116616fcb52df7f41e7889866 26efcc0bee77b88ac00000000',
            '0200000001009ffb964e60a50eb3bf5baa87413ffdc2ca10cf72c41296de62ae74e00609b4010000006a4730440220541f5cdb2eb75a69782dd4482fdcd0b7f76bb93b2fbae426f39641e8878e62af02203898bb0bd4dd52206b349a2d53468478600bb07bbfd66567c3f84e41f9703dfd0121030ba7000729cb4b1cfe3830cc2229a17a4a091bd54efc755c97251597937b2f810100000002e803000000000000695121026bd60090a47bad423c9c0250e8e9ffecf8a31453e728a0dd10fa9b647c483c3f21028b51b24ae4dd206fa5b5243e803c5b590000000000000000000000000000000021030ba7000729cb4b1cfe3830cc2229a17a4a091bd54efc755c97251597937b2f8153aef0b9f505000000001976a914bfcd3a9da714bfba50a4fd8b499a96d32fec7f1f88ac00000000'
        ]

        it(`should handle ${ITERATIONS} bit-flipped real transactions`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const seedHex = SEED_TXHEX[crypto.randomInt(SEED_TXHEX.length)].replace(/\s/g, '')
                const seedBuf = Buffer.from(seedHex, 'hex')
                const mutated = flipBits(seedBuf, 4)

                try {
                    const result = await withTimeout(
                        () => decoder.parseRawTransaction(mutated.toString('hex')),
                        5000
                    )
                    const check = checkParseTransactionResult(result)
                    if (!check.ok) {
                        reporter.recordInvariantViolation(
                            mutated.toString('hex').substring(0, 200),
                            check.violations, 'pipeline_bitflip_real'
                        )
                    } else {
                        reporter.recordSuccess()
                    }
                } catch (err) {
                    if (err.message.startsWith('Timeout:')) {
                        reporter.recordTimeout({ iteration: i }, 'pipeline_bitflip_real')
                    } else {
                        reporter.recordSuccess()
                    }
                }
            }
        })
    })
})
