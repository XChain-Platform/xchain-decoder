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

const bitcoin = require('bitcoinjs-lib')
const { format: formatLogLine } = require('node:util')
const { logger, MAGIC_WORD, MAGIC_WORD_BUFFER, P2SH_BUFFER, P2WSH_BUFFER, FUNDING_VOUT_BASE } = require('./constants.js')
const { compiledPushSize } = require('./payload_helpers.js')

function captureOutputAddress(nextOutput, txOutputIndex, nextTxId, openDispenserAddresses, dispenseOutputs, paymentOutputs){
    let outputAddress = null
    try {
        if (!this.isFutureSegwitScript(nextOutput.script))
            outputAddress = bitcoin.address.fromOutputScript(nextOutput.script, this.network)
    } catch (err){
        //the output script has no matching address
    }

    if (outputAddress){
        let outputIsDispense = openDispenserAddresses.has(outputAddress)

        if (outputIsDispense){
            let dispenseOutput = {
                txIndex:nextTxId,
                vout:txOutputIndex,
                destinationAddress:outputAddress,
                amount:nextOutput.value
            }

            dispenseOutputs.push(dispenseOutput)
            return true
        } else {
            // Capture every non-OP_RETURN, non-dispense output. The indexer
            // fans out per-output processing for payment actions (e.g. COINPAY)
            // by LEFT JOIN-ing transaction_outputs and parsing once per row.
            paymentOutputs.push({
                vout:txOutputIndex,
                destinationAddress:outputAddress,
                amount:nextOutput.value
            })
        }
    }
    return false
}

function readP2shChunks(transaction, nextTxId, nextDataBuffer){
    for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
        let nextInput = transaction.ins[txInputIndex]
        try {
            let decodedScriptSig = bitcoin.script.decompile(nextInput["script"])
            if (!decodedScriptSig || decodedScriptSig.length < 3 || !Buffer.isBuffer(decodedScriptSig[2])) continue
            let decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
            if (!decodedRedeemScript || decodedRedeemScript.length < 1 || !Buffer.isBuffer(decodedRedeemScript[0])) continue
            let decodedData = decodedRedeemScript[0]
            nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
        } catch (e) {
            this.parseErrors++
            logger.error(formatLogLine(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e))
            // Do NOT drop this input's chunk and keep concatenating: a missing
            // interior chunk leaves nextDataBuffer holding a silently truncated
            // ACTION payload that can still decompile to a corrupted push, with no
            // quarantine event. Fail the whole tx instead so the block loop routes
            // it through the TX_PARSE_MAX_RETRIES retry-then-PARSE_ERROR quarantine
            // path (this file's fail-loud-or-quarantine contract).
            throw new Error(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}: ${e && e.message ? e.message : e}`)
        }
    }
    return nextDataBuffer
}

function readP2wshChunks(transaction, nextTxId, nextDataBuffer){
    for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
        let nextInput = transaction.ins[txInputIndex]
        try {
            // Per-chain capability gate (see above). `continue`, not
            // `break`: this branch sits inside the enclosing OUTPUT loop,
            // so breaking here would stop scanning the transaction's
            // remaining outputs. Same idiom and same meaning as the
            // witness-shape check on the next line: this input carries no
            // payload for us.
            if (this.network.supportsSegwit === false) continue
            if (!nextInput["witness"] || nextInput["witness"].length < 3 || !Buffer.isBuffer(nextInput["witness"][2])) continue
            let decodedRedeemScript = bitcoin.script.decompile(nextInput["witness"][2])
            if (!decodedRedeemScript || decodedRedeemScript.length < 1 || !Buffer.isBuffer(decodedRedeemScript[0])) continue
            let decodedData = decodedRedeemScript[0]
            nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
        } catch (e) {
            this.parseErrors++
            logger.error(formatLogLine(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e))
            // Do NOT drop this input's chunk and keep concatenating: a missing
            // interior chunk leaves nextDataBuffer holding a silently truncated
            // ACTION payload that can still decompile to a corrupted push, with no
            // quarantine event. Fail the whole tx instead so the block loop routes
            // it through the TX_PARSE_MAX_RETRIES retry-then-PARSE_ERROR quarantine
            // path (this file's fail-loud-or-quarantine contract).
            throw new Error(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}: ${e && e.message ? e.message : e}`)
        }
    }
    return nextDataBuffer
}

function* readOpReturnCarrier(transaction, decompiledScript, nextTxId, firstInputTxId, carrier){
    let { nextDataBuffer, otherCarrierRecognized, p2shFundingTxId } = carrier
    let dataWithoutObfuscation = yield this.removeObfuscation(decompiledScript[1], firstInputTxId)

    if (dataWithoutObfuscation != null){
        if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
            // An XCHN OP_RETURN is a carrier the moment the magic matches,
            // whatever it goes on to contribute. Marked here so §3.8 below
            // sees the marker-only shape (magic and nothing after it), which
            // adds zero bytes to dataBuffer.
            otherCarrierRecognized = true
            // P2SH chunk carrier: the OP_RETURN only flags the encoding,
            // the payload chunks live in the inputs' redeem scripts.
            if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2SH_BUFFER)){
                p2shFundingTxId = firstInputTxId // commit tx carrying any native-coin fee output
                nextDataBuffer = readP2shChunks.call(this, transaction, nextTxId, nextDataBuffer)

            // P2WSH chunk carrier: same shape as P2SH, chunks in the witness.
            } else if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2WSH_BUFFER)){
                p2shFundingTxId = firstInputTxId // commit tx carrying any native-coin fee output
                // A chain that declares no segwit has no witness carrier, so refuse
                // to read payload out of a witness stack there instead of trusting
                // upstream node validation to keep one from ever arriving. Same
                // per-chain capability gate the taproot envelope lane already carries
                // (envelopeRecognitionHeight), which this older lane never got.
                //
                // `=== false`, never a falsy test: supportsSegwit is declared only on
                // the non-segwit coin (src/coins/DOGE.js), so it is undefined on
                // BTC/LTC and `!this.network.supportsSegwit` would disable the whole
                // P2WSH lane on the chains that DO use it and change how already
                // indexed history decodes.
                //
                // Placed inside the branch body rather than in the `else if`
                // condition, and after p2shFundingTxId is set, on purpose. Folding it
                // into the condition would fall through to the trailing `else`, which
                // appends the marker remainder as raw payload; clearing the funding
                // txid would drop the commit's native-fee attribution. Both are
                // behaviour changes on a live chain, and this is a capability gate.
                // Against chain-realistic input it is a strict no-op: a non-segwit
                // transaction carries no witness stack, so every input already failed
                // the shape check below and nextDataBuffer already stayed empty.
                nextDataBuffer = readP2wshChunks.call(this, transaction, nextTxId, nextDataBuffer)
            } else {
                nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
            }
        }
    }
    return { nextDataBuffer, otherCarrierRecognized, p2shFundingTxId }
}

function* readMultisignCarrier(decompiledScript, firstInputTxId, carrier){
    let { nextDataBuffer, otherCarrierRecognized } = carrier
    let pubkey1 = decompiledScript[1].subarray(1) //removing the 02 at the beginning
    let pubkey2 = decompiledScript[2].subarray(1) //removing the 02 at the beginning

    let data = Buffer.concat([pubkey1, pubkey2])

    // We intentionally do NOT strip trailing zero bytes here.
    // The encoder's prepareData() zero-pads the plaintext chunk to fill
    // the 64-byte MULTISIGN slot BEFORE obfuscation, so after decryption
    // the trailing bytes are literal 0x00 (not keystream). The final
    // partial chunk always carries this pad; a full 64-byte chunk also
    // has a ~1/256 chance of a genuine 0x00 last ciphertext byte. Stripping
    // either dropped a real byte, decrypted one byte short, and silently
    // corrupted the payload (bitcoin.script.decompile returned null on the
    // truncated buffer). Instead we decrypt the full chunk. The trailing
    // 0x00 bytes fall outside the payload's own self-describing
    // compiled-script length and are discarded when the reassembled buffer
    // is run through bitcoin.script.decompile() below.
    let dataWithoutObfuscation = yield this.removeObfuscation(data, firstInputTxId)

    if (dataWithoutObfuscation != null){
        if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
            // Same rule as the OP_RETURN branch: the magic match IS the
            // carrier. A MULTISIGN slot always yields ~60 bytes, so this one
            // is already covered by byte count; marked anyway so the two
            // branches cannot drift apart.
            otherCarrierRecognized = true
            nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
        }
    }
    return { nextDataBuffer, otherCarrierRecognized }
}

function* scanOutputs(transaction, openDispenserAddresses, nextTxId, firstInputTxId, dispenseOutputs, paymentOutputs, scan){
    let { dataBuffer, getSource, p2shFundingTxId, otherCarrierRecognized } = scan
    for (let txOutputIndex=0;txOutputIndex < transaction.outs.length;txOutputIndex++){
        // Invariant guard: a real on-chain output index must stay below FUNDING_VOUT_BASE
        // so it can never collide with an attributed funding fee output stored at
        // vout + FUNDING_VOUT_BASE. This is structurally impossible for a Bitcoin-family
        // tx (output counts are bounded far below the base), so if it ever fires the base
        // has been mis-sized and the funding/real vout domains are no longer disjoint.
        if (txOutputIndex >= FUNDING_VOUT_BASE){
            logger.error(`FATAL invariant violation: real output index ${txOutputIndex} in tx ${nextTxId} reaches FUNDING_VOUT_BASE (${FUNDING_VOUT_BASE}); funding fee outputs can no longer be stored collision-free`)
        }
        let nextOutput = transaction.outs[txOutputIndex]
        let decompiledScript = bitcoin.script.decompile(nextOutput.script)
        let nextDataBuffer = new Buffer.allocUnsafe(0)

        if (captureOutputAddress.call(this, nextOutput, txOutputIndex, nextTxId, openDispenserAddresses, dispenseOutputs, paymentOutputs)) getSource = true

        if ((decompiledScript != null) && (decompiledScript.length > 0)){
            // OP_RETURN carrier
            if (
                (decompiledScript.length == 2)
                && (decompiledScript[0] == bitcoin.opcodes.OP_RETURN)
            ){
                ;({ nextDataBuffer, otherCarrierRecognized, p2shFundingTxId } = yield* readOpReturnCarrier.call(this, transaction, decompiledScript, nextTxId, firstInputTxId, { nextDataBuffer, otherCarrierRecognized, p2shFundingTxId }))
            } else
            // MULTISIGN carrier
            if (
                (decompiledScript.length == 6)
                && (decompiledScript[5] == bitcoin.opcodes.OP_CHECKMULTISIG)
            ){
                if (!Buffer.isBuffer(decompiledScript[1]) || !Buffer.isBuffer(decompiledScript[2])) {
                    continue
                }

                ;({ nextDataBuffer, otherCarrierRecognized } = yield* readMultisignCarrier.call(this, decompiledScript, firstInputTxId, { nextDataBuffer, otherCarrierRecognized }))
            }
        }

        if (nextDataBuffer.length > 0){
            dataBuffer = Buffer.concat([dataBuffer,nextDataBuffer])
        }
    }
    return { dataBuffer, getSource, p2shFundingTxId, otherCarrierRecognized }
}

function reportEmptyLeadingPush(decompiledData, dataBuffer, nextTxId){
    // Visibility only. One shape inside this branch is not the inert
    // zero-length case the blanking was written for: an EMPTY LEADING
    // PUSH (OP_0, which decompiles to the integer 0) followed by more
    // payload. The action push is empty but a second push, the rawData
    // the sender paid to carry, is still sitting in the stream, and the
    // blanking below discards it without a trace, so an operator seeing
    // no action for the tx has nothing to correlate. Report it
    // distinctly and count it toward parse_errors (a monitoring counter
    // only). ACCEPTANCE IS DELIBERATELY UNCHANGED: the payload is still
    // blanked and rawData/getSource are still left untouched. Whether
    // this wire shape should be accepted end-to-end is a cross-service
    // flag-day decision that also governs
    // xchain-encoder/src/common/validator.js, and must not change here alone.
    if (decompiledData[0] === 0 && (decompiledData.length > 1 || dataBuffer.length > 1)){
        this.parseErrors++
        const droppedPushBytes = decompiledData
            .slice(1)
            .reduce((total, push) => total + (Buffer.isBuffer(push) ? push.length : 0), 0)
        logger.error(`Tx ${nextTxId}: empty leading push (OP_0) in a ${dataBuffer.length}-byte ` +
            `payload carrying ${decompiledData.length - 1} further element(s) totalling ` +
            `${droppedPushBytes} data byte(s); payload blanked and the trailing push(es), ` +
            `including any rawData, are NOT read (acceptance unchanged)`)
    }
}

function decompilePayload(nextTxId, envelopeCarrier, payload){
    let { dataBuffer, rawData, getSource, compiledDataLength } = payload
    if (dataBuffer.length > 0){
        let decompiledData = bitcoin.script.decompile(dataBuffer)
        if (decompiledData != null && decompiledData.length > 0) {
            // A single-byte OP_0 segment ([0x00]) decompiles to the integer 0,
            // not a Buffer, and a non-standard script can decompile to a leading
            // opcode integer. On any non-Buffer result, reject the degenerate decode:
            // clear dataBuffer and leave rawData/getSource untouched so a stray opcode
            // integer can never reach the raw_data column or trigger a spurious source
            // lookup. Every downstream consumer can then rely on dataBuffer being a
            // Buffer (otherwise the integer silently fails .length guards and throws in
            // hex-encoding paths). No valid payload is zero-length, so this is inert
            // for real data.
            if (!Buffer.isBuffer(decompiledData[0])){
                reportEmptyLeadingPush.call(this, decompiledData, dataBuffer, nextTxId)
                dataBuffer = Buffer.allocUnsafe(0)
            } else {
                dataBuffer = decompiledData[0]
                // Re-measure compiledDataLength from the decompiled buffer so MULTISIGN
                // zero-pad inflation does not cause valid payloads in [8161, 8192] bytes
                // to trip the MAX_ACTION_DATA_LENGTH guard. For P2SH/P2WSH/OP_RETURN the
                // result is identical to the pre-decompile measurement: the push overhead
                // (1 byte direct, 2 bytes OP_PUSHDATA1, 3 bytes OP_PUSHDATA2) is added
                // back, matching exactly what the encoder's compiled script measured.
                // Never for the envelope: its §4 measurand is the initial pre-decompile
                // value (see the comment above compiledDataLength's binding).
                if (!envelopeCarrier){
                    compiledDataLength = compiledPushSize(dataBuffer.length)
                }
                if (decompiledData.length > 1){
                    // Mirror the Buffer gate on decompiledData[0] above: decompile
                    // returns opcodes as integers, so a payload whose second element
                    // is an opcode (a trailing OP_1..OP_16/OP_1NEGATE, or the
                    // MULTISIGN zero-pad's OP_0) would otherwise flow a bare integer
                    // into rawData and the raw_data column, a shape no consumer
                    // expects (the encoder's push[1] is always a Buffer).
                    rawData = Buffer.isBuffer(decompiledData[1]) ? decompiledData[1] : null
                    // Count the second push too. The encoder bounds the WHOLE compiled
                    // script (both pushes) against MAX_COMPILED_ACTION_DATA_LENGTH, so
                    // measuring only push[0] here let a small action push + a large
                    // rawData push (e.g. a FILE) decode past the guard that the encoder
                    // and validator would have rejected. Add push[1]'s compiled size
                    // (data length + the same OP_PUSH overhead) so the decoder's ceiling
                    // matches the encoder's.
                    if (Buffer.isBuffer(rawData) && !envelopeCarrier){
                        compiledDataLength += compiledPushSize(rawData.length)
                    }
                }
                getSource = true
            }
        } else {
            dataBuffer = Buffer.allocUnsafe(0)
        }
    }
    return { dataBuffer, rawData, getSource, compiledDataLength }
}

module.exports = { scanOutputs, decompilePayload }
