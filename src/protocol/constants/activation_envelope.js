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

// ENVELOPE_RECOGNITION_ACTIVATION (Taproot-envelope spec §7): the LOCAL block height
// at/above which the decoder recognizes Taproot-envelope reveals as
// action-bearing transactions, per host chain and network. Recognition changes
// what counts as an action (and §3.8's mixed-carrier/multi-envelope rejections
// activate at the same height), so it is fleet-deterministic: every decoder
// instance for a given chain+network MUST flip at the same height or the fleet
// forks on the first envelope (or the first mixed-carrier tx). Keyed on each
// chain's OWN local block height (like STATE_COMMITMENT_ACTIVATION), because
// recognition happens while parsing that chain's blocks; DOGE has no segwit,
// hence no Taproot and no envelope, so its entry is null (never active) and
// must stay null. Below the height the decoder behaves EXACTLY as shipped: a
// pre-flag tx containing an envelope plus an OP_RETURN action replays as the
// OP_RETURN action, exactly as the fleet indexed it live.
//
// The mainnet heights were pinned 2026-08-02 against a MEASURED tip (BTC 960812,
// LTC 3153356) with ~6 hours of margin over a redeploy train that takes about an
// hour. Re-pinning an already-deployed, already-armed cohort is done by moving the
// constant, never by rebasing the code. testnet/regtest stay genesis-active: this
// gate only ever applied to mainnet.
//
// DEPLOY DEADLINE: EVERY decoder on BTC and LTC mainnet MUST be running this
// constant before its height or the fleet forks on the first envelope (or the first
// mixed-carrier tx, which the §3.8 rejections start refusing at exactly this
// height). Rollout order within any venue: decoder before encoder, per the standing
// coupling rule. Verify the fleet by reading the armed map out of each RUNNING
// container rather than out of this file.
const ENVELOPE_RECOGNITION_ACTIVATION = {
    BTC:  { mainnet: 960850, testnet: 0, regtest: 0 },
    LTC:  { mainnet: 3153500, testnet: 0, regtest: 0 },
    DOGE: { mainnet: null, testnet: null, regtest: null },
};

// ENVELOPE_CARRIER_RECOGNITION_ACTIVATION (Taproot-envelope spec §3.8): the LOCAL block
// height at/above which the decoder counts a RECOGNIZED but payload-free carrier as a
// mixed carrier. Below it, arbitration infers carrier presence from accumulated payload
// bytes, so an OP_RETURN that deobfuscates to exactly the XCHN magic and nothing else
// contributes zero bytes and the envelope is still accepted as an action - while §3.8
// says an envelope mixed with any other carrier is not an action. That is a divergence
// against any implementation written from the published rule.
//
// Its own height, separate from ENVELOPE_RECOGNITION_ACTIVATION, because that gate is
// already ARMED on BTC and LTC mainnet: §3.8 arbitration has been live consensus since
// 2026-08-02, so changing what it refuses is a second recognition change and every
// decoder must flip at the same height or the fleet forks. Below the height the decoder
// behaves EXACTLY as shipped, so replay of indexed history is byte-identical.
//
// The mainnet entries are deliberately UNPINNED (null = never active). Pinning them
// against a measured tip, with the redeploy train's margin, is an operator decision and
// a deploy-train act, not a code edit made in passing. testnet/regtest are genesis-active,
// matching the sibling gate above: recognition itself has been genesis-active there, so
// the refusal rule the spec states applies to those chains from genesis too.
//
// DEPLOY DEADLINE (once pinned): EVERY decoder on that chain+network MUST be running the
// pinned height before it, or the fleet forks on the first envelope carrying a
// marker-only XCHN OP_RETURN. Verify the fleet by reading the armed map out of each
// RUNNING container rather than out of this file.
const ENVELOPE_CARRIER_RECOGNITION_ACTIVATION = {
    BTC:  { mainnet: null, testnet: 0, regtest: 0 },
    LTC:  { mainnet: null, testnet: 0, regtest: 0 },
    DOGE: { mainnet: null, testnet: null, regtest: null },
};

module.exports = {
    ENVELOPE_RECOGNITION_ACTIVATION,
    ENVELOPE_CARRIER_RECOGNITION_ACTIVATION,
};
