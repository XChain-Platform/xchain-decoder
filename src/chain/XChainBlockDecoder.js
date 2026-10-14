// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto = require('crypto');
const bitcoinjs = require('bitcoinjs-lib');
// BigInt-safe 64-bit reader/writer, applied in-process so a >2^53-1 sat DOGE
// output cannot wedge block decode even when the Dockerfile COPY patch is absent.
const bufferutils_js_1 = require('./apply_bufferutils_patch');
const transaction_js_1 = require('bitcoinjs-lib/src/transaction');
const coins = require('../coins');

const LITECOIN_HOGEX_FLAG = 0x08
const LITECOIN_MWEB_SEGWIT_FLAG = 0x09

// Block/tx wire-serialization families this decoder actually implements. The
// per-coin branches below (Litecoin 'mweb' marker/flag stripping, Dogecoin
// 'auxpow' handled upstream in BlockchainConnector.getBlockWithoutAuxPow,
// 'default' plain bitcoinjs) are keyed on the coin's declared wireFormat from
// the canonical coin registry (src/coins) rather than a hardcoded coin-name
// list. A newly-registered merge-mined or MWEB-style coin must declare a
// wireFormat this decoder handles; a coin absent from the registry or carrying
// an unimplemented family fails loudly at construction instead of silently
// falling through to the strict default parser and misparsing at its first
// special block.
const { KaspaBlockDecoder } = require('./kaspa/kaspa_block_decoder.js')
const HANDLED_WIRE_FORMATS = new Set(['default', 'mweb', 'auxpow', 'kaspa'])   // 'kaspa' = the new family: blake3 txids, borsh framing, carrier in the transaction payload. See chain/kaspa/.

function readMwebTransactions(bufferReader, block) {
    const readTransaction = () => {
      const tx = transaction_js_1.Transaction.fromBuffer(
        bufferReader.buffer.slice(bufferReader.offset),
        true,
      );
      bufferReader.offset += tx.byteLength();
      return tx;
    };
    const nTransactions = bufferReader.readVarInt();
    // Sanity-bound the claimed tx count against the bytes actually
    // present: the smallest possible serialized transaction is well
    // over 10 bytes, so a varint claiming more than remaining/10
    // transactions is structurally impossible. Without this, a forged
    // count only failed later via a buffer over-read inside
    // Transaction.fromBuffer, which has an unguarded loop with an incidental
    // unnamed exit. (Block bytes come from the trusted node, so this
    // is defense-in-depth, not a reachable DoS.)
    const remainingBytes = bufferReader.buffer.length - bufferReader.offset;
    if (nTransactions > remainingBytes / 10) {
        throw new Error('Block declares ' + nTransactions + ' transactions but only ' +
            remainingBytes + ' bytes remain (invalid transaction count)');
    }
    block.transactions = [];
    for (let i = 0; i < nTransactions; ++i) {
      try {
        if (i == nTransactions - 1){//If it's the last transaction, then check if it's the HogEx
            let nextTxBuffer = bufferReader.buffer.slice(bufferReader.offset)
            let txVersion = nextTxBuffer.readUInt32LE();
            let marker = nextTxBuffer.readUInt8(4);
            let flag = nextTxBuffer.readUInt8(5);

            if ((txVersion == 0x01 || txVersion == 0x02) && (marker == 0x00) && (flag == LITECOIN_HOGEX_FLAG || flag == LITECOIN_MWEB_SEGWIT_FLAG)){
                let removeOffsetStart = bufferReader.offset + 4 //4 bytes for txVersion
                let removeOffsetEnd = removeOffsetStart + 2 //2 bytes for marker + flag

                //Remove the marker+flag (0x08 pure-MWEB, or 0x09 segwit+MWEB), so bitcoinjs-lib parses this tx as a normal transaction
                let bufferReaderBeforeFlag = bufferReader.buffer.slice(0, removeOffsetStart)
                let bufferReaderAfterFlag = bufferReader.buffer.slice(removeOffsetEnd)
                bufferReader.buffer = Buffer.concat([bufferReaderBeforeFlag, bufferReaderAfterFlag])

            }
        }

        let tx = readTransaction();
        block.transactions.push(tx);
      } catch (err){
        throw err
      }
    }
}

class XChainBlockDecoder {

    constructor(networkName) {
        let networkNameSplit = networkName.split("-")
        this.coin = networkNameSplit[0]
        const tick = coins.FULL_NAME_TO_TICK[this.coin]
        this.wireFormat = tick ? coins.WIRE_FORMAT[tick] : undefined
        if (!this.wireFormat || !HANDLED_WIRE_FORMATS.has(this.wireFormat)) {
            throw new Error(
                'XChainBlockDecoder: no block/tx wire-format contract declared for coin "' + this.coin +
                '" (network "' + networkName + '"). Declare a handled wireFormat (default/mweb/auxpow) ' +
                'on the coin in src/coins before onboarding the chain.')
        }
        // Kaspa family: kaspad answers with structured wRPC blocks, not raw hex, so this
        // decoder keeps a family adapter that presents the same surface to the ingest path
        // (see chain/kaspa/kaspa_block_decoder.js, and the delegate tests).
        this.kaspa = (this.wireFormat === 'kaspa') ? new KaspaBlockDecoder(networkName) : null
    }

    // Structured entry points for the Kaspa family. Callers that hold an
    // XChainBlockDecoder use these instead of the buffer-based ones, so the family
    // switch lives here rather than in every caller.
    blockFromObject(rawBlock) {
        if (!this.kaspa) throw new Error('XChainBlockDecoder.blockFromObject: only the kaspa wire-format takes structured blocks')
        return this.kaspa.blockFromObject(rawBlock)
    }

    transactionFromObject(rawTransaction) {
        if (!this.kaspa) throw new Error('XChainBlockDecoder.transactionFromObject: only the kaspa wire-format takes structured transactions')
        return this.kaspa.transactionFromObject(rawTransaction)
    }
    
    blockFromHex(blockHex){
        return this.blockFromBuffer(Buffer.from(blockHex,"hex"))
    }

    transactionFromHex(txHex){
        if (this.wireFormat === "mweb") {
            const marker = txHex.substr(8, 2)
            const flag   = txHex.substr(10, 2)
            if (
                (txHex.substr(0, 8) === "01000000" || txHex.substr(0, 8) === "02000000") &&
                marker === "00" &&
                (flag === "08" || flag === "09")
            ) {
                // Strip the 2-byte marker+flag (MWEB flag 0x08, or segwit+MWEB 0x09).
                // bitcoinjs-lib misreads these flags causing UInt64 range errors.
                txHex = txHex.substr(0, 8) + txHex.substr(12)
            }
        }
        // Non-strict mode ignores trailing MWEB extension data after the tx.
        return transaction_js_1.Transaction.fromBuffer(Buffer.from(txHex, "hex"), true)
    }
    
    doubleSha256AndReverse(data){
        const firstHash = crypto.createHash('sha256').update(data).digest();
        const secondHash = crypto.createHash('sha256').update(firstHash).digest();
        const reversedHash = Buffer.from(secondHash).reverse();
        return reversedHash;
    }
    
    blockFromBuffer(buffer){
        switch(this.wireFormat){
            case "mweb":

                /**
                *   This piece of code is the same as bitcoinjs-lib Block.fromBuffer with some changes for litecoin (MWEB)
                */
                if (buffer.length < 80) throw new Error('Buffer too small (< 80 bytes)');
                const bufferReader = new bufferutils_js_1.BufferReader(buffer);
                const block = new bitcoinjs.Block();
                block.version = bufferReader.readInt32();
                block.prevHash = bufferReader.readSlice(32);
                block.merkleRoot = bufferReader.readSlice(32);
                block.timestamp = bufferReader.readUInt32();
                block.bits = bufferReader.readUInt32();
                block.nonce = bufferReader.readUInt32();
                if (buffer.length === 80) return block;
                readMwebTransactions(bufferReader, block)
                const witnessCommit = block.getWitnessCommit();
                // This Block contains a witness commit
                if (witnessCommit) block.witnessCommit = witnessCommit;
                return block; 
            case "kaspa":
                // Kaspa is not a bitcoinjs family (blake3 txids, borsh framing, carrier in the
                // transaction payload). Parsing these bytes with bitcoinjs produces rows that
                // look valid — the failure mode this file header warns about — so the byte-level
                // entry points stay loud. The structured entry points live on this class
                // (blockFromObject / transactionFromObject) and delegate to chain/kaspa/, which
                // presents the same surface the ingest path already consumes.
                throw new KaspaBlockDecoder('kaspa').blockFromBuffer(buffer)
            default:
                // The bitcoinjs families (bitcoin, dogecoin): unchanged, and it must stay the
                // default arm — putting the kaspa case above it once made every bitcoin and
                // dogecoin block take the Kaspa path (caught by test/smoke/block_decoder.test.js).
                return bitcoinjs.Block.fromBuffer(buffer)
        }
    }
}

module.exports = XChainBlockDecoder
