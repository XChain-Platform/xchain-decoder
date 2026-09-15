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
 *
 * XChain Decoder - Decoder Class
 *
 * This file handles starting the decoder and parsing blocks and transactions
 *
 ********************************************************************/

const util = require('../util')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const { format: formatLogLine } = require('node:util')
const { logger } = require('./constants.js')

function* fetchPrevoutTransaction(txId, outputIndex){
    // A prevout lookup that FAILS is not a prevout that does not exist. Swallowing
    // the failure into source=null made this instance skip (or mis-source) a tx that
    // every healthy instance accepts, committing instance-dependent block contents.
    // Tag and rethrow instead: the block loop rolls the whole block back and retries,
    // so a block is only ever committed from fully-resolved lookups. The prevout of a
    // confirmed tx always exists on a txindex node, so an empty RPC result is a
    // lookup failure too, never "absent".
    let outputRawTransaction
    try {
        outputRawTransaction = yield this.connector.getRawTransaction(txId)
        if (!outputRawTransaction){
            throw new Error(`empty getrawtransaction result for confirmed prevout tx ${txId}`)
        }
    } catch (err){
        this.rpcErrors++
        logger.error(formatLogLine(`getSourceFromOutput: failed to fetch tx ${txId} (output ${outputIndex}): `, err))
        err.rpcLookupFailure = true
        throw err
    }
    // Decode OUTSIDE the tagged try. getRawTransaction either yields a whole
    // JSON-decoded hex string or fails, so a wire-decode throw here is deterministic
    // CONTENT, identical on every instance, not a transport fault. Tagging it
    // rpcLookupFailure routed it to the block loop's UNBOUNDED height retry and wedged
    // the decoder at that height forever; untagged it reaches the retry-then-quarantine
    // ladder (TX_PARSE_MAX_RETRIES), which is parity-safe exactly because the fault is
    // deterministic. start() refuses to run a Dogecoin decoder whose BigInt-safe
    // bufferutils reader is inactive for the same reason: that is the one decode fault
    // that would differ between instances.
    // MUST parse through transactionFromHex (strips the LTC MWEB marker+flag), not
    // bitcoin.Transaction.fromHex: a Litecoin funding/prevout tx can carry the MWEB
    // flag (0x08/0x09) and vanilla strict parsing throws a UInt64 range error on it.
    // transactionFromHex is the same parser the block path uses; for BTC/DOGE and
    // non-flagged txs it is a plain parse.
    return this.xchainBlockDecoder.transactionFromHex(outputRawTransaction)
}

function isRevealCarrierScript(script){
    let isP2sh = (
        (script.length == 23) //23 bytes for a standard p2sh
        && (script[0] == 0xa9) //OP_HASH160
        && (script[1] == 0x14) //PUSH 20 bytes
        && (script[23 - 1] == 0x87) //OP_EQUAL
    )
    let isP2wsh = (
        (script.length == 34) //34 bytes for a standard p2wsh
        && (script[0] == 0x00) //OP_0 (witness v0)
        && (script[1] == 0x20) //PUSH 32 bytes
    )
    return isP2sh || isP2wsh
}

function* fetchCommitFundingOutput(outputTransaction){
    let prevOutputIndex = outputTransaction.ins[0].index
    let prevTxHash = util.uint8ArrayToHex(Buffer.from(outputTransaction.ins[0].hash).reverse())
    // Same fail-loud contract as the first fetch: tag the FETCH failure so the
    // block loop retries the block instead of quarantining the tx.
    let prevRawTransaction
    try {
        prevRawTransaction = yield this.connector.getRawTransaction(prevTxHash)
        if (!prevRawTransaction){
            throw new Error(`empty getrawtransaction result for confirmed commit-funding tx ${prevTxHash}`)
        }
    } catch (err){
        this.rpcErrors++
        logger.error(formatLogLine(`getSourceFromOutput: failed to fetch commit-funding tx ${prevTxHash}: `, err))
        err.rpcLookupFailure = true
        throw err
    }
    // Decode outside the tagged try; see the first fetch above.
    // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex.
    let prevTransaction = this.xchainBlockDecoder.transactionFromHex(prevRawTransaction)
    return prevTransaction.outs[prevOutputIndex]
}

function* resolveSourceFromOutput(txId, outputIndex, capture){
    let source = null
    let output = null
    let outputTransaction = null

    outputTransaction = yield* fetchPrevoutTransaction.call(this, txId, outputIndex)
    // Publish the FIRST-HOP tx here, before the P2SH/P2WSH walk-back below can
    // reassign `output`. The walk-back fetches the commit's own funder, a
    // different transaction; handing that to the fee resolver would attribute
    // another tx's outputs into this action's reserved FUNDING_VOUT_BASE domain.
    if (capture) capture.sourceTransaction = outputTransaction
    // An out-of-range output index is deterministic content (the same on every
    // instance), so it may still resolve to a null source below.
    output = outputTransaction.outs[outputIndex]

    if (output != null){
        let script = output.script
        //Check if output is a P2SH or P2WSH data-carrying reveal output. If so,
        //the spent output's own address is the script (commit) address, not the
        //signer; walk back one hop to the commit tx's first input and take
        //THAT prev output's address (the funder/issuer). Without the P2WSH branch
        //the source of every P2WSH-encoded action resolved to the bech32 script
        //address (bcrt1q...), which holds no gas → spurious "insufficient funds (FEE)".
        if (isRevealCarrierScript(script)){
            output = yield* fetchCommitFundingOutput.call(this, outputTransaction)
        }


        try {
            if (!this.isFutureSegwitScript(output.script))
                source = bitcoin.address.fromOutputScript(output.script, this.network)
        } catch(err){
            // No representable address for this output script (P2PK, bare
            // multisig, ...): leave source null rather than failing the parse.
        }
    }

    return source
}

module.exports = {
    // Deciphers the data inside an XChain transaction.
    async removeObfuscation(data, txid){
        var decryptedData = null

        // A txid too short to yield a 16-byte key AND a 16-byte IV is not a
        // decryptable input: without this guard a null/undefined txid throws
        // TypeError out of `.substr`, and anything under 32 characters reaches
        // crypto with a truncated IV, both of which the catch below rethrows
        // because it only swallows padding/decrypt errors.
        //
        // Returning null here cannot mask a misparse: both callers pass a
        // hex-encoded 32-byte hash (always exactly 64 characters), so no input
        // from a parsed transaction can take this branch. It only makes the
        // function total for the fuzz suite's out-of-band callers.
        if (typeof txid !== 'string' || txid.length < 32){
            return null
        }

        if (Buffer.isBuffer(data)){

            try {
                var cipherKey = txid.substr(0,16)
                var iv = txid.substr(16,16)

                var decipher = crypto.createDecipheriv('aes-128-ctr', cipherKey, iv);
                decryptedData = decipher.update(data) // + decipher.final()
                decryptedData = Buffer.concat([decryptedData, decipher.final()])
            } catch (err){
                if ((err.code != "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH") && (err.code != "ERR_OSSL_BAD_DECRYPT")){
                    throw err
                }
                decryptedData = null
            }
        }
        return decryptedData
    },

    async parseRawTransaction(rawTransaction){
        // Parse via xchainBlockDecoder.transactionFromHex, not bitcoin.Transaction.fromHex:
        // the former strips the LTC MWEB marker+flag (0x08/0x09) that makes vanilla strict
        // parsing throw a deterministic UInt64 range error. See getSourceFromOutput.
        return await this.parseTransaction(this.xchainBlockDecoder.transactionFromHex(rawTransaction))
    },

    // `capture`, when given, receives the parsed FIRST-HOP transaction for `txId` as
    // `capture.sourceTransaction`. On the P2SH/P2WSH chunk flow that transaction is the
    // same commit findFundingFeeOutputs would otherwise fetch a second time, so the
    // caller can hand it over as prefetchedFundingTx. It is an out-parameter rather than
    // a widened return value on purpose: the return contract (a source address or null)
    // is stubbed and asserted across the suite, and a caller that ignores `capture`
    // behaves exactly as before.
    async getSourceFromOutput(txId, outputIndex, capture = null){
        // The lookup steps are generators that yield each node read to this
        // loop, so the method suspends only while a read is pending, once per
        // read, and the decode and walk-back after a read run in the same
        // stretch. An async helper awaited here would add a suspension after
        // each read settles.
        const steps = resolveSourceFromOutput.call(this, txId, outputIndex, capture)
        let next = steps.next()
        while (!next.done){
            let settled
            try {
                settled = await next.value
            } catch (err) {
                next = steps.throw(err)
                continue
            }
            next = steps.next(settled)
        }
        return next.value
    },

    extractPubkeyFromInput(input){
        // P2WPKH or P2SH-P2WPKH: pubkey is second witness element
        if (input.witness && input.witness.length >= 2){
            let pubkey = input.witness[1]
            if (pubkey && (pubkey.length === 33 || pubkey.length === 65)){
                return pubkey.toString('hex')
            }
        }
        // P2PKH: scriptSig is <sig> <pubkey>, decompile and take last element
        if (input.script && input.script.length > 0){
            let decompiledScript = bitcoin.script.decompile(input.script)
            if (decompiledScript && decompiledScript.length >= 2){
                let lastElement = decompiledScript[decompiledScript.length - 1]
                if (Buffer.isBuffer(lastElement) && (lastElement.length === 33 || lastElement.length === 65)){
                    return lastElement.toString('hex')
                }
            }
        }
        return null
    },

    isFutureSegwitScript(script) {
        // Native segwit scripts: version byte (OP_0..OP_16) + push length + witness program
        // Total length is 4-42 bytes.  OP_0 (v0) and OP_1 (v1/taproot) are handled by
        // bitcoinjs-lib; OP_2-OP_16 (0x52-0x60) are "future" versions that trigger a
        // console warning.  Must also verify the push-length byte matches, otherwise
        // non-segwit scripts like P2PKH (starts with OP_DUP=0x76) would be misclassified.
        if (script.length < 4 || script.length > 42) return false
        let version = script[0]
        // Verify the witness version is in range: a segwit program's first byte is
        // OP_2 through OP_16, so anything outside that is a different script kind.
        if (version < 0x52 || version > 0x60) return false
        let pushLen = script[1]
        return pushLen >= 2 && pushLen <= 40 && script.length === pushLen + 2
    }
}
