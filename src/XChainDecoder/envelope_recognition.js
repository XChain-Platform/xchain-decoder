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
const bitcoin = require('bitcoinjs-lib')
const { format: formatLogLine } = require('node:util')
const { MAGIC_WORD_BUFFER, TAPROOT_LEAF_VERSION, TAPROOT_ANNEX_MARKER, logger } = require('./constants.js')
const { ENVELOPE_RECOGNITION_ACTIVATION } = require('../protocol/constants.js')
// §3.8's second height: when a RECOGNIZED but payload-free carrier starts counting as a
// mixed carrier. Separate from the gate above, which is already armed on mainnet.
const { ENVELOPE_CARRIER_RECOGNITION_ACTIVATION } = require('../protocol/constants.js')

function envelopeScriptFromWitness(witness){
    // An envelope needs at least a script and a control block, so a stack
    // with fewer than two items cannot be one.
    if (!witness || witness.length < 2) return null
    let stackTop = witness.length - 1
    const lastItem = witness[stackTop]
    // The last item must be real bytes: an empty or non-buffer slot is a
    // malformed stack, not an envelope.
    if (!Buffer.isBuffer(lastItem) || lastItem.length === 0) return null
    // Annex present: at least (script, control, annex) would remain,
    // but the rule is unconditional: annex-bearing => not an envelope.
    if (lastItem[0] === TAPROOT_ANNEX_MARKER) return null
    const controlBlock = witness[stackTop]
    // The control block's first byte carries the leaf version (its lowest
    // bit is the parity flag and is ignored); a different version is a
    // different kind of spend.
    if ((controlBlock[0] & 0xfe) !== TAPROOT_LEAF_VERSION) return null
    // A control block is a 33-byte head plus a whole number of 32-byte
    // path hashes. Any other length is not a valid taproot control block.
    if (controlBlock.length < 33 || ((controlBlock.length - 33) % 32) !== 0) return null
    const script = witness[stackTop - 1]
    // The script sits directly under the control block, and the shortest
    // possible envelope script is 8 bytes, so anything smaller cannot be one.
    if (!Buffer.isBuffer(script) || script.length < 8) return null
    return script
}

function envelopeShapeFromScript(script){
    const decompiled = bitcoin.script.decompile(script)
    // Minimum shape: OP_0, OP_IF, magic, format, 1 push, OP_ENDIF, key, OP_CHECKSIG.
    if (!decompiled || decompiled.length < 8) return null
    let i = 0
    // The envelope opens with a push of nothing followed by OP_IF, which
    // is what makes the whole block unspendable data rather than logic.
    if (decompiled[i++] !== bitcoin.opcodes.OP_0) return null
    if (decompiled[i++] !== bitcoin.opcodes.OP_IF) return null
    // The magic word identifies the envelope as this platform's; a
    // different word means somebody else's data, which is not ours to read.
    if (!Buffer.isBuffer(decompiled[i]) || !decompiled[i].equals(MAGIC_WORD_BUFFER)) return null
    i++
    const formatByte = decompiled[i++]
    // The format marker is exactly one byte. A longer or absent push is a
    // malformed envelope rather than a future format.
    if (!Buffer.isBuffer(formatByte) || formatByte.length !== 1) return null
    // Unknown format bytes are not recognized: invisible by design,
    // future formats activate via their own flag heights (§3.2).
    if (formatByte[0] !== 0x00) return null
    // The 32-byte internal-key push sits AFTER OP_ENDIF, so this loop
    // stops exactly at OP_ENDIF for a well-formed envelope; a payload
    // element that decompiled to a bare opcode stops it early and the
    // OP_ENDIF check below fails the walk.
    const payloadPushes = []
    while (i < decompiled.length && Buffer.isBuffer(decompiled[i])){
        payloadPushes.push(decompiled[i])
        i++
    }
    // An envelope carrying no payload at all is not one.
    if (payloadPushes.length === 0) return null
    // The payload run has to end at OP_ENDIF. Stopping anywhere else means
    // the walk hit something that is not a data push, so the shape is wrong.
    if (decompiled[i++] !== bitcoin.opcodes.OP_ENDIF) return null
    // After the data block comes the 32-byte key the output is signed
    // against; any other length is not a key.
    if (!Buffer.isBuffer(decompiled[i]) || decompiled[i].length !== 32) return null
    i++
    // The key is checked by the final opcode, and that opcode must be the
    // last thing in the script.
    if (decompiled[i++] !== bitcoin.opcodes.OP_CHECKSIG) return null
    // Anything trailing the signature check means this is a script that
    // merely CONTAINS an envelope shape, which the grammar does not accept.
    if (i !== decompiled.length) return null
    return { script, payload: Buffer.concat(payloadPushes) }
}

module.exports = {
    // Local recognition height for the Taproot envelope on this decoder's
    // chain+network, or null when the envelope is never active here (DOGE, or
    // an unknown key). Null-safe by construction so a mis-set env can only
    // disable recognition, never enable it early.
    envelopeRecognitionHeight(){
        const coinMap = ENVELOPE_RECOGNITION_ACTIVATION[this.coinTick]
        const height = coinMap ? coinMap[this.consensusNetwork] : null
        return (typeof height === 'number') ? height : null
    },

    // Whether envelope recognition (and the §3.8 rejection rules, which
    // activate at the SAME height) applies at `blockHeight`. A missing height
    // (undefined caller, e.g. a bare parseRawTransaction) resolves to
    // INACTIVE: the pre-flag behavior is the shipped one, so defaulting closed
    // can never make replay diverge from history.
    envelopeActiveAt(blockHeight){
        const activationHeight = this.envelopeRecognitionHeight()
        return activationHeight !== null
            && typeof blockHeight === 'number'
            && blockHeight >= activationHeight
    },

    // Local height at which a recognized-but-payload-free carrier starts counting as a
    // mixed carrier under §3.8, or null when that rule is never active here (DOGE, an
    // unpinned mainnet, or an unknown key). Same null-safe shape as the sibling above,
    // so a mis-set env can only leave the shipped behavior in place, never arm early.
    envelopeCarrierRecognitionHeight(){
        const coinMap = ENVELOPE_CARRIER_RECOGNITION_ACTIVATION[this.coinTick]
        const height = coinMap ? coinMap[this.consensusNetwork] : null
        return (typeof height === 'number') ? height : null
    },

    // Whether §3.8 counts a payload-free recognized carrier at `blockHeight`. A missing
    // height resolves to INACTIVE, so replay below the gate matches shipped behavior.
    envelopeCarrierRecognitionActiveAt(blockHeight){
        const activationHeight = this.envelopeCarrierRecognitionHeight()
        return activationHeight !== null
            && typeof blockHeight === 'number'
            && blockHeight >= activationHeight
    },

    // Pattern-match one input's witness stack against the envelope grammar
    // (envelope spec §3.2). Pure and RPC-free by contract (§3.8: recognition is
    // free pattern-matching; the commit fetch happens once, later, at parse).
    // Returns { script, payload } or null; NEVER throws (a foreign/fuzzed
    // witness must not crash the block loop).
    //
    // Rules pinned by spec §3.8 and the adversarial vectors:
    // - witness is indexed from the END per BIP341 (control block last, script
    //   second-to-last); a stack carrying an annex (last item leading 0x50) is
    //   NOT recognized, forever;
    // - the magic and format byte are cleartext; a wrong magic or an unknown
    //   format byte yields null (invisible, not an invalid action);
    // - the structure is exact: OP_FALSE OP_IF <"XCHN"> <0x00> <payload push
    //   1..n> OP_ENDIF <32-byte key> OP_CHECKSIG, nothing more. Any payload
    //   element that decompiles to a bare opcode (a minimally-encoded 1-byte
    //   push the encoder's rebalance never emits) breaks the pattern and
    //   yields null deterministically.
    detectEnvelopeWitness(witness){
        try {
            const script = envelopeScriptFromWitness(witness)
            if (script === null) return null
            return envelopeShapeFromScript(script)
        } catch (err){
            // Fuzzed/hostile witnesses must never crash recognition.
            return null
        }
    },

    // Source attribution for an envelope reveal (envelope spec §3.4): the
    // reveal's ins[0] prevout is the commit output, a payload-dependent
    // one-time P2TR address nothing else references, so the source is the
    // address FUNDING the commit: the prevout of the COMMIT transaction's
    // ins[0]. This is structurally the same walk-back getSourceFromOutput
    // already performs for P2SH/P2WSH data-carrier outputs (fetch the spent
    // tx, hop to ITS ins[0] prevout), scoped to recognized envelopes only so
    // ordinary actions spent FROM a taproot address keep their shipped
    // attribution. Takes the already-fetched commit transaction (the commit is
    // fetched exactly once per recognized envelope, §3.8); fail-loud contract
    // matches getSourceFromOutput (rpcLookupFailure tagging).
    async getEnvelopeSourceFromCommit(commitTransaction){
        if (!commitTransaction.ins || commitTransaction.ins.length === 0) return null
        const prevTxHash = util.uint8ArrayToHex(Buffer.from(commitTransaction.ins[0].hash).reverse())
        const prevOutputIndex = commitTransaction.ins[0].index
        let prevRawTransaction
        try {
            prevRawTransaction = await this.connector.getRawTransaction(prevTxHash)
            if (!prevRawTransaction){
                throw new Error(`empty getrawtransaction result for confirmed commit-funding tx ${prevTxHash}`)
            }
        } catch (err){
            this.rpcErrors++
            logger.error(formatLogLine(`getEnvelopeSourceFromCommit: failed to fetch commit-funding tx ${prevTxHash}: `, err))
            err.rpcLookupFailure = true
            throw err
        }
        // Decode outside the tagged try; see getSourceFromOutput.
        // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex.
        const prevTransaction = this.xchainBlockDecoder.transactionFromHex(prevRawTransaction)
        const output = prevTransaction.outs[prevOutputIndex]
        if (output == null) return null
        let source = null
        try {
            if (!this.isFutureSegwitScript(output.script))
                source = bitcoin.address.fromOutputScript(output.script, this.network)
        } catch (err){
            // No representable address (P2PK, bare multisig, ...): null source,
            // matching getSourceFromOutput.
        }
        return source
    },

    // Fetch + parse the envelope commit transaction, once per recognized
    // envelope (§3.8). Same fail-loud rpcLookupFailure contract as every other
    // confirmed-prevout fetch: the commit of a confirmed reveal always exists
    // on a txindex node, so an empty result is a lookup failure, never absence.
    async fetchEnvelopeCommitTransaction(commitTxId){
        let rawTransaction
        try {
            rawTransaction = await this.connector.getRawTransaction(commitTxId)
            if (!rawTransaction){
                throw new Error(`empty getrawtransaction result for confirmed envelope commit tx ${commitTxId}`)
            }
        } catch (err){
            this.rpcErrors++
            logger.error(formatLogLine(`fetchEnvelopeCommitTransaction: failed to fetch commit tx ${commitTxId}: `, err))
            err.rpcLookupFailure = true
            throw err
        }
        // Decode outside the tagged try; see getSourceFromOutput.
        return this.xchainBlockDecoder.transactionFromHex(rawTransaction)
    }
}
