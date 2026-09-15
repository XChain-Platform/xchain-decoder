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
 * Fuzz harness for XChainDecoder#parseTransaction()
 *
 * Targets: OP_RETURN, P2SH, P2WSH, multisig code paths, script decompilation,
 * dispenser detection, source resolution edge cases.
 */

const crypto = require('crypto')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { flipBits } = require('../support/mutators/bit_flip')
const { mutateRandom } = require('../support/mutators/byte_manipulate')
const {
    PREV_HASH, buildXchnPayload, buildP2shMarker, buildP2wshMarker,
    buildOpReturnTx, buildMultisigTx, randomActionString, randomDispenserString,
    randomTxid, encrypt
} = require('../support/mutators/structure_aware')
const {
    ITERATIONS, configureSuite, createDecoder, fuzzOne
} = require('./parse_transaction.fuzz/support.cjs')

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- OP_RETURN with random ACTION payloads ---
    describe('OP_RETURN with random ACTION data', () => {
        it(`should handle ${ITERATIONS} random ACTION payloads`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const action = randomActionString()
                const tx = buildOpReturnTx(action)
                await fuzzOne(decoder, reporter, tx, 'random_action_opreturn')
            }
        })
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- OP_RETURN with random DISPENSER payloads ---
    describe('OP_RETURN with random DISPENSER data', () => {
        it(`should handle ${ITERATIONS} random DISPENSER payloads`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const dispenser = randomDispenserString()
                const tx = buildOpReturnTx(dispenser)
                await fuzzOne(decoder, reporter, tx, 'random_dispenser_opreturn')
            }
        })
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Bit-flipped known-good transaction hex ---
    describe('bit-flipped transaction hex', () => {
        // Seed from existing test fixtures
        const SEED_HEX = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

        it(`should handle ${ITERATIONS} bit-flipped transactions`, async () => {
            const seedBuf = Buffer.from(SEED_HEX, 'hex')
            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const mutated = flipBits(seedBuf, 8)
                await fuzzOne(decoder, reporter, mutated.toString('hex'), 'bit_flip_tx')
            }
        })
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Byte-mutated transaction hex ---
    describe('byte-mutated transaction hex', () => {
        const SEED_HEX = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

        it(`should handle ${ITERATIONS} byte-mutated transactions`, async () => {
            const seedBuf = Buffer.from(SEED_HEX, 'hex')
            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const mutated = mutateRandom(seedBuf)
                await fuzzOne(decoder, reporter, mutated.toString('hex'), 'byte_mutate_tx')
            }
        })
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Completely random hex strings (parseRawTransaction) ---
    describe('completely random hex', () => {
        it(`should handle ${ITERATIONS} random hex strings`, async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const decoder = createDecoder()
                const size = crypto.randomInt(500)
                const hex = crypto.randomBytes(size).toString('hex')
                await fuzzOne(decoder, reporter, hex, 'random_hex')
            }
        })
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Hypothesis H2: Multisig with tiny pubkeys ---
    describe('H2: multisig with tiny/empty pubkeys', () => {
        const pubkeySizes = [0, 1, 2, 16, 32, 33, 64, 65, 128]

        for (const size of pubkeySizes) {
            it(`should handle multisig with ${size}-byte pubkeys`, async () => {
                const decoder = createDecoder()
                const tx = new bitcoin.Transaction()
                tx.version = 2
                tx.addInput(PREV_HASH, 1)
                tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

                const pubkey1 = Buffer.alloc(size, 0x02)
                const pubkey2 = Buffer.alloc(size, 0x03)
                const pubkey3 = Buffer.alloc(Math.max(size, 33), 0x04)

                try {
                    const msScript = bitcoin.script.compile([
                        bitcoin.opcodes.OP_1,
                        pubkey1, pubkey2, pubkey3,
                        bitcoin.opcodes.OP_3,
                        bitcoin.opcodes.OP_CHECKMULTISIG
                    ])
                    tx.addOutput(msScript, 1000)
                    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
                    await fuzzOne(decoder, reporter, tx, 'tiny_pubkey_multisig')
                } catch (err) {
                    // script.compile may reject invalid sizes (acceptable)
                    reporter.recordSuccess()
                }
            })
        }
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Hypothesis H3: P2SH with partial input failures ---
    describe('H3: P2SH with mixed valid/invalid inputs', () => {
        it(`should handle ${Math.min(ITERATIONS, 500)} P2SH txs with corrupt inputs`, async () => {
            for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
                const decoder = createDecoder()
                const tx = new bitcoin.Transaction()
                tx.version = 2

                // Add 3 inputs, some with valid scriptSig, some garbage
                for (let j = 0; j < 3; j++) {
                    tx.addInput(PREV_HASH, j)
                    if (j === 1) {
                        // Corrupt input
                        tx.ins[j].script = crypto.randomBytes(crypto.randomInt(100))
                    } else {
                        // Valid-looking P2SH scriptSig with 3 pushes
                        const sig = crypto.randomBytes(72)
                        const pubkey = crypto.randomBytes(33)
                        const redeemScript = bitcoin.script.compile([Buffer.from('test data ' + j), bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_TRUE])
                        tx.ins[j].script = bitcoin.script.compile([sig, pubkey, redeemScript])
                    }
                }

                // OP_RETURN with XCHNp2sh marker
                const txid = Buffer.from(PREV_HASH).reverse().toString('hex')
                const marker = encrypt(Buffer.from('XCHNp2sh'), txid)
                tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, marker]), 0)
                tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

                await fuzzOne(decoder, reporter, tx, 'p2sh_mixed_inputs')
            }
        })
    })
})

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Hypothesis H4: Script decompile returns opcode at index 0 ---
    describe('H4: dataBuffer that decompiles to opcodes', () => {
        it('should handle buffers that decompile to opcodes instead of data pushes', async () => {
            const decoder = createDecoder()

            // Build various opcode-only scripts
            const opcodeBuffers = [
                Buffer.from([bitcoin.opcodes.OP_TRUE]),
                Buffer.from([bitcoin.opcodes.OP_0]),
                Buffer.from([bitcoin.opcodes.OP_1]),
                Buffer.from([bitcoin.opcodes.OP_16]),
                Buffer.from([bitcoin.opcodes.OP_NOP]),
                Buffer.from([bitcoin.opcodes.OP_RETURN]),
                Buffer.from([bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_DROP]),
                Buffer.from([bitcoin.opcodes.OP_1, bitcoin.opcodes.OP_1, bitcoin.opcodes.OP_ADD])
            ]

            for (const opBuf of opcodeBuffers) {
                // Encrypt as XCHN payload so it passes the magic prefix check
                const txid = Buffer.from(PREV_HASH).reverse().toString('hex')
                const plainBuf = Buffer.concat([Buffer.from('XCHN'), opBuf])
                const cipher = encrypt(plainBuf, txid)

                const tx = new bitcoin.Transaction()
                tx.version = 2
                tx.addInput(PREV_HASH, 1)
                tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
                tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
                tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

                await fuzzOne(decoder, reporter, tx, 'opcode_script_decompile')
            }
        })
    })
})
