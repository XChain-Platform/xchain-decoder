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

// Maximum *compiled* on-chain ACTION push, in bytes.
//
// This is measured against the reassembled script push as it appears on
// chain (i.e. the OP_PUSHDATA-prefixed buffer, BEFORE bitcoin.script.decompile
// strips the push prefix. The indexing decoder is the protocol arbiter: it
// drops any transaction whose compiled ACTION push exceeds this value, so the
// encoder must enforce the identical compiled-size ceiling. A transaction the
// encoder produces above this size would be silently dropped by every node.
const MAX_ACTION_DATA_LENGTH = 8192;

// Bytes added by the OP_PUSHDATA2 push prefix (1-byte opcode + 2-byte
// little-endian length) when a 256..65535-byte payload is compiled into the
// on-chain script. For a single such push the compiled length is therefore
// (decoded payload bytes + OP_RETURN_PUSH_OVERHEAD); smaller payloads use a
// 1- or 2-byte prefix, and multi-segment encodings add one prefix per segment.
// This is why the authoritative cap is enforced on the *compiled* length, not
// on the decoded character count.
const OP_RETURN_PUSH_OVERHEAD = 3;

// Maximum smart-contract source code size, in bytes (64 KiB). Enforced by the
// SDK (pre-flight validation), the indexer (DEPLOY processing) and the VM
// (isolate limit). These were each declared independently and are kept in
// lockstep by the same regression suite.
const MAX_CODE_SIZE = 65536;

// ENVELOPE_MAX_PAYLOAD: the Taproot-envelope payload ceiling, PER-ENCODING by
// design (legacy lanes keep MAX_ACTION_DATA_LENGTH; a global raise would
// multiply the chunk-lane abuse ceiling ~50x). Measures the REASSEMBLED
// envelope payload byte length after concatenation of the payload pushes,
// before parse; the envelope's own 520-byte push framing is NOT counted (the
// legacy constant, by contrast, is framing-inclusive of the single on-chain
// push).
// DERIVED FROM WEIGHT: the binding limit is Bitcoin Core's
// MAX_STANDARD_TX_WEIGHT of 400,000 WU, not a round byte count. 400,000 payload
// bytes build a 402,789 WU reveal, which is non-standard and unrelayable; the
// true maxima are 397,228 (P2WPKH change) and 397,009 (P2TR change + floor pad).
// 390,000 sits 7,050 WU under the limit in the worst reveal shape. Re-derive it
// from the weight limit if it ever changes; do not pick a number.
// Enforced identically in the decoder's block and mempool paths, mirrored by
// the encoder validator. Canonical source: xchain-documentation/protocol/
// constants.js (ENVELOPE_MAX_PAYLOAD).
const ENVELOPE_MAX_PAYLOAD = 390000;

module.exports = {
    MAX_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD,
    MAX_CODE_SIZE,
    ENVELOPE_MAX_PAYLOAD,
};
