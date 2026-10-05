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

// Cross-contract calls (emit.execute). Maximum call depth: a user-submitted
// EXECUTE runs at depth 0; each emit.execute hop adds 1. Enforced by the VM at
// emit time and re-validated by the indexer when it processes the emission.
const VM_MAX_CALL_DEPTH = 4;

// Minimum caller-funded gas reservation per emit.execute call. Bounds call-tree
// fan-out: every call costs at least (VM_EMISSION + VM_MIN_CALL_GAS) out of the
// caller's own gas budget. Enforced by the VM and the indexer in lockstep.
const VM_MIN_CALL_GAS = 5000;

// Cross-CHAIN contract calls (emit.crossExecute / XCALL).
// Enforced by the VM at emit time and re-validated host-side by the indexer
// (processEmission + actions/xcall.js); the target chain re-validates the
// signed dispatch row before injecting. See protocol/Cross_Chain_Calls.md.

// Target-side gas ceiling bounds. The injected execution is fee-less on the
// target chain (the caller pre-paid on the source chain), so the per-call cap
// is much tighter than the same-chain 1M execution ceiling. The minimum equals
// VM_MIN_CALL_GAS.
const XCALL_MIN_GAS = 5000;
const XCALL_MAX_GAS = 200000;

// Cross-chain hop budget: a user-originated call is hop 1; a call emitted from
// a cross-chain-injected execution (or from a result callback) is hop 2; more
// requires a fresh user transaction. Bounds X→Y→X ping-pong, which is
// otherwise free after the first hop (injected executions have no fee payer).
const XCALL_MAX_HOPS = 2;

// Source-chain deadline window (blocks). Must comfortably exceed both chains'
// relay confirmation depths plus federation rounds; expiry past deadline_block
// is synthesized deterministically by every source-chain indexer.
const XCALL_MIN_DEADLINE_BLOCKS = 10;
const XCALL_MAX_DEADLINE_BLOCKS = 4000;

// Return payload cap, bytes (pre-base64). The payload is mirrored to every
// indexer and ANCHOR-archived on DOGE; an oversize return becomes status
// 'payload_too_large' with an EMPTY payload (deterministic. Never truncated).
const XCALL_MAX_RETURN_BYTES = 1024;

// Deterministic per-block injection cap on each target chain. Overflow carries
// forward to the next block in (snapshot_block, call_id) order. Never dropped.
const XCALL_MAX_CALLS_PER_BLOCK = 25;

module.exports = {
    VM_MAX_CALL_DEPTH,
    VM_MIN_CALL_GAS,
    XCALL_MIN_GAS,
    XCALL_MAX_GAS,
    XCALL_MAX_HOPS,
    XCALL_MIN_DEADLINE_BLOCKS,
    XCALL_MAX_DEADLINE_BLOCKS,
    XCALL_MAX_RETURN_BYTES,
    XCALL_MAX_CALLS_PER_BLOCK,
};
