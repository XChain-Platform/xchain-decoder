/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Decoder - PRICE v1 oracle-usage-fee output recognition 
 *
 * A Mode B (ORACLE_ADDRESS) dispenser pays its oracle operator up front as a real
 * native-coin output, and the indexer REJECTS the create/refill when that output is
 * absent or short (xchain-indexer utility.validateOracleFee, ). The indexer
 * only ever sees outputs the decoder persisted to `transaction_outputs`, and that
 * capture was previously limited to the protocol FEE_DESTINATION and COINPAY - so
 * an output paying an ORACLE_ADDRESS was dropped and every fee-bearing Mode B
 * create was rejected identically whether or not the payer actually paid.
 *
 * This module holds the two pure decisions that capture needs; the DB-backed half
 * (resolving a format-2 refill's oracle address from the open dispenser) lives in
 * XChainDecoder because it needs a connection.
 *
 ********************************************************************/

'use strict';

const { ORACLE_FEE_OUTPUT_ACTIVATION } = require('./protocol/constants.js')

// Field positions in the DISPENSER v0 wire format (must stay in sync with the
// indexer, xchain-indexer/src/actions/dispenser.js this.formats[0]):
//   0 DISPENSER | 1 VERSION | 2 GIVE_COIN | 3 GIVE_TICK | 4 GIVE_AMOUNT
//   5 GIVE_OWNERSHIP | 6 GIVE_ESCROW | 7 GET_COIN | 8 GET_TICK | 9 GET_AMOUNT
//   10 GET_ADDRESS | 11 FIAT_CODE | 12 FIAT_AMOUNT | 13 ORACLE_ADDRESS
//   14 EXPIRATION | 15 ALLOW_LIST | 16 BLOCK_LIST | 17 MEMO
const ORACLE_ADDRESS_INDEX = 13

// Is oracle-fee output capture in force for a block at `blockTime` on this network?
//
// Fails CLOSED on an unrecognized network name: an unknown network must not be read
// as "no gate" (which would capture from genesis on a chain the fleet has not armed
// and fork it), so it captures nothing at all. Mirrors the indexer's
// ProtocolChanges.isEnabled network guard, in the direction available to a decoder
// that cannot halt a block over it.
//
// Comparison is `blockTime >= activation`, the same >= semantics protocol_changes
// uses (it disables while `change.mainnet_time > current.block_time`).
function isOracleFeeCaptureActive(consensusNetwork, blockTime){
    const activation = ORACLE_FEE_OUTPUT_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const t = Number(blockTime)
    if (!Number.isFinite(t)) return false
    return t >= activation
}

// The ORACLE_ADDRESS a DISPENSER v0 create names, or null when it names none.
//
// Returns null for a compacted `^<id>` reference. That id lives in the INDEXER's
// index_addresses space, which the decoder cannot resolve (its own ids are a
// different AUTO_INCREMENT sequence), exactly like the GET_ADDRESS case the create
// path already fails loud on. Capturing against the raw `^<id>` token would key on a
// string no output can ever pay, so the honest answer is "no capture", which leaves
// the indexer rejecting the create - the fail-closed direction. The SDK is therefore
// held back from compacting DISPENSER.ORACLE_ADDRESS (addressRefFields.js
// `noCompact`), so only a third-party composer or a historical replay reaches here.
function oracleAddressFromCreate(fields){
    if (!Array.isArray(fields)) return null
    const token = fields[ORACLE_ADDRESS_INDEX]
    if (token === undefined || token === null || token === '') return null
    if (String(token).charAt(0) === '^') return null
    return String(token)
}

// True when a v0 ORACLE_ADDRESS token is present but compacted, i.e. capture was
// skipped for a reason worth logging rather than because no oracle was named.
function isCompactedOracleAddress(fields){
    if (!Array.isArray(fields)) return false
    const token = fields[ORACLE_ADDRESS_INDEX]
    return token !== undefined && token !== null && token !== '' &&
           String(token).charAt(0) === '^'
}

module.exports = {
    ORACLE_ADDRESS_INDEX,
    isOracleFeeCaptureActive,
    oracleAddressFromCreate,
    isCompactedOracleAddress,
}
