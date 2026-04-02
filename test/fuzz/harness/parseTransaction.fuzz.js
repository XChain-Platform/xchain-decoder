/**
 * Fuzz harness for XChainDecoder#parseTransaction()
 *
 * Targets: OP_RETURN, P2SH, P2WSH, multisig code paths, script decompilation,
 * dispenser detection, source resolution edge cases.
 */

const assert = require('assert')
const crypto = require('crypto')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')
const { flipBits } = require('../mutators/bitFlip')
const { mutateRandom } = require('../mutators/byteManipulate')
const {
    PREV_HASH, buildXchnPayload, buildP2shMarker, buildP2wshMarker,
    buildOpReturnTx, buildMultisigTx, randomActionString, randomDispenserString,
    randomTxid, encrypt
} = require('../mutators/structureAware')
const { checkParseTransactionResult, withTimeout } = require('../invariants')
const FuzzReporter = require('../reporter')

bitcoin.initEccLib(ecc)

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS) || 2000

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

// Errors thrown by bitcoinjs-lib during Transaction.fromHex/fromBuffer are expected
// when we feed it corrupted hex — these are not decoder bugs.
function isBitcoinjsParseError(err) {
    const msg = err.message || ''
    return msg.includes('Cannot read slice out of bounds') ||
           msg.includes('Transaction has unexpected data') ||
           msg.includes('RangeError: value out of range') ||
           msg.includes('out of range') ||
           msg.includes('outside buffer bounds') ||
           msg.includes('Expected') // bitcoinjs-lib format errors
}

// Helper to run one fuzz iteration
async function fuzzOne(decoder, reporter, txOrHex, mutatorName) {
    try {
        let result
        if (typeof txOrHex === 'string') {
            result = await withTimeout(() => decoder.parseRawTransaction(txOrHex), 5000)
        } else {
            result = await withTimeout(() => decoder.parseTransaction(txOrHex), 5000)
        }
        const check = checkParseTransactionResult(result)
        if (!check.ok) {
            reporter.recordInvariantViolation(txOrHex, check.violations, mutatorName)
        } else {
            reporter.recordSuccess()
        }
    } catch (err) {
        if (err.message.startsWith('Timeout:')) {
            reporter.recordTimeout(txOrHex, mutatorName)
        } else if (typeof txOrHex === 'string' && isBitcoinjsParseError(err)) {
            // Expected: bitcoinjs-lib rejects malformed hex before decoder code runs
            reporter.recordSuccess()
        } else {
            reporter.recordCrash(txOrHex, err, mutatorName)
        }
    }
}

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    let reporter

    before(() => {
        reporter = new FuzzReporter('parseTransaction')
    })

    afterEach(() => {
        sinon.restore()
    })

    after(() => {
        reporter.printSummary()
        const s = reporter.getSummary()
        assert.strictEqual(s.crashes, 0, `${s.crashes} crashes found — check test/fuzz/crashes/parseTransaction/`)
        assert.strictEqual(s.invariantViolations, 0, `${s.invariantViolations} invariant violations found`)
        assert.strictEqual(s.timeouts, 0, `${s.timeouts} timeouts found`)
    })

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
                    // script.compile may reject invalid sizes — that's fine
                    reporter.recordSuccess()
                }
            })
        }
    })

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

    // --- Transactions with no inputs ---
    describe('edge: transaction with no inputs', () => {
        it('should handle transaction with empty ins array', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
            // tx.ins is empty — parseTransaction accesses ins[0].hash

            try {
                const result = await withTimeout(() => decoder.parseTransaction(tx), 5000)
                // Should return null or handle gracefully
                const check = checkParseTransactionResult(result)
                if (!check.ok) {
                    reporter.recordInvariantViolation(tx, check.violations, 'no_inputs')
                } else {
                    reporter.recordSuccess()
                }
            } catch (err) {
                reporter.recordCrash(tx, err, 'no_inputs')
            }
        })
    })

    // --- Transactions with no outputs ---
    describe('edge: transaction with no outputs', () => {
        it('should handle transaction with empty outs array', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            // tx.outs is empty

            await fuzzOne(decoder, reporter, tx, 'no_outputs')
        })
    })

    // --- Many outputs ---
    describe('edge: transaction with many outputs', () => {
        it('should handle transaction with 100 random outputs', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            for (let i = 0; i < 100; i++) {
                const scriptType = crypto.randomInt(4)
                switch (scriptType) {
                    case 0: // OP_RETURN
                        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, crypto.randomBytes(crypto.randomInt(76))]), 0)
                        break
                    case 1: // P2PKH
                        tx.addOutput(Buffer.from('76a914' + crypto.randomBytes(20).toString('hex') + '88ac', 'hex'), crypto.randomInt(100000000))
                        break
                    case 2: // random script
                        tx.addOutput(crypto.randomBytes(crypto.randomInt(50) + 2), crypto.randomInt(100000000))
                        break
                    case 3: // empty script
                        tx.addOutput(Buffer.alloc(0), 0)
                        break
                }
            }

            await fuzzOne(decoder, reporter, tx, 'many_outputs')
        })
    })

    // --- Dispenser address match with fuzzed outputs ---
    describe('dispenser detection with various output types', () => {
        it(`should handle ${Math.min(ITERATIONS, 500)} txs with dispenser-matching addresses`, async () => {
            for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
                const decoder = createDecoder()
                // Every address matches a dispenser
                decoder.db.isThereADispenserForAddress = sinon.stub().resolves(true)

                const action = randomActionString()
                const tx = buildOpReturnTx(action)
                await fuzzOne(decoder, reporter, tx, 'dispenser_match')
            }
        })
    })

    // --- Multisig with all-zero data ---
    describe('multisig: all-zero pubkey data', () => {
        it('should handle multisig where pubkeys are all zeros', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            const pubkey1 = Buffer.alloc(33, 0x00)
            pubkey1[0] = 0x02
            const pubkey2 = Buffer.alloc(33, 0x00)
            pubkey2[0] = 0x02
            const pubkey3 = Buffer.alloc(33, 0x03)

            const msScript = bitcoin.script.compile([
                bitcoin.opcodes.OP_1,
                pubkey1, pubkey2, pubkey3,
                bitcoin.opcodes.OP_3,
                bitcoin.opcodes.OP_CHECKMULTISIG
            ])
            tx.addOutput(msScript, 1000)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            await fuzzOne(decoder, reporter, tx, 'allzero_multisig')
        })
    })

    // --- P2WSH with missing/corrupt witness data ---
    describe('P2WSH with missing/corrupt witness', () => {
        it(`should handle ${Math.min(ITERATIONS, 500)} P2WSH txs with corrupt witness`, async () => {
            for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
                const decoder = createDecoder()
                const tx = new bitcoin.Transaction()
                tx.version = 2
                tx.addInput(PREV_HASH, 1)
                tx.ins[0].script = Buffer.alloc(0)

                // Randomly corrupt witness
                const witnessType = crypto.randomInt(5)
                switch (witnessType) {
                    case 0: tx.ins[0].witness = []; break
                    case 1: tx.ins[0].witness = [crypto.randomBytes(10)]; break
                    case 2: tx.ins[0].witness = [crypto.randomBytes(10), crypto.randomBytes(10)]; break
                    case 3: tx.ins[0].witness = [crypto.randomBytes(10), crypto.randomBytes(10), crypto.randomBytes(crypto.randomInt(100))]; break
                    case 4: tx.ins[0].witness = [null, undefined, crypto.randomBytes(10)]; break
                }

                const txid = Buffer.from(PREV_HASH).reverse().toString('hex')
                const marker = encrypt(Buffer.from('XCHNp2wsh'), txid)
                tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, marker]), 0)
                tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

                await fuzzOne(decoder, reporter, tx, 'p2wsh_corrupt_witness')
            }
        })
    })

    // --- Hypothesis H8: Empty reassembled data buffer ---
    describe('H8: empty data buffer after output loop', () => {
        it('should handle txs where all OP_RETURN outputs decrypt to non-XCHN data', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            // Multiple OP_RETURN outputs, none with XCHN prefix
            for (let i = 0; i < 5; i++) {
                tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, crypto.randomBytes(32)]), 0)
            }
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            await fuzzOne(decoder, reporter, tx, 'empty_reassembled')
        })
    })
})
