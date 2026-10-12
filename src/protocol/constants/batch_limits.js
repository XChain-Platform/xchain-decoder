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

// ATTEST expiry sweep.
// Deterministic per-block cap on the ATTEST v0 deadline-expiry sweep.
// Each expired request synthesizes an ATTEST v2 action that flips the request to
// 'expired' and fires its callback, so an unbounded sweep lets a single block
// inherit an arbitrary backlog: one block's processing time (and its actions
// rows) becomes a function of how many requests happened to expire at once,
// which an attacker controls by batching requests with a common deadline.
//
// Overflow carries forward to the next block rather than being dropped: the
// selection is ordered (deadline_block ASC, action_index ASC), a TOTAL order
// because action_index is unique, so the same requests expire in the same order
// on every node, just spread across more blocks. Mirrors the XCALL sibling cap
// above in both value and carry-forward semantics.
//
// CONSENSUS-VISIBLE: the cap decides which block an expiry lands in, which moves
// actions rows, the contract hash and the checkpoint preimage. It ships ungated
// because the pre-launch fleet-wide replay recomputes all of it.
const ATTEST_MAX_EXPIRIES_PER_BLOCK = 25;

// Token-gated content.
// Fixed fractional scale for comparing FILE.GATE_MIN_AMOUNT thresholds against a
// holder's balance. The wallet scales both sides to this many fractional digits
// as BigInt (packages/core THRESHOLD_SCALE); the indexer compares with mathjs
// bignumber. A threshold carrying MORE decimal places than this is
// unrepresentable on the wallet side, so the two implementations would disagree
// on the last digit for values neither considers malformed. The indexer therefore
// bounds a threshold's decimal places at min(gate tick divisibility,
// THRESHOLD_SCALE) rather than at divisibility alone.
//
// Cross-repo twin: xchain-wallet packages/core THRESHOLD_SCALE. These two must
// move together or the disagreement returns.
const THRESHOLD_SCALE = 18;

// Chunked DEPLOY (DEPLOY v4 carriers + DEPLOY v2/v3 assemble).
// A contract whose base64(code) exceeds the single-tx budget is split across
// ordered DEPLOY v4 carrier actions and reassembled by a DEPLOY v2/v3 keyed on
// the CODE_HASH. Enforced by the indexer (deploy_chunk + deploy assembly) and
// the SDK (chunkHelper splitter) in lockstep.

// Maximum number of chunks one DEPLOY may assemble. base64(MAX_CODE_SIZE) is
// ~87.4 KB; at the conservative per-chunk part budget below that is ~12 chunks,
// so 16 leaves headroom while bounding assembler work + chunk-table DoS.
const MAX_DEPLOY_CHUNKS = 16;

// Maximum bytes of base64 code carried by a single DEPLOY v4 carrier's CODE_PART.
// Sized so the compiled v4 carrier action (action prefix + 64-char CODE_HASH +
// indices + the part) stays comfortably under MAX_ACTION_DATA_LENGTH including
// the OP_PUSHDATA2 prefix. The SDK splits at this size; the indexer rejects a
// larger part (belt-and-suspenders; the decoder already drops oversize pushes).
const MAX_DEPLOYCHUNK_PART_BYTES = 7800;

module.exports = {
    ATTEST_MAX_EXPIRIES_PER_BLOCK,
    THRESHOLD_SCALE,
    MAX_DEPLOY_CHUNKS,
    MAX_DEPLOYCHUNK_PART_BYTES,
};
