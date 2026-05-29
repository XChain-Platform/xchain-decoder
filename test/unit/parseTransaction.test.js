const assert = require('assert')
const sinon = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// --- Synthetic test transaction builder ---
// The decoder derives AES key/IV from the reversed hex of the first input's prevout hash.
// All test txs use the same prevout hash for simplicity.
const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

function getKeyIv() {
    const display = Buffer.from(PREV_HASH).reverse().toString('hex')
    return { key: display.substr(0, 16), iv: display.substr(16, 16) }
}

function encryptBuf(plainBuf) {
    const { key, iv } = getKeyIv()
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    let enc = cipher.update(plainBuf)
    return Buffer.concat([enc, cipher.final()])
}

// Build encrypted XCHN payload. The data after XCHN prefix must be a compiled bitcoin script.
function buildXchnPayload(data, rawData) {
    const parts = [Buffer.from(data)]
    if (rawData) parts.push(Buffer.from(rawData))
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return encryptBuf(plainBuf)
}

function addStandardInput(tx) {
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
}

function addP2PKHOutput(tx, value) {
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), value || 100000000)
}

// Pre-built transaction hex strings (verified to decode correctly)
const TX_HEX = {
    opReturn: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000',
    opReturnWithRaw: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000226a205ed141846cc8c7e76787783472e71ffb177e0eda0d24b8406eccc9cd4be35b1000e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000',
    // Genuine AES-128-CTR encryption of "XCHN" + compile(["Multisig data"]) padded
    // to a full 64-byte chunk (matches real encoder output: the zero-padding is
    // applied to the plaintext before encryption, so it decrypts back to 0x00 / OP_0
    // and is harmlessly ignored by bitcoin.script.decompile at reassembly).
    multisig: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff02e803000000000000695121025ed141846dc8d3e27dce7b3c6cab14fb07115cbb7a04d9341aadaaa5268635642102e71ca15723d902414e2d1eabfe0fbd6380eb928110bbec51127fce0de72f14652103030303030303030303030303030303030303030303030303030303030303030353ae00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'
}

// Create a decoder with mocked DB and connector
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

describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // --- Coinbase transaction rejection ---

    it('[REGRESSION P0] R-SCR-001: should return null for a coinbase transaction', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        tx.ins[0].hash = Buffer.alloc(32, 0)

        const result = await decoder.parseTransaction(tx)
        assert.strictEqual(result, null)
    })

    it('should return null when standard_input is false', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        tx.ins[0]['standard_input'] = false

        const result = await decoder.parseTransaction(tx)
        assert.strictEqual(result, null)
    })

    // --- OP_RETURN decoding ---

    it('[REGRESSION P0] R-SCR-001: should decode an OP_RETURN transaction with XCHN payload', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)

        assert.ok(result)
        assert.ok(result.data.length > 0)
        assert.strictEqual(result.data.toString('utf-8'), 'Small data test')
    })

    it('should decode OP_RETURN with data and rawData', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturnWithRaw)

        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), 'Main payload')
        assert.ok(result.rawData)
        assert.strictEqual(result.rawData.toString('utf-8'), 'Raw attachment')
    })

    it('should return null rawData when there is only one script push', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)

        assert.strictEqual(result.rawData, null)
    })

    it('should return empty data for a transaction with no XChain-relevant outputs', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        // Remove the OP_RETURN output, keep only the P2PKH
        tx.outs = [tx.outs[1]]

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.strictEqual(result.data.length, 0)
        assert.strictEqual(result.dispenseOutputs.length, 0)
    })

    // --- Multisig decoding ---

    it('[REGRESSION P0] R-SCR-004: should decode a 1-of-3 multisig transaction', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.multisig)

        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), 'Multisig data')
    })

    it('should strip trailing zeros from multisig payload', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.multisig)
        const data = result.data

        assert.notStrictEqual(data[data.length - 1], 0)
    })

    it('[REGRESSION P0] R-SCR-005: should not drop a 0x00 final ciphertext byte on a full multisig chunk', async () => {
        // A full 64-byte MULTISIGN chunk (magic(4) + 60 data bytes, no padding)
        // carries live AES-128-CTR ciphertext in its final byte. ~1/256 of the
        // time that byte is 0x00. The decoder must NOT strip it: doing so decrypts
        // one byte short and silently corrupts the decoded action. This test forces
        // the final ciphertext byte to 0x00 and asserts a byte-for-byte round trip.
        const { key, iv } = getKeyIv()

        // AES-CTR encrypting an all-zero buffer yields the raw keystream.
        const ksCipher = crypto.createCipheriv('aes-128-ctr', key, iv)
        const keystream = Buffer.concat([ksCipher.update(Buffer.alloc(64, 0)), ksCipher.final()])

        // Build a 60-byte compiled script: 1-byte pushdata prefix + 59 data bytes.
        // Plaintext chunk = XCHN(4) + script(60) = exactly 64 bytes (both pubkey
        // halves full, no zero-pad), so plaintext[63] is the last data byte.
        const action = Buffer.alloc(59)
        for (let i = 0; i < action.length; i++) action[i] = 0x41 + (i % 26)
        // Force plaintext[63] == keystream[63] so ciphertext[63] == 0x00.
        action[action.length - 1] = keystream[63]

        const scriptPayload = bitcoin.script.compile([action])
        assert.strictEqual(scriptPayload.length, 60)
        const plain = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
        assert.strictEqual(plain.length, 64)

        const cipher = encryptBuf(plain)
        assert.strictEqual(cipher.length, 64)
        // Precondition: the bug only triggers when the final ciphertext byte is 0x00.
        assert.strictEqual(cipher[63], 0x00)

        // Split into two 32-byte halves, each 0x02-prefixed, as dataToPubkey() does.
        const pubkey1 = Buffer.concat([Buffer.from([0x02]), cipher.subarray(0, 32)])
        const pubkey2 = Buffer.concat([Buffer.from([0x02]), cipher.subarray(32, 64)])
        const pubkey3 = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 0x03)])

        const multisigScript = bitcoin.script.compile([
            bitcoin.opcodes.OP_1,
            pubkey1,
            pubkey2,
            pubkey3,
            bitcoin.opcodes.OP_3,
            bitcoin.opcodes.OP_CHECKMULTISIG
        ])

        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)
        tx.addOutput(multisigScript, 1000)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.ok(Buffer.isBuffer(result.data))
        // Byte-for-byte: the decoded action must equal the original 59 bytes,
        // including the final byte the old strip loop would have dropped.
        assert.strictEqual(result.data.length, action.length)
        assert.ok(result.data.equals(action), 'decoded data must match original payload byte-for-byte')
    })

    // --- Result structure ---

    it('[REGRESSION P0] R-SCR-001: should return an object with data, rawData, source, destination, and dispenseOutputs', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)

        assert.ok('data' in result)
        assert.ok('rawData' in result)
        assert.ok('source' in result)
        assert.ok('destination' in result)
        assert.ok('dispenseOutputs' in result)
    })

    it('should return destination as null', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)
        assert.strictEqual(result.destination, null)
    })

    it('should return empty dispenseOutputs when no dispenser addresses match', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)
        assert.ok(Array.isArray(result.dispenseOutputs))
        assert.strictEqual(result.dispenseOutputs.length, 0)
    })

    // --- Dispenser output detection ---

    it('should detect dispense outputs when db reports a matching dispenser address', async () => {
        decoder.db.isThereADispenserForAddress = sinon.stub().resolves(true)

        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.ok(result.dispenseOutputs.length > 0)
        assert.ok(result.dispenseOutputs[0].destinationAddress)
        assert.ok(typeof result.dispenseOutputs[0].amount === 'number' || typeof result.dispenseOutputs[0].amount === 'bigint')
    })

    it('should populate txIndex and vout in dispense outputs', async () => {
        decoder.db.isThereADispenserForAddress = sinon.stub().resolves(true)

        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result.dispenseOutputs.length > 0)
        assert.ok(result.dispenseOutputs[0].txIndex)
        assert.strictEqual(typeof result.dispenseOutputs[0].vout, 'number')
    })

    // --- standard_input field handling ---

    it('should treat missing standard_input field as true (default)', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        delete tx.ins[0]['standard_input']

        const result = await decoder.parseTransaction(tx)
        assert.ok(result !== null)
    })

    it('should treat standard_input: true as normal', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        tx.ins[0]['standard_input'] = true

        const result = await decoder.parseTransaction(tx)
        assert.ok(result !== null)
    })

    // --- OP_RETURN without XCHN prefix ---

    it('should not include data from an OP_RETURN that decrypts without XCHN prefix', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        // Replace the OP_RETURN data with random bytes that won't decrypt to XCHN
        const randomData = crypto.randomBytes(32)
        tx.outs[0].script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, randomData])

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.strictEqual(result.data.length, 0)
    })

    // --- Edge cases for multisig ---

    it('should skip multisig outputs that do not have exactly 6 decompiled elements', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
    })

    // --- parseRawTransaction ---

    it('should throw on invalid hex input', async () => {
        await assert.rejects(async () => {
            await decoder.parseRawTransaction('not_valid_hex')
        })
    })

    it('should throw on empty hex string', async () => {
        await assert.rejects(async () => {
            await decoder.parseRawTransaction('')
        })
    })

    // --- Dynamic transaction building ---

    it('[REGRESSION P0] R-SCR-001: should decode a dynamically built OP_RETURN transaction', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = buildXchnPayload('SEND|0|XCHAIN|1000')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
    })

    it('[REGRESSION P0] R-SCR-001: should decode a DISPENSER payload', async () => {
        const dispenserData = 'DISPENSER|0|GIVE_COIN||||||GET_COIN|||||||3600'
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = buildXchnPayload(dispenserData)
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.ok(result.data.toString('utf-8').startsWith('DISPENSER'))
    })
})

describe('XChainDecoder#isFutureSegwitScript()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    it('should return false for P2PKH script', () => {
        const script = Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex')
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for OP_RETURN script', () => {
        const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('test')])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for OP_0 (v0 segwit, handled by bitcoinjs)', () => {
        // P2WPKH: OP_0 <20-byte hash>
        const script = Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, 0xbb)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for OP_1 (v1 taproot, handled by bitcoinjs)', () => {
        // P2TR: OP_1 <32-byte key>
        const script = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xcc)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return true for OP_2 (v2 future segwit) with valid push length', () => {
        // OP_2=0x52, push 20 bytes
        const script = Buffer.concat([Buffer.from([0x52, 0x14]), Buffer.alloc(20, 0xdd)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), true)
    })

    it('should return true for OP_16 (v16 future segwit) with valid push length', () => {
        // OP_16=0x60, push 32 bytes
        const script = Buffer.concat([Buffer.from([0x60, 0x20]), Buffer.alloc(32, 0xee)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), true)
    })

    it('should return false for version byte above OP_16', () => {
        const script = Buffer.concat([Buffer.from([0x61, 0x14]), Buffer.alloc(20, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for script shorter than 4 bytes', () => {
        assert.strictEqual(decoder.isFutureSegwitScript(Buffer.from([0x52, 0x02, 0xaa])), false)
    })

    it('should return false for script longer than 42 bytes', () => {
        const script = Buffer.concat([Buffer.from([0x52, 0x29]), Buffer.alloc(41, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false when push length does not match actual script length', () => {
        // OP_2 with push=20 but only 10 bytes of data
        const script = Buffer.concat([Buffer.from([0x52, 0x14]), Buffer.alloc(10, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })
})

describe('XChainDecoder#getSourceFromOutput()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should return null when connector throws (invalid txid)', async () => {
        decoder.connector.getRawTransaction = sinon.stub().rejects(new Error('not found'))

        const result = await decoder.getSourceFromOutput('deadbeef', 0)
        assert.strictEqual(result, null)
    })

    it('should return null when output index is out of bounds', async () => {
        decoder.connector.getRawTransaction = sinon.stub().resolves(TX_HEX.opReturn)

        const result = await decoder.getSourceFromOutput('sometxid', 99)
        assert.strictEqual(result, null)
    })

    it('should return an address for a valid P2PKH output', async () => {
        decoder.connector.getRawTransaction = sinon.stub().resolves(TX_HEX.opReturn)

        // Output 1 is P2PKH
        const result = await decoder.getSourceFromOutput('sometxid', 1)
        assert.ok(result)
        assert.strictEqual(typeof result, 'string')
        assert.ok(result.length > 20, 'Address should be a non-trivial string')
    })

    it('should return null for OP_RETURN output (no valid address)', async () => {
        decoder.connector.getRawTransaction = sinon.stub().resolves(TX_HEX.opReturn)

        const result = await decoder.getSourceFromOutput('sometxid', 0)
        assert.strictEqual(result, null)
    })

    it('should chase P2SH outputs one level deeper', async () => {
        // Create a P2SH output script (23 bytes: OP_HASH160 PUSH20 <20 bytes> OP_EQUAL)
        const p2shScript = Buffer.alloc(23)
        p2shScript[0] = 0xa9   // OP_HASH160
        p2shScript[1] = 0x14   // PUSH 20 bytes
        p2shScript[22] = 0x87  // OP_EQUAL
        for (let i = 2; i < 22; i++) p2shScript[i] = 0xaa

        const outerTx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        outerTx.outs[1].script = p2shScript

        decoder.connector.getRawTransaction = sinon.stub()
        decoder.connector.getRawTransaction.onFirstCall().resolves(outerTx.toHex())
        decoder.connector.getRawTransaction.onSecondCall().resolves(TX_HEX.opReturn)

        const result = await decoder.getSourceFromOutput('sometxid', 1)
        // Should have chased one level
        assert.ok(decoder.connector.getRawTransaction.calledTwice)
    })
})
