const assert = require('assert')
const sinon = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db')

bitcoin.initEccLib(ecc)

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

function buildXchnPayload(data) {
    const scriptPayload = bitcoin.script.compile([Buffer.from(data)])
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return encryptBuf(plainBuf)
}

function buildDispenserTx(expiration) {
    // DISPENSER|version|giveCoin|giveAmount|giveEscrow|giveStatus|getCoin|getAmount|getEscrow|getAddress|getStatus|oracle|expiration
    const fields = ['DISPENSER', '0', 'GIVE_COIN', '1000', '', '', 'GET_COIN', '500', '', 'addr', '', '', String(expiration)]
    const data = fields.join('|')

    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

    const cipher = buildXchnPayload(data)
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
    return tx
}

function createDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false),
        insertTransaction: sinon.stub().resolves(true),
        insertDispenser: sinon.stub().resolves(true),
        insertTransactionOutput: sinon.stub().resolves(true),
        getLastBlockIndex: sinon.stub().resolves(0),
        getLastTxIndex: sinon.stub().resolves(0)
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().resolves(
            '0200000001' + '00'.repeat(32) + '01000000' +
            '6b48' + '30'.repeat(72) + '21' + '02'.repeat(33) +
            'ffffffff' + '01' + '00e1f50500000000' +
            '1976a914' + 'aa'.repeat(20) + '88ac' + '00000000'
        )
    }
    return decoder
}

describe('Security: DISPENSER Field Validation', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // --- SEC-11: Expiration validation ---

    describe('Expiration numeric validation', () => {
        it('[REGRESSION P1] R-DSP-001: should parse a valid numeric expiration', async () => {
            const tx = buildDispenserTx(1700000000)
            const result = await decoder.parseTransaction(tx)

            assert.ok(result)
            assert.ok(result.data.length > 0)
            assert.ok(result.data.toString('utf-8').includes('1700000000'))
        })

        it('should parse expiration of 0', async () => {
            const tx = buildDispenserTx(0)
            const result = await decoder.parseTransaction(tx)

            assert.ok(result)
            assert.ok(result.data.toString('utf-8').includes('DISPENSER'))
        })
    })

    // --- SEC-13: parseInt radix ---

    describe('Version parsing safety', () => {
        it('[REGRESSION P1] R-DSP-002: should verify parseInt uses radix 10 in source code', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8')

            // Look for dispenser version parsing — should use radix 10
            const dispenserParseIntMatch = source.match(/parseInt\(commandVersion,\s*10\)/)
            assert.ok(dispenserParseIntMatch, 'parseInt for commandVersion should specify radix 10')
        })

        it('should verify Number() is used for expiration (not parseInt)', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/XChainDecoder.js'), 'utf-8')

            // Expiration should use Number() for strict numeric conversion
            assert.ok(
                source.includes('Number(decodedDataSplit[12])'),
                'Expiration should be parsed with Number()'
            )
        })
    })

    // --- Pipe-delimited field injection ---

    describe('Field injection resistance', () => {
        it('[REGRESSION P1] R-DSP-001: should handle extra pipe characters in DISPENSER payload', async () => {
            const fields = ['DISPENSER', '0', 'GIVE|INJECTED', '1000', '', '', 'GET_COIN', '500', '', 'addr', '', '', '3600']
            const data = fields.join('|')

            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            const cipher = buildXchnPayload(data)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            // Should not crash — extra pipes shift fields
            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
        })

        it('should handle newlines embedded in DISPENSER fields', async () => {
            const fields = ['DISPENSER', '0', 'GIVE\nCOIN', '1000', '', '', 'GET_COIN', '500', '', 'addr', '', '', '3600']
            const data = fields.join('|')

            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            const cipher = buildXchnPayload(data)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
        })
    })
})
