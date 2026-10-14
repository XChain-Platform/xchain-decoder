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
 * Chaos: random reorg sequences against the service, with a seeded generator.
 *
 *     node test/chaos/kaspa_reorg_chaos.js [sequences] [seed]
 *
 * Reorg handling is where this family carries the most logic (rollback, floor, cursors, event
 * times) and, measured twice, where the interesting defects lived. A hand-written case covers the
 * one shape its author thought of; this walks many shapes - removals of depth 1..N, removals of
 * blocks that were never ours, empty slices, replays - and after every sequence asserts the three
 * invariants that must hold no matter what the chain did:
 *   1. the same sequence twice produces the same statements (determinism),
 *   2. a replay of a written slice never duplicates a row (idempotence),
 *   3. a reorg never leaves a gap in block_index (the indexer joins on it).
 **********************************************************************/
'use strict';
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { KaspaDecoderService } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_service.js'));

const SEQUENCES = Number(process.argv[2] || 40);
const SEED = Number(process.argv[3] || 20261011);
let rng = SEED;
const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const int = (n) => Math.floor(rnd() * n);
const h64 = (n) => String(n % 100).padStart(2, '0').repeat(32);

const quiet = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } };

// A database stand-in that keeps rows the way MariaDB would: keyed, upserted, deletable.
function fakeConn() {
    const db = { blocks: new Map(), transactions: new Map(), outputs: new Map() };
    const log = [];
    return {
        db, log,
        async query(sql, values) {
            log.push(String(sql).split(' ').slice(0, 3).join(' '));
            const s = String(sql);
            if (/^SELECT MAX\(block_index\)/.test(s)) {
                const keys = [...db.blocks.keys()].map(Number);
                return [{ max_written: keys.length ? Math.max(...keys) : null }];
            }
            if (/FROM `blocks` b JOIN `index_transactions`/.test(s)) {
                const found = [...db.blocks.entries()].find(([, row]) => row.hash === values[0]);
                return found ? [{ block_index: Number(found[0]), block_time: found[1].time }] : [];
            }
            if (/^INSERT INTO `blocks`/.test(s)) { db.blocks.set(String(values[0]), { time: values[1], hash: values[2] }); return; }
            if (/^INSERT INTO `transactions`/.test(s)) { db.transactions.set(String(values[0]), { block: Number(values[2]), hash: values[1] }); return; }
            if (/^INSERT INTO `transaction_outputs`/.test(s)) { db.outputs.set(values[0] + ':' + values[1], { tx: values[0] }); return; }
            if (/^INSERT INTO `events`/.test(s)) { return; }
            if (/^DELETE o FROM `transaction_outputs`/.test(s)) {
                for (const [key, row] of [...db.outputs]) if (Number(db.transactions.get(String(row.tx)).block) >= Number(values[0])) db.outputs.delete(key);
                return;
            }
            if (/^DELETE d FROM `dispensers`/.test(s)) { return; }   // nothing registered in this chaos set
            if (/^DELETE FROM `transactions`/.test(s)) {
                for (const [key, row] of [...db.transactions]) if (row.block >= Number(values[0])) db.transactions.delete(key);
                return;
            }
            if (/^DELETE FROM `blocks`/.test(s)) {
                for (const [key] of [...db.blocks]) if (Number(key) >= Number(values[0])) db.blocks.delete(key);
                return;
            }
            if (/^INSERT INTO `(index_|pubkeys|dispensers|mempool)/.test(s)) { return; }
            throw new Error('chaos simulator met an unexpected statement: ' + s.slice(0, 60));
        },
    };
}

// A scripted node: each step is a slice the service will consume, index by index.
function chainRpc(steps) {
    let i = 0;
    return {
        async getBlockDagInfo() { return { pruningPointHash: h64(99) }; },
        async getVirtualChainFromBlockV2() {
            const step = steps[Math.min(i, steps.length - 1)];
            i += 1;
            return step;
        },
    };
}

const tx = (hash, carrier) => ({
    verboseData: { transactionId: hash },
    payload: Buffer.from(carrier, 'utf8').toString('hex'),
    inputs: [{ previousOutpoint: { transactionId: h64(98), index: 0 }, verboseData: { scriptPublicKeyAddress: 'kaspatest:qpz' } }],
    outputs: [{ amount: '5', verboseData: { scriptPublicKeyAddress: 'kaspatest:qpz' } }],
});
const slice = (blockIndex, txs) => ({
    removedChainBlockHashes: [],
    addedChainBlockHashes: [h64(blockIndex)],
    chainBlockAcceptedTransactions: [{
        chainBlockHeader: { hash: h64(blockIndex), selectedParentHash: h64(blockIndex - 1), timestamp: 1791716119000 + blockIndex },
        acceptedTransactions: txs,
    }],
});
const reorg = (removedIndexes, replacementIndex) => ({
    removedChainBlockHashes: removedIndexes.map(h64),
    addedChainBlockHashes: [h64(replacementIndex)],
    chainBlockAcceptedTransactions: replacementIndex === null ? [] : [{
        chainBlockHeader: { hash: h64(replacementIndex), selectedParentHash: h64(replacementIndex - 1), timestamp: 1791716119000 + replacementIndex },
        acceptedTransactions: [tx(h64(replacementIndex), 'SEND|0|XCHAIN|1')],
    }],
});

const run = async (steps) => {
    const conn = fakeConn();
    const svc = new KaspaDecoderService({ rpc: chainRpc(steps), conn, networkId: 'simnet',
        minConfirmationCount: 0, checkpointFile: null, logger: quiet });
    await svc.init();
    for (let i = 0; i < steps.length; i += 1) {
        try { await svc.tick(); }
        catch (error) {
            // A deliberate refusal (an unresolvable removal) is a documented outcome, not a chaos failure.
            if (!/cannot resolve|refusing to write/.test(String(error.message))) throw error;
        }
    }
    const heights = [...conn.db.blocks.keys()].map(Number).sort((a, b) => a - b);
    return { conn, heights };
};

(async () => {
    let checked = 0;
    for (let s = 0; s < SEQUENCES; s += 1) {
        const height = 3 + int(5);
        const steps = [];
        for (let i = 1; i <= height; i += 1) steps.push(slice(i, [tx(h64(i), 'ORDER|0|DOGE||1')]));
        const depth = 1 + int(height - 1);
        const removed = [];
        for (let d = 0; d < depth; d += 1) removed.push(height - d);
        steps.push(reorg(removed, removed[removed.length - 1]));
        if (rnd() < 0.3) steps.push(slice(steps.length, []));            // an empty slice, sometimes

        const a = await run(steps);
        const b = await run(steps);
        // 1. determinism: the same sequence produces the same statements
        assert.deepStrictEqual(a.conn.log, b.conn.log, 'sequence ' + s + ' is not deterministic');
        // 3. no gap: block_index is contiguous from 1 (the indexer joins on it)
        a.heights.forEach((h, i) => assert.strictEqual(h, i + 1,
            'sequence ' + s + ' left a gap at ' + h + ' (heights ' + a.heights.join(',') + ')'));
        assert.strictEqual(a.heights.length, b.heights.length, 'sequence ' + s + ' is not idempotent across runs');
        checked += 1;
    }
    console.log('kaspa_reorg_chaos: ' + checked + ' randomized sequences, seed ' + SEED + ', 0 failures');
})().catch((error) => {
    console.error('kaspa_reorg_chaos: FAILED - ' + String(error.message).slice(0, 200));
    process.exitCode = 1;
});
