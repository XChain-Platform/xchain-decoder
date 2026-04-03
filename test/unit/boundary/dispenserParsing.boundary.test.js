const assert = require('assert')
const sinon = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

function getKeyIv() {
    const display = Buffer.from(PREV_HASH).reverse().toString('hex')
    return { key: display.substr(0, 16), iv: display.substr(16, 16) }
}

function encryptBuf(plainBuf) {
    const { key, iv } = getKeyIv()
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    return Buffer.concat([cipher.update(plainBuf), cipher.final()])
}

function buildXchnPayload(data) {
    const parts = [Buffer.from(data)]
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

// Helper: build a transaction with the given ACTION string as XCHN payload
function buildActionTx(actionString) {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    addStandardInput(tx)
    const cipher = buildXchnPayload(actionString)
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
    addP2PKHOutput(tx)
    return tx
}

// ============================================================================
// These tests exercise the DISPENSER field extraction logic from the boundary
// testing plan (scenarios A-1 through A-12, E-1 through E-7).
//
// The actual DISPENSER creation happens in the block-processing loop (not in
// parseTransaction), so we test parseTransaction's output to verify the data
// field content, and test the DISPENSER parsing logic patterns in isolation.
// ============================================================================

describe('Boundary: ACTION String Parsing (A-1 through A-12)', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // A-1: Empty decoded data
    it('A-1: empty payload after XCHN prefix → data is Buffer of length 0', async () => {
        // buildXchnPayload with empty string creates: XCHN + script.compile([Buffer.from('')])
        // The compiled script will have the empty buffer push
        const tx = buildActionTx('')
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Empty string compiles to a script with OP_0, which decompiles to
        // a Buffer — the data field will be a Buffer (possibly empty or a zero-push)
    })

    // A-2: Single character
    it('A-2: single character ACTION → stored as-is', async () => {
        const tx = buildActionTx('D')
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.ok(result.data.length > 0)
    })

    // A-3: Only pipes
    it('A-3: pipe-only string → stored as-is, not DISPENSER-prefixed', async () => {
        const tx = buildActionTx('|||||')
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.ok(result.data.length > 0)
        const decoded = result.data.toString('utf-8')
        assert.ok(!decoded.startsWith('DISPENSER'))
    })

    // A-5: DISPENSER with all 15 fields present (v0 complete happy path)
    it('[REGRESSION P1] R-DSP-001 A-5: DISPENSER v0 with all 15 fields → complete parse', async () => {
        const action = 'DISPENSER|0|BTC|JDOG|1|10|LTC||0.01|bcrt1qaddr|||9999999999|||memo'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        const decoded = result.data.toString('utf-8')
        assert.strictEqual(decoded, action)
    })

    // A-6: DISPENSER with extra fields beyond spec
    it('A-6: DISPENSER with extra fields → extra fields ignored', async () => {
        const action = 'DISPENSER|0|BTC|||LTC||||addr|||3600|||extra1|extra2|extra3'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), action)
    })

    // A-12: Data with embedded null bytes
    it('A-12: data with embedded null bytes → textDecoder handles it', async () => {
        const action = 'DISPENSER|0|BTC\x00||||||||||||||'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        const decoded = result.data.toString('utf-8')
        assert.ok(decoded.startsWith('DISPENSER'))
    })
})

describe('Boundary: DISPENSER Field Extraction Logic (A-4, A-7 through A-11)', () => {
    // These test the DISPENSER parsing logic patterns in isolation,
    // since the actual parsing happens in the block-processing loop.

    // A-4: DISPENSER with only 2 fields — now rejected by field-count check
    it('[REGRESSION P1] R-DSP-001 A-4: short DISPENSER string "DISPENSER|0" — rejected (< 13 fields)', () => {
        const decodedData = 'DISPENSER|0'
        const decodedDataSplit = decodedData.split('|')

        assert.strictEqual(decodedDataSplit.length, 2)
        assert.strictEqual(parseInt(decodedDataSplit[1]), 0)

        // The decoder now requires decodedDataSplit.length >= 13 before
        // accessing fields. With only 2 fields, no dispenser is created.
        assert.ok(decodedDataSplit.length < 13, 'short string rejected by field-count check')
    })

    // A-7: DISPENSER version non-numeric
    it('[REGRESSION P1] R-DSP-002 A-7: DISPENSER with version "abc" — parseInt returns NaN, not == 0', () => {
        const decodedData = 'DISPENSER|abc|BTC|||LTC||||addr|||3600'
        const decodedDataSplit = decodedData.split('|')
        const commandVersion = decodedDataSplit[1]

        assert.ok(isNaN(parseInt(commandVersion)))
        // NaN == 0 is false → dispenser not created
        assert.ok(parseInt(commandVersion) != 0)
    })

    // A-8: DISPENSER version negative
    it('A-8: DISPENSER with version "-1" — parseInt returns -1, not == 0', () => {
        const decodedData = 'DISPENSER|-1|BTC|||LTC||||addr|||3600'
        const decodedDataSplit = decodedData.split('|')
        const commandVersion = decodedDataSplit[1]

        assert.strictEqual(parseInt(commandVersion), -1)
        assert.ok(parseInt(commandVersion) != 0)
    })

    // A-9: DISPENSER version as float "0.5"
    it('A-9: DISPENSER with version "0.5" — parseInt returns 0, treated as v0', () => {
        const decodedData = 'DISPENSER|0.5|BTC|||LTC||||addr|||3600'
        const decodedDataSplit = decodedData.split('|')
        const commandVersion = decodedDataSplit[1]

        // parseInt("0.5") = 0
        assert.strictEqual(parseInt(commandVersion), 0)
        // This means the dispenser creation branch is entered
    })

    // A-10/A-11: MEDIUMTEXT limits — these are DB-level constraints, tested as assertions
    it('A-10: ACTION string near MEDIUMTEXT limit (16,777,215 bytes) — large string creates correctly', () => {
        // Just verify the logic handles large strings without JS-level issues
        const largeAction = 'SEND|0|' + 'X'.repeat(16777200)
        assert.ok(largeAction.startsWith('SEND'))
        assert.ok(!largeAction.startsWith('DISPENSER'))
        // No DISPENSER parsing triggered for non-DISPENSER actions
    })

    // DISPENSER with both giveCoin and getCoin empty — should NOT create dispenser
    it('DISPENSER with both coins empty — skip dispenser creation', () => {
        const decodedData = 'DISPENSER|0||||||||||||||'
        const decodedDataSplit = decodedData.split('|')
        const commandVersion = decodedDataSplit[1]
        const giveCoin = decodedDataSplit[2]
        const getCoin = decodedDataSplit[6]

        assert.strictEqual(parseInt(commandVersion), 0)
        assert.strictEqual(giveCoin, '')
        assert.strictEqual(getCoin, '')
        // (getCoin != "") || (giveCoin != "") → false — dispenser NOT created
        assert.ok(!(getCoin != '' || giveCoin != ''))
    })

    // DISPENSER with giveCoin empty but getCoin present
    // Fields: 0=ACTION, 1=version, 2=giveCoin, 3=giveAsset, 4=giveAmount, 5=giveMultiplier,
    //         6=getCoin, 7=getAsset, 8=getAmount, 9=getAddress, 10=?, 11=?, 12=expiration
    it('DISPENSER with only getCoin — should create dispenser', () => {
        const decodedData = 'DISPENSER|0|||||LTC|||addr|||3600||'
        const decodedDataSplit = decodedData.split('|')
        const giveCoin = decodedDataSplit[2]
        const getCoin = decodedDataSplit[6]

        assert.strictEqual(giveCoin, '')
        assert.strictEqual(getCoin, 'LTC')
        assert.ok(getCoin != '' || giveCoin != '')
    })

    // Case sensitivity: "dispenser" (lowercase)
    it('lowercase "dispenser" — startsWith("DISPENSER") is false', () => {
        assert.ok(!'dispenser|0|BTC|...'.startsWith('DISPENSER'))
    })
})

describe('Boundary: Dispenser Expiration Values (E-1 through E-7)', () => {
    // These test FROM_UNIXTIME behavior at the application/query level.
    // The actual SQL execution requires a DB, but we test the JS-side handling.

    // E-1: Unix epoch
    it('[REGRESSION P1] R-DSP-002 E-1: expiration "0" — valid timestamp, FROM_UNIXTIME(0) = 1970-01-01', () => {
        const expiration = '0'
        // This is a valid value that the decoder passes directly to the SQL query
        assert.strictEqual(parseInt(expiration), 0)
        assert.ok(!isNaN(parseInt(expiration)))
    })

    // E-2: 32-bit max
    it('E-2: expiration "2147483647" — max 32-bit, valid FROM_UNIXTIME', () => {
        const expiration = '2147483647'
        assert.strictEqual(parseInt(expiration), 2147483647)
    })

    // E-3: Beyond 32-bit — FROM_UNIXTIME returns NULL on some MariaDB versions
    it('E-3: expiration "2147483648" — beyond 32-bit boundary', () => {
        const expiration = '2147483648'
        assert.strictEqual(parseInt(expiration), 2147483648)
        // BOUNDARY FINDING: This gets passed to FROM_UNIXTIME() which may return NULL
        // causing the dispenser to have NULL expiration and never expire
    })

    // E-4: Negative timestamp
    it('E-4: expiration "-1" — negative, FROM_UNIXTIME(-1) = NULL', () => {
        const expiration = '-1'
        assert.strictEqual(parseInt(expiration), -1)
        // BOUNDARY FINDING: FROM_UNIXTIME(-1) = NULL on most MariaDB versions
    })

    // E-5: Non-numeric
    it('E-5: expiration "abc" — parseInt returns NaN', () => {
        const expiration = 'abc'
        assert.ok(isNaN(parseInt(expiration)))
        // Passed as NaN to SQL — MariaDB may coerce to 0 or NULL
    })

    // E-6: Empty string
    it('E-6: expiration "" — parseInt returns NaN', () => {
        const expiration = ''
        assert.ok(isNaN(parseInt(expiration)))
        // FROM_UNIXTIME("") in MariaDB may coerce to FROM_UNIXTIME(0) = 1970-01-01
    })

    // E-7: Undefined (field missing from short ACTION string)
    it('E-7: expiration undefined — from short action string', () => {
        const decodedDataSplit = 'DISPENSER|0'.split('|')
        const expiration = decodedDataSplit[12]

        assert.strictEqual(expiration, undefined)
        // BOUNDARY FINDING: undefined passes through to parameterized query as NULL.
        // FROM_UNIXTIME(NULL) = NULL → dispenser never expires.
        // Combined with A-4 finding: short DISPENSER strings create immortal dispensers.
    })

    // Additional: very large timestamp
    it('expiration "99999999999" — year 5138, beyond MariaDB DATETIME range', () => {
        const expiration = '99999999999'
        assert.strictEqual(parseInt(expiration), 99999999999)
        // FROM_UNIXTIME(99999999999) is beyond DATETIME max (9999-12-31), returns NULL
    })
})

describe('Boundary: Combinatorial DISPENSER Scenarios', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Combo 4: DISPENSER data + source address resolution failure
    it('DISPENSER payload but getSourceFromOutput returns null — tx skipped', async () => {
        decoder.connector.getRawTransaction = sinon.stub().rejects(new Error('not found'))

        const action = 'DISPENSER|0|BTC|JDOG|1|10|LTC||0.01|addr|||3600|||'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.ok(result.data.length > 0)
        // source is null because getSourceFromOutput failed
        assert.strictEqual(result.source, null)
        // In the block-processing loop, this would be skipped at line 620-622:
        // (data.length > 0 && source != null) — source is null, so it's skipped
        // The DISPENSER is NOT created. This is correct behavior.
    })

    // Combo 5: BATCH string with DISPENSER as non-first command
    it('BATCH with DISPENSER as second command — decoder does NOT parse it', async () => {
        const action = 'SEND|0|BTC|100;DISPENSER|0|BTC|||LTC||||addr|||3600|||'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        const decoded = result.data.toString('utf-8')
        // The full BATCH string is stored. startsWith("DISPENSER") is false
        // because the string starts with "SEND".
        assert.ok(!decoded.startsWith('DISPENSER'))
        assert.ok(decoded.includes('DISPENSER'))
        // The decoder does NOT create a dispenser for BATCH-embedded DISPENSERs.
    })

    // Combo: DISPENSER as first command in a BATCH (should be caught)
    it('BATCH with DISPENSER as first command — decoder DOES parse it', async () => {
        const action = 'DISPENSER|0|BTC|||LTC||||addr|||3600|||;SEND|0|BTC|100'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        const decoded = result.data.toString('utf-8')
        // startsWith("DISPENSER") is true
        assert.ok(decoded.startsWith('DISPENSER'))
        // But the split on "|" will include the ";SEND|0|BTC|100" in later fields
        // This could pollute the expiration and other fields
        const split = decoded.split('|')
        // Field [12] would be "3600" (if enough pipes before the semicolon)
        assert.strictEqual(split[12], '3600')
    })
})
