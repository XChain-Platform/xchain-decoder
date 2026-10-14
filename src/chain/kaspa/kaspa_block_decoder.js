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
 ********************************************************************/

/*********************************************************************
 * KaspaBlockDecoder — the Kaspa-family counterpart of XChainBlockDecoder.
 *
 * Why this file exists: XChainBlockDecoder is a bitcoinjs adapter. Pointing
 * bitcoin.Block.fromBuffer() at Kaspa bytes cannot be made to work (blake3
 * txids, borsh framing), and silently mis-parsing them produces rows that
 * look valid — the failure mode the header of XChainBlockDecoder.js warns
 * about. So the family gets its own adapter that presents the SAME surface
 * to the ingest path, and XChainBlockDecoder delegates to it.
 *
 * Interface parity (pinned by test/unit/chain/kaspa/kaspa_block_decoder.test.js,
 * which walks every field the ingest path actually reads — measured by grepping
 * block./transaction./output. accesses in XChainDecoder/*.js):
 *
 *   block  : { timestamp, prevHash, transactions }
 *   tx     : { ins, outs, getId(), version }
 *   input  : { hash, index, script, sequence }
 *   output : { script, value }
 *
 * The divergence, stated plainly rather than papered over: kaspad has no
 * `getblock <hash> 0` raw-hex RPC. It answers over wRPC with structured
 * blocks, so the node connector calls blockFromObject()/transactionFromObject().
 * blockFromHex()/transactionFromHex() exist for surface parity and throw with
 * the reason, instead of guessing at an encoding nobody agreed on.
 ********************************************************************/
'use strict';

const { MAX_ACTION_DATA_LENGTH } = require('./constants.js');
// Resolved at module scope rather than inline where it is used (CODE-STYLE: require inside a body
// only for a computed path). Required lazily is not needed here: the path is fixed.
const { canonicalizeActionPayload } = require('../../XChainDecoder/payload_helpers.js');

// kaspad reports amounts as decimal strings ("5000000000"). Keep them as BigInt
// internally: the platform's outputs table stores VARCHAR(250), and rounding a
// coin amount through Number() is the kind of silent loss this decoder exists to
// avoid. The shaped output exposes BigInt, and the store layer stringifies it.
function toBigIntAmount(value) {
    if (value === null || value === undefined) return 0n;
    if (typeof value === 'bigint') return value;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) throw new Error('Kaspa amount is not a non-negative integer: "' + text + '"');
    return BigInt(text);
}

// Output script: the ingest path reads output.script as a Buffer (it hands it to
// the address/role resolution). Kaspa exposes a script version plus a hex script
// body; the version is folded into the first byte so two outputs that differ only
// in version cannot collide when compared byte-for-byte.
function scriptBufferOf(output) {
    const spk = output && output.scriptPublicKey;
    if (!spk) return Buffer.alloc(0);
    const hex = typeof spk === 'string' ? spk : (spk.scriptPublicKey || '');
    const version = typeof spk === 'object' && spk.version !== undefined ? Number(spk.version) : 0;
    const body = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
    return Buffer.concat([Buffer.from([version]), body]);
}

function addressOf(output) {
    const verbose = output && output.verboseData;
    if (!verbose) return null;
    return verbose.scriptPublicKeyAddress || null;
}

// Payload: the carrier for this family. kaspad returns it as hex.
//
// A malformed hex field must never become a SHORTER action string. Buffer.from(hex)
// stops silently at the first invalid pair (measured: '4f524445520179' -> 7 bytes,
// 'zz' -> empty), and a truncated action is a *different* action — an amount can lose
// digits and still look like a valid ORDER. Invalid hex therefore blanks the carrier
// and is reported through payloadMalformed, exactly like an oversize payload.
const HEX_PAIRS = /^([0-9a-fA-F]{2})*$/;

const crypto = require('crypto');

// 4.1 canonicalisation. The protocol expands a handful of legacy ACTION aliases at DECODE
// time (TRANSFER->SEND, ADDR->ADDRESS, DROP->AIRDROP, CAST->BROADCAST, MSG->MESSAGE), and
// the indexer dispatches on the canonical name -- so a family that skips this step silently
// drops any alias-form action. The helper is reused rather than reimplemented: its own
// module header says the alias table exists precisely so two decode-time readers can share
// it (protocol/action_aliases.js).

// -- 4.2 de-obfuscation -------------------------------------------------------
// The protocol prepends the 4-byte magic XCHN and AES-128-CTR-encrypts the ACTION with a
// key derived from the spending transaction's first input txid (reversed LE->BE; leading 16
// bytes = key, next 16 = IV). The platform keeps one copy on the encoder side
// (XChainEncoder/payload_preparation.js) and one on the decoder side
// (XChainDecoder/source_resolution.js); this family follows that split instead of reaching
// across services for a private helper.
const MAGIC_PREFIX = Buffer.from('XCHN', 'utf8');

function deobfuscateCarrier(payloadHex, txidHex) {
    const hex = String(payloadHex || '').replace(/^0x/, '');
    if (!hex || !/^([0-9a-fA-F]{2})*$/.test(hex)) return null;
    const txidBytes = Buffer.from(String(txidHex || '').replace(/^0x/, ''), 'hex');
    if (txidBytes.length !== 32) return null;
    try {
        const be = Buffer.from(txidBytes).reverse();
        const decipher = crypto.createDecipheriv('aes-128-ctr', be.slice(0, 16), be.slice(16, 32));
        const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]);
        if (!plain.slice(0, 4).equals(MAGIC_PREFIX)) return null;    // not an XChain payload
        return plain.slice(4).toString('utf8');
    } catch (error) {
        return null;
    }
}

function firstInputTxidOf(raw) {
    const input = (raw && raw.inputs && raw.inputs[0]) || null;
    return input && input.previousOutpoint ? input.previousOutpoint.transactionId : null;
}
function payloadTextOf(tx) {
    if (!tx || tx.payload === undefined || tx.payload === null) return { text: '', malformed: false };
    const hex = String(tx.payload).replace(/^0x/, '');
    if (hex === '') return { text: '', malformed: false };
    if (!HEX_PAIRS.test(hex)) return { text: '', malformed: true };
    return { text: Buffer.from(hex, 'hex').toString('utf8'), malformed: false };
}

function shapedOutput(output) {
    return {
        script: scriptBufferOf(output),
        value: toBigIntAmount(output && output.amount),
        // Family extras, ignored by the bitcoinjs-shaped consumers but used by the
        // Kaspa store layer: the address and version kaspad already resolved.
        address: addressOf(output),
        scriptVersion: output && output.scriptPublicKey ? Number(output.scriptPublicKey.version || 0) : 0,
    };
}

function shapedInput(input) {
    const outpoint = (input && input.previousOutpoint) || {};
    return {
        hash: String(outpoint.transactionId || ''),
        index: Number(outpoint.index || 0),
        script: Buffer.alloc(0),                     // Kaspa inputs carry no script
        sequence: undefined,
        address: (input && input.verboseData && input.verboseData.scriptPublicKeyAddress) || null,
    };
}

class KaspaTransaction {
    constructor(raw) {
        if (!raw || (raw.hash === undefined && raw.verboseData === undefined)) {
            throw new Error('KaspaTransaction needs a block transaction with a verboseData.transactionId');
        }
        this.raw = raw;
        this.internalId = String((raw.verboseData && raw.verboseData.transactionId) || raw.hash || '');
        if (!this.internalId) throw new Error('KaspaTransaction: no transaction id on the wire object');
        this.version = Number(raw.version || 0);
        this.ins = (raw.inputs || []).map(shapedInput);
        this.outs = (raw.outputs || []).map(shapedOutput);

        // The carrier. Oversize payloads are blanked here, matching the protocol
        // ceiling: the row is still written (the ingest path records money-bearing
        // transactions even when the action itself is unusable).
        // 4.2 first: an obfuscated carrier is the protocol shape. A payload without the magic
        // was not written by an obfuscating writer; we still accept it (marked, countable)
        // because our own earlier build wrote such rows. Strict mode is a one-line switch.
        const deob = deobfuscateCarrier(raw && raw.payload, firstInputTxidOf(raw));
        this.payloadUnobfuscated = deob === null;
        const carrier = deob !== null ? { text: deob, malformed: false } : payloadTextOf(raw);
        // Canonicalise BEFORE the row is written: the stored data must be the name the
        // indexer dispatches on. isKnown=false is left untouched, matching the platform.
        const canonical = carrier.text === '' ? null
            : canonicalizeActionPayload(Buffer.from(carrier.text, 'utf8'));
        this.payloadMalformed = carrier.malformed;                       // invalid hex -> carrier blanked, never truncated
        this.payloadOversize = carrier.text.length > MAX_ACTION_DATA_LENGTH;
        this.payload = (this.payloadMalformed || this.payloadOversize) ? '' : carrier.text;
        if (canonical && !this.payloadMalformed && !this.payloadOversize) {
            this.payload = canonical.buffer.toString('utf8');
            this.actionName = canonical.actionName;      // observability: canonical name
            this.rawActionName = canonical.rawActionName;
            this.actionAliasExpanded = canonical.actionName !== canonical.rawActionName;
        }
        this.coinbase = (raw.inputs || []).length === 1 && !this.ins[0].hash;
    }

    getId() { return this.internalId; }
    get id() { return this.internalId; }
    getHash() { return this.internalId; }

    // bitcoinjs parity: consumers read .outs and .ins, and occasionally .toHex().
    toHex() { throw new Error('KaspaTransaction.toHex: this family has no byte-identical round-trip; use .raw (wRPC object)'); }
}

class KaspaBlock {
    constructor(raw, decoder) {
        if (!raw || !raw.header) throw new Error('KaspaBlock needs a block object with a header');
        this.raw = raw;
        this.header = raw.header;
        this.timestamp = Number(raw.header.timestamp || 0);
        this.prevHash = raw.header.selectedParentHash ? String(raw.header.selectedParentHash) : null;
        // Kaspa has no separate "block id" distinct from the header hash; the wRPC
        // block object carries it under verboseData.hash or the caller supplies it.
        this.internalId = String((raw.verboseData && raw.verboseData.hash) || raw.hash || '');
        this.hash = this.internalId;
        this.transactions = (raw.transactions || []).map((t) => new KaspaTransaction(t));
        if (decoder) this.decoder = decoder;
    }

    getId() { return this.internalId; }
}

class KaspaBlockDecoder {
    constructor(networkName) {
        this.networkName = networkName;
        this.coin = 'kaspa';                 // XChainDecoder/startup.js reads .coin
        this.wireFormat = 'kaspa';           // XChainDecoder.js:208 reads .wireFormat
    }

    // ── the family entry points (used by the Kaspa node connector) ──────────
    blockFromObject(raw) { return new KaspaBlock(raw, this); }
    transactionFromObject(raw) { return new KaspaTransaction(raw); }

    // ── surface parity with XChainBlockDecoder ─────────────────────────────
    // These exist so a caller written against the bitcoinjs adapter fails with a
    // reason instead of an undefined is not a function, and so the divergence is
    // documented in one place.
    blockFromHex() {
        throw new Error('KaspaBlockDecoder.blockFromHex: kaspad exposes no raw-hex block RPC. ' +
            'The Kaspa node connector returns structured wRPC blocks — use blockFromObject().');
    }

    transactionFromHex() {
        throw new Error('KaspaBlockDecoder.transactionFromHex: kaspad exposes no raw-hex transaction RPC. ' +
            'The Kaspa node connector returns structured wRPC transactions — use transactionFromObject().');
    }

    blockFromBuffer() {
        throw new Error('KaspaBlockDecoder.blockFromBuffer: borsh framing is not announced by this family. ' +
            'Use blockFromObject().');
    }
}

module.exports = { KaspaBlockDecoder, KaspaBlock, KaspaTransaction, toBigIntAmount, deobfuscateCarrier, MAGIC_PREFIX };
module.exports.KaspaBlockDecoder = KaspaBlockDecoder;
