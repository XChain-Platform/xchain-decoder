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
 * XChain Protocol: Canonical Size Limits
 *
 * Single documented source of truth for the protocol-level size caps
 * that more than one service enforces independently. These values had
 * drifted apart before (services each re-declared their own copy and
 * applied it to subtly different quantities), which produced a class of
 * silent-failure bugs where one service accepted data another rejected.
 *
 * Plain CommonJS, zero dependencies; require()-able from any service,
 * tool, or test. Each service keeps its own local copy of these values
 * so it stays self-contained for deployment (the services ship as
 * independent containers and do not share a node_modules tree); the
 * cross-service regression suite asserts every local copy equals the
 * value declared here, so the limits can never silently diverge again.
 *
 ********************************************************************/

const actionSize = require('./constants/action_size.js');
const vmCrossCall = require('./constants/vm_cross_call.js');
const batchLimits = require('./constants/batch_limits.js');
const activation = require('./constants/activation.js');
const dispenserWideExpiration = require('./constants/dispenser_wide_expiration.js');

// VALID_FIAT_CODES: the accepted FIAT_CODE allow-list for PRICE actions. The indexer's
// config['FIATS'] keys (xchain-indexer/src/config.js) are the on-chain arbiter; this list
// mirrors them in the indexer's insertion order. The SDK validator (VALID_FIAT_CODES) must
// be a byte-equal allow-list so it never refuses a FIAT the protocol accepts (it previously
// drifted, missing EUR and KRW). The cross-service parity test asserts SDK === this list.
const VALID_FIAT_CODES = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];

// GAS_TICK: the protocol gas token's TICK. The indexer's config['GAS']
// (xchain-indexer/src/config.js) is the on-chain arbiter: it names the token
// debited for capability STAKE, VOTE deposits/escrows, contract gas billing,
// and every other gas-denominated flow. The SDK co-signer policy engine keys
// capability-STAKE spending caps to this tick (STAKE v1/v2 carry no TICK
// field). The cross-service parity test asserts indexer === SDK === this value.
const GAS_TICK = 'XCHAIN';

// Oracle federation (xchain-hub).
// Canonical source: xchain-hub/src/constants.js, mirrored here by hand. These two are
// NOT in the GOLDEN set of the xcall constants gate, and this repo carries no copy of
// that gate at all; the guard that diffs this copy against the canonical lives in
// xchain-hub/test/unit/constants-conformance.test.js (#3886), whose MIRRORS roster
// names this repo, so a drift here reddens hub CI rather than this repo's. Treat any
// change as a manual all-copies edit. Nothing here reads either one; they are
// re-exports for consumers.

// Coarse global sanity ceiling on an ingested price_snapshots value (pre-scale,
// covers pairs like BTC/KRW up to ~$7M BTC with headroom); rejects
// parse-overflow / misplaced-decimal garbage. Per-pair outliers are caught by
// the co-sign deviation gate and multi-submitter aggregation, not here.
const PRICE_MAX = 10_000_000_000;

// Co-sign deviation band for the oracle PREPARE content-validation gate: a
// follower refuses to co-sign a proposed price that deviates more than this
// fraction from its own local aggregate for the pair. MUST be
// federation-uniform: if hubs used different bands, identical aggregates
// could yield different accept/withhold decisions (a liveness divergence on
// the ±band boundary). 0.05 = 5%.
const ORACLE_DEVIATION_THRESHOLD = 0.05;

module.exports = {
    MAX_ACTION_DATA_LENGTH: actionSize.MAX_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD: actionSize.OP_RETURN_PUSH_OVERHEAD,
    MAX_CODE_SIZE: actionSize.MAX_CODE_SIZE,
    MAX_DEPLOY_CHUNKS: batchLimits.MAX_DEPLOY_CHUNKS,
    MAX_DEPLOYCHUNK_PART_BYTES: batchLimits.MAX_DEPLOYCHUNK_PART_BYTES,
    VM_MAX_CALL_DEPTH: vmCrossCall.VM_MAX_CALL_DEPTH,
    VM_MIN_CALL_GAS: vmCrossCall.VM_MIN_CALL_GAS,
    XCALL_MIN_GAS: vmCrossCall.XCALL_MIN_GAS,
    XCALL_MAX_GAS: vmCrossCall.XCALL_MAX_GAS,
    XCALL_MAX_HOPS: vmCrossCall.XCALL_MAX_HOPS,
    XCALL_MIN_DEADLINE_BLOCKS: vmCrossCall.XCALL_MIN_DEADLINE_BLOCKS,
    XCALL_MAX_DEADLINE_BLOCKS: vmCrossCall.XCALL_MAX_DEADLINE_BLOCKS,
    XCALL_MAX_RETURN_BYTES: vmCrossCall.XCALL_MAX_RETURN_BYTES,
    XCALL_MAX_CALLS_PER_BLOCK: vmCrossCall.XCALL_MAX_CALLS_PER_BLOCK,
    ATTEST_MAX_EXPIRIES_PER_BLOCK: batchLimits.ATTEST_MAX_EXPIRIES_PER_BLOCK,
    THRESHOLD_SCALE: batchLimits.THRESHOLD_SCALE,
    STAKE_WEIGHTED_QUORUM_ACTIVATION: activation.STAKE_WEIGHTED_QUORUM_ACTIVATION,
    EQUIV_HEADER_ACTIVATION: activation.EQUIV_HEADER_ACTIVATION,
    STATE_COMMITMENT_ACTIVATION: activation.STATE_COMMITMENT_ACTIVATION,
    CHECKPOINT_COMMITMENT_ACTIVATION: activation.CHECKPOINT_COMMITMENT_ACTIVATION,
    ANCHOR_REWARD_ACTIVATION: activation.ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT: activation.ANCHOR_REWARD_AMOUNT,
    ARCHIVE_REWARD_ACTIVATION: activation.ARCHIVE_REWARD_ACTIVATION,
    ARCHIVE_REWARD_AMOUNT: activation.ARCHIVE_REWARD_AMOUNT,
    CROSS_CHAIN_ROYALTY_ACTIVATION: activation.CROSS_CHAIN_ROYALTY_ACTIVATION,
    ORACLE_FEE_OUTPUT_ACTIVATION: activation.ORACLE_FEE_OUTPUT_ACTIVATION,
    ORACLE_FEE_SET_CAPTURE_ACTIVATION: activation.ORACLE_FEE_SET_CAPTURE_ACTIVATION,
    DISPENSER_EXPIRY_REALIGN_ACTIVATION: activation.DISPENSER_EXPIRY_REALIGN_ACTIVATION,
    DISPENSER_CANCEL_GRACE_ACTIVATION: activation.DISPENSER_CANCEL_GRACE_ACTIVATION,
    DISPENSER_PURGE_GRACE_ACTIVATION: activation.DISPENSER_PURGE_GRACE_ACTIVATION,
    DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION: activation.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION,
    DISPENSER_WIDE_EXPIRATION_ACTIVATION: dispenserWideExpiration.DISPENSER_WIDE_EXPIRATION_GATES,
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION: activation.BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
    ENVELOPE_MAX_PAYLOAD: actionSize.ENVELOPE_MAX_PAYLOAD,
    ENVELOPE_RECOGNITION_ACTIVATION: activation.ENVELOPE_RECOGNITION_ACTIVATION,
    ENVELOPE_CARRIER_RECOGNITION_ACTIVATION: activation.ENVELOPE_CARRIER_RECOGNITION_ACTIVATION,
    VALID_FIAT_CODES,
    GAS_TICK,
    PRICE_MAX,
    ORACLE_DEVIATION_THRESHOLD,
};
