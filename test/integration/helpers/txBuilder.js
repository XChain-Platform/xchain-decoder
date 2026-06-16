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
 * Transaction builder helper for integration tests.
 *
 * Provides functions to:
 *  - Generate funded regtest addresses (Legacy, SegWit, Taproot)
 *  - Encrypt ACTION payloads with AES-128-CTR (matching decoder protocol)
 *  - Build and broadcast OP_RETURN / multisig transactions with XCHN data
 *  - Mine blocks and wait for the decoder to process them
 */

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip39 = require('bip39')
const { ECPairFactory } = require('ecpair')
const nodeHelper = require('../../nodeHelper')

bitcoin.initEccLib(ecc)
const bip32 = BIP32Factory(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.regtest

const MNEMONIC = 'erase average powder march guess lemon basic eight arena world once puzzle'

// Derivation counter — incremented to get fresh addresses per test
let derivationIndex = 100

function getNextDerivation() {
    derivationIndex++
    const seed = bip39.mnemonicToSeedSync(MNEMONIC)
    const root = bip32.fromSeed(seed, network)
    const account = root.derivePath("m/44'/0'/0'/0")
    return account.derive(0).derive(derivationIndex)
}

/**
 * Encrypt data with AES-128-CTR using the first 32 hex chars of a txid as key+iv.
 * This matches the decoder's removeObfuscation() method.
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
 * After deobfuscation, the decoder does bitcoin.script.decompile() on the
 * payload after the XCHN prefix, so data must be script-compiled.
 */
function buildXchnPayload(actionString, txid, rawData) {
    const parts = [Buffer.from(actionString)]
    if (rawData) parts.push(Buffer.from(rawData))
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return obfuscate(plainBuf, txid)
}

/**
 * Fund an address by sending BTC from the test wallet, then mine a block.
 * Returns { txid, rawTx, rawTxHex, address, satoshis }
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
 *
 * @param {object} funded - Result from createFunded*Address()
 * @param {string} actionString - Pipe-delimited ACTION string (e.g. "SEND|0|TOKEN|100|dest|memo")
 * @param {string} [rawData] - Optional raw data (second script push)
 * @returns {{ txHash, blockIndex }} - The broadcast tx hash and the block it was mined in
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

    // Encrypt the ACTION data
    const encryptedPayload = buildXchnPayload(actionString, funded.txid, rawData)
    const opReturnScript = bitcoin.payments.embed({ data: [encryptedPayload] })

    psbt.addOutput({ script: opReturnScript.output, value: 0 })
    psbt.addOutput({ address: funded.address, value: funded.satoshis - fee })

    // Sign
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

    // Mine a block
    await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)

    // Get the block index
    const info = await global.nodeClientTest.getBlockchainInfo()
    const blockIndex = info.blocks

    return { txHash, blockIndex }
}

/**
 * Build, sign, and broadcast a 1-of-3 multisig transaction with XCHN payload.
 */
async function broadcastMultisig(funded, actionString) {
    const fee = 10000
    const psbt = new bitcoin.Psbt({ network })

    // Only legacy inputs for multisig outputs
    psbt.addInput({
        hash: funded.txid,
        index: funded.voutIndex,
        sequence: 0x00000001,
        nonWitnessUtxo: Buffer.from(funded.rawTxHex, 'hex')
    })

    // Build XCHN multisig payload
    const parts = [Buffer.from(actionString)]
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    const encrypted = obfuscate(plainBuf, funded.txid)

    // Pad to 64 bytes, split into two 32-byte pubkeys
    const padded = Buffer.concat([encrypted, Buffer.alloc(64 - encrypted.length, 0)])
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
 * Wait for the decoder to process up to a given block index.
 * Polls db.getLastBlockIndex() with retries.
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

module.exports = {
    obfuscate,
    buildXchnPayload,
    fundAddress,
    createFundedLegacyAddress,
    createFundedSegwitAddress,
    createFundedTaprootAddress,
    broadcastOpReturn,
    broadcastMultisig,
    broadcastPlainTransaction,
    broadcastNonXchnOpReturn,
    waitForDecoder,
    waitForTransaction
}
