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
const { logger, FUNDING_VOUT_BASE } = require('./constants.js')
const { MAX_ACTION_DATA_LENGTH, ENVELOPE_MAX_PAYLOAD } = require('../protocol/constants.js')
const { scanOutputs, decompilePayload } = require('./carrier_extraction.js')

// Carrier arbitration for the Taproot envelope (envelope spec §3.8),
// active only at/above the recognition height. Deterministic rules,
// pinned by the adversarial vectors:
// - a tx containing an envelope PLUS any other candidate carrier
//   (OP_RETURN XCHN data, chunk marker, MULTISIGN outputs, i.e.
//   anything the loop above accumulated or flagged) is NOT a valid
//   action;
// - a tx with two or more envelope inputs is NOT a valid action;
// - an envelope anywhere but ins[0] is NOT a valid action (§3.5:
//   reveal input 0 MUST be the commit outpoint; attribution and
//   fee resolution assume it).
// "Not a valid action" clears the action payload only: dispense and
// payment outputs stay recorded, exactly like any other no-action
// money-bearing tx.
function* arbitrateEnvelope(envelopeActive, envelopeInputs, blockHeight, nextTxId, firstInputTxId, otherCarrierRecognized, arb){
    let { dataBuffer, p2shFundingTxId, envelopeCarrier, envelopeCommitTransaction } = arb
    if (envelopeActive && envelopeInputs.length > 0){
        // §3.8 refuses an envelope mixed with any other CARRIER. The first two
        // disjuncts infer a carrier from its side effects (payload bytes, a chunk
        // marker), which misses a carrier that contributes neither: an OP_RETURN
        // deobfuscating to exactly XCHN and nothing after it. The third disjunct
        // reads recognition directly, behind its own activation height so replay
        // below it stays byte-identical to what the fleet indexed live.
        const carrierRecognitionActive = this.envelopeCarrierRecognitionActiveAt(blockHeight)
        const otherCarrierPresent = (dataBuffer.length > 0) || (p2shFundingTxId != null)
            || (carrierRecognitionActive && otherCarrierRecognized)
        // Verify exactly one envelope, carried alone, in the first input.
        // Two envelopes, an envelope beside another carrier, or one in a later
        // input are all ambiguous about which payload the transaction meant,
        // and the rule refuses ambiguity rather than guessing: every node must
        // reach the same answer from the same bytes.
        if (envelopeInputs.length >= 2 || otherCarrierPresent || envelopeInputs[0].index !== 0){
            this.parseErrors++
            logger.error(`Tx ${nextTxId}: envelope rejected deterministically (` +
                `${envelopeInputs.length} envelope input(s) at [${envelopeInputs.map(e => e.index).join(',')}]` +
                `${otherCarrierPresent ? ', mixed with another carrier' : ''}); no action`)
            dataBuffer = Buffer.allocUnsafe(0)
            p2shFundingTxId = null
        } else {
            // Single valid envelope at ins[0]: it IS the carrier. The
            // payload is the reassembled compiled action stream (raw by
            // design, §3.3: no deobfuscation step exists for the
            // envelope) and feeds the identical decompile below, so the
            // indexer stays encoding-blind. ins[0] spends the commit,
            // so firstInputTxId IS the commit txid: native fee outputs
            // ride it (§3.5), resolved via the same funding-fee
            // mechanism as the chunk lanes; the commit is fetched once
            // here and reused for attribution + fee resolution.
            dataBuffer = envelopeInputs[0].payload
            envelopeCarrier = true
            envelopeCommitTransaction = yield this.fetchEnvelopeCommitTransaction(firstInputTxId)
            p2shFundingTxId = firstInputTxId
        }
    }
    return { dataBuffer, p2shFundingTxId, envelopeCarrier, envelopeCommitTransaction }
}

function* capturePubkey(transaction, db, source){
    //Extract and store public key from the first input if source was found
    //
    // The opportunistic write below only fires for a source index_addresses
    // already holds, and the MEMPOOL lane depends on exactly that: it must never
    // allocate a replicated lookup id from non-deterministic mempool arrival
    // order (see insertMempoolTransaction). So a first-ever source's key is
    // carried out as sourcePubkey instead, and the confirmed-block path writes it
    // in db.insertTransaction once createAddress has allocated the id.
    let sourcePubkey = null
    if (source){
        let pubkey = this.extractPubkeyFromInput(transaction.ins[0])
        if (pubkey){
            sourcePubkey = pubkey
            let addressId = yield db.getAddressId(source)
            if (addressId && !(yield db.hasPubkey(addressId))){
                yield db.insertPubkey(addressId, pubkey)
            }
        }
    }
    return sourcePubkey
}

function* attributeFundingFees(p2shFundingTxId, firstInputTxId, envelopeCommitTransaction, sourceCommitCapture, paymentOutputs){
    //For a P2SH/P2WSH reveal, attribute the native-coin fee output (which lives on the funding
    //commit tx) to this action so the indexer can validate it (see findFundingFeeOutputs).
    if (p2shFundingTxId){
        // The chunk lanes set p2shFundingTxId = firstInputTxId, which getSourceFromOutput
        // above has already fetched and parsed, so reuse it instead of paying a second
        // RPC round trip (with its own 10-attempt retry budget) for the same txid. The
        // txid equality guard matters: getSourceFromOutput does not run when the source
        // was already known or not needed, and findFundingFeeOutputs must still fetch
        // for itself in that case.
        let prefetchedFundingTx = envelopeCommitTransaction
            || ((p2shFundingTxId === firstInputTxId && sourceCommitCapture.sourceTransaction) || null)
        let fundingFeeOutputs = yield this.findFundingFeeOutputs(p2shFundingTxId, prefetchedFundingTx)
        for (let feeOutput of fundingFeeOutputs){
            // Remap the FUNDING tx's vout into the reserved funding domain before this output
            // is stored under the REVEAL's tx_index, so it can never collide on the
            // (tx_index, vout) primary key with one of the reveal tx's own outputs (a dispense
            // or COINPAY output at the same vout number). See FUNDING_VOUT_BASE.
            paymentOutputs.push({
                ...feeOutput,
                vout: FUNDING_VOUT_BASE + feeOutput.vout
            })
        }
    }
}

function buildParseResult(dataBuffer, compiledDataLength, rawData, source, sourcePubkey, dispenseOutputs, paymentOutputs, envelopeCarrier){
    return {
        data:dataBuffer,
        compiledDataLength: compiledDataLength,
        rawData: rawData,
        source:source,
        // The key this transaction exposed on chain, or null. Carried so the
        // confirmed-block insert can record it for a source that had no
        // index_addresses row when the opportunistic write above ran.
        sourcePubkey: sourcePubkey,
        destination:null,
        dispenseOutputs:dispenseOutputs,
        paymentOutputs:paymentOutputs,
        // Per-encoding §4 ceiling for the size guards at both call
        // sites: the envelope gets ENVELOPE_MAX_PAYLOAD, every legacy
        // lane keeps MAX_ACTION_DATA_LENGTH. Carried in the result so
        // the block and mempool guards cannot drift from what was
        // recognized here.
        payloadCeiling: envelopeCarrier ? ENVELOPE_MAX_PAYLOAD : MAX_ACTION_DATA_LENGTH,
        envelope: envelopeCarrier
    }
}

function* resolveXChainTransaction(transaction, db, nextTxId, firstInputTxId, dispenseOutputs, paymentOutputs, parsed){
    let { source, dataBuffer, rawData, getSource, p2shFundingTxId, envelopeCarrier, envelopeCommitTransaction } = parsed
    // compiledDataLength starts as the raw accumulated byte count.
    // For P2SH/P2WSH/OP_RETURN this equals the compiled push size (the
    // script already carries the OP_PUSHDATA prefix). For MULTISIGN the
    // slots are zero-padded to 64 bytes each, so this value is inflated
    // by up to 59 bytes of pad on the final chunk. We re-measure below
    // once the decompile result is available -- EXCEPT for the
    // envelope, whose §4 measurand is exactly this initial value: the
    // reassembled payload byte length before parse. The re-measure
    // must not run for it: compiledPushSize models push framing only
    // up to OP_PUSHDATA2 (+3), but an envelope rawData push above
    // 65,535 bytes is framed with OP_PUSHDATA4 (+5) inside the payload
    // stream, so re-measuring would under-count by 2 bytes right at
    // the ENVELOPE_MAX_PAYLOAD boundary and accept a payload the
    // encoder validator (which measures true compiled length) refuses.
    let compiledDataLength = dataBuffer.length

    ;({ dataBuffer, rawData, getSource, compiledDataLength } = decompilePayload.call(this, nextTxId, envelopeCarrier, { dataBuffer, rawData, getSource, compiledDataLength }))

    //Get the source from the output spent by the first input of this transaction
    //only if there is data or a dispense and the source was not retrieved before.
    //Envelope reveals attribute differently (§3.4): ins[0]'s prevout is the
    //one-time P2TR commit output, so the source is the address funding the
    //COMMIT (its ins[0] prevout), resolved from the already-fetched commit.
    let sourceCommitCapture = {}
    if (getSource && (source == null)){
        source = envelopeCarrier
            ? yield this.getEnvelopeSourceFromCommit(envelopeCommitTransaction)
            : yield this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index, sourceCommitCapture)
    }

    let sourcePubkey = yield* capturePubkey.call(this, transaction, db, source)

    yield* attributeFundingFees.call(this, p2shFundingTxId, firstInputTxId, envelopeCommitTransaction, sourceCommitCapture, paymentOutputs)

    return buildParseResult(dataBuffer, compiledDataLength, rawData, source, sourcePubkey, dispenseOutputs, paymentOutputs, envelopeCarrier)
}

function* parseXChainTransaction(transaction, openDispenserAddresses, db, blockHeight, nextTxId, firstInputTxId){
    let dispenseOutputs = []
    let paymentOutputs = []
    // For a P2SH/P2WSH reveal, the funding (commit) tx (whose outputs this reveal spends) is the
    // first input's previous tx. Native-coin fee outputs are placed there (not on the reveal), so we
    // capture the funding txid to look them up before returning. Null for non-P2SH transactions.
    let p2shFundingTxId = null
    // Whether any NON-envelope carrier was RECOGNIZED on this transaction, tracked
    // independently of how many payload bytes it contributed. §3.8's mixed-carrier
    // refusal is about carriers, not bytes: an OP_RETURN deobfuscating to exactly the
    // XCHN magic is a carrier that contributes nothing, and inferring presence from
    // dataBuffer.length alone made it invisible. Read only inside the envelope
    // arbitration, behind its own activation height.
    let otherCarrierRecognized = false

    let source = null
    let dataBuffer = Buffer.allocUnsafe(0)
    let rawData = null
    let getSource = false

    // Taproot-envelope recognition (envelope spec §3.8), height-gated:
    // below the flag height this whole surface is inert and the tx
    // parses EXACTLY as shipped (a pre-flag mixed-carrier tx replays as
    // the fleet indexed it live). Recognition is a pure, RPC-free
    // pattern match over the inputs' witness stacks.
    const envelopeActive = this.envelopeActiveAt(blockHeight)
    let envelopeInputs = []
    if (envelopeActive){
        for (let txInputIndex = 0; txInputIndex < transaction.ins.length; txInputIndex++){
            const detected = this.detectEnvelopeWitness(transaction.ins[txInputIndex].witness)
            if (detected) envelopeInputs.push({ index: txInputIndex, payload: detected.payload })
        }
    }
    // Set when this tx's action is carried by a (single, valid)
    // envelope; routes the per-encoding ceiling, the commit-based
    // source attribution and the commit fee-output resolution below.
    let envelopeCarrier = false
    let envelopeCommitTransaction = null

    ;({ dataBuffer, getSource, p2shFundingTxId, otherCarrierRecognized } = yield* scanOutputs.call(this, transaction, openDispenserAddresses, nextTxId, firstInputTxId, dispenseOutputs, paymentOutputs, { dataBuffer, getSource, p2shFundingTxId, otherCarrierRecognized }))

    ;({ dataBuffer, p2shFundingTxId, envelopeCarrier, envelopeCommitTransaction } = yield* arbitrateEnvelope.call(this, envelopeActive, envelopeInputs, blockHeight, nextTxId, firstInputTxId, otherCarrierRecognized, { dataBuffer, p2shFundingTxId, envelopeCarrier, envelopeCommitTransaction }))

    return yield* resolveXChainTransaction.call(this, transaction, db, nextTxId, firstInputTxId, dispenseOutputs, paymentOutputs, { source, dataBuffer, rawData, getSource, p2shFundingTxId, envelopeCarrier, envelopeCommitTransaction })
}

function* parseTransactionSteps(transaction, openDispenserAddresses, db, blockHeight){
    // openDispenserAddresses is a Set of every open-dispenser address, loaded
    // once per block by the caller. Membership is tested in JS here instead of
    // issuing a DB round-trip per output. Defensive fallback to an empty Set
    // keeps callers that don't pass it (e.g. some unit tests) working.
    if (!openDispenserAddresses) openDispenserAddresses = new Set()
    // db is the handle used for the pubkey-capture writes below. The block path passes
    // this.db (default); the mempool path passes this.mempoolDb so pubkey writes for a
    // pending tx never touch the block's open transaction.
    if (!db) db = this.db
    // A zero-input transaction has no ins[0] to dereference below (the coinbase/
    // standard_input guard also reads ins[0]). An LTC MWEB/HogEx integration tx can
    // parse to zero canonical inputs after marker+flag stripping; such a tx carries no
    // XChain data. Skip it cleanly here, mirroring the mempool path's ins.length guard,
    // so it never throws a TypeError that costs 3 wasted block re-parses + a spurious
    // PARSE_ERROR quarantine event.
    if (!transaction.ins || transaction.ins.length === 0) return null
    let nextTxId = transaction.getId()
    let firstInputTxId = util.uint8ArrayToHex(Buffer.from(transaction.ins[0].hash).reverse())
    let standardInput = ("standard_input" in transaction.ins[0]?transaction.ins[0]["standard_input"]:true)

    //Ignore coin base transactions
    if ((firstInputTxId != "0000000000000000000000000000000000000000000000000000000000000000") && standardInput){
        return yield* parseXChainTransaction.call(this, transaction, openDispenserAddresses, db, blockHeight, nextTxId, firstInputTxId)
    } else {
        return null
    }
}

module.exports = {
    // blockHeight gates Taproot-envelope recognition (envelope spec §7): the
    // confirmed-block path passes the block being parsed, the mempool path
    // passes its next-block estimate. Omitted/undefined resolves to INACTIVE
    // (shipped pre-flag behavior), so no caller can accidentally recognize
    // envelopes below the flag height.
    async parseTransaction(transaction, openDispenserAddresses, db, blockHeight){
        // The steps are generators so every leaf wait is awaited once, here, exactly as
        // when this was one function: an awaited async helper would add a suspension, and
        // a transaction with no carrier must still resolve without one.
        const steps = parseTransactionSteps.call(this, transaction, openDispenserAddresses, db, blockHeight)
        let next = steps.next()
        while (!next.done){
            let resumed
            try {
                resumed = await next.value
            } catch (err){
                // Rethrown at the step's own wait, so its try/catch sees it as before.
                next = steps.throw(err)
                continue
            }
            next = steps.next(resumed)
        }
        return next.value
    },
}
