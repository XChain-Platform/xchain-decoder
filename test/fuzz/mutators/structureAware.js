/**
 * Structure-aware mutators — understand the XChain protocol format
 * to produce inputs that exercise deeper code paths.
 */

const crypto = require('crypto')
const bitcoinCrypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')

const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

function getKeyIv(txid) {
    txid = txid || Buffer.from(PREV_HASH).reverse().toString('hex')
    return { key: txid.substr(0, 16), iv: txid.substr(16, 16) }
}

function encrypt(plainBuf, txid) {
    const { key, iv } = getKeyIv(txid)
    const cipher = bitcoinCrypto.createCipheriv('aes-128-ctr', key, iv)
    return Buffer.concat([cipher.update(plainBuf), cipher.final()])
}

/** Build a fuzzed XCHN-prefixed encrypted payload. */
function buildXchnPayload(data, txid) {
    const parts = [Buffer.from(data)]
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return encrypt(plainBuf, txid)
}

/** Build a fuzzed XCHNp2sh marker payload. */
function buildP2shMarker(txid) {
    return encrypt(Buffer.from('XCHNp2sh'), txid)
}

/** Build a fuzzed XCHNp2wsh marker payload. */
function buildP2wshMarker(txid) {
    return encrypt(Buffer.from('XCHNp2wsh'), txid)
}

/** Generate a random pipe-delimited DISPENSER string. */
function randomDispenserString() {
    const fieldCount = crypto.randomInt(20)
    const fields = ['DISPENSER']
    for (let i = 0; i < fieldCount; i++) {
        const type = crypto.randomInt(5)
        switch (type) {
            case 0: fields.push(''); break
            case 1: fields.push(String(crypto.randomInt(1000000))); break
            case 2: fields.push(crypto.randomBytes(crypto.randomInt(20) + 1).toString('hex')); break
            case 3: fields.push(String(-crypto.randomInt(1000))); break
            case 4: fields.push('TICK' + crypto.randomInt(100)); break
        }
    }
    return fields.join('|')
}

/** Generate a random ACTION string. */
function randomActionString() {
    const actions = ['SEND', 'ISSUE', 'DESTROY', 'SWEEP', 'BROADCAST', 'DIVIDEND', 'ORDER', 'DISPENSER', 'BATCH', 'MINT', 'AIRDROP']
    const action = actions[crypto.randomInt(actions.length)]
    const version = crypto.randomInt(3)
    const fieldCount = crypto.randomInt(15)
    const fields = [action, String(version)]
    for (let i = 0; i < fieldCount; i++) {
        const type = crypto.randomInt(6)
        switch (type) {
            case 0: fields.push(''); break
            case 1: fields.push(String(crypto.randomInt(281474976710655))); break
            case 2: fields.push(crypto.randomBytes(crypto.randomInt(32) + 1).toString('hex')); break
            case 3: fields.push(String(-crypto.randomInt(1000000))); break
            case 4: fields.push('TICK.NAME'); break
            case 5: fields.push('\x00\xFF\n\t'); break
        }
    }
    return fields.join('|')
}

/** Build a complete OP_RETURN transaction with fuzzed XCHN data. */
function buildOpReturnTx(actionData, txid) {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

    const cipher = buildXchnPayload(actionData, txid)
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

    return tx
}

/** Build a 1-of-3 multisig transaction with fuzzed pubkey data. */
function buildMultisigTx(data, txid) {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

    // Pad data to fill two pubkeys (32 bytes each, with 1-byte prefix stripped)
    const dataBuf = Buffer.from(data)
    const paddedData = Buffer.alloc(64, 0)
    dataBuf.copy(paddedData, 0, 0, Math.min(dataBuf.length, 64))

    // Add 0x02 prefix to make them look like compressed pubkeys
    const pubkey1 = Buffer.concat([Buffer.from([0x02]), paddedData.subarray(0, 32)])
    const pubkey2 = Buffer.concat([Buffer.from([0x02]), paddedData.subarray(32)])
    const pubkey3 = Buffer.concat([Buffer.from([0x03]), crypto.randomBytes(32)])

    // Encrypt the payload including XCHN prefix
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), dataBuf])
    const encrypted1 = encrypt(Buffer.concat([Buffer.from([0x02]), plainBuf.subarray(0, Math.min(32, plainBuf.length))]), txid)
    const encrypted2 = encrypt(Buffer.concat([Buffer.from([0x02]), plainBuf.subarray(32)]), txid)

    // Use OP_1 pubkey1 pubkey2 pubkey3 OP_3 OP_CHECKMULTISIG
    const msScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_1,
        pubkey1,
        pubkey2,
        pubkey3,
        bitcoin.opcodes.OP_3,
        bitcoin.opcodes.OP_CHECKMULTISIG
    ])

    tx.addOutput(msScript, 1000)
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
    return tx
}

/** Generate a fuzzed txid string of various lengths. */
function randomTxid() {
    const type = crypto.randomInt(6)
    switch (type) {
        case 0: return '' // empty
        case 1: return crypto.randomBytes(4).toString('hex') // short (8 chars)
        case 2: return crypto.randomBytes(16).toString('hex') // exactly 32 chars
        case 3: return crypto.randomBytes(32).toString('hex') // normal (64 chars)
        case 4: return crypto.randomBytes(64).toString('hex') // long (128 chars)
        case 5: return 'zzzz' + crypto.randomBytes(14).toString('hex') // non-hex prefix
    }
}

/** Generate a fuzzed block buffer for Litecoin with various marker/flag combos. */
function buildFuzzedLitecoinBlockHex(opts) {
    opts = opts || {}
    const version = opts.version || '02000000'
    const prevHash = crypto.randomBytes(32).toString('hex')
    const merkleRoot = crypto.randomBytes(32).toString('hex')
    const timestamp = '00000000'
    const bits = '00000000'
    const nonce = '00000000'
    const header = version + prevHash + merkleRoot + timestamp + bits + nonce

    if (opts.headerOnly) return header

    // Build a minimal coinbase tx
    const marker = opts.marker != null ? opts.marker : '00'
    const flag = opts.flag != null ? opts.flag : '08'

    // Use the raw version+marker+flag pattern that triggers HogEx logic
    const txVersion = opts.txVersion || '02000000'
    const fakeTxBody = txVersion + marker + flag + '01' +
        '0000000000000000000000000000000000000000000000000000000000000000' + 'ffffffff' +
        '04' + '01010101' + 'ffffffff' +
        '01' + '0000000000000000' + '00' +
        '00000000'

    const txCount = '01'
    return header + txCount + fakeTxBody
}

module.exports = {
    PREV_HASH, getKeyIv, encrypt,
    buildXchnPayload, buildP2shMarker, buildP2wshMarker,
    randomDispenserString, randomActionString,
    buildOpReturnTx, buildMultisigTx,
    randomTxid, buildFuzzedLitecoinBlockHex
}
