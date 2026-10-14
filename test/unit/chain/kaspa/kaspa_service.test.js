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
 * kaspa_service: the part that must not be wrong.
 *
 * This was the only production file in the family with no test in the tree, and
 * the largest: transactions, backoff, the checkpoint, the mempool gate. A
 * Stryker run over the rest of the family started at 8.22% and 15.69% before its
 * tests moved in-repo, so the reasoning below is the same one: the assertions
 * have to be where the mutation runner can execute them.
 **********************************************************************/
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KaspaDecoderService, classifyError } = require('../../../../src/chain/kaspa/kaspa_service.js');

const quiet = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } };
const H = (c) => c.repeat(32);   // 2 chars x 32 = a 64-hex block hash, the real shape

// A recording connection: the service only ever talks to the DB through
// query/beginTransaction/commit/rollback, so that is all this needs to fake.
function fakeConn({ failOnInsert = 0, failWith = null } = {}) {
    const log = { queries: [], begins: 0, commits: 0, rollbacks: 0, inserts: 0, failOnInsert, failWith };
    return Object.assign(log, {
        async query(sql) {
            log.queries.push(String(sql));
            // Fail on the Nth WRITE, not the Nth query: an absolute index breaks whenever a
            // read is added anywhere earlier in the tick (it did, twice).
            if (/^(INSERT|DELETE)/i.test(String(sql))) {
                log.inserts++;
                if (failOnInsert > 0 && log.inserts === failOnInsert) throw new Error(failWith || 'E');
            }
            if (/SELECT MAX\(block_index\)/i.test(String(sql))) return [{ maxIndex: null }];
            if (/FROM `kaspa_decoder_state`/i.test(String(sql))) return [];
            return [];
        },
        async beginTransaction() { log.begins++; },
        async commit() { log.commits++; },
        async rollback() { log.rollbacks++; },
    });
}

// A two-block slice with one real ACTION, in the shape the node delivers.
function fakeRpc() {
    const tx = (id, carrier) => ({
        verboseData: { transactionId: id }, payload: Buffer.from(carrier, 'utf8').toString('hex'),
        inputs: [{ previousOutpoint: { transactionId: 'aa'.repeat(32), index: 0 }, verboseData: { scriptPublicKeyAddress: 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7' } }],
        outputs: [{ amount: '5', verboseData: { scriptPublicKeyAddress: 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7' } }],
    });
    const blocks = [
        { chainBlockHeader: { hash: H('b1'), selectedParentHash: H('b0'), timestamp: 1791716119000 }, acceptedTransactions: [tx(H('t1'), 'ORDER|0|DOGE||1')] },
        { chainBlockHeader: { hash: H('b2'), selectedParentHash: H('b1'), timestamp: 1791716120000 }, acceptedTransactions: [tx(H('t2'), 'SEND|0|DOGE||2')] },
    ];
    return {
        async connect() {}, async disconnect() {},
        async getBlockDagInfo() { return { pruningPointHash: H('b0') }; },
        async getVirtualChainFromBlockV2() { return { chainBlockAcceptedTransactions: blocks, removedChainBlockHashes: [] }; },
        async getBlockCount() { return { blockCount: '2', headerCount: '2' }; },
        async getMempoolEntries() { return []; },
    };
}

const service = (over = {}) => new KaspaDecoderService(Object.assign({
    rpc: fakeRpc(), conn: fakeConn(), networkId: 'simnet', minConfirmationCount: 0,
    checkpointFile: null, logger: quiet,
}, over));

describe('kaspa_service: error classification', function () {

    it('splits transport/database trouble from data trouble, deliberately', function () {
        for (const message of ['Connection lost: The server closed the connection', 'PROTOCOL_CONNECTION_LOST',
            'connect ECONNREFUSED 127.0.0.1:18510', 'Lock wait timeout exceeded', 'Too many connections']) {
            assert.strictEqual(classifyError(new Error(message)), 'recoverable', message);
        }
        for (const message of ['unknown variant `high`', 'ER_BAD_FIELD_ERROR: Unknown column', 'payload exceeds the carrier limit']) {
            assert.strictEqual(classifyError(new Error(message)), 'fatal', message);
        }
    });
});

describe('kaspa_service: transactions, tick and rollback', function () {

    it('wraps one tick in exactly one transaction and commits once', async function () {
        const conn = fakeConn();
        const svc = service({ conn });
        await svc.init();
        const result = await svc.tick();
        assert.strictEqual(conn.begins, 1, 'one transaction per tick');
        assert.strictEqual(conn.commits, 1);
        assert.strictEqual(conn.rollbacks, 0);
        assert.strictEqual(result.blocks, 2, 'both blocks in the slice');
        assert.ok(result.writeStatements > 0, 'and statements were issued');
    });

    it('rolls back on a recoverable failure and lets the run loop retry it', async function () {
        // The contract: a recoverable DB failure is NOT swallowed here - it rolls the
        // transaction back and propagates, and run() is what backs off and retries. Asserting
        // a silent { skipped: true } here would be asserting a softer contract than the code has.
        const recoverable = fakeConn({ failOnInsert: 1, failWith: 'Connection lost: The server closed the connection' });
        const svc = service({ conn: recoverable });
        await svc.init();
        await assert.rejects(() => svc.tick(), /Connection lost/);
        assert.strictEqual(recoverable.rollbacks, 1, 'the transaction was rolled back');
        assert.strictEqual(recoverable.commits, 0, 'and nothing was committed');

        const fatal = fakeConn({ failOnInsert: 1, failWith: 'ER_BAD_FIELD_ERROR: Unknown column' });
        const svc2 = service({ conn: fatal });
        await svc2.init();
        await assert.rejects(() => svc2.tick(), /ER_BAD_FIELD_ERROR/, 'a data error must not be swallowed');
    });

    it('never writes outside a transaction', async function () {
        const conn = fakeConn();
        const svc = service({ conn });
        await svc.init();
        const beforeInit = conn.queries.length;
        await svc.tick();
        assert.ok(conn.queries.length > beforeInit, 'the tick issued statements');
        assert.strictEqual(conn.begins, 1, 'and every one of them was inside the transaction');
    });
});

describe('kaspa_service: the checkpoint', function () {

    it('starts from the pruning point, and reconciles the WRITE FLOOR with the database', async function () {
        const fresh = service({});
        assert.strictEqual(await fresh.init(), H('b0'), 'fresh install starts at the pruning point');

        // The database is the authority for the floor (it decides what an incremental write
        // skips); the cursor hash still comes from the checkpoint file or the pruning point.
        const ahead = fakeConn();
        ahead.query = async (sql) => {
            if (/MAX\(block_index\)/i.test(String(sql))) return [{ max_written: 7 }];
            return [];
        };
        const resumed = service({ conn: ahead });
        assert.strictEqual(await resumed.init(), H('b0'), 'the cursor is not invented from the DB');
        assert.strictEqual(resumed.writtenBlocks, 7, 'but the write floor follows the database');
    });

    it('writes atomically (temp + rename) and a new instance restores from it', async function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspa-cp-'));
        const file = path.join(dir, 'checkpoint.json');
        const first = service({ checkpointFile: file });
        await first.init();
        await first.tick();
        const written = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(written.checkpoint, H('b2'), 'the tip of the written slice');
        assert.strictEqual(written.networkId, 'simnet');
        assert.ok(written.writtenBlocks >= 2);
        assert.ok(typeof written.savedAt === 'string', 'savedAt is metadata, not a decision input');

        const second = service({ checkpointFile: file });
        assert.strictEqual(await second.init(), H('b2'), 'and it is restored on the next start');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('the DATABASE wins over the file for the write floor, whatever order init() runs in', async function () {
        // The blind spot a mutation run found in this very file: the case above has no checkpoint
        // file, so it cannot tell whether the reconciliation runs before or after the file is
        // read. A file claiming 99 while the database says 3 must end at 3 - the file's floor
        // would silently skip every row between 3 and 99.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspa-cp3-'));
        const file = path.join(dir, 'checkpoint.json');
        fs.writeFileSync(file, JSON.stringify({ checkpoint: H('b2'), networkId: 'simnet', writtenBlocks: 99, ticks: 5, savedAt: 'x' }));
        const conn = fakeConn();
        conn.query = async (sql) => {
            if (/MAX\(block_index\)/i.test(String(sql))) return [{ max_written: 3 }];
            return [];
        };
        const svc = service({ conn, checkpointFile: file });
        await svc.init();
        assert.strictEqual(svc.writtenBlocks, 3, 'the database is the authority for the floor');
        assert.strictEqual(svc.checkpoint, H('b2'), 'and the cursor still comes from the file');
        fs.rmSync(dir, { recursive: true, force: true });
    });
    it('ignores a checkpoint written for another network', async function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspa-cp2-'));
        const file = path.join(dir, 'checkpoint.json');
        fs.writeFileSync(file, JSON.stringify({ checkpoint: H('b2'), networkId: 'mainnet', writtenBlocks: 9, ticks: 1, savedAt: 'x' }));
        const svc = service({ checkpointFile: file, networkId: 'simnet' });
        assert.strictEqual(await svc.init(), H('b0'), 'mainnet progress must never leak into a simnet run');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('kaspa_service: the mempool gate and stop', function () {

    it('honours the interval on an injected clock, and lets the caller advance it', async function () {
        const conn = fakeConn();
        const svc = service({ conn, mempoolIntervalMs: 1000 });
        await svc.init();
        const first = await svc.pollMempoolOnce([], { now: 10000 });
        assert.notStrictEqual(first.skipped, true, 'first call at t=10000 runs');
        const tooSoon = await svc.pollMempoolOnce([], { now: 10500 });
        assert.strictEqual(tooSoon.skipped, true);
        assert.strictEqual(tooSoon.reason, 'interval-not-reached');
        const later = await svc.pollMempoolOnce([], { now: 11001 });
        assert.notStrictEqual(later.skipped, true, 'past the interval it runs again');
    });

    it('stops idempotently and keeps its own counters', async function () {
        const svc = service({});
        await svc.init();
        await svc.tick();
        svc.requestStop();                       // the real name: requestStop(), not stop()
        svc.requestStop();
        assert.strictEqual(svc.stopping, true, 'the run loop is asked to stop, idempotently');
        assert.strictEqual(svc.ticks, 1);
        assert.strictEqual(svc.networkId, 'simnet');
        assert.strictEqual(svc.checkpoint, H('b2'), 'the cursor follows the blocks that were written');
    });
});

describe('kaspa_service: an unresolvable reorg must refuse to write (P2)', function () {
    it('refuses to write when the removal set cannot be resolved', async function () {
        // Read from the bytes: when no removed chain block can be located in the hash map or in
        // the database, `rollbackFrom` stays null, the write floor does not move, and the
        // replacement blocks are then filtered out as already-written - a silent divergence that
        // only leaves an error line in the log. fail-closed means: refuse the write.
        const conn = fakeConn();
        conn.query = async (sql) => {
            if (/JOIN `index_transactions`/i.test(String(sql))) return [];      // the hash is nowhere
            if (/MAX\(block_index\)/i.test(String(sql))) return [{ max_written: 5 }];
            return [];
        };
        const rpc = fakeRpc();
        const answer = await rpc.getVirtualChainFromBlockV2({});
        rpc.getVirtualChainFromBlockV2 = async () => Object.assign({}, answer, {
            removedChainBlockHashes: ['ff'.repeat(32)],                          // unknown to us both ways
        });
        const svc = new KaspaDecoderService({ rpc, conn, networkId: 'simnet', minConfirmationCount: 0,
            checkpointFile: null, logger: quiet });
        await svc.init();
        await assert.rejects(() => svc.tick(), /cannot resolve|refus/i,
            'an unresolvable reorg must not be written silently');
        assert.strictEqual(conn.commits, 0, 'and nothing may be committed');
    });
});

describe('kaspa_service: the working set stays bounded (P1)', function () {
    it('drops rows it has already written, and never lets the cursor go backwards', async function () {
        // Read from the bytes: only state.events was ever cleared, so blocks/transactions and the
        // two id maps grew for the whole life of the process, and every tick re-materialised them.
        const h64 = (n) => String(n).padStart(2, '0').repeat(32);
        let height = 0;
        const rpc = fakeRpc();
        rpc.getVirtualChainFromBlockV2 = async () => {
            height += 1;
            const hash = h64(height);
            return {
                chainBlockAcceptedTransactions: [{
                    chainBlockHeader: { hash, selectedParentHash: height > 1 ? h64(height - 1) : h64(0), timestamp: 1000 + height },
                    acceptedTransactions: [],
                }],
                removedChainBlockHashes: [], addedChainBlockHashes: [hash],
            };
        };
        const svc = new KaspaDecoderService({ rpc, conn: fakeConn(), networkId: 'simnet',
            minConfirmationCount: 0, checkpointFile: null, logger: quiet });
        await svc.init();

        const sizes = [];
        for (let i = 0; i < 10; i += 1) { await svc.tick(); sizes.push(svc.state.blocks.length); }
        assert.ok(svc.state.blocks.length <= 1,
            'only the un-written tail may remain, found ' + svc.state.blocks.length);
        assert.ok(sizes.every((n) => n <= 1), 'and it must never grow across ticks: ' + sizes.join(','));
        assert.strictEqual(svc.state.transactions.length, 0, 'transactions above the floor likewise');
        assert.strictEqual(svc.checkpoint, h64(10), 'the cursor points at the last WRITTEN block');
    });
});

describe('kaspa_service: run() initialises inside its own retry loop (P2 asymmetry)', function () {
    it('starts the reader even when the node is not up at first', async function () {
        // Measured on a closed port: init() outside the loop threw ECONNREFUSED, the part's start
        // promise rejected, and the chain was never read - while a node that dies later is retried.
        let attempts = 0;
        const rpc = fakeRpc();
        const realDag = rpc.getBlockDagInfo.bind(rpc);
        rpc.getBlockDagInfo = async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:18999');
            return realDag();
        };
        const svc = new KaspaDecoderService({ rpc, conn: fakeConn(), networkId: 'simnet',
            minConfirmationCount: 0, checkpointFile: null, logger: quiet, baseBackoffMs: 10 });
        assert.strictEqual(svc.checkpoint, null, 'not initialised to begin with');
        await svc.run({ intervalMs: 1, maxTicks: 2 });
        assert.notStrictEqual(svc.checkpoint, null, 'run() must have initialised despite the first failure');
        assert.ok(attempts >= 2, 'and it must have retried: ' + attempts);
    });
});
