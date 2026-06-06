/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Generates valid Bitcoin transactions and blocks with XChain ACTION payloads.
 *
 * Produces data that the decoder can parse end-to-end:
 *  - Funding transactions (P2PKH outputs for source address resolution)
 *  - XChain OP_RETURN transactions (encrypted XCHN payloads)
 *  - XChain 1-of-3 multisig transactions
 *  - Plain (non-XChain) transactions
 *  - Complete blocks containing any mix of the above
 */

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.regtest

const ACTION_TEMPLATES = [
    'SEND|0|XCHAIN|100|%ADDR%|memo',
    'ISSUE|0|TEST.TOKEN|1000000|true|description here',
    'BROADCAST|0|test broadcast message payload',
    'DESTROY|0|XCHAIN|50|tag|memo',
    'SWEEP|0|%ADDR%|ALL|XCHAIN|memo'
]

class DataGenerator {
    constructor() {
        this.prevBlockHash = '0000000000000000000000000000000000000000000000000000000000000000'
        this.blockHeight = 0
        this._keyPairs = Array.from({ length: 20 }, () => ECPair.makeRandom({ network }))
        this._addrIdx = 0
    }

    _nextKeyPair() {
        return this._keyPairs[this._addrIdx++ % this._keyPairs.length]
    }

    _getP2PKH(keyPair) {
        return bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network })
    }

    obfuscate(data, txid) {
        const key = txid.substr(0, 16)
        const iv = txid.substr(16, 16)
        const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
        return Buffer.concat([cipher.update(data), cipher.final()])
    }

    doubleSha256(data) {
        return crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(data).digest()
        ).digest()
    }

    _encodeVarInt(n) {
        if (n < 0xfd) return Buffer.from([n])
        if (n <= 0xffff) {
            const buf = Buffer.alloc(3)
            buf[0] = 0xfd
            buf.writeUInt16LE(n, 1)
            return buf
        }
        const buf = Buffer.alloc(5)
        buf[0] = 0xfe
        buf.writeUInt32LE(n, 1)
        return buf
    }

    /**
     * Create a funding transaction with a P2PKH output.
     * Used as the "previous transaction" that XChain txs reference.
     */
    generateFundingTx() {
        const kp = this._nextKeyPair()
        const { address, output } = this._getP2PKH(kp)

        const tx = new bitcoin.Transaction()
        tx.version = 2
        // Coinbase-like input with random script for unique txid
        tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff, crypto.randomBytes(32))
        tx.addOutput(output, 100000000) // 1 BTC

        return {
            txid: tx.getId(),
            txHex: tx.toHex(),
            address,
            output,
            kp
        }
    }

    /**
     * Generate a transaction with an encrypted XCHN OP_RETURN payload.
     */
    generateXChainOpReturnTx(options = {}) {
        const { action = null, payloadSize = null } = options

        const funding = this.generateFundingTx()

        let actionStr = action || ACTION_TEMPLATES[Math.floor(Math.random() * ACTION_TEMPLATES.length)]
        actionStr = actionStr.replace(/%ADDR%/g, funding.address)

        // Pad to desired payload size
        if (payloadSize && actionStr.length < payloadSize) {
            actionStr += '|' + 'X'.repeat(payloadSize - actionStr.length - 1)
        }

        const tx = new bitcoin.Transaction()
        tx.version = 2

        // Input referencing the funding tx (hash in internal byte order)
        const fundingHashInternal = Buffer.from(funding.txid, 'hex').reverse()
        tx.addInput(fundingHashInternal, 0, 0xfffffffe)

        // Build encrypted OP_RETURN payload
        const scriptPayload = bitcoin.script.compile([Buffer.from(actionStr)])
        const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
        const encrypted = this.obfuscate(plainBuf, funding.txid)

        const opReturnScript = bitcoin.script.compile([
            bitcoin.opcodes.OP_RETURN,
            encrypted
        ])
        tx.addOutput(opReturnScript, 0)
        tx.addOutput(funding.output, 99990000)

        return {
            tx,
            txHex: tx.toHex(),
            txId: tx.getId(),
            fundingTxId: funding.txid,
            fundingTxHex: funding.txHex,
            action: actionStr
        }
    }

    /**
     * Generate a transaction with an encrypted XCHN 1-of-3 multisig payload.
     */
    generateXChainMultisigTx(options = {}) {
        const { action = null } = options

        const funding = this.generateFundingTx()

        let actionStr = action || 'SEND|0|XCHAIN|100|' + funding.address + '|memo'

        const tx = new bitcoin.Transaction()
        tx.version = 2
        tx.addInput(Buffer.from(funding.txid, 'hex').reverse(), 0, 0xfffffffe)

        // Build encrypted multisig payload
        const scriptPayload = bitcoin.script.compile([Buffer.from(actionStr)])
        const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
        const encrypted = this.obfuscate(plainBuf, funding.txid)

        // Pad to 64 bytes, split into two 32-byte pubkeys
        const needed = Math.max(64, encrypted.length + (64 - encrypted.length % 64) % 64)
        const padded = Buffer.concat([encrypted, Buffer.alloc(needed - encrypted.length, 0)])

        const pubkey1 = Buffer.concat([Buffer.from([0x02]), padded.subarray(0, 32)])
        const pubkey2 = Buffer.concat([Buffer.from([0x02]), padded.subarray(32, 64)])
        const pubkey3 = Buffer.alloc(33, 0x03)

        const multisigScript = bitcoin.script.compile([
            bitcoin.opcodes.OP_1, pubkey1, pubkey2, pubkey3,
            bitcoin.opcodes.OP_3, bitcoin.opcodes.OP_CHECKMULTISIG
        ])

        tx.addOutput(multisigScript, 1000)
        tx.addOutput(funding.output, 99989000)

        return {
            tx,
            txHex: tx.toHex(),
            txId: tx.getId(),
            fundingTxId: funding.txid,
            fundingTxHex: funding.txHex,
            action: actionStr
        }
    }

    /**
     * Generate a plain (non-XChain) transaction.
     */
    generatePlainTx() {
        const funding = this.generateFundingTx()

        const tx = new bitcoin.Transaction()
        tx.version = 2
        tx.addInput(Buffer.from(funding.txid, 'hex').reverse(), 0, 0xfffffffe)
        tx.addOutput(funding.output, 99990000)

        return {
            tx,
            txHex: tx.toHex(),
            txId: tx.getId(),
            fundingTxId: funding.txid,
            fundingTxHex: funding.txHex
        }
    }

    /**
     * Generate a coinbase transaction for a block.
     */
    generateCoinbaseTx() {
        const tx = new bitcoin.Transaction()
        tx.version = 2

        const heightBuf = Buffer.alloc(4)
        heightBuf.writeUInt32LE(this.blockHeight)
        const script = Buffer.concat([Buffer.from([0x04]), heightBuf, crypto.randomBytes(4)])

        tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff, script)

        const kp = this._nextKeyPair()
        const { output } = this._getP2PKH(kp)
        tx.addOutput(output, 5000000000) // 50 BTC reward

        return tx
    }

    /**
     * Generate a complete block with a specified mix of transaction types.
     */
    generateBlock(options = {}) {
        const {
            xchnTxCount = 0,
            plainTxCount = 0,
            action = null,
            payloadSize = null,
            txType = 'opreturn'
        } = options

        this.blockHeight++
        const timestamp = 1700000000 + this.blockHeight

        const transactions = []
        const fundingTxStore = new Map()

        // Coinbase (always first)
        transactions.push(this.generateCoinbaseTx())

        // XChain transactions
        for (let i = 0; i < xchnTxCount; i++) {
            let entry
            if (txType === 'multisig') {
                entry = this.generateXChainMultisigTx({ action })
            } else {
                entry = this.generateXChainOpReturnTx({ action, payloadSize })
            }
            transactions.push(entry.tx)
            fundingTxStore.set(entry.fundingTxId, entry.fundingTxHex)
        }

        // Plain transactions
        for (let i = 0; i < plainTxCount; i++) {
            const entry = this.generatePlainTx()
            transactions.push(entry.tx)
            fundingTxStore.set(entry.fundingTxId, entry.fundingTxHex)
        }

        // Build 80-byte block header
        const header = Buffer.alloc(80)
        header.writeInt32LE(0x20000000, 0) // version

        // prevHash in internal byte order
        Buffer.from(this.prevBlockHash, 'hex').reverse().copy(header, 4)

        // Simplified merkle root (double-sha256 of first tx)
        this.doubleSha256(transactions[0].toBuffer()).copy(header, 36)

        header.writeUInt32LE(timestamp, 68)
        header.writeUInt32LE(0x207fffff, 72) // regtest difficulty bits
        header.writeUInt32LE(0, 76)          // nonce

        // Compute block hash (double-sha256, reversed for display)
        const blockHash = Buffer.from(this.doubleSha256(header)).reverse().toString('hex')

        const prevBlockHash = this.prevBlockHash
        this.prevBlockHash = blockHash

        // Serialize: header + varint(txCount) + serialized txs
        const varint = this._encodeVarInt(transactions.length)
        const txBuffers = transactions.map(tx => tx.toBuffer())
        const blockBuffer = Buffer.concat([header, varint, ...txBuffers])

        return {
            height: this.blockHeight,
            blockHash,
            blockHex: blockBuffer.toString('hex'),
            prevBlockHash,
            timestamp,
            txCount: transactions.length,
            xchnTxCount,
            plainTxCount,
            fundingTxStore
        }
    }

    /**
     * Generate a chain of blocks with consistent prevBlockHash linkage.
     *
     * xchnTxsPerBlock and plainTxsPerBlock can be numbers or functions (blockIndex) => count
     * for variable-density chains.
     */
    generateBlockChain(blockCount, options = {}) {
        const {
            xchnTxsPerBlock = 0,
            plainTxsPerBlock = 0,
            action = null,
            payloadSize = null,
            txType = 'opreturn'
        } = options

        const blocks = []
        const allFundingTxs = new Map()

        for (let i = 0; i < blockCount; i++) {
            const block = this.generateBlock({
                xchnTxCount: typeof xchnTxsPerBlock === 'function'
                    ? xchnTxsPerBlock(i)
                    : xchnTxsPerBlock,
                plainTxCount: typeof plainTxsPerBlock === 'function'
                    ? plainTxsPerBlock(i)
                    : plainTxsPerBlock,
                action,
                payloadSize,
                txType
            })
            blocks.push(block)
            for (const [txid, hex] of block.fundingTxStore) {
                allFundingTxs.set(txid, hex)
            }
        }

        return { blocks, fundingTxs: allFundingTxs }
    }

    /**
     * Generate standalone XChain transactions for mempool testing.
     * Returns entries suitable for MockBlockchainConnector.loadMempoolTxs().
     */
    generateMempoolEntries(count, options = {}) {
        const { xchnRatio = 0.1 } = options
        const entries = []

        for (let i = 0; i < count; i++) {
            let entry
            if (Math.random() < xchnRatio) {
                entry = this.generateXChainOpReturnTx(options)
            } else {
                entry = this.generatePlainTx()
            }
            entries.push({
                txId: entry.txId,
                txHex: entry.txHex,
                fundingTxId: entry.fundingTxId,
                fundingTxHex: entry.fundingTxHex
            })
        }

        return entries
    }

    reset() {
        this.prevBlockHash = '0000000000000000000000000000000000000000000000000000000000000000'
        this.blockHeight = 0
        this._addrIdx = 0
    }
}

module.exports = DataGenerator
