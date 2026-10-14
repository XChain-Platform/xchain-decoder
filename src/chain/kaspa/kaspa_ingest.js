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
 * Kaspa ingest projection (pure functions — offline testable)
 *
 * Job: project one slice of Kaspa's virtual chain (added/removed chain
 * blocks plus their accepted transactions) onto the platform's decoder
 * tables. The table set is the platform's, not this family's: blocks,
 * transactions, transaction_outputs, index_transactions, index_addresses,
 * pubkeys, dispensers, events. Anything the indexer reads, this must write
 * (see KASPA-ADAPTER-V2.md §11.10 for the audit that found the two tables
 * a first cut had missed).
 *
 * Conventions taken from the platform sources, not invented here:
 *
 *   · amount / fee are non-authoritative: the decoder writes NULL / 0
 *     ("Not authoritative: the decoder hardcodes destination:null" and the
 *     same treatment for amount/fee in src/sql/transactions.sql).
 *   · transactions.destination_id is ALWAYS NULL. The per-output address
 *     lives in transaction_outputs, and the indexer fans out per output —
 *     xchain-indexer/src/db/transactions/decoder_block_data.js:96 does
 *     `row.destination = row.output_destination`. Writing a real address
 *     into transactions.destination_id would be a second, divergent source
 *     of truth for the DISPENSE path.
 *   · An action payload longer than MAX_ACTION_DATA_LENGTH is DROPPED
 *     (data NULL), never truncated: a truncated action string is a
 *     different action.
 *   · ids are registered EAGERLY, during ingest, never lazily inside rows().
 *     Lazy allocation makes the id depend on when rows() is called, which
 *     breaks deterministic replay of the same input.
 ********************************************************************/
'use strict';

const { MAX_ACTION_DATA_LENGTH } = require('./constants.js');
// Wire shaping is shared with the family decoder rather than reimplemented: it owns the
// 4.2 de-obfuscation, and requiring it here keeps ONE copy. No cycle: the decoder only
// requires ./constants.js.
const { deobfuscateCarrier } = require('./kaspa_block_decoder.js');
const { canonicalizeActionPayload } = require('../../XChainDecoder/payload_helpers.js');

// ── the small slice of action-string parsing this layer owns ────────────────
// Not a full action parser (that is the indexer's job). Two things only:
//   · DISPENSER open  -> register the address as an open dispenser, so that a
//     later data-less payment TO that address can be recognised the way the
//     platform recognises it (xchain-decoder/src/XChainDecoder/
//     carrier_extraction.js:36 `openDispenserAddresses.has(outputAddress)`).
//   · DISPENSER_CLOSE -> stamp expired_block_index on the open row.
function actionOf(data) {
    if (data === null || data === undefined || data === '') return '';
    return String(data).split('|')[0].trim().toUpperCase();
}

function detectDispenser(data) {
    const action = actionOf(data);
    if (action === 'DISPENSER') return { open: true };
    if (action === 'DISPENSER_CLOSE') return { open: false };
    return null;
}

// ── pure helpers ───────────────────────────────────────────────────────────
// Chain time normalisation. Kaspa headers carry MILLISECONDS; the platform column is
// seconds -- src/sql/blocks.sql declares block_time BIGINT UNSIGNED, and the bitcoin
// families fill it from a header timestamp, which is seconds. The indexer compares it
// against second-valued activation constants, so writing ms here made every gate read
// as long past. Measured live: simnet header.timestamp = 1791716119613.
const MS_THRESHOLD = 1e12;                       // any genuine seconds value is far below this
function chainTimeToSeconds(value) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.floor(n >= MS_THRESHOLD ? n / 1000 : n);
}
const hex = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.replace(/^0x/, '').toLowerCase();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    if (Array.isArray(value)) return Buffer.from(value).toString('hex');
    return null;
};

// The carrier for this family: the transaction payload itself (UTF-8), not an
// OP_RETURN output. Oversize payloads come back as null, meaning "drop the
// action, still write the row".
function payloadToActionString(payloadHex) {
    if (!payloadHex) return '';
    const buffer = Buffer.from(payloadHex, 'hex');
    if (buffer.length > MAX_ACTION_DATA_LENGTH) return null;
    return buffer.toString('utf8');
}

// Platform semantics: a transaction's source is the address of its first input.
function resolveSource(transaction) {
    const inputs = transaction.inputs || [];
    for (const input of inputs) {
        const verbose = input.verboseData || (input.previousOutpoint && input.previousOutpoint.verboseData) || {};
        if (verbose.scriptPublicKeyAddress) return String(verbose.scriptPublicKeyAddress);
        if (input.previousOutpointAddress) return String(input.previousOutpointAddress);
    }
    return null;
}

function outputAddress(output) {
    const verbose = output.verboseData || {};
    return verbose.scriptPublicKeyAddress ? String(verbose.scriptPublicKeyAddress) : null;
}

// ── the in-flight ledger (one entry per table, keyed by table name) ────────
class IngestState {
    constructor() {
        this.nextBlockIndex = 1;        // 0 is reserved
        this.nextTxIndex = 1;
        this.nextAddressId = 2;         // 1 is the empty placeholder row the platform DDL seeds
        this.nextHashId = 2;            // same
        this.hashes = new Map([['', 1]]);
        this.addresses = new Map([['', 1]]);
        this.blocks = [];
        this.transactions = [];
        this.transaction_outputs = [];
        this.pubkeys = [];
        this.dispensers = [];
        this.events = [];               // append-only; the service flushes by cursor
        this.openDispensers = new Map(); // address -> tx_index
    }

    // The state is a WORKING SET for a long-running reader, not an archive. Everything at or below
    // the write floor is already in the database, so keeping it here costs memory for the life of
    // the process and makes every later tick re-materialise it. Only the row arrays with a block
    // scope are cut: `hashes`/`addresses` keep their ids (rows already in the tables reference
    // them), `pubkeys` is lookup data, and `dispensers` is a long-lived projection whose close
    // still depends on rows written long ago.
    trimToFloor(floor) {
        const above = (value) => Number(value) > Number(floor);
        this.blocks = this.blocks.filter((b) => above(b.block_index));
        this.transactions = this.transactions.filter((t) => above(t.block_index));
        const keptTx = new Set(this.transactions.map((t) => t.tx_index));
        this.transaction_outputs = this.transaction_outputs.filter((o) => keptTx.has(o.tx_index));
        return this;
    }

    hashId(hash) {
        if (!hash) return 1;
        if (!this.hashes.has(hash)) this.hashes.set(hash, this.nextHashId++);
        return this.hashes.get(hash);
    }

    addressId(address) {
        if (!address) return 1;
        if (!this.addresses.has(address)) this.addresses.set(address, this.nextAddressId++);
        return this.addresses.get(address);
    }

    // Rows are named and ordered exactly like the DDL columns, so the store
    // layer can build INSERTs without a second mapping table.
    rows() {
        return {
            blocks: this.blocks.map((b) => ({
                block_index: b.block_index,
                block_time: b.block_time,
                block_hash_id: this.hashId(b.block_hash),
                previous_block_hash_id: this.hashId(b.previous_block_hash),
            })),
            transactions: this.transactions.map((t) => ({
                tx_index: t.tx_index,
                tx_hash_id: this.hashId(t.tx_hash),
                block_index: t.block_index,
                source_id: this.addressId(t.source),
                destination_id: this.addressId(t.destination),
                amount: null,            // non-authoritative, see the header
                fee: 0,                  // non-authoritative, see the header
                data: t.data,
                raw_data: t.raw_data,
            })),
            transaction_outputs: this.transaction_outputs.map((o) => ({
                tx_index: o.tx_index,
                vout: o.vout,
                destination_id: this.addressId(o.destination),
                amount: String(o.amount),
            })),
            pubkeys: this.pubkeys.map((p) => ({ address_id: this.addressId(p.address), pubkey: p.pubkey })),
            dispensers: this.dispensers.map((d) => ({
                tx_index: d.tx_index,
                address_id: this.addressId(d.address),
                expiration: d.expiration === null || d.expiration === undefined ? null : Number(d.expiration),
                oracle_address_id: d.oracle_address ? this.addressId(d.oracle_address) : null,
                source_address_id: d.source_address ? this.addressId(d.source_address) : null,
                expired_block_index: d.expired_block_index === null || d.expired_block_index === undefined
                    ? null : Number(d.expired_block_index),
            })),
            events: this.events.map((e) => ({ time: e.time, code: e.code, data: e.data })),
            index_transactions: [...this.hashes.entries()].map(([hash, id]) => ({ id, hash })),
            index_addresses: [...this.addresses.entries()].map(([address, id]) => ({ id, address })),
        };
    }
}

// ── main entry: project a virtual-chain slice onto table rows ──────────────
// chainBlocks: [{ hash, previousBlockHash, timestamp, acceptedTransactions: [tx] }]
//   · array order IS virtual-chain order (low -> high), matching
//     getVirtualChainFromBlockV2's addedChainBlockHashes.
// Same input twice must produce byte-identical output (deterministic replay).
function ingest(chainBlocks, options = {}) {
    const state = options.state || new IngestState();

    for (const block of chainBlocks) {
        const blockIndex = state.nextBlockIndex++;
        // Register ids now, not inside rows(): see the header.
        state.hashId(block.hash);
        state.hashId(block.previousBlockHash || null);
        state.blocks.push({
            block_index: blockIndex,
            block_time: chainTimeToSeconds(block.timestamp),
            block_hash: block.hash,
            previous_block_hash: block.previousBlockHash || null,
        });

        for (const transaction of (block.acceptedTransactions || [])) {
            const txHash = hex(transaction.verboseData && transaction.verboseData.transactionId)
                || hex(transaction.id) || null;
            const payloadHex = hex(transaction.payload);
            // The node delivers the 4.2-OBFUSCATED carrier, so the action string only exists after
            // de-obfuscation with the spending tx's first input txid; cleartext is still accepted
            // because our own earlier build wrote such rows. Without this step every real-wire
            // action lands as garbage — the P0 of the 2026-10-11 audit, reproduced by the
            // end-to-end pin in test/service.test.js (which feeds obfuscated bytes, not fixtures).
            const firstInput = (transaction.inputs && transaction.inputs[0]) || null;
            const firstInputTxid = firstInput && firstInput.previousOutpoint
                ? firstInput.previousOutpoint.transactionId : null;
            const deobfuscated = deobfuscateCarrier(payloadHex, firstInputTxid);
            let data = deobfuscated !== null ? deobfuscated : payloadToActionString(payloadHex);
            // 4.1: expand legacy ACTION aliases before the row is written; the indexer dispatches
            // on the canonical name, so an unexpanded alias is a dropped action.
            let actionText = null;                 // pre-gate text, for our own projections
            if (typeof data === 'string' && data !== '') {
                const canonical = canonicalizeActionPayload(Buffer.from(data, 'utf8'));
                // The storage gate governs what the `data` COLUMN holds (a recognised ACTION, as
                // on the other chains). It must not govern our own projections: DISPENSER_CLOSE is
                // handled by the platform's indexer (XChainDecoder/constants.js:109) but is not in
                // the canonical action list, so gating first silently dropped every close and left
                // dispensers open forever. Keep the pre-gate value for the bookkeeping below.
                actionText = data;
                data = canonical.isKnown ? canonical.buffer.toString('utf8') : null;
            }
            const source = resolveSource(transaction);
            const outputs = transaction.outputs || [];
            const destination = null;               // always null, see the header

            state.hashId(txHash);
            state.addressId(source);
            state.addressId(destination);
            outputs.forEach((output) => state.addressId(outputAddress(output)));

            const txIndex = state.nextTxIndex++;
            state.transactions.push({
                tx_index: txIndex,
                tx_hash: txHash,
                block_index: blockIndex,
                source,
                destination,
                data,
                raw_data: payloadHex ? Buffer.from(payloadHex, 'hex') : null,
            });

            // Dispenser bookkeeping. The exposition of state.openDispensers is not
            // consumed by the indexer (it re-derives matching from its own
            // dispensers/dispenser_statuses tables, see xchain-indexer/src/db/
            // dispensers/dispense_matching.js:32); it is kept because the platform
            // decoder keeps the same map, and a divergence between the two views is
            // exactly what the mismatch audit (KASPA-ADAPTER-V2.md §11.10) had to fix
            // after the fact.
            const dispenser = detectDispenser(actionText !== null ? actionText : data);
            if (dispenser && source) {
                if (dispenser.open) {
                    // expiration is left NULL on purpose: the wire index of the
                    // EXPIRATION field was never verified, and a guessed index would
                    // write a wrong expiry that nothing later corrects. The column is
                    // nullable; DISPENSER_CLOSE (and the expiration sweep upstream)
                    // set expired_block_index.
                    state.dispensers.push({
                        tx_index: txIndex,
                        address: source,
                        expiration: null,
                        oracle_address: null,
                        source_address: source,
                        expired_block_index: null,
                    });
                    state.openDispensers.set(source, txIndex);
                } else {
                    for (const row of state.dispensers) {
                        if (row.address === source && row.expired_block_index === null) row.expired_block_index = blockIndex;
                    }
                    state.openDispensers.delete(source);
                }
            }

            // One output row per output: the indexer fans out per row and reads the
            // destination from here (decoder_block_data.js:95-102).
            outputs.forEach((output, vout) => {
                state.transaction_outputs.push({
                    tx_index: txIndex,
                    vout,
                    destination: outputAddress(output),
                    amount: output.amount === null || output.amount === undefined ? '0' : String(output.amount),
                });
            });

            const pubkey = transaction.verboseData && transaction.verboseData.sourcePubkey;
            if (pubkey && source) state.pubkeys.push({ address: source, pubkey: String(pubkey) });
        }
    }

    return { state, rows: state.rows() };
}

// ── rollback: deleted for real, then replayed ──────────────────────────────
// The platform reorgs by deleting the reverted rows and re-appending from the
// reorged slice; this mirrors that, including the cascade to the child tables
// that have no block_index of their own.
function rollback(state, removedHashes) {
    const removed = new Set(removedHashes || []);
    if (!removed.size) return state;

    const removedBlockIndexes = new Set(
        state.blocks.filter((b) => removed.has(b.block_hash)).map((b) => b.block_index));
    if (!removedBlockIndexes.size) return state;
    const minIndex = Math.min(...removedBlockIndexes);

    state.blocks = state.blocks.filter((b) => b.block_index < minIndex);
    const removedTxIndexes = new Set(
        state.transactions.filter((t) => t.block_index >= minIndex).map((t) => t.tx_index));
    state.transactions = state.transactions.filter((t) => t.block_index < minIndex);
    state.transaction_outputs = state.transaction_outputs.filter((o) => !removedTxIndexes.has(o.tx_index));
    state.dispensers = state.dispensers.filter((d) => !removedTxIndexes.has(d.tx_index));
    state.openDispensers = new Map(
        state.dispensers.filter((d) => d.expired_block_index === null).map((d) => [d.address, d.tx_index]));

    // Cursors move back too, so the next append starts from the same place the
    // first pass would have (deterministic replay).
    state.nextBlockIndex = minIndex;
    state.nextTxIndex = state.transactions.length
        ? Math.max(...state.transactions.map((t) => t.tx_index)) + 1
        : 1;
    return state;
}

module.exports = {
    ingest,
    rollback,
    IngestState,
    payloadToActionString,
    resolveSource,
    actionOf,
    detectDispenser,
    MAX_ACTION_DATA_LENGTH,
    chainTimeToSeconds,
};
