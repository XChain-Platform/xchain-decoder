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
 * Transaction builder helper for E2E tests.
 *
 * Extends the integration txBuilder with:
 *  - sendToAddress helper (plain BTC send to any address)
 *  - invalidateBlock / reconsiderBlock / getBlockHash for reorg simulation
 *  - Mempool polling helpers
 *  - Decoder stop/restart helpers
 *
 * Every node call goes over RPC to the containerised venue. The reorg helpers
 * used to shell out to `bitcoin-cli -regtest`, which reached whatever node the
 * host happened to be running rather than the fixture's own.
 */

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip39 = require('bip39')
const { ECPairFactory } = require('ecpair')
const nodeHelper = require('../../nodeHelper')
const { waitUntil } = require('../../helpers/waitUntil')
const bufferutils = require('bitcoinjs-lib/src/bufferutils')

bitcoin.initEccLib(ecc)
const bip32 = BIP32Factory(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.regtest

const MNEMONIC = 'erase average powder march guess lemon basic eight arena world once puzzle'

// A MULTISIGN carrier holds its payload in two 32-byte data pubkeys.
const MULTISIG_SLOT_BYTES = 64

// Derivation counter, incremented to get fresh addresses per test
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
 * Add an input to a PSBT with the stock Number-valued 64-bit reader in force.
 *
 * bitcoinjs-lib parses a legacy input's nonWitnessUtxo transaction once, here at
 * addInput time, and caches the result for signing and for the amount arithmetic
 * inside extractTransaction. These fixtures load the decoder into the same
 * process, and the decoder patches bitcoinjs-lib's 64-bit reader to return BigInt
 * so Dogecoin outputs above 2^53 survive (src/applyBufferutilsPatch.js). PSBT's
 * own amount arithmetic starts from a Number, so a cached BigInt output value
 * makes extractTransaction throw "Cannot mix BigInt and other types" on every
 * legacy input. Parsing the previous transaction with the stock reader keeps the
 * cache in Numbers; regtest values are nowhere near the 2^53 ceiling the patch
 * exists for. The swap spans a single synchronous call, so the decoder polling in
 * this same process can never observe it.
 */
function addPsbtInput(psbt, inputData) {
    const proto = bufferutils.BufferReader.prototype
    const patchedReader = proto.readUInt64
    proto.readUInt64 = function readUInt64AsNumber() {
        const value = this.buffer.readBigUInt64LE(this.offset)
        this.offset += 8
        return Number(value)
    }
    try {
        return psbt.addInput(inputData)
    } finally {
        proto.readUInt64 = patchedReader
    }
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
        addPsbtInput(psbt, {
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: funded.output },
            tapInternalKey: funded.xOnlyPubkey
        })
    } else if (funded.addressType === 'segwit') {
        const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: funded.key.publicKey, network })
        addPsbtInput(psbt, {
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: p2wpkh.output }
        })
    } else {
        addPsbtInput(psbt, {
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
        addPsbtInput(psbt, {
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: funded.output },
            tapInternalKey: funded.xOnlyPubkey
        })
    } else if (funded.addressType === 'segwit') {
        const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: funded.key.publicKey, network })
        addPsbtInput(psbt, {
            hash: funded.txid,
            index: funded.voutIndex,
            sequence: 0x00000001,
            witnessUtxo: { value: funded.satoshis, script: p2wpkh.output }
        })
    } else {
        addPsbtInput(psbt, {
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

    addPsbtInput(psbt, {
        hash: funded.txid,
        index: funded.voutIndex,
        sequence: 0x00000001,
        nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
    })

    const parts = [Buffer.from(actionString)]
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    if (plainBuf.length > MULTISIG_SLOT_BYTES) {
        throw new Error(
            `multisig ACTION payload is ${plainBuf.length} bytes, over the ` +
            `${MULTISIG_SLOT_BYTES}-byte two-pubkey slot: use a shorter action string`)
    }

    // Zero-pad the PLAINTEXT to fill the 64-byte slot, then obfuscate, which is
    // what the encoder does. Padding the CIPHERTEXT instead (the original shape
    // here) decrypts to keystream garbage rather than to zeroes, and the decoder
    // deliberately does not strip a trailing tail before decompiling: the garbage
    // then either parsed as junk opcodes or made bitcoin.script.decompile return
    // null, in which case the transaction was never recorded at all.
    const padded = Buffer.concat([plainBuf, Buffer.alloc(MULTISIG_SLOT_BYTES - plainBuf.length, 0)])
    const encrypted = obfuscate(padded, funded.txid)

    // Split the 64-byte slot into two data pubkeys
    const pubkey1 = Buffer.concat([Buffer.from([0x02]), encrypted.subarray(0, 32)])
    const pubkey2 = Buffer.concat([Buffer.from([0x02]), encrypted.subarray(32, 64)])
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

    addPsbtInput(psbt, {
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

    addPsbtInput(psbt, {
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
 *
 * These three used to shell out to `bitcoin-cli -regtest`, which talks to
 * whatever node the HOST is running and reads ~/.bitcoin for its credentials.
 * The fixture's node is a container, so the reorg the test thought it was
 * causing either hit an unrelated chain or, on a machine with no host node,
 * threw. They go over the same RPC connection as everything else now.
 *
 * invalidateblock and reconsiderblock are absent from bitcoin-core v5's
 * generated method list, so they go through the generic `command` path rather
 * than a named client method that does not exist.
 */
async function invalidateBlock(blockHash) {
    return global.nodeClientTest.command('invalidateblock', blockHash)
}

/**
 * Reconsider a previously invalidated block.
 */
async function reconsiderBlock(blockHash) {
    return global.nodeClientTest.command('reconsiderblock', blockHash)
}

/**
 * Get the block hash at a given height.
 */
async function getBlockHash(height) {
    return global.nodeClientTest.getBlockHash(height)
}

/**
 * Wait for the decoder to process up to a given block index.
 */
async function waitForDecoder(targetBlockIndex, maxWaitMs) {
    await waitUntil(
        async () => (await global.db.getLastBlockIndex()) >= targetBlockIndex,
        {
            timeout: maxWaitMs || 30000,
            interval: 500,
            message: `Decoder did not reach block ${targetBlockIndex} within timeout`
        }
    )
    return true
}

/**
 * Wait for a specific transaction to appear in the decoder DB.
 */
async function waitForTransaction(txHash, maxWaitMs) {
    return waitUntil(
        () => global.db.getTransaction(txHash),
        {
            timeout: maxWaitMs || 30000,
            interval: 500,
            message: `Transaction ${txHash} not found in decoder DB within timeout`
        }
    )
}

/**
 * Wait for a specific transaction to appear in the mempool_transactions table.
 */
async function waitForMempoolTransaction(txHash, maxWaitMs) {
    return waitUntil(
        async () => {
            const connection = await global.db.pool.getConnection()
            try {
                const rows = await connection.query(
                    `SELECT * FROM mempool_transactions WHERE tx_hash = ?`,
                    [txHash]
                )
                return rows.length > 0 ? rows[0] : null
            } finally {
                await connection.release()
            }
        },
        {
            timeout: maxWaitMs || 90000, // mempool polls every 60s
            interval: 2000,
            message: `Mempool transaction ${txHash} not found within timeout`
        }
    )
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
