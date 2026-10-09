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
 **********************************************************************/

// Stake-weighted quorum (STAKE_WEIGHTED_QUORUM).
// Consensus-critical activation: at/above this BTC-anchored snapshot_block the
// federation quorum becomes stake-WEIGHTED (signers' summed source stake must
// exceed 2/3 of total active snapshot stake) instead of count-based (2f+1 of the
// pubkey COUNT).
//
// Keyed on the BTC `snapshot_block` carried by every settlement/checkpoint
// canonical (NOT each chain's local processing height) so the hub and the BTC,
// LTC and DOGE indexers all flip on the SAME anchor. A per-chain local-height
// gate would fork: one snapshot_block lands at different local heights per chain.
// The `network` is also taken from the row, so the gate is env-independent.
//
// Enforced IDENTICALLY by the hub (every PBFT tally engine), the indexer
// (every settlement-signature gate + recovery), and the sdk/explorer/sync
// verifiers. All five keep a local copy of this map; the cross-service
// regression suite asserts they equal these values, so the activation height
// can never silently diverge (a divergence forks the chain).
//
// mainnet is ARMED (2026-07-07) to a concrete near-term height: 961000, the
// BTC-anchored flag-day at which mainnet flips from the count-based quorum
// rule to stake-weighted. BTC anchor ~2026-08-04; hub + ALL indexers (+
// sdk/explorer/sync copies) MUST deploy before this height. testnet/regtest
// activate at genesis so the e2e / regtest stack exercises stake-weighting
// from block 0.
const STAKE_WEIGHTED_QUORUM_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

// EQUIV_HEADER_ACTIVATION: the BTC-anchored flag-day at/above which every
// consensus canonical is prefixed with a uniform signed header
// `EQUIV|<ENGINE_TAG>|<ROUND_ID>|<VIEW>||<CONTENT>`. This is consensus-breaking (it changes the
// signed preimage of every settlement/checkpoint/price/attestation signature + the config-change
// PBFT canonical), so it is gated, kept byte-identical to the local copies in
// xchain-{hub,indexer,sdk,explorer,sync}/src/equivocation_header.js by the
// cross-service regression suite, and must deploy hub + ALL indexers atomically. Its sole
// consumer is the SLASH v0 equivocation-slashing action, which is only constructible from
// post-flag-day (header-carrying) messages. Same ARMED height and deploy-by convention as
// STAKE_WEIGHTED_QUORUM_ACTIVATION: mainnet is armed to 961000 (2026-07-07; BTC anchor
// ~2026-08-04), not a disabled placeholder.
const EQUIV_HEADER_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

// STATE_COMMITMENT_ACTIVATION (light-client SPV, spec §6.4): the flag-day at/above which
// each indexer computes + commits the additive per-block `state_root` (balances+stakes SMT)
// and `block_merkle_root`. ADDITIVE (the three consensus block hashes + BLOCK_HASH_VERSION are
// untouched), so it is not consensus-breaking by itself; it only adds new committed roots that
// the xchain-sync follower recomputes and HALTS on if they diverge. UNLIKE the two maps above,
// this gates on the chain's OWN local block_index (each chain starts committing its own per-block
// root at its own height); the Phase 2 checkpoint/ANCHOR extension that SIGNS these roots gates on
// snapshot_block. Kept byte-identical to the local copies in xchain-indexer/src/
// state_commitment_activation.js + xchain-sync/src/state_commitment_activation.js (and xchain-hub
// at Phase 2) by the cross-service regression suite. ARMED MID-CHAIN 2026-07-07 with per-chain
// '<COIN>:<network>' keys (one shared height cannot fit BTC ~957k and DOGE ~6.28M at once; bare
// network key remains for regtest; coin-less mainnet/testnet lookups stay inert). Same heights
// as the two state-hash gate maps, so ONE deploy-by date governs all Cohort-C flips; each height
// precedes the Cohort-B BTC anchor (961000) as the checkpoint-commitment ordering requires.
const STATE_COMMITMENT_ACTIVATION = {
    'BTC:mainnet':  958500,     // ARMED 2026-07-07 at tip 957062; ~10 days of margin
    'LTC:mainnet':  3143000,    // ARMED 2026-07-07 at tip 3138154; ~8 days
    'DOGE:mainnet': 6291000,    // ARMED 2026-07-07 at tip 6280094; ~7.5 days
    'BTC:testnet':  145000,     // ARMED 2026-07-07 at tip 143299
    'LTC:testnet':  4805000,    // ARMED 2026-07-07 at tip 4797675
    'DOGE:testnet': 67000000,   // ARMED 2026-07-07 at tip 66498605 (fast chain, wide margin)
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the roots end to end
};

// CHECKPOINT_COMMITMENT_ACTIVATION (light-client SPV, spec §6.1/§6.3, Phase 2): the flag-day at/above
// which the quorum-signed checkpoint canonical (and the on-chain ANCHOR) COMMIT the additive
// `state_root` + `block_merkle_root` (with their version bytes) that STATE_COMMITMENT_ACTIVATION made
// the indexer compute in Phase 1. Post-flag-day the checkpoint canonical string gains
// `|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION` and a new ANCHOR v3 carries
// the roots on DOGE; pre-flag-day both keep their old shape and the roots are absent. Consensus-relevant
// for signature verification (the signed preimage changes), so it must deploy hub + ALL indexers + the
// SDK/explorer verifiers atomically.
//
// UNLIKE STATE_COMMITMENT_ACTIVATION (which gates on each chain's OWN local block_index, since each chain
// computes its own per-block root), this gates on the BTC-anchored `snapshot_block` carried by every
// checkpoint canonical, exactly like STAKE_WEIGHTED_QUORUM_ACTIVATION / EQUIV_HEADER_ACTIVATION, so the
// hub and the BTC/LTC/DOGE indexers all flip the SIGNED shape on the same anchor. The operator MUST pick
// a snapshot_block at/after which every checkpointed chain is already past its own STATE_COMMITMENT
// flag-day (else the engine would have no roots to sign). Kept byte-identical to the local copies in
// xchain-{hub,indexer,sdk,explorer,sync}/src/checkpoint_commitment_activation.js (sync consumes it at
// checkpoint.js to decide whether to expect the roots) by the cross-service regression suite. Same
// ARMED height and deploy-by convention as the maps above: mainnet is armed to 961000
// (2026-07-07; BTC anchor ~2026-08-04), not a disabled placeholder.
const CHECKPOINT_COMMITMENT_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 146000,      // ARMED 2026-07-22: first BTC-testnet anchor past all three STATE_COMMITMENT testnet thresholds; was 0, which forced the SPV root suffix from testnet genesis before the indexer computes roots, so the hub refused to sign every testnet checkpoint
    regtest: 0,
};

// ANCHOR_REWARD_ACTIVATION (anchor-reward re-derivation): the flag-day at/above which the validator
// anchor reward stops being TRUSTED from the hub's `pushvalidatorrewards` JSON-RPC and is instead
// DERIVED by every indexer from the on-chain ANCHOR bytes. Post-flag-day the hub emits a publisher-
// bearing ANCHOR (v4 rootless / v5 root-bearing) carrying the elected publisher pubkey plus a 2f+1
// `oracle_publish` attestation (XANCPUB) over the reward tuple; the indexer verifies that quorum and
// credits the publisher with ANCHOR_REWARD_AMOUNT (a frozen consensus constant, NEVER from the wire).
// Below the flag-day the old push path stands and v4/v5 anchors are rejected. Consensus-relevant (the
// credited reward becomes a COLLECT-spendable per-block ledger row), so it must deploy hub + ALL
// indexers atomically. Like CHECKPOINT_COMMITMENT_ACTIVATION / STAKE_WEIGHTED_QUORUM_ACTIVATION it gates
// on the BTC-anchored `snapshot_block` carried by every ANCHOR canonical. Kept byte-identical to the
// local copies in xchain-{hub,indexer}/src/anchor_reward_activation.js by the cross-service regression
// suite. Same ARMED height and deploy-by convention as the maps above: mainnet is armed to 961000
// (2026-07-07; BTC anchor ~2026-08-04), not a disabled placeholder.
const ANCHOR_REWARD_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

// ANCHOR_REWARD_AMOUNT: the frozen validator anchor-publish reward, signed into the XANCPUB attestation
// by the hub and re-derived by the indexer (never from the wire). Changing it is itself a flag-day.
const ANCHOR_REWARD_AMOUNT = '10.00000000';

// ARCHIVE_REWARD_ACTIVATION (archive-reward re-derivation): the flag-day at/above which the
// anchor_archive reward stops riding the key-authenticated `pushvalidatorrewards` rail and is instead
// DERIVED by every indexer from the on-chain ANCHOR v6 bytes (the v1 archive anchor plus the same
// PUBLISHER + 2f+1 XANCPUB attestation tail as v4/v5, attested over an 'anchor_archive' canonical
// keyed on MATCH_BATCH_SEQ). This retires the last insider-with-key reward-forge surface the
// per-chain ANCHOR_REWARD flag-day left open. Below the flag-day the legacy v1 + push path stands
// and v6 anchors are rejected. Consensus-relevant, same deploy rules and snapshot_block gating as
// ANCHOR_REWARD_ACTIVATION; kept byte-identical to the local copies in
// xchain-{hub,indexer}/src/anchor_reward_activation.js by the cross-service regression suite.
const ARCHIVE_REWARD_ACTIVATION = {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off 969500 onto the pre-launch-freeze train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
};

// ARCHIVE_REWARD_AMOUNT: the frozen archive-publish reward, signed into the archive XANCPUB
// attestation by the hub and re-derived by the indexer (never from the wire). Kept equal to the
// hub's historical default (ANCHOR_REWARD_PER_PUBLISH). Changing it is itself a flag-day.
const ARCHIVE_REWARD_AMOUNT = '10.00000000';

// CROSS_CHAIN_ROYALTY_ACTIVATION (cross-chain royalty match-canonical): the flag-day at/above which
// the validator-signed XMATCH canonical carries the matched orders' royalty payout legs
// (a_payout_legs / b_payout_legs), so a colluding hub cannot strip a royalty from a cross-chain
// match; below it the canonical stays byte-identical to the legacy format, so pre-existing
// signatures keep verifying. Consensus-relevant (the signed preimage changes), so it must deploy
// hub + ALL indexers atomically. Like CHECKPOINT_COMMITMENT_ACTIVATION / ANCHOR_REWARD_ACTIVATION
// it gates on the BTC-anchored `snapshot_block` carried by every XMATCH canonical. The CREATE-side
// acceptance rule (deny a royalty-bearing cross-chain listing while enforcement is impossible) is
// gated separately by the CROSS_CHAIN_ROYALTY entry in the indexer's protocol_changes.js; the
// operator MUST flip this canonical gate first or together with it, NEVER create-side first
// (create-side ON with canonical OFF would put the legs in unsigned mirror fields, the exact
// tamper hole the legs-in-canonical design closes). Kept byte-identical to the local copies in
// xchain-{hub,indexer}/src/cross_chain_royalty_activation.js by the cross-service regression
// suite. Same ARMED height and deploy-by convention as the maps above: mainnet is armed to
// 961000 (2026-07-07; BTC anchor ~2026-08-04), not a disabled placeholder.
const CROSS_CHAIN_ROYALTY_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
};

// ORACLE_FEE_OUTPUT_ACTIVATION (PRICE v1 oracle usage fee): the flag-day
// at/above which the DECODER persists a native-coin output paying a DISPENSER's
// ORACLE_ADDRESS into transaction_outputs, so the indexer's validateOracleFee can see the
// fee that was actually paid. Keyed on BLOCK TIME (not height) because dispensers settle on
// BTC, LTC and DOGE, whose heights diverge; compared with the same >= semantics the indexer's
// protocol_changes gates use.
//
// The mainnet value is NOT free to choose: capturing a second output on a data-bearing
// transaction makes it fan out to two rows in getDecoderBlockData, and BELOW the indexer's
// FIX_OUTPUT_FANOUT flag-day (protocol_changes.js, mainnet block_time 1786060800) such a
// transaction is a consensus-critical fault that HALTS the block. This gate must therefore
// never precede FIX_OUTPUT_FANOUT; it is armed to exactly the same instant so capture begins
// in the same block the collapse does. Below it a Mode B create against a fee-bearing oracle
// is rejected with 'missing oracle fee output' whether or not the payer paid, which is the
// fail-closed direction and costs nothing while no mainnet chain holds a dispenser.
// testnet/regtest are genesis-on, matching FIX_OUTPUT_FANOUT there.
//
// Vendored byte-equal into xchain-decoder/src/protocol/constants.js; the parity suites keep
// the two copies and the indexer's FIX_OUTPUT_FANOUT timestamp in lockstep.
const ORACLE_FEE_OUTPUT_ACTIVATION = {
    mainnet: 1786060800,  // 2026-08-07 00:00:00 UTC, the contract-era flag-day FIX_OUTPUT_FANOUT rides
    testnet: 0,
    regtest: 0,
};

// Enables set-membership oracle-fee capture for all open Mode B dispensers owned by
// the source. The legacy single-row lookup can miss a refill's oracle when the source
// owns multiple dispensers. This block-time gate must never precede
// ORACLE_FEE_OUTPUT_ACTIVATION because it changes persisted outputs. Mainnet is armed
// at that base gate after a zero-dispenser history audit; testnet and regtest start at
// genesis. Every decoder must deploy an armed value before its activation instant.
const ORACLE_FEE_SET_CAPTURE_ACTIVATION = {
    mainnet: 1786060800,  // ARMED by the 2026-09-09 ruling at its base gate's own instant, the earliest the ordering above permits; identity on the indexed mainnet history (0 dispensers, measured 2026-09-09)
    // ARMED AT GENESIS (instant 0 = always in force), operator-ratified 2026-08-18 under the
    // pre-launch ruling that every feature must be ACTIVE on testnet. This gate fixes a defect
    // that spends a payer native coin and gives nothing back, so a public testnet WILL hit it.
    // Safe at 0 because testnet decoder/indexer state is REBUILT from the chain before launch.
    testnet: 0,
    regtest: 0,
};

// Moves decoder soft-expiry from block start to after the transaction loop, matching
// the indexer's measurement point so boundary-block payments are retained. This
// block-time gate changes persisted outputs. Genesis activation was approved after a
// zero-dispenser and zero-dispense history audit; every decoder must deploy an armed
// value before its activation instant.
const DISPENSER_EXPIRY_REALIGN_ACTIVATION = {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    // ARMED AT GENESIS (instant 0 = always in force), operator-ratified 2026-08-18 under the
    // pre-launch ruling that every feature must be ACTIVE on testnet. This gate fixes a defect
    // that spends a payer native coin and gives nothing back, so a public testnet WILL hit it.
    // Safe at 0 because testnet decoder/indexer state is REBUILT from the chain before launch.
    testnet: 0,
    regtest: 0,
};

// Keeps just-expired cancelling dispensers in the payment capture set for the
// indexer's cancellation grace window. Only capture eligibility widens; the expiry
// mark, edit mirror, oracle lookup, and purge timing stay unchanged. This block-time
// gate changes persisted outputs. Genesis activation was approved after a
// zero-dispenser and zero-dispense history audit; every decoder must deploy an armed
// value before its activation instant.
const DISPENSER_CANCEL_GRACE_ACTIVATION = {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    // ARMED AT GENESIS (instant 0 = always in force), matching the sibling
    // DISPENSER_EXPIRY_REALIGN_ACTIVATION under the pre-launch ruling that every feature must
    // be ACTIVE on testnet. This gate closes a defect that spends a payer's native coin and
    // gives nothing back, so a public testnet WILL hit it. Safe at 0 because testnet
    // decoder/indexer state is REBUILT from the chain before launch.
    testnet: 0,
    regtest: 0,
};

// DISPENSER_PURGE_GRACE_ACTIVATION: the block-time boundary at/above which the
// decoder keeps a soft-expired dispenser until its cancellation grace period has
// passed instead of hard-purging it at the raw expiration time. It is a separate
// gate from DISPENSER_CANCEL_GRACE_ACTIVATION because capture eligibility and row
// retention change independently.
//
// Mainnet and testnet remain unarmed so existing history is not reinterpreted.
// Regtest is genesis-active so the grace-aware purge path is exercised there.
const DISPENSER_PURGE_GRACE_ACTIVATION = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

const DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

// EXACT_INTEGER_EXPIRATION_ACTIVATION: the block-time boundary at/above which the
// decoder tests a DISPENSER create or edit EXPIRATION wire spelling in exact decimal
// space as well as checking its Number conversion. The legacy
// Number.isSafeInteger(Number(token)) guard can
// accept a fractional wire value when its fractional tail is below Number precision,
// while the indexer's exact integer rule rejects the same action. Registering or
// extending that dispenser here would then make the decoder capture payments for an
// action the indexer did not accept.
//
// This recognition change is consensus-affecting because it can remove an address from
// the decoder's payment-output capture set. Every network therefore remains UNARMED
// until an operator audit establishes a safe flag-day and the matching indexer gate is
// armed. null means never active; unknown networks and invalid block times fail closed.
const EXACT_INTEGER_EXPIRATION_ACTIVATION = {
    mainnet: null,
    testnet: null,
    regtest: null,
};

// Enables output capture and open-dispenser registration from BATCH subcommands.
// Both must switch together because the registry supplies the dispenser capture set.
// This block-time gate changes persisted rows and must never precede either the
// indexer's FIX_OUTPUT_FANOUT or BATCH_ISSUANCE_LIMITS activation. Mainnet is armed
// below; testnet and regtest start at genesis. Every decoder must deploy the armed
// value before the first affected BATCH.
const BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION = {
    mainnet: 1786838400,  // ARMED 2026-08-14 for 2026-08-16T00:00:00Z, matching BATCH_ISSUANCE_LIMITS
    testnet: 0,
    regtest: 0,
};

// Enables Taproot-envelope action recognition at each chain's local height. It also
// activates mixed-carrier and multi-envelope rejection. DOGE remains disabled because
// it has no Taproot. Mainnet heights were pinned 2026-08-02; testnet and regtest start
// at genesis. Deploy every decoder before an armed height, decoder before encoder.
const ENVELOPE_RECOGNITION_ACTIVATION = {
    BTC:  { mainnet: 960850, testnet: 0, regtest: 0 },
    LTC:  { mainnet: 3153500, testnet: 0, regtest: 0 },
    DOGE: { mainnet: null, testnet: null, regtest: null },
};

// Makes a recognized payload-free carrier count in mixed-carrier arbitration. This is
// separate because envelope recognition is already armed on BTC and LTC mainnet.
// Mainnet stays unpinned pending an operator decision; testnet and regtest start at
// genesis. Deploy every decoder before pinning a mainnet height.
const ENVELOPE_CARRIER_RECOGNITION_ACTIVATION = {
    BTC:  { mainnet: null, testnet: 0, regtest: 0 },
    LTC:  { mainnet: null, testnet: 0, regtest: 0 },
    DOGE: { mainnet: null, testnet: null, regtest: null },
};

module.exports = {
    STAKE_WEIGHTED_QUORUM_ACTIVATION,
    EQUIV_HEADER_ACTIVATION,
    STATE_COMMITMENT_ACTIVATION,
    CHECKPOINT_COMMITMENT_ACTIVATION,
    ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT,
    ARCHIVE_REWARD_ACTIVATION,
    ARCHIVE_REWARD_AMOUNT,
    CROSS_CHAIN_ROYALTY_ACTIVATION,
    ORACLE_FEE_OUTPUT_ACTIVATION,
    ORACLE_FEE_SET_CAPTURE_ACTIVATION,
    DISPENSER_EXPIRY_REALIGN_ACTIVATION,
    DISPENSER_CANCEL_GRACE_ACTIVATION,
    DISPENSER_PURGE_GRACE_ACTIVATION,
    DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION,
    EXACT_INTEGER_EXPIRATION_ACTIVATION,
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
    ENVELOPE_RECOGNITION_ACTIVATION,
    ENVELOPE_CARRIER_RECOGNITION_ACTIVATION,
};
