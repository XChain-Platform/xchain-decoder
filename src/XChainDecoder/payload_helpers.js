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

const { OP_RETURN_PUSH_OVERHEAD } = require('../protocol/constants.js')
const ACTION_ALIASES = require('../protocol/action_aliases.js')
const { lenientTextDecoder, VALID_ACTION_NAMES } = require('./constants.js')

// Whether a getblockchaininfo reply says the node is still in initial block
// download. While it is, a node tip BELOW the stored tip is not a rollback: the
// node has simply not yet validated blocks this database already holds (an
// operator's fresh mainnet node, a reindex, a node restored behind a decoder that
// followed another endpoint). Reconciling against that tip deletes valid blocks
// to the safe-depth ceiling and writes a durable halt for a reorg that never
// happened; the right move is to wait until the node passes the stored tip and
// let the forward hash compare decide. Strict === true: an absent field (an
// older node, a trimmed proxy) keeps the pre-existing behaviour.
function nodeStillCatchingUp(info){
    return !!info && info["initialblockdownload"] === true
}

// Compiled size of a single script push once bitcoin.script.compile adds its
// length prefix: a direct push opcode for <=75 bytes, OP_PUSHDATA1 (+2) for
// <=255, or OP_PUSHDATA2 (+3) beyond that. Single source for measuring both
// push[0] (data) and push[1] (rawData) in parseTransaction; this formula is
// the protocol-arbiter side of the encoder's identical compiledPushSize
// (xchain-encoder/src/common/validator.js), and the compiledPushSizeConformance test
// pins both against bitcoin.script.compile byte-for-byte across the 75/255
// prefix boundaries. Do not fork this logic inline. Only the OP_PUSHDATA2
// branch names a constant: the +1/+2 branches are different opcodes that
// OP_RETURN_PUSH_OVERHEAD does not describe.
function compiledPushSize(byteLength){
    if (byteLength <= 75)  return byteLength + 1   // direct push opcode
    if (byteLength <= 255) return byteLength + 2   // OP_PUSHDATA1
    return byteLength + OP_RETURN_PUSH_OVERHEAD    // OP_PUSHDATA2
}

// Canonicalize the ACTION name in a raw payload buffer, expanding a short-form
// alias to its canonical form. Single source for the tokenize+lookup logic
// shared by the confirmed-block and mempool decode paths: those two sites had
// drifted into structurally different implementations (string split/join vs
// byte splice) that happened to agree only because every encoder-producible
// payload is valid UTF-8. Do not fork this logic inline.
//
// Tokenizes on the FIRST 0x7C ('|') byte only, matching the on-chain wire
// format (ACTION|param|param|...). The name portion is lenient-decoded ONLY
// for the alias lookup, so invalid UTF-8 in the name cannot throw; every byte
// after the first pipe is returned verbatim. Callers that need a string decode
// the returned buffer themselves, so U+FFFD substitution for invalid UTF-8 is
// applied exactly once, at the call site.
//
// Returns { buffer, rawActionName, actionName, isKnown }:
//   buffer        - the payload with its name portion rewritten to the canonical
//                   ASCII spelling when the name was a recognized alias; the
//                   original reference, unmodified, otherwise, which includes
//                   the case where the name is not one this service knows.
//   rawActionName - the name exactly as it appeared on-chain, for logging.
//   actionName    - the same name after any alias has been expanded.
//   isKnown       - whether that expanded name is one of VALID_ACTION_NAMES.
function canonicalizeActionPayload(buffer) {
    const pipeIndex = buffer.indexOf(0x7C) // '|'
    const nameEnd = pipeIndex === -1 ? buffer.length : pipeIndex
    const rawActionName = lenientTextDecoder.decode(buffer.subarray(0, nameEnd))
    const actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
    const isKnown = VALID_ACTION_NAMES.has(actionName)
    const outBuffer = (isKnown && actionName !== rawActionName)
        ? Buffer.concat([Buffer.from(actionName, 'ascii'), buffer.subarray(nameEnd)])
        : buffer
    return { buffer: outBuffer, rawActionName, actionName, isKnown }
}

// Probe whether bitcoinjs-lib's 64-bit reader tolerates a value > 2^53-1 (the BigInt-safe
// bufferutils patch) rather than throwing 'value out of range'. The decoder relies on this
// patch to decode a Dogecoin output > 2^53-1 sat (~90.07M DOGE) without wedging block
// decode; it ships via a Dockerfile COPY over node_modules, so a stock/unpatched
// node_modules (a Dockerfile regression, or a non-Docker run) would silently reintroduce
// the wedge. Reads a synthetic 2^53 uint64 (one past the stock reader's ceiling). The
// bufferutils module is injectable for testing. Returns false on any failure (fail-safe:
// an unrecognizable module reads as "patch not confirmed").
function bigIntBufferutilsActive(bufferutils){
    try {
        let bu = bufferutils || require('bitcoinjs-lib/src/bufferutils')
        if (!bu.BufferReader) return false
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64()
        return true
    } catch(_){
        return false
    }
}
module.exports = { nodeStillCatchingUp, compiledPushSize, canonicalizeActionPayload, bigIntBufferutilsActive }
