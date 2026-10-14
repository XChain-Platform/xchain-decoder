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
 * kaspa_store: the SQL plan, asserted at the level Stryker can see.
 *
 * Why this file exists at all: the family had no store test in the tree, so a
 * Stryker run over buildWritePlan scored 8.22% (6 killed / 67 survived) — every
 * mutant that changed a table name or dropped an ON DUPLICATE KEY clause lived
 * on, because the assertions only asked "is there a statement", never "which
 * table, with which idempotence". These tests ask the second question.
 **********************************************************************/
'use strict';
const assert = require('assert');

const { buildWritePlan, buildRollbackPlan, insertSql, buildMempoolWritePlan, SCHEMA } =
    require('../../../../src/chain/kaspa/kaspa_store.js');
const { ingest } = require('../../../../src/chain/kaspa/kaspa_ingest.js');

// Self-contained fixtures: this file borrows no helper from another test file.
const SOURCE = 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7';
const DEST = 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7';
const mkTx = (id, carrier) => ({
    verboseData: { transactionId: id },
    payload: Buffer.from(carrier, 'utf8').toString('hex'),
    inputs: [{ previousOutpoint: { transactionId: 'aa'.repeat(32), index: 0 }, verboseData: { scriptPublicKeyAddress: SOURCE } }],
    outputs: [{ amount: '5', verboseData: { scriptPublicKeyAddress: DEST } }],
});
const DISPENSER_BLOCK = {
    hash: 'b1'.repeat(32), previousBlockHash: 'b0'.repeat(32), timestamp: 1791716119,
    acceptedTransactions: [mkTx('d1'.repeat(32), 'DISPENSER|0|DOGE||1000')],
};
const REORG_EVENT = { time: '2026-10-11 10:55:19', code: 'REORG', data: '[{"block_index":1}]' };

describe('kaspa_store: write plan', function () {

    const plan = buildWritePlan(ingest([DISPENSER_BLOCK]).rows,
        { sinceBlockIndex: 0, events: [REORG_EVENT] });
    const ofTable = (name) => plan.filter((s) => s.sql.startsWith('INSERT INTO `' + name + '`'));

    it('names each table exactly, and produces the rows a dispenser block needs', function () {
        for (const name of ['blocks', 'transactions', 'transaction_outputs', 'dispensers', 'events']) {
            assert.ok(ofTable(name).length >= 1, 'must emit a statement for ' + name);
        }
        assert.strictEqual(ofTable('events').length, 1, 'exactly this tick\'s event');
        assert.ok(!plan.some((s) => s.sql.includes('INTO ``')), 'no empty table name');
    });

    it('marks the lookup tables idempotent, so replaying a slice cannot fail', function () {
        for (const name of ['dispensers', 'pubkeys', 'index_transactions', 'index_addresses']) {
            for (const statement of ofTable(name)) {
                assert.ok(statement.sql.includes('ON DUPLICATE KEY UPDATE'), name + ' must upsert');
            }
        }
    });

    it('writes the events that are handed to it even when no block is new', function () {
        const onlyEvents = buildWritePlan({ blocks: [{ block_index: 1 }], transactions: [] },
            { sinceBlockIndex: 1, events: [REORG_EVENT] });
        assert.strictEqual(onlyEvents.length, 1);
        assert.ok(onlyEvents[0].sql.startsWith('INSERT INTO `events`'));
        assert.strictEqual(buildWritePlan({ blocks: [{ block_index: 1 }], transactions: [] }, { sinceBlockIndex: 1 }).length, 0);
    });

    it('insertSql refuses an unknown table and fills missing columns with NULL', function () {
        assert.throws(() => insertSql('nope', {}), /unknown table/);
        const s = insertSql('blocks', { block_index: 3 });
        assert.strictEqual(s.values.length, SCHEMA.blocks.length);
        assert.strictEqual(s.values[0], 3);
    });
});

describe('kaspa_store: rollback plan', function () {

    it('deletes children before parents and never touches the lookup or event tables', function () {
        const rp = buildRollbackPlan(7);
        assert.strictEqual(rp.length, 4);
        assert.ok(rp[0].sql.includes('transaction_outputs'));
        assert.ok(rp[1].sql.includes('dispensers'));
        assert.ok(rp[2].sql.startsWith('DELETE FROM `transactions`'));
        assert.ok(rp[3].sql.startsWith('DELETE FROM `blocks`'));
        for (const statement of rp) {
            assert.deepStrictEqual(statement.values, [7]);
            assert.ok(!/index_transactions|index_addresses|pubkeys|`events`/.test(statement.sql));
        }
    });

    it('rejects a bad floor rather than deleting everything', function () {
        assert.throws(() => buildRollbackPlan(-1), /non-negative integer/);
        assert.throws(() => buildRollbackPlan('abc'), /non-negative integer/);
    });
});

describe('kaspa_store: mempool mirror', function () {

    it('keeps sompi amounts as strings (Number() rounds past 2^53-1)', function () {
        const far = '9007199254740993';
        const p = buildMempoolWritePlan([{ tx_hash: 'aa', amount: far, fee: far }]);
        assert.strictEqual(String(p[0].values[3]), far);
        assert.strictEqual(String(p[0].values[4]), far);
    });

    it('skips entries without a hash and defaults the fee', function () {
        const p = buildMempoolWritePlan([{ tx_hash: 'aa' }, { source: 'x' }, null]);
        assert.strictEqual(p.length, 1);
        assert.strictEqual(String(p[0].values[4]), '0');
    });
});

describe('kaspa_store: evidence-driven - the survivor classes from the mutation report', function () {

    // buildWritePlan must never throw for a well-formed row set: a mutant that makes it throw is
    // exactly what turns a kill into an untracked RuntimeError.
    const withRow = (over) => Object.assign({
        blocks: [{ block_index: 2, block_time: 1791716119, block_hash_id: 1, previous_block_hash_id: 1 }],
        transactions: [{ tx_index: 5, tx_hash_id: 1, block_index: 2, source_id: 1, destination_id: 1,
            amount: '1', fee: '0', data: null, raw_data: null }],
        transaction_outputs: [{ tx_index: 5, vout: 0, destination_id: 1, amount: '1' }],
        dispensers: [], pubkeys: [], index_transactions: [], index_addresses: [],
    }, over || {});

    it('never throws, for every shape of a row set the ingest can hand it', function () {
        const shapes = [withRow(), withRow({ index_transactions: [{ id: 1, hash: 'aa' }] }),
            withRow({ index_addresses: [{ id: 1, address: 'x' }] }),
            withRow({ dispensers: [{ tx_index: 5, address_id: 1, expiration: null, oracle_address_id: null, source_address_id: 1, expired_block_index: null }] }),
            withRow({ pubkeys: [{ address_id: 1, pubkey: '02' }] })];
        for (const rows of shapes) {
            assert.doesNotThrow(() => buildWritePlan(rows, { sinceBlockIndex: 0, events: [] }),
                'a valid row set must produce a plan, not an exception');
        }
    });

    it('survives a row set with the optional arrays missing entirely (the || [] defaults)', function () {
        const bare = { blocks: withRow().blocks, transactions: withRow().transactions };
        const plan = buildWritePlan(bare, { sinceBlockIndex: 0, events: [] });
        assert.ok(plan.length >= 2, 'missing arrays mean fewer statements, not a crash');
        assert.ok(plan.every((s) => typeof s.sql === 'string' && s.sql.startsWith('INSERT INTO `')));
        const empty = buildWritePlan({}, { sinceBlockIndex: 0, events: [] });
        assert.deepStrictEqual(empty, [], 'no rows at all means no statements at all');
    });

    it('excludes work at or below the write floor, and includes what is above it', function () {
        const rows = withRow({
            blocks: [{ block_index: 7, block_time: 1, block_hash_id: 1, previous_block_hash_id: 1 }],
            transactions: [{ tx_index: 9, tx_hash_id: 1, block_index: 7, source_id: 1, destination_id: 1, amount: '1', fee: '0', data: null, raw_data: null }],
        });
        const atFloor = buildWritePlan(rows, { sinceBlockIndex: 7 });
        assert.deepStrictEqual(atFloor, [], 'a block AT the floor is already written');
        const above = buildWritePlan(rows, { sinceBlockIndex: 6 });
        assert.strictEqual(above.filter((s) => s.sql.startsWith('INSERT INTO `blocks`')).length, 1);
        assert.strictEqual(above.filter((s) => s.sql.startsWith('INSERT INTO `transactions`')).length, 1);
    });

    it('marks EVERY table idempotent, not just the lookup ones', function () {
        // The upsert flags on blocks/transactions/transaction_outputs are the fix the real-database
        // test demanded; a mutant that drops one of them must fail here, not silently replay into
        // a duplicate-key error.
        const rows = withRow({
            index_transactions: [{ id: 1, hash: 'aa' }], index_addresses: [{ id: 1, address: 'x' }],
            dispensers: [{ tx_index: 5, address_id: 1, expiration: null, oracle_address_id: null, source_address_id: 1, expired_block_index: null }],
            pubkeys: [{ address_id: 1, pubkey: '02' }],
        });
        const plan = buildWritePlan(rows, { sinceBlockIndex: 0, events: [] });
        const tables = ['blocks', 'transactions', 'transaction_outputs', 'dispensers', 'pubkeys', 'index_transactions', 'index_addresses'];
        for (const name of tables) {
            const mine = plan.filter((s) => s.sql.startsWith('INSERT INTO `' + name + '`'));
            assert.ok(mine.length >= 1, name + ' must appear in the plan');
            for (const s of mine) assert.ok(s.sql.includes('ON DUPLICATE KEY UPDATE'), name + ' must be replay-safe');
        }
        const events = buildWritePlan({}, { sinceBlockIndex: 0, events: [{ time: 't', code: 'REORG', data: '[]' }] });
        assert.strictEqual(events.length, 1, 'events are append-only and carry no upsert');
        assert.ok(!events[0].sql.includes('ON DUPLICATE KEY UPDATE'));
    });
});

describe('kaspa_store: buildWritePlan - the defaults and filters no test used to exercise', function () {
    const store = require('../../../../src/chain/kaspa/kaspa_store.js');
    const plan = (rows, opts) => store.buildWritePlan(rows, opts);
    const ids = (p) => JSON.stringify(p.values);
    // Column names come from the module's own SCHEMA (blocks: block_index/block_time/block_hash_id/
    // previous_block_hash_id; transactions: tx_index/tx_hash_id/...; events: time/code/data), so the
    // fixtures here must use those names or every value would land as null.
    const block = (i) => ({ block_index: i, block_time: 1700000000 + i, block_hash_id: 'h' + i, previous_block_hash_id: 'h' + (i - 1) });
    const txrow = (bi, ti) => ({ block_index: bi, tx_index: ti, tx_hash_id: 't' + bi + '-' + ti });

    it('emits ONLY what the rows actually contain (the || [] defaults must not invent statements)', function () {
        const p = plan({ blocks: [block(6)] }, { sinceBlockIndex: 5 });
        assert.strictEqual(p.length, 1, 'one new block, nothing else in rows: got ' + p.length + ' statements');
        assert.ok(ids(p[0]).includes('h6'), 'and it is that block');
    });

    it('filters by the cursor: a row exactly AT the cursor is excluded, one above it is not', function () {
        // The mutation this kills: Number(x) > Number(since) turning into >= would let the row at the
        // cursor through, and 'true' would let the older one through.
        const p = plan({ blocks: [block(4), block(5), block(6)] }, { sinceBlockIndex: 5 });
        assert.strictEqual(p.length, 1, 'only block 6 is newer than the cursor (block 5 is AT it): ' + p.length);
        assert.ok(ids(p[0]).includes('h6'), 'and no older block leaked in');
    });

    it('emits index rows when they are present (the && [] mutation would silently drop them)', function () {
        const rows = { blocks: [block(6)], index_transactions: [{ id: 'idx-1', hash: 'idxhash-SEND' }], index_addresses: [{ id: 'idx-2', address: 'addr-a' }], pubkeys: [{ address_id: 'addr-a', pubkey: 'pubkey-k' }] };
        const p = plan(rows, { sinceBlockIndex: 5 });
        const all = p.map(ids).join(' ');
        assert.ok(all.includes('idxhash-SEND'), 'index_transactions row must be written');
        assert.ok(all.includes('addr-a'), 'index_addresses row must be written');
        assert.ok(all.includes('pubkey-k'), 'pubkeys row must be written');
        assert.strictEqual(p.length, 4, 'block + 3 index rows, no more: ' + p.length);
    });

    it('gates transactions, outputs and dispensers on the NEW transaction set', function () {
        const rows = { blocks: [block(6)],
            transactions: [txrow(4, 1), txrow(6, 2)],          // tx 1 is old, tx 2 is new
            transaction_outputs: [{ tx_index: 1, vout: 0, destination_id: 'd-old', amount: '1' }, { tx_index: 2, vout: 0, destination_id: 'd-new', amount: '2' }],
            dispensers: [{ tx_index: 1, address_id: 'disp-old', expiration: 1 }, { tx_index: 2, address_id: 'disp-new', expiration: 2 }] };
        const p = plan(rows, { sinceBlockIndex: 5 });
        const all = p.map(ids).join(' ');
        assert.ok(all.includes('t6-2'), 'the new transaction is written');
        assert.ok(!all.includes('t4-1'), 'the old transaction is NOT written');
        assert.ok(all.includes('d-new') && !all.includes('d-old'), 'the new output is written, the old one is not');
        assert.ok(all.includes('disp-new') && !all.includes('disp-old'), 'the new dispenser registration is written, the old one is not');
    });

    it('emits events even when there is no block delta (a removal-only reorg has none)', function () {
        // The bug this pins: an earlier version returned [] before the events loop, so the reorg
        // witness was advanced over events that were never written.
        const p = plan({ blocks: [], transactions: [] }, { sinceBlockIndex: 9, events: [{ id: 7, code: 'REORG' }] });
        assert.strictEqual(p.length, 1, 'the event survives a block-less tick: ' + p.length);
        assert.ok(ids(p[0]).includes('REORG'), 'and it is the reorg witness');
    });
});

describe('kaspa_store: buildWritePlan - idempotence and the row filters', function () {
    const store = require('../../../../src/chain/kaspa/kaspa_store.js');
    const block = (i) => ({ block_index: i, block_time: 1700000000 + i, block_hash_id: 'h' + i, previous_block_hash_id: 'h' + (i - 1) });
    const txrow = (bi, ti) => ({ block_index: bi, tx_index: ti, tx_hash_id: 't' + bi + '-' + ti });
    const plan = (rows, opts) => store.buildWritePlan(rows, opts);

    it('the three data-carrying statements must be idempotent (they are the ones that stopped the reader)', function () {
        // Real-database finding: without ON DUPLICATE KEY UPDATE, replaying a slice that is already
        // in the table died on a duplicate primary key, and that error is not in the recoverable
        // class - so the reader stopped. These three carry the block's and the transaction's own
        // data, so each of them must upsert.
        const p = plan({ blocks: [block(6)], transactions: [txrow(6, 2)],
            transaction_outputs: [{ tx_index: 2, vout: 0, destination_id: 'd', amount: '2' }] }, { sinceBlockIndex: 5 });
        assert.strictEqual(p.length, 3, 'block + transaction + output: ' + p.length);
        const upserts = p.filter((x) => /ON DUPLICATE KEY UPDATE/.test(x.sql));
        assert.strictEqual(upserts.length, 3, 'all three must carry the upsert arm, not just some: ' + upserts.length);
        assert.ok(p.every((x) => /^INSERT INTO/.test(x.sql)), 'and they are inserts, not deletes');
    });

    it('a transaction whose row appears once cannot be written twice (the Set, not an array)', function () {
        // newTx is a Set built from the new transactions. If it became an array or the map() lost its
        // filter, a repeated tx_index would produce a repeated statement - a duplicate insert.
        // newTx is a Set built from the new transactions: it decides WHICH rows are written, it does
        // not deduplicate the input. Ingest emits one row per transaction, so a repeated tx_index in
        // rows is unreachable in practice - recorded here so the Set mutating to an array (or losing
        // its filter) is still detectable: the old-block gate must keep holding.
        const p = plan({ blocks: [block(6)], transactions: [txrow(4, 1), txrow(6, 2)] }, { sinceBlockIndex: 5 });
        const all = JSON.stringify(p.map((x) => x.values));
        assert.ok(!all.includes('t4-1'), 'the old transaction is gated out even when it is in rows');
        assert.ok(all.includes('t6-2'), 'and the new one is written');
        assert.strictEqual(p.length, 2, 'one block and one transaction: ' + p.length);
    });

    it('rows at or below the cursor are dropped from every filtered table', function () {
        // The excluded row gets a marker that cannot appear anywhere else: previous_block_hash_id of
        // the NEXT block is 'h5', so grepping for that string would have matched a legitimate value.
        const marker = (i) => ({ block_index: i, block_time: 1700000000 + i, block_hash_id: 'MARK-' + i, previous_block_hash_id: 'PREV-' + i });
        const p = plan({ blocks: [marker(5), marker(6)], transactions: [txrow(5, 1), txrow(6, 2)],
            transaction_outputs: [{ tx_index: 1, vout: 0, destination_id: 'out-old' }, { tx_index: 2, vout: 0, destination_id: 'out-new' }],
            dispensers: [{ tx_index: 1, address_id: 'disp-old' }, { tx_index: 2, address_id: 'disp-new' }] },
            { sinceBlockIndex: 5 });
        const all = JSON.stringify(p.map((x) => x.values));
        assert.ok(!all.includes('MARK-5') && !all.includes('PREV-5'), 'the block AT the cursor is not written');
        assert.ok(!all.includes('t5-1'), 'the transaction at the cursor is not written');
        assert.ok(!all.includes('out-old') && !all.includes('disp-old'), 'neither is its output or dispenser');
        assert.ok(all.includes('MARK-6') && all.includes('t6-2') && all.includes('out-new') && all.includes('disp-new'), 'the newer ones are');
    });
});

describe('kaspa_store: the contracts outside the write plan', function () {
    const store = require('../../../../src/chain/kaspa/kaspa_store.js');

    it('SCHEMA pins the exact column list every INSERT is built from (silent column drift is the failure this denies)', function () {
        // These lists are the decoder-to-indexer contract: a renamed or reordered column is not a style
        // question, it is a row that lands in the wrong place. Pinned verbatim on purpose.
        assert.deepStrictEqual(store.SCHEMA, {
            index_transactions: ['id', 'hash'],
            index_addresses: ['id', 'address'],
            blocks: ['block_index', 'block_time', 'block_hash_id', 'previous_block_hash_id'],
            transactions: ['tx_index', 'tx_hash_id', 'block_index', 'source_id', 'destination_id', 'amount', 'fee', 'data', 'raw_data'],
            transaction_outputs: ['tx_index', 'vout', 'destination_id', 'amount'],
            pubkeys: ['address_id', 'pubkey'],
            dispensers: ['tx_index', 'address_id', 'expiration', 'oracle_address_id', 'source_address_id', 'expired_block_index'],
            events: ['time', 'code', 'data'],
            mempool_transactions: ['tx_hash', 'source', 'destination', 'amount', 'fee', 'data', 'raw_data'],
        });
    });

    it('insertSql: unknown table refuses, missing column becomes NULL, values follow column order', function () {
        assert.throws(() => store.insertSql('no_such_table', {}), /unknown table/, 'an unknown table must refuse, not build');
        const { sql, values } = store.insertSql('blocks', { block_index: 7 });
        assert.ok(/^INSERT INTO `blocks` \(/.test(sql), 'table is quoted: ' + sql.slice(0, 40));
        assert.ok(/\(\?, \?, \?, \?\) VALUES/.test(sql) || /\) VALUES \(\?/.test(sql), 'one placeholder per column');
        assert.strictEqual(values.length, 4, 'one value per column');
        assert.strictEqual(values[0], 7, 'first value is the block_index we passed');
        assert.strictEqual(values[1], null, 'a column that was not supplied is NULL, never undefined');
    });

    it('the upsert arm exists when asked for, and never overwrites the id', function () {
        const plain = store.insertSql('index_addresses', { id: 1, address: 'a' });
        assert.ok(!/ON DUPLICATE/.test(plain.sql), 'no upsert arm unless it is asked for');
        const up = store.insertSql('index_addresses', { id: 1, address: 'a' }, { upsert: true });
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(up.sql), 'the upsert arm is present when asked for');
        const arm = up.sql.slice(up.sql.indexOf('ON DUPLICATE KEY UPDATE'));
        assert.ok(/`address` = VALUES\(`address`\)/.test(arm), 'the arm updates the other columns');
        assert.ok(!/`id` = VALUES/.test(arm), 'and never the id - that is what makes a replay idempotent');
    });

    it('withTransaction: passes through without transaction support, commits on success, rolls back and rethrows on failure', async function () {
        const passthrough = { calls: [] };
        const r1 = await store.withTransaction(passthrough, async () => 'x');
        assert.strictEqual(r1, 'x', 'a connection without begin/commit still runs the work');

        const ok = { calls: [], async beginTransaction() { this.calls.push('begin'); }, async commit() { this.calls.push('commit'); }, async rollback() { this.calls.push('rollback'); } };
        assert.strictEqual(await store.withTransaction(ok, async () => 5), 5);
        assert.deepStrictEqual(ok.calls, ['begin', 'commit'], 'committed exactly once, no rollback');

        const bad = { calls: [], async beginTransaction() { this.calls.push('begin'); }, async commit() { this.calls.push('commit'); }, async rollback() { this.calls.push('rollback'); } };
        const boom = new Error('write failed');
        await assert.rejects(() => store.withTransaction(bad, async () => { throw boom; }), /write failed/, 'the original failure is rethrown');
        assert.deepStrictEqual(bad.calls, ['begin', 'rollback'], 'rolled back exactly once, no commit');

        const worse = { calls: [], async beginTransaction() {}, async commit() {}, async rollback() { throw new Error('rollback also failed'); } };
        await assert.rejects(() => store.withTransaction(worse, async () => { throw boom; }), (error) => {
            assert.strictEqual(error, boom, 'the ORIGINAL error is what surfaces');
            assert.ok(/rollback also failed/.test(String(error.rollbackError)), 'and the rollback failure rides along');
            return true;
        });
    });

    it('toIdempotent: DROP is dropped, CREATE becomes IF NOT EXISTS, anything else is untouched', function () {
        assert.strictEqual(store.toIdempotent('DROP TABLE IF EXISTS `blocks`;'), null, 'a DROP would empty the database on every start');
        assert.strictEqual(store.toIdempotent('CREATE TABLE `blocks` ('), 'CREATE TABLE IF NOT EXISTS `blocks` (', 'CREATE is made repeatable');
        assert.strictEqual(store.toIdempotent('INSERT INTO `events` VALUES (1)'), 'INSERT INTO `events` VALUES (1)', 'other statements pass through');
    });

    it('buildMempoolWritePlan: an entry without a hash is skipped, and defaults are NULL not undefined', function () {
        const p = store.buildMempoolWritePlan([
            { tx_hash: 'h1', source: 's', destination: 'd', amount: '1', fee: '0', data: 'x', raw_data: 'r' },
            { source: 'no-hash-at-all' },
            null,
        ]);
        assert.strictEqual(p.length, 1, 'only the entry with a hash becomes a statement: ' + p.length);
        assert.ok(JSON.stringify(p[0].values).includes('h1'), 'and it is that entry');
        const p2 = store.buildMempoolWritePlan([{ tx_hash: 'h2' }]);
        assert.strictEqual(p2.length, 1);
        assert.ok(!JSON.stringify(p2[0].values).includes('undefined'), 'absent fields are NULL, never undefined');
    });

    it('buildRollbackPlan: refuses a nonsense cursor, and deletes children before parents', function () {
        assert.throws(() => store.buildRollbackPlan(-1), /non-negative/, 'a negative cursor is refused');
        assert.throws(() => store.buildRollbackPlan('not a number'), /non-negative/, 'so is a non-number');
        const plan = store.buildRollbackPlan(42);
        assert.ok(plan.length >= 3, 'several statements, children first: ' + plan.length);
        plan.forEach((s) => assert.ok(Array.isArray(s.values) && s.values[0] === 42, 'every statement carries the cursor'));
        const sql = plan.map((s) => s.sql).join('\n');
        assert.ok(sql.indexOf('transaction_outputs') < sql.indexOf('`transactions`'), 'outputs are deleted before their parent transactions');
    });
});
