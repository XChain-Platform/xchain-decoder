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

const { logger } = require('./constants.js')
const { oracleAddressFromCreate, V0_GIVE_COIN_INDEX, V0_GET_COIN_INDEX, V0_GET_ADDRESS_INDEX, V0_EXPIRATION_INDEX, V2_EXPIRATION_INDEX } = require('../protocol/oracle_fee_output')
const { isBatchSubCommandCaptureActive } = require('../protocol/batch_sub_command_capture')

//Catch any dispenser message to add it to
//the list of possible dispenses.
//
//v0 wire format (must stay in sync with the
//indexer (see xchain-indexer/src/actions/dispenser.js):
//  DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT
//    |GIVE_OWNERSHIP|GIVE_ESCROW
//    |GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS
//    |FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS
//    |EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
//
// THE COMMAND VIEW IS `commands` ABOVE, deliberately the same
// variable and therefore the same flag-day as payment-output
// capture: [decodedData] for every non-BATCH transaction and for
// every block below BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION, the
// BATCH's sub-commands at/above it. Registration and capture are two
// halves of ONE decision (this registry IS the address set that
// decides which outputs are captured as dispenses), so arming them at
// different instants would leave the decoder half-batch-aware for no
// gain. Below the gate a BATCH's sub-commands stay invisible here
// exactly as they were, and the walk reduces to the single
// `decodedData.startsWith("DISPENSER")` test it replaces, so a
// from-genesis re-decode is byte-identical.
//
// What was broken: that top-level test is false for
// `BATCH|0|DISPENSER|0|...`, so a dispenser created inside a batch
// never entered the open set, its buyer's payments were never
// captured, and no DISPENSE ever fired - while the INDEXER, which
// dispatches the sub-command, registered it. Money-bearing, and a
// live decoder/indexer divergence.
//
// TWO PASSES, both in sub-command position order:
//   1. every v0 create is validated, the set is collapsed to one
//      registration per OPERATING ADDRESS (see
//      collapseDispenserRegistrations: the dispensers PRIMARY KEY is
//      (tx_index, address_id), which a batch can collide with), and
//      the survivors are inserted;
//   2. the format-1/2 lifecycle mirrors run AFTERWARDS, so an edit
//      anywhere in the batch reaches a dispenser created anywhere in
//      the same batch. The indexer dispatches in strict position
//      order, so an edit placed BEFORE its create fails there while
//      the decoder extends a row: that is the hold-open-longer
//      direction its advisory contract permits. The reverse ordering
//      would let an edit AFTER its create miss the row, which closes
//      early - the money-bearing direction.
//
// Per sub-command, not per transaction: EXPIRATION is read from THIS
// command's field [14] (defaulting from the shared block time, as the
// indexer's own default does), and the operating address from THIS
// command's GET_ADDRESS. There is no per-sub-command DISPENSER_ACTION_INDEX
// to reproduce: the indexer mints one per sub-command from its own
// action_index sequence (actions/batch/index.js -> db.createActionIndex ->
// getNextActionIndex), an id space the decoder has never held for
// top-level dispensers either. These rows are keyed on
// (tx_index, operating address) and nothing here is keyed on an
// action index, so nothing is approximated by not having one.
//
// THE PREFIX CARRIES ITS DELIMITER at/above the same gate, and only
// there. `startsWith("DISPENSER")` selects on a bare action NAME, but
// the wire delimits the name with '|', so it also matches every
// longer string sharing that head: `DISPENSERX|0|...`, which
// xchain-indexer/src/actions/index.js dispatches nowhere, and the real but
// indexer-SYNTHESIZED DISPENSER_CLOSE / DISPENSER_EXPIRE (both sit in
// FEE_QUOTE_EXEMPT beside DISPENSE and ORDER_MATCH), whose
// wire-spelled form carries no resolvable DISPENSER_ACTION_INDEX and
// so resolves no dispenser there either. The indexer runs NOTHING for
// any of them while the bare prefix has the decoder splitting on '|',
// reading field [1] as a DISPENSER FORMAT, and registering a create
// (or extending an open row on a format-2 read). The registry IS the
// set that decides which outputs become DISPENSE outputs, so the
// decoder then captures dispenses no indexer will ever settle. The
// direction is over-capture, which is why it was survivable and why
// it closes on a flag-day rather than as a hotfix.
//
// WHERE IT IS ACTUALLY REACHABLE, which is not where it looks. NOT at
// the top level: buildStoredActionRecord runs the VALID_ACTION_NAMES
// gate first, and that set holds 'DISPENSER' and no other name
// beginning DISPENSER, so `DISPENSERX|...` is blanked to '' before
// this walk ever sees it. The one top-level string that survives that
// gate and still misses `DISPENSER|` is the bare token 'DISPENSER'
// with no pipe at all, whose field [1] is undefined and whose FORMAT
// therefore parses NaN, matching no branch below either way.
// Sub-commands get NO such gate: the name checked was BATCH, and
// nothing re-checks the pieces. Row 26's walk is what made this
// reachable, and `BATCH|0|DISPENSERX|0|...` really does register.
//
// WHY IT IS GATED ANYWAY, given that the below-gate branch is a
// provable no-op today. That proof rests entirely on the membership
// of VALID_ACTION_NAMES, a set that can gain a DISPENSER-prefixed
// name later; the day it does, a from-genesis re-decode of history
// BELOW the flag-day must still reproduce the over-captured rows the
// fleet wrote, and only a gate can promise that in advance. It rides
// BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION rather than a constant
// of its own because that gate is BUILT AND STILL UNARMED on mainnet:
// the tightening costs no flag-day, and the inheritance it closes
// arms in the same instant that introduced it. A second constant
// would arm one half of one decision separately.
//
// `DISPENSER|` is the whole tightening: DISPENSER has no legacy
// VERSION-less wire form to spare (actions.js injects VERSION 0 for
// ISSUE/MINT/SEND only), and no alias resolves to it (ACTION_ALIASES
// is TRANSFER/ADDR/DROP/CAST/MSG), so every form the indexer
// dispatches to actionDispenser literally begins 'DISPENSER|'.
function dispenserCommandPrefixFor(block){
    const dispenserCommandPrefix =
        isBatchSubCommandCaptureActive(this.consensusNetwork, block.timestamp)
            ? "DISPENSER|"
            : "DISPENSER"
    return dispenserCommandPrefix
}

function pushOperatingAddressCreate(getAddress, decodedDataSplit, expiration, dispenserCreateCandidates, parseResult, nextTransactionHash, lastProcessedTxIndex){
    if (getAddress && getAddress.length > 0 && getAddress.charAt(0) === "^"){
        // Fail loud on a compacted `^<id>` GET_ADDRESS. This is a
        // reference into the INDEXER's index_addresses id space,
        // which the decoder cannot resolve (its own index_addresses
        // uses a different, AUTO_INCREMENT id space). Registering a
        // dispenser under the raw `^<id>` token would key it on a
        // string that never equals a real payment-output address,
        // so the dispenser would silently never dispense (and a
        // junk index_addresses row would be created). The SDK no
        // longer compacts DISPENSER.GET_ADDRESS, so any token
        // reaching here is a third-party composer or a historical
        // replay: surface it instead of registering a dead
        // dispenser. Do NOT roll the block back - the tx is
        // otherwise valid, this delegated dispenser is simply not
        // registered.
        this.parseErrors++
        logger.error(`Skipping dispenser in tx ${nextTransactionHash} (txIndex ${lastProcessedTxIndex}): unresolved compacted GET_ADDRESS reference '${getAddress}' - the decoder cannot resolve ^<id> address references, so this delegated dispenser was NOT registered`)
    } else {
        // The dispenser operates on GET_ADDRESS when a delegated
        // address is given, otherwise on the tx SOURCE (indexer
        // default). The indexer matches dispense triggers on this
        // operating address (get_address_id), so the decoder must
        // register and gate on the SAME key or dispenses paid to a
        // delegated address are never emitted.
        const operatingAddress = (getAddress && getAddress.length > 0)
            ? getAddress
            : parseResult["source"]
        // Mode B dispensers carry their PRICE v1 oracle address so a
        // later v2 refill, whose payload names no address, can
        // still have its oracle-fee output captured.
        // Compacted `^<id>` tokens resolve to null, same reason as
        // GET_ADDRESS above.
        dispenserCreateCandidates.push({
            address: operatingAddress,
            // The create SOURCE, kept alongside the operating
            // address so a later cancel/edit/refill issued by the
            // creator of a DELEGATED (GET_ADDRESS) dispenser still
            // resolves to this row, exactly as the indexer's
            // "SOURCE == dispenser SOURCE or GET_ADDRESS" gate
            // allows. Stored only when it differs from the
            // operating address.
            sourceAddress: parseResult["source"],
            oracleAddress: oracleAddressFromCreate(decodedDataSplit),
            expiration: expiration
        })
    }
}

function pushV0DispenserCreate(decodedDataSplit, dispenserCreateCandidates, parseResult, block, nextTransactionHash, lastProcessedTxIndex){
    let giveCoin = decodedDataSplit[V0_GIVE_COIN_INDEX]
    let getCoin = decodedDataSplit[V0_GET_COIN_INDEX]
    let getAddress = decodedDataSplit[V0_GET_ADDRESS_INDEX]

    // Treat a missing token OR an empty-string token as an
    // omitted EXPIRATION and substitute the same default the
    // indexer uses; only a present, non-empty value is validated.
    let expirationToken = decodedDataSplit[V0_EXPIRATION_INDEX]
    let expiration
    if (expirationToken === undefined || expirationToken === "") {
        expiration = this.getDefaultExpiration(block.timestamp)
    } else {
        expiration = Number(expirationToken)
    }

    // Require an INTEGER, matching the indexer, which rejects any
    // non-integer EXPIRATION outright (isInteger, see
    // xchain-indexer/src/actions/dispenser.js). dispensers.expiration
    // is BIGINT UNSIGNED, so a fractional value like 1700000000.5
    // either fails the write under a strict sql_mode - wedging the
    // block loop, which then retries the same deterministic tx
    // forever - or truncates under a lax one, leaving the decoder
    // holding a dispenser the indexer never registered.
    // Number.isSafeInteger already excludes NaN and Infinity, so it
    // subsumes the isNaN test it replaces; the default expiration is
    // integral by construction (block timestamp + whole days).
    //
    // SAFE integer, not merely integer, and no u32 ceiling. The old
    // `expiration > 4294967295` reject was recognition drift: the
    // indexer escrows any non-negative integer EXPIRATION into its own
    // BIGINT UNSIGNED column, so a dispenser opened past year 2106 (or
    // spelled 9999999999 for "never") stayed open and escrowed there
    // while the decoder skipped registration, and a later coin payment
    // to it was never flagged as a dispense. Number.isSafeInteger is
    // the bound that actually holds: at or below it Number() round-trips
    // the payload token exactly, so the decoder stores the same value
    // the indexer does, and it stays far inside BIGINT UNSIGNED.
    // Dropping the ceiling outright would NOT be safe - Number.isInteger
    // is true for 1e300, which overflows the column and wedges the block
    // loop on the same deterministic tx forever.
    if (!Number.isSafeInteger(expiration) || expiration < 0) {
        this.parseErrors++
        logger.error(`Skipping dispenser in tx ${nextTransactionHash}: invalid expiration value '${decodedDataSplit[V0_EXPIRATION_INDEX]}'`)
    } else if (this.dispenserOpensForThisChain(giveCoin, getCoin)){
        pushOperatingAddressCreate.call(this, getAddress, decodedDataSplit, expiration, dispenserCreateCandidates, parseResult, nextTransactionHash, lastProcessedTxIndex)
    }
}

function collectDispenserCreates(commands, dispenserCommandPrefix, parseResult, block, nextTransactionHash, lastProcessedTxIndex){
    let dispenserCreateCandidates = []
    for (let dispenserCommand of commands){
        if (typeof dispenserCommand !== 'string' || !dispenserCommand.startsWith(dispenserCommandPrefix))
            continue
        let decodedDataSplit = dispenserCommand.split("|")
        // Field [1] is the DISPENSER FORMAT (create=0, cancel=1,
        // edit=2; xchain-indexer/src/actions/dispenser.js this.formats).
        // The decoder mirrors all three so its open-dispenser view (the
        // address set that gates transaction_output capture) tracks the
        // same lifecycle the indexer derives. Formats 1 and 2 reference
        // the target by DISPENSER_ACTION_INDEX, an id in the INDEXER's
        // global action_index space that the decoder does not maintain
        // (same unresolvable id space as the ^<id> GET_ADDRESS the
        // create path fails loud on). The decoder therefore resolves the
        // target by the cancel/edit tx SOURCE address: the indexer gates
        // both on SOURCE == dispenser SOURCE or GET_ADDRESS, and the
        // decoder row records BOTH of those addresses (address_id = the
        // operating address, source_address_id = the create SOURCE when
        // delegated), so a SOURCE-address match reproduces the indexer's
        // authorisation outcome for delegated dispensers too.
        // What stays approximate is only WHICH dispenser an address's
        // cancel targets when that address has several open at once: the
        // action_index that would disambiguate is not in the decoder's id
        // space, so the row keyed on the operating address wins, then the
        // most recent. The residual gap is enumerated in
        // xchain-indexer/src/chain/dispenser_divergence_metrics.js.
        let commandVersion = decodedDataSplit[1]
        let dispenserFormat = parseInt(commandVersion, 10)

        // Everything after GET_AMOUNT is optional on v0, so the
        // length gate ends the required run there rather than at
        // ORACLE_ADDRESS; see hasRequiredDispenserCreateFields for
        // the field map and for what the old >= 14 gate cost.
        if (dispenserFormat === 0 && this.hasRequiredDispenserCreateFields(decodedDataSplit)){
            pushV0DispenserCreate.call(this, decodedDataSplit, dispenserCreateCandidates, parseResult, block, nextTransactionHash, lastProcessedTxIndex)
        }
    }
    return dispenserCreateCandidates
}

async function registerDispenser(loop, nextRegistration, openDispenserAddresses){
    if (!(await this.db.insertDispenser({
        txIndex: loop.lastProcessedTxIndex,
        address: nextRegistration.address,
        sourceAddress: nextRegistration.sourceAddress,
        oracleAddress: nextRegistration.oracleAddress,
        expiration: nextRegistration.expiration
    }))){
        // insertDispenser's error path already rolled the block back.
        return 'rollback'
    }
    // Keep the in-memory open-dispenser set current so a
    // later transaction in this same block that pays this
    // freshly-opened dispenser is still recognized as a
    // dispense (mirrors the old per-output DB lookup).
    if (nextRegistration.address)
        openDispenserAddresses.add(nextRegistration.address)
}

function dispenserEditExtension(dispenserCommand, dispenserCommandPrefix, parseResult, block){
    if (typeof dispenserCommand !== 'string' || !dispenserCommand.startsWith(dispenserCommandPrefix))
        return null
    let decodedDataSplit = dispenserCommand.split("|")
    let dispenserFormat = parseInt(decodedDataSplit[1], 10)
    if (dispenserFormat === 1){
        // Format 1 = cancel. Wire: VERSION|DISPENSER_ACTION_INDEX|MEMO.
        // NOT MIRRORED. The decoder's open-dispenser view is advisory
        // and must never close a row on a guessed target: it has
        // no DISPENSER_ACTION_INDEX, so it could only resolve the cancel
        // by SOURCE, and with two open dispensers on one source that
        // closes the wrong one, which stops capturing payments to a
        // still-live dispenser (money-bearing). Left unmirrored, a
        // cancelled dispenser stays in the decoder's open set until its
        // own expiration and the indexer drops the extra triggers.
        // Full reasoning: db.js, above extendOpenDispenserExpirationBySource.
    } else if (dispenserFormat === 2){
        // Format 2 = edit. Wire: VERSION|DISPENSER_ACTION_INDEX|GIVE_ESCROW
        //   |EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO.
        // Only a present, valid, future EXPIRATION affects the decoder's
        // open-view (GIVE_ESCROW refills and LIST changes do not move the
        // expiry the soft-expire keys on). The indexer overlays the last
        // valid non-null edit EXPIRATION onto the base (getExpiredItems),
        // and rejects a non-future value (bclte(EXPIRATION, BLOCK_TIME)), so
        // an empty EXPIRATION is a no-op here and a past/invalid one is
        // skipped.
        //
        // EXTEND ONLY, and against every open row of the source rather
        // than a guessed one: the decoder must not close early,
        // and an edit that lengthens an expiry is exactly the case where
        // failing to mirror WOULD close early. An edit that shortens one
        // is deliberately not mirrored.
        const editSource = parseResult["source"]
        const editExpirationToken = decodedDataSplit[V2_EXPIRATION_INDEX]
        if (editSource && editSource.length > 0 &&
            editExpirationToken !== undefined && editExpirationToken !== ""){
            const newExpiration = Number(editExpirationToken)
            // Same integer contract as the create guard above: the edit
            // path writes through extendOpenDispenserExpirationBySource
            // into the same BIGINT UNSIGNED column, and the indexer
            // rejects a fractional edit EXPIRATION with the identical
            // isInteger test, and the same SAFE-integer ceiling rather than
            // a u32 one (see the create guard: a u32 reject here would
            // silently decline to mirror an extend the indexer accepted,
            // closing the decoder's row early on a dispenser that is still
            // open and escrowed).
            if (Number.isSafeInteger(newExpiration) && newExpiration >= 0 &&
                newExpiration > block.timestamp){
                return { editSource, newExpiration }
            }
        }
    }
    return null
}

async function extendEditedDispenser(extension, nextBlockHeight){
    const { editSource, newExpiration } = extension
    // nextBlockHeight lets the mirror also clear a soft-expiry
    // THIS block stamped: deleteOpenDispensers ran before this
    // loop, so without it the `IS NULL` filter silently skipped
    // exactly the row a same-block extend is for, and the
    // decoder went dark on a dispenser the indexer keeps open.
    // The row is open again from the next block's load, which
    // ends the PERSISTENT divergence.
    //
    // RESIDUAL, and NOT benign: this restores the DB row, not
    // this block's in-memory capture set, so outputs paying
    // that dispenser in the REST of this block are still
    // missed, and under-capture is the money-bearing direction.
    // Re-seeding the set is not blocked by the guessed-target
    // rule (the extend already acts on EVERY open row of the
    // source, so reading those rows' operating addresses back
    // is set membership with no ranking); it is blocked because
    // widening the captured set changes the persisted output
    // set mid-block, which needs its own activation flag-day
    // with the legacy set preserved below it so a from-genesis
    // re-decode stays byte-identical. Outputs BEFORE the edit
    // tx in this block are unreachable by any re-seed and need
    // the end-of-block expiry realignment instead, which is
    // now what DISPENSER_EXPIRY_REALIGN_ACTIVATION arms: at/above
    // that gate nothing is stamped before the loop, so there is
    // no same-block stamp to clear and no mid-block gap at all.
    // The clear below stays for the legacy era it was written
    // for, where it is still the only thing ending the
    // PERSISTENT divergence.
    if ((await this.db.extendOpenDispenserExpirationBySource(editSource, newExpiration, nextBlockHeight)) === false){
        // extendOpenDispenserExpirationBySource's error path already rolled the block back.
        return 'rollback'
    }
}

module.exports = { dispenserCommandPrefixFor, collectDispenserCreates, registerDispenser, dispenserEditExtension, extendEditedDispenser }
