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
const { isOracleFeeCaptureActive, isOracleFeeSetCaptureActive, oracleAddressFromCreate, isCompactedOracleAddress, V0_REQUIRED_FIELD_COUNT, ORACLE_ADDRESS_INDEX } = require('../protocol/oracle_fee_output')
const { logger, strictTextDecoder, lenientTextDecoder } = require('./constants.js')
const { canonicalizeActionPayload } = require('./payload_helpers.js')
const { MAX_ACTION_DATA_LENGTH } = require('../protocol/constants.js')

module.exports = {
    // For a P2SH/P2WSH reveal, the native-coin fee output lives on the funding (commit) transaction:
    // the wallet/SDK place the fee output on the first tx they generate, and the reveal (this action's
    // tx) spends that commit's P2SH outputs. Fetch the funding tx and return any output paying the
    // protocol FEE_DESTINATION, shaped as a paymentOutput, so the indexer sees it among this action's
    // transaction_outputs and can validate the native-coin fee. Deterministic (same commit → same
    // output). Returns [] only for deterministic reasons (no fee destination configured, no funding
    // txid). A FAILED lookup throws (tagged rpcLookupFailure) so the block loop retries the block:
    // treating it as "no fee output" committed fee outputs on some instances and not others, and
    // whether an action paid its fee must never depend on which instance decoded it.
    async findFundingFeeOutputs(fundingTxId, prefetchedFundingTx = null){
        let results = []
        if (!this.feeDestination || !fundingTxId) return results
        // prefetchedFundingTx: the Taproot-envelope path fetches the commit
        // exactly once (spec §3.8) and hands the parsed tx in here, so the fee
        // resolver extends to the commit without a second RPC round trip. The
        // P2SH/P2WSH chunk flows hand in the commit getSourceFromOutput already
        // parsed, so the fetch below is the fallback for a caller that has none.
        let fundingTx = prefetchedFundingTx
        if (!fundingTx){
            let fundingTxHex
            try {
                fundingTxHex = await this.connector.getRawTransaction(fundingTxId)
                if (!fundingTxHex){
                    throw new Error(`empty getrawtransaction result for confirmed funding tx ${fundingTxId}`)
                }
            } catch (err){
                this.rpcErrors++
                logger.error(formatLogLine(`findFundingFeeOutputs: failed to fetch funding tx ${fundingTxId}:`, err.message))
                err.rpcLookupFailure = true
                throw err
            }
            // Decode outside the tagged try; see getSourceFromOutput.
            // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex.
            fundingTx = this.xchainBlockDecoder.transactionFromHex(fundingTxHex)
        }
        for (let vout = 0; vout < fundingTx.outs.length; vout++){
            let output = fundingTx.outs[vout]
            let outputAddress = null
            try {
                if (!this.isFutureSegwitScript(output.script))
                    outputAddress = bitcoin.address.fromOutputScript(output.script, this.network)
            } catch (err){
                //the output script has no matching address; skip
            }
            if (outputAddress && outputAddress === this.feeDestination){
                results.push({ vout: vout, destinationAddress: outputAddress, amount: output.value })
            }
        }
        return results
    },

    // A v0 DISPENSER open is valid for THIS chain only when BOTH coin fields name
    // this chain's native coin. This mirrors the indexer's four format==0 checks
    // (xchain-indexer/src/actions/dispenser.js): GIVE_COIN and GET_COIN must each be
    // a supported COIN AND equal the local COIN. Requiring both to equal this.coinTick
    // satisfies all four at once (the local coin is by definition supported).
    //
    // Opening a dispenser whenever either coin field is merely non-empty admits
    // three shapes the indexer rejects outright: GIVE_COIN set
    // with GET_COIN empty, GET_COIN set with GIVE_COIN empty, and either field naming
    // a foreign network (e.g. a DOGE-configured decoder seeing DISPENSER|0|BTC|...).
    // Such rows have no matching indexer record and can misclassify later ordinary
    // native-coin payments to that address as failed dispenses. The strict gate keeps
    // decoder and indexer in agreement.
    //
    // Only command version 0 carries these coin fields; the caller already gates this
    // check behind commandVersion === 0, so other/future versions are unaffected.
    dispenserOpensForThisChain(giveCoin, getCoin){
        return giveCoin === this.coinTick && getCoin === this.coinTick
    },

    // Does a split v0 DISPENSER create payload carry every field the indexer
    // requires? Split indices are offset by one from the indexer's field list
    // because the decoder splits the whole action string, ACTION token included:
    //
    //   [0] DISPENSER [1] VERSION [2] GIVE_COIN [3] GIVE_TICK [4] GIVE_AMOUNT
    //   [5] GIVE_OWNERSHIP [6] GIVE_ESCROW [7] GET_COIN [8] GET_TICK
    //   [9] GET_AMOUNT [10] GET_ADDRESS [11] FIAT_CODE [12] FIAT_AMOUNT
    //   [13] ORACLE_ADDRESS [14] EXPIRATION [15] ALLOW_LIST [16] BLOCK_LIST
    //   [17] MEMO
    //
    // Everything from GET_ADDRESS on is optional (GET_ADDRESS defaults to
    // SOURCE, EXPIRATION to a block-time window), so the required run ends at
    // GET_AMOUNT and a conforming create is at least 10 tokens long.
    //
    // This gate was >= 14, which silently dropped every create whose optional
    // tail was omitted rather than padded - the shape the wallet emits when the
    // seller keeps the default expiry (`DISPENSER|0|BTC|TICK|500||2000|BTC||0.01`,
    // 10 tokens). The indexer opened those dispensers and showed them valid with
    // escrow locked while the decoder never registered the operating address, so
    // buyer payments were never recognised as dispenses: the buyer's coin went to
    // the seller and no tokens came back. Verified on BTC regtest - a 10-token
    // create took a payment and dispensed nothing; the same create with an
    // explicit EXPIRATION (15 tokens) dispensed correctly.
    hasRequiredDispenserCreateFields(decodedDataSplit){
        return Array.isArray(decodedDataSplit) && decodedDataSplit.length >= V0_REQUIRED_FIELD_COUNT
    },

    // The ORACLE_ADDRESSes whose native-coin outputs this transaction's payment-output
    // capture must persist, as an array (empty when there are none).
    //
    // A Mode B dispenser pays its PRICE v1 oracle operator up front as a real on-chain
    // output, and the indexer rejects the create/refill when it cannot SEE that output
    // in `transaction_outputs` (utility.validateOracleFee). The decoder stays
    // address-keyed and prices nothing: it captures any output paying the oracle address
    // this transaction is associated with and leaves every amount/eligibility question to
    // the indexer, exactly as it does for the protocol FEE_DESTINATION.
    //
    //   v0 (create): the address is in the payload itself (field 13), so this is always a
    //       one-element answer.
    //   v2 (edit/refill): the payload carries no address. It names the target by
    //       DISPENSER_ACTION_INDEX, an id in the INDEXER's action space the decoder does
    //       not maintain, so the oracle address is read back from the open dispenser rows
    //       this decoder registered, resolved by SOURCE address. That match covers the
    //       create SOURCE as well as the operating address, so a delegated (GET_ADDRESS)
    //       dispenser refilled by its original creator resolves too. An unmatched SOURCE
    //       captures nothing and the indexer rejects that refill, which is fail-closed.
    //
    //       Which rows a v2 resolves to is itself gated, on
    //       ORACLE_FEE_SET_CAPTURE_ACTIVATION:
    //         at/above it - EVERY open Mode B dispenser of that source, and the caller
    //             tests membership. No ORDER BY can identify the DISPENSER_ACTION_INDEX
    //             target, so the set is the only answer that captures the right output for
    //             a source holding more than one open dispenser.
    //         below it - the legacy single top-ranked pick, preserved byte-for-byte
    //             because widening the persisted output set is consensus-affecting and a
    //             re-decode of pre-flag-day history must reproduce what the fleet wrote.
    //             Its known defect (a refill of any non-top-ranked row captures nothing)
    //             is stated at getOpenDispenserOracleAddressBySource in db.js.
    //
    // Returns false on a DB fault so the caller can roll the block back: silently
    // capturing nothing would make this node disagree with a healthy one about what the
    // transaction paid, which is a ledger fork rather than a missed row.
    async resolveOracleFeeAddresses(decodedData, source, blockTime, transactionHash){
        if (typeof decodedData !== 'string' || !decodedData.startsWith("DISPENSER|"))
            return []
        // Consensus gate. Below it the decoder captures nothing, so a fee-bearing Mode B
        // create is rejected whether or not it paid - the fail-closed direction, and the
        // one that keeps a from-genesis re-decode byte-identical to what live nodes wrote.
        // The gate is armed to the indexer's FIX_OUTPUT_FANOUT instant because capturing a
        // SECOND output on a data-bearing transaction fans it out to two rows, which below
        // that flag-day is a consensus-critical fault that halts the block.
        if (!isOracleFeeCaptureActive(this.consensusNetwork, blockTime))
            return []

        let fields = decodedData.split("|")
        let format = parseInt(fields[1], 10)

        if (format === 0){
            if (isCompactedOracleAddress(fields)){
                // Unresolvable `^<id>` reference into the indexer's address-id space. Log
                // it the way the sibling GET_ADDRESS case does rather than capturing
                // against a token no output can pay. The SDK does not compact this field
                // (addressRefFields.js `noCompact`), so this is a third-party composer or
                // a historical replay.
                this.parseErrors++
                logger.error(`Oracle-fee output NOT captured for tx ${transactionHash}: compacted ORACLE_ADDRESS reference '${fields[ORACLE_ADDRESS_INDEX]}' cannot be resolved by the decoder, so the indexer will reject this dispenser create`)
                return []
            }
            let createOracleAddress = oracleAddressFromCreate(fields)
            return createOracleAddress ? [createOracleAddress] : []
        }

        if (format === 2){
            if (!source || source.length === 0) return []
            if (isOracleFeeSetCaptureActive(this.consensusNetwork, blockTime)){
                let oracleAddresses = await this.db.getOpenDispenserOracleAddressesBySource(source)
                if (oracleAddresses === false) return false
                // db.js returns an array; any iterable of addresses (a Set, say) is accepted
                // so an alternate accessor shape degrades to a correct capture rather than
                // to a silently empty one. A bare string is NOT one: spreading it would
                // make every character a set member.
                if (!oracleAddresses || typeof oracleAddresses === 'string' ||
                    typeof oracleAddresses[Symbol.iterator] !== 'function') return []
                // Drop null/empty entries defensively: an unresolvable address must never
                // become a set member, or an output whose own address failed to resolve
                // (also null) would match it and be captured by accident.
                return [...oracleAddresses].filter(nextAddress => typeof nextAddress === 'string' && nextAddress.length > 0)
            }
            let oracleAddress = await this.db.getOpenDispenserOracleAddressBySource(source)
            if (oracleAddress === false) return false
            return oracleAddress ? [oracleAddress] : []
        }

        return []
    },

    // The UNION of the oracle-fee addresses named by every command in `commands`, or false
    // when a deterministic DB fault stopped a resolution (propagated so the caller retries
    // the block rather than persisting a smaller output set than a healthy node would).
    //
    // For a non-BATCH transaction `commands` is [decodedData] and this is exactly
    // resolveOracleFeeAddresses. For a BATCH at/above
    // BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION it is the sub-command list, and one batch
    // may name several oracles: each DISPENSER sub-command is dispatched independently by
    // the indexer and pays its own oracle, so the whole union has to be capturable.
    //
    // The cache bounds the DB work a 250-command batch can force inside the block loop. A
    // v0 create resolves purely by parsing its own fields (no query at all), while every
    // v2 refill resolves from SOURCE alone - the payload names its target by
    // DISPENSER_ACTION_INDEX, an id in the indexer's space the decoder does not maintain -
    // so all v2 sub-commands of one transaction resolve identically and share a cache key.
    async resolveOracleFeeAddressesForCommands(commands, source, blockTime, transactionHash){
        let addresses = []
        let resolved = new Set()
        for (let nextCommand of commands){
            if (typeof nextCommand !== 'string' || !nextCommand.startsWith("DISPENSER|"))
                continue
            let cacheKey = nextCommand.startsWith("DISPENSER|2|") ? "DISPENSER|2|" : nextCommand
            if (resolved.has(cacheKey))
                continue
            resolved.add(cacheKey)
            let commandAddresses = await this.resolveOracleFeeAddresses(nextCommand, source, blockTime, transactionHash)
            if (commandAddresses === false)
                return false
            for (let nextAddress of commandAddresses)
                addresses.push(nextAddress)
        }
        return addresses
    },

    // Whether a parse result is worth a transactions row at all: it must carry an
    // attributable ACTION (data plus a resolved source) or at least one possible
    // dispense. A tx failing this never reaches the storage gate and never consumes
    // a tx_index. Kept beside buildStoredActionRecord so the two halves of "what
    // gets stored" are one readable pair rather than a loop condition nothing
    // outside the running block loop can call.
    hasStorableContent(parseResult){
        if (parseResult == null) return false
        const hasAction = (parseResult["data"] != null)
            && (parseResult["data"].length > 0)
            && (parseResult["source"] != null)
        return hasAction || (parseResult["dispenseOutputs"]?.length > 0)
    },

    // The storage gate: turns a parseTransaction result into the exact ACTION
    // record a row INSERT stores. This is the second half of the decode contract
    // and the one that decides what history actually holds. A shared callable entry
    // point keeps the confirmed-block and mempool paths consistent and lets
    // conformance tests exercise the storage contract directly.
    //
    // Applies, in order: the per-encoding compiled-size ceiling (envelope spec §4),
    // alias canonicalization, the UTF-8 decode (strict, lenient fallback) and the
    // VALID_ACTION_NAMES gate. A rejected ACTION is NOT a rejected transaction: when
    // the tx also carries money-bearing dispense/payment outputs the action is
    // blanked ('' plus a null raw_data, never SQL NULL, so a pending row and its
    // confirmed twin still correlate) and the caller stores the outputs. Only a tx
    // with nothing else to record is skipped.
    //
    // mempool selects the log wording of the two paths; the acceptance rules are
    // identical by construction, which is the point of the shared helper.
    // Returns { skip, data, rawData }.
    buildStoredActionRecord(parseResult, txHash, mempool){
        const rejectPrefix = (mempool ? 'Mempool: tx ' : 'Skipping ACTION for tx ') + txHash + ': '
        const utf8Prefix = (mempool ? 'Mempool: tx ' : 'Tx ') + txHash + ': '

        let payload = parseResult["data"]
        // No action payload at all: the tx is stored for its outputs alone. null
        // (only reachable from a stub result) stays null so the mempool row keeps
        // the shape it had before this helper existed.
        if (payload == null) return { skip: false, data: null, rawData: parseResult["rawData"] || null }
        if (payload.length === 0) return { skip: false, data: "", rawData: parseResult["rawData"] || null }

        let hasOutputs = ((parseResult["dispenseOutputs"]?.length > 0) || (parseResult["paymentOutputs"]?.length > 0))
        // The || covers results from stubs/older shapes without the field.
        let payloadCeiling = parseResult["payloadCeiling"] || MAX_ACTION_DATA_LENGTH

        // Verify the on-chain push is within the protocol's size cap. This service
        // is the arbiter for that rule, so an oversized push is dropped rather than
        // trimmed: accepting one would put a record on the ledger no other node has.
        if (parseResult["compiledDataLength"] > payloadCeiling){
            this.parseErrors++
            logger.error(rejectPrefix + `ACTION data exceeds maximum length (${parseResult["compiledDataLength"]} > ${payloadCeiling})`)
            return { skip: !hasOutputs, data: "", rawData: null }
        }

        // Canonicalize (tokenize + alias-expand) at the BYTE level before string
        // decoding, so the canonical name (always plain ASCII) rides through the same
        // strict/lenient decode as everything else and the DB ends up alias-free
        // regardless of which spelling was used on-chain. canonical.buffer equals the
        // parsed payload unchanged whenever no rewrite is needed (including the
        // unknown-name case), so this decode is byte-for-byte identical to decoding
        // the raw data. The ceiling above deliberately bounds the WIRE form only: an
        // alias expansion runs after it and may push the stored record past the cap.
        const canonical = canonicalizeActionPayload(payload)
        let decodedData
        try {
            decodedData = strictTextDecoder.decode(canonical.buffer)
        } catch (e) {
            this.parseErrors++
            decodedData = lenientTextDecoder.decode(canonical.buffer)
            logger.error(formatLogLine(utf8Prefix + 'ACTION data contains invalid UTF-8, decoded with replacement characters', e))
        }

        // Verify the ACTION name is one this protocol defines. An unrecognized name
        // is somebody else's data sharing the chain, not a malformed transaction of
        // ours, so it is rejected without being recorded as an error against a user.
        if (!canonical.isKnown){
            this.parseErrors++
            logger.error(rejectPrefix + `unknown ACTION name '${canonical.rawActionName.substring(0, 32)}'`)
            return { skip: !hasOutputs, data: "", rawData: null }
        }

        return { skip: false, data: decodedData, rawData: parseResult["rawData"] || null }
    }
}
