/**
 * Transaction builder helper for E2E tests.
 *
 * Extends the integration txBuilder with:
 *  - P2SH two-transaction broadcast (fund → spend to reveal data)
 *  - P2WSH two-transaction broadcast (fund → spend to reveal data)
 *  - sendToAddress helper (plain BTC send to any address)
 *  - invalidateBlock / reconsiderBlock for reorg simulation
 *  - Mempool polling helpers
 *  - Decoder stop/restart helpers
 */

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip39 = require('bip39')
const { ECPairFactory } = require('ecpair')
const nodeHelper = require('../../nodeHelper')
const XChainDecoder = require('../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)
const bip32 = BIP32Factory(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.regtest

const MNEMONIC = 'erase average powder march guess lemon basic eight arena world once puzzle'

// Derivation counter — incremented to get fresh addresses per test
let derivationIndex = 200 // offset from integration tests to avoid collisions

function getNextDerivation() {
    derivationIndex++
    const seed = bip39.mnemonicToSeedSync(MNEMONIC)
    const root = bip32.fromSeed(seed, network)
    const account = root.derivePath("m/44'/0'/0'/0")
    return account.derive(0).derive(derivationIndex)
}

/**
 * Encrypt data with AES-128-CTR using the first 32 hex chars of a txid as key+iv.
 */
function obfuscate(data, txid) {
    const key = txid.substr(0, 16)
    const iv = txid.substr(16, 16)
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    let enc = cipher.update(data)
    return Buffer.concat([enc, cipher.final()])
}

/**
 * Build the full XCHN payload: XCHN prefix + bitcoin script-compiled data.
 */
function buildXchnPayload(actionString, txid, rawData) {
    const parts = [Buffer.from(actionString)]
    if (rawData) parts.push(Buffer.from(rawData))
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return obfuscate(plainBuf, txid)
}

/**
 * Build the XCHN P2SH marker payload: encrypts "XCHNp2sh" for the OP_RETURN.
 */
function buildXchnP2shMarker(txid) {
    const plainBuf = Buffer.from('XCHNp2sh')
    return obfuscate(plainBuf, txid)
}

/**
 * Build the XCHN P2WSH marker payload: encrypts "XCHNp2wsh" for the OP_RETURN.
 */
function buildXchnP2wshMarker(txid) {
    const plainBuf = Buffer.from('XCHNp2wsh')
    return obfuscate(plainBuf, txid)
}

/**
 * Fund an address by sending BTC from the test wallet, then mine a block.
 */
async function fundAddress(address, btcAmount) {
    const txid = await global.nodeClientTest.sendToAddress(address, btcAmount || 1)
    const rawTx = await global.nodeClientTest.getRawTransaction(txid, true)
    const rawTxHex = await global.nodeClientTest.getRawTransaction(txid)
    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)

    let satoshis = 0
    let voutIndex = -1
    for (let i = 0; i < rawTx.vout.length; i++) {
        const v = rawTx.vout[i]
        if (v.scriptPubKey && v.scriptPubKey.address === address) {
            satoshis = Math.round(v.value * 100000000)
            voutIndex = i
            break
        }
    }

    return { txid, rawTx, rawTxHex, address, satoshis, voutIndex }
}

/**
 * Create a Legacy (P2PKH) address and fund it.
 */
async function createFundedLegacyAddress(btcAmount) {
    const key = getNextDerivation()
    const { address } = bitcoin.payments.p2pkh({ pubkey: key.publicKey, network })
    const funding = await fundAddress(address, btcAmount)
    return { ...funding, key, addressType: 'legacy' }
}

/**
 * Create a SegWit (P2WPKH) address and fund it.
 */
async function createFundedSegwitAddress(btcAmount) {
    const key = getNextDerivation()
    const { address } = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network })
    const funding = await fundAddress(address, btcAmount)
    return { ...funding, key, addressType: 'segwit' }
}

/**
 * Create a Taproot (P2TR) address and fund it.
 */
async function createFundedTaprootAddress(btcAmount) {
    const key = getNextDerivation()
    const xOnlyPubkey = key.publicKey.slice(1, 33)
    const p2tr = bitcoin.payments.p2tr({ internalPubkey: xOnlyPubkey, network })
    const tweakedKey = key.tweak(bitcoin.crypto.taggedHash('TapTweak', xOnlyPubkey))
    const funding = await fundAddress(p2tr.address, btcAmount)
    return {
        ...funding,
        key,
        tweakedKey,
        xOnlyPubkey,
        output: p2tr.output,
        addressType: 'taproot'
    }
}

/**
 * Build, sign, and broadcast an OP_RETURN transaction with an XCHN ACTION payload.
 */
async function broadcastOpReturn(funded, actionString, rawData) {
    const fee = 10000
    const psbt = new bitcoin.Psbt({ network })

    if (funded.addressType === 'taproot') {
        psbt.addInput({
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: funded.output },
            tapInternalKey: funded.xOnlyPubkey
        })
    } else if (funded.addressType === 'segwit') {
        const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: funded.key.publicKey, network })
        psbt.addInput({
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: p2wpkh.output }
        })
    } else {
        psbt.addInput({
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
        })
    }

    const encryptedPayload = buildXchnPayload(actionString, funded.txid, rawData)
    const opReturnScript = bitcoin.payments.embed({ data: [encryptedPayload] })

    psbt.addOutput({ script: opReturnScript.output, value: 0 })
    psbt.addOutput({ address: funded.address, value: funded.satoshis - fee })

    if (funded.addressType === 'taproot') {
        for (let i = 0; i < psbt.data.inputs.length; i++) {
            psbt.signInput(i, funded.tweakedKey)
        }
    } else {
        const signer = ECPair.fromPrivateKey(funded.key.privateKey, { network })
        for (let i = 0; i < psbt.data.inputs.length; i++) {
            psbt.signInput(i, signer)
        }
    }

    psbt.finalizeAllInputs()
    const txHex = psbt.extractTransaction().toHex()
    const txHash = await nodeHelper.broadcastTx(txHex)

    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
    const info = await global.nodeClientTest.getBlockchainInfo()

    return { txHash, blockIndex: info.blocks }
}

/**
 * Broadcast an OP_RETURN XCHN transaction WITHOUT mining a block.
 * Used for mempool tests.
 */
async function broadcastOpReturnNoMine(funded, actionString) {
    const fee = 10000
    const psbt = new bitcoin.Psbt({ network })

    if (funded.addressType === 'taproot') {
        psbt.addInput({
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: funded.output },
            tapInternalKey: funded.xOnlyPubkey
        })
    } else if (funded.addressType === 'segwit') {
        const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: funded.key.publicKey, network })
        psbt.addInput({
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: p2wpkh.output }
        })
    } else {
        psbt.addInput({
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
        })
    }

    const encryptedPayload = buildXchnPayload(actionString, funded.txid)
    const opReturnScript = bitcoin.payments.embed({ data: [encryptedPayload] })

    psbt.addOutput({ script: opReturnScript.output, value: 0 })
    psbt.addOutput({ address: funded.address, value: funded.satoshis - fee })

    if (funded.addressType === 'taproot') {
        for (let i = 0; i < psbt.data.inputs.length; i++) {
            psbt.signInput(i, funded.tweakedKey)
        }
    } else {
        const signer = ECPair.fromPrivateKey(funded.key.privateKey, { network })
        for (let i = 0; i < psbt.data.inputs.length; i++) {
            psbt.signInput(i, signer)
        }
    }

    psbt.finalizeAllInputs()
    const txHex = psbt.extractTransaction().toHex()
    const txHash = await nodeHelper.broadcastTx(txHex)

    return { txHash }
}

/**
 * Build, sign, and broadcast a 1-of-3 multisig transaction with XCHN payload.
 */
async function broadcastMultisig(funded, actionString) {
    const fee = 10000
    const psbt = new bitcoin.Psbt({ network })

    psbt.addInput({
        hash: funded.txid,
        index: funded.voutIndex,
        sequence: 0x00000001,
        nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
    })

    const parts = [Buffer.from(actionString)]
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    const encrypted = obfuscate(plainBuf, funded.txid)

    const padded = Buffer.concat([encrypted, Buffer.alloc(Math.max(0, 64 - encrypted.length), 0)])
    const pubkey1 = Buffer.concat([Buffer.from([0x02]), padded.subarray(0, 32)])
    const pubkey2 = Buffer.concat([Buffer.from([0x02]), padded.subarray(32, 64)])
    const pubkey3 = Buffer.alloc(33, 0x03)

    const multisigScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_1, pubkey1, pubkey2, pubkey3,
        bitcoin.opcodes.OP_3, bitcoin.opcodes.OP_CHECKMULTISIG
    ])

    psbt.addOutput({ script: multisigScript, value: 1000 })
    psbt.addOutput({ address: funded.address, value: funded.satoshis - fee - 1000 })

    const signer = ECPair.fromPrivateKey(funded.key.privateKey, { network })
    for (let i = 0; i < psbt.data.inputs.length; i++) {
        psbt.signInput(i, signer)
    }

    psbt.finalizeAllInputs()
    const txHex = psbt.extractTransaction().toHex()
    const txHash = await nodeHelper.broadcastTx(txHex)

    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
    const info = await global.nodeClientTest.getBlockchainInfo()

    return { txHash, blockIndex: info.blocks }
}

/**
 * Build and broadcast a transaction with NO XCHN data (just a regular P2PKH send).
 */
async function broadcastPlainTransaction(funded) {
    const fee = 10000
    const psbt = new bitcoin.Psbt({ network })

    psbt.addInput({
        hash: funded.txid,
        index: funded.voutIndex,
        sequence: 0x00000001,
        nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
    })

    psbt.addOutput({ address: funded.address, value: funded.satoshis - fee })

    const signer = ECPair.fromPrivateKey(funded.key.privateKey, { network })
    psbt.signInput(0, signer)
    psbt.finalizeAllInputs()

    const txHex = psbt.extractTransaction().toHex()
    const txHash = await nodeHelper.broadcastTx(txHex)
    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
    const info = await global.nodeClientTest.getBlockchainInfo()

    return { txHash, blockIndex: info.blocks }
}

/**
 * Build and broadcast a transaction with a non-XCHN OP_RETURN.
 */
async function broadcastNonXchnOpReturn(funded, rawBytes) {
    const fee = 10000
    const psbt = new bitcoin.Psbt({ network })

    psbt.addInput({
        hash: funded.txid,
        index: funded.voutIndex,
        sequence: 0x00000001,
        nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
    })

    const opReturnScript = bitcoin.payments.embed({ data: [rawBytes || crypto.randomBytes(20)] })
    psbt.addOutput({ script: opReturnScript.output, value: 0 })
    psbt.addOutput({ address: funded.address, value: funded.satoshis - fee })

    const signer = ECPair.fromPrivateKey(funded.key.privateKey, { network })
    psbt.signInput(0, signer)
    psbt.finalizeAllInputs()

    const txHex = psbt.extractTransaction().toHex()
    const txHash = await nodeHelper.broadcastTx(txHex)
    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
    const info = await global.nodeClientTest.getBlockchainInfo()

    return { txHash, blockIndex: info.blocks }
}

/**
 * Send BTC to any address (used for dispenser trigger payments).
 * Mines a block after sending.
 */
async function sendToAddress(address, btcAmount) {
    const txid = await global.nodeClientTest.sendToAddress(address, btcAmount || 0.001)
    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
    const info = await global.nodeClientTest.getBlockchainInfo()
    return { txHash: txid, blockIndex: info.blocks }
}

/**
 * Mine N blocks without any special transactions.
 */
async function mineBlocks(count) {
    await global.nodeClientTest.generateToAddress(count, global.mainTestAddress)
    const info = await global.nodeClientTest.getBlockchainInfo()
    return info.blocks
}

/**
 * Invalidate a block by hash (for reorg simulation).
 */
function invalidateBlock(blockHash) {
    const { execSync } = require('child_process')
    execSync(`bitcoin-cli -regtest invalidateblock ${blockHash}`, { stdio: 'pipe' })
}

/**
 * Reconsider a previously invalidated block.
 */
function reconsiderBlock(blockHash) {
    const { execSync } = require('child_process')
    execSync(`bitcoin-cli -regtest reconsiderblock ${blockHash}`, { stdio: 'pipe' })
}

/**
 * Get the block hash at a given height.
 */
function getBlockHash(height) {
    const { execSync } = require('child_process')
    return execSync(`bitcoin-cli -regtest getblockhash ${height}`, { stdio: 'pipe' }).toString().trim()
}

/**
 * Wait for the decoder to process up to a given block index.
 */
async function waitForDecoder(targetBlockIndex, maxWaitMs) {
    const deadline = Date.now() + (maxWaitMs || 30000)
    while (Date.now() < deadline) {
        const lastBlock = await global.db.getLastBlockIndex()
        if (lastBlock >= targetBlockIndex) return true
        await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Decoder did not reach block ${targetBlockIndex} within timeout`)
}

/**
 * Wait for a specific transaction to appear in the decoder DB.
 */
async function waitForTransaction(txHash, maxWaitMs) {
    const deadline = Date.now() + (maxWaitMs || 30000)
    while (Date.now() < deadline) {
        const tx = await global.db.getTransaction(txHash)
        if (tx) return tx
        await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Transaction ${txHash} not found in decoder DB within timeout`)
}

/**
 * Wait for a specific transaction to appear in the mempool_transactions table.
 */
async function waitForMempoolTransaction(txHash, maxWaitMs) {
    const deadline = Date.now() + (maxWaitMs || 90000) // mempool polls every 60s
    while (Date.now() < deadline) {
        const connection = await global.db.pool.getConnection()
        try {
            const rows = await connection.query(
                `SELECT mpt.*, it.hash AS tx_hash
                 FROM mempool_transactions mpt
                 LEFT JOIN index_transactions it ON it.id = mpt.tx_hash_id
                 WHERE it.hash = ?`,
                [txHash]
            )
            if (rows.length > 0) return rows[0]
        } finally {
            await connection.release()
        }
        await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error(`Mempool transaction ${txHash} not found within timeout`)
}

/**
 * Stop the global decoder and wait for it to wind down.
 */
async function stopDecoder() {
    if (global.decoder) {
        global.decoder.stop()
        await new Promise(r => setTimeout(r, 2000))
    }
}

/**
 * Start a fresh decoder instance and wait for it to sync to chain tip.
 */
async function startDecoder() {
    global.decoder = global.createDecoder()
    global.decoder.start()

    const info = await global.nodeClientTest.getBlockchainInfo()
    await waitForDecoder(info.blocks, 60000)
}

module.exports = {
    obfuscate,
    buildXchnPayload,
    buildXchnP2shMarker,
    buildXchnP2wshMarker,
    fundAddress,
    createFundedLegacyAddress,
    createFundedSegwitAddress,
    createFundedTaprootAddress,
    broadcastOpReturn,
    broadcastOpReturnNoMine,
    broadcastMultisig,
    broadcastPlainTransaction,
    broadcastNonXchnOpReturn,
    sendToAddress,
    mineBlocks,
    invalidateBlock,
    reconsiderBlock,
    getBlockHash,
    waitForDecoder,
    waitForTransaction,
    waitForMempoolTransaction,
    stopDecoder,
    startDecoder
}
