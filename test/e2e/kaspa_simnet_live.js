/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without any AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * End to end against a LIVE node and a REAL database - the run that caught what no fake could.
 *
 *     node test/e2e/kaspa_simnet_live.js [ticks]
 *     KASPA_RPC_URL=ws://127.0.0.1:18510/json DECODER_DB_USER=... node test/e2e/kaspa_simnet_live.js
 *
 * This is the shape of the check that found the "non-action payload written into data" defect: a
 * fake connection cannot see a column's contents and a fixture cannot see a live node. It is
 * SKIP-GUARDED, never silently green: with no reachable node or database it prints SKIP and exits 0,
 * because a CI box without a kaspad must not be told the integration passed.
 *
 * It writes only to a scratch database it creates and drops (xchain_kaspa_e2e_decoder) and it never
 * broadcasts anything - the node is read-only for this script.
 **********************************************************************/
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRATCH_DB = 'xchain_kaspa_e2e_decoder';
const TICKS = Number(process.argv[2] || 2);
const RPC_URL = process.env.KASPA_RPC_URL || 'ws://127.0.0.1:18510/json';

let mariadb = null;
try { mariadb = require('mariadb'); } catch (error) { mariadb = null; }
const { createRpcClient, KaspaDecoderService } = (() => {
    const client = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_node_client.js'));
    const service = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_service.js'));
    return { createRpcClient: client.createRpcClient, KaspaDecoderService: service.KaspaDecoderService };
})();

const quiet = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } };
const cfg = () => ({
    host: process.env.DECODER_DB_HOST || '127.0.0.1',
    port: Number(process.env.DECODER_DB_PORT || 3306),
    user: process.env.DECODER_DB_USER || 'xchain',
    password: process.env.DECODER_DB_PASSWORD || 'xchain',
});

const skip = (why) => { console.log('kaspa_simnet_live: SKIP - ' + why); process.exit(0); };

(async () => {
    if (!mariadb) skip('the optional dependency "mariadb" is not installed');

    let root = null;
    try {
        root = await mariadb.createConnection(Object.assign(cfg(), { connectTimeout: 3000, multipleStatements: true }));
    } catch (error) {
        skip('no reachable MariaDB at ' + cfg().host + ':' + cfg().port + ' (' + String(error.message).slice(0, 60) + ')');
    }

    const rpc = createRpcClient({ url: RPC_URL, timeoutMs: 15000 });
    try {
        await rpc.connect();
        const dag = await rpc.getBlockDagInfo();
        assert.ok(dag && dag.pruningPointHash, 'a live node answers getBlockDagInfo');
    } catch (error) {
        if (root) { try { await root.end(); } catch (e) { /* closing best-effort */ } }
        skip('no reachable kaspad at ' + RPC_URL + ' (' + String(error.message).slice(0, 60) + ')');
    }

    // Readiness first. A node that is syncing answers every RPC with the transitional IBD state,
    // and getVirtualChainFromBlockV2 on such a node simply never returns - measured: a silent
    // 600-second hang with no output. Not-ready is a SKIP with a reason, never a wait.
    console.log('  step 1/4: node readiness');
    let dag = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        dag = await rpc.call('getBlockDagInfo');
        if (Number(dag.blockCount) > 0 && Number(dag.headerCount) > 0) break;
        await new Promise((r) => setTimeout(r, 2000));
    }
    if (!(Number(dag.blockCount) > 0 && Number(dag.headerCount) > 0)) {
        if (root) { try { await root.end(); } catch (e) { /* closing best-effort */ } }
        try { await rpc.disconnect(); } catch (e) { /* closing best-effort */ }
        skip('node is not ready (blockCount=' + dag.blockCount + ', headerCount=' + dag.headerCount +
            ', isSynced not trusted here - see judgeInitialBlockDownload)');
    }

    console.log('  step 2/4: platform DDL into the scratch database');
    await root.query('DROP DATABASE IF EXISTS `' + SCRATCH_DB + '`');
    await root.query('CREATE DATABASE `' + SCRATCH_DB + '`');
    const conn = await mariadb.createConnection(Object.assign(cfg(), { database: SCRATCH_DB, multipleStatements: true }));

    const sqlDir = path.join(ROOT, 'src', 'sql');
    let statements = 0;
    for (const file of fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort()) {
        for (const raw of fs.readFileSync(path.join(sqlDir, file), 'utf8').split(/;\s*\n/)) {
            const s = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim();
            if (!s) continue;
            try { await conn.query(s); statements += 1; }
            catch (error) { if (!/already exists|Duplicate/i.test(String(error.message))) throw error; }
        }
    }
    console.log('  schema: platform DDL applied (' + statements + ' statements, scratch db ' + SCRATCH_DB + ')');

    console.log('  step 3/4: ticks against the live node');
    const svc = new KaspaDecoderService({ rpc, conn, networkId: process.env.KASPA_NETWORK || 'simnet',
        minConfirmationCount: 0, checkpointFile: null, logger: quiet });
    const from = await svc.init();
    console.log('  live slice starts at the pruning point ' + String(from).slice(0, 16) + '...');

    let totalWritten = 0;
    for (let i = 0; i < TICKS; i += 1) {
        const r = await svc.tick();
        totalWritten += r.writeStatements;
        console.log('  tick ' + (i + 1) + ': blocks=' + r.blocks + ' txs=' + r.transactions +
            ' removed=' + r.removedBlocks + ' statements=' + r.writeStatements +
            ' checkpoint=' + String(svc.checkpoint).slice(0, 16) + '...');
    }

    console.log('  step 4/4: sql read-back');
    // Read back with SQL. This is the part no fake can do.
    const count = async (sql) => Number((await conn.query(sql))[0].n);
    const rows = {
        blocks: await count('SELECT COUNT(*) AS n FROM `blocks`'),
        transactions: await count('SELECT COUNT(*) AS n FROM `transactions`'),
        outputs: await count('SELECT COUNT(*) AS n FROM `transaction_outputs`'),
        joinable: await count('SELECT COUNT(*) AS n FROM `transactions` t JOIN `blocks` b ON b.block_index = t.block_index'),
    };
    const garbage = await count("SELECT COUNT(*) AS n FROM `transactions` WHERE data IS NOT NULL AND data REGEXP '[^ -~|]'");
    const withRaw = await count('SELECT COUNT(*) AS n FROM `transactions` WHERE raw_data IS NOT NULL');
    const kept = await count('SELECT COUNT(*) AS n FROM `transactions` WHERE data IS NOT NULL');

    console.log('  sql read-back: blocks=' + rows.blocks + ' transactions=' + rows.transactions +
        ' outputs=' + rows.outputs + ' joinable=' + rows.joinable);
    console.log('  data column: ' + kept + ' recognised ACTION(s), ' + garbage + ' non-printable, raw_data on ' + withRaw);

    assert.ok(rows.blocks > 0, 'a live node produced blocks');
    assert.strictEqual(rows.joinable, rows.transactions, 'every transaction joins to its block');
    assert.strictEqual(garbage, 0, 'no non-printable payload may reach the data column');
    assert.ok(withRaw >= kept, 'raw bytes are preserved for everything that carried a payload');
    assert.ok(totalWritten > 0, 'the service wrote through the real connection');

    await root.query('DROP DATABASE IF EXISTS `' + SCRATCH_DB + '`');
    await conn.end();
    await root.end();
    await rpc.disconnect();
    console.log('kaspa_simnet_live: OK - ' + TICKS + ' tick(s) against ' + RPC_URL + ', ' + rows.transactions +
        ' transactions read back from the real schema');
})().catch((error) => {
    console.error('kaspa_simnet_live: FAILED - ' + String(error.message).slice(0, 220));
    process.exitCode = 1;
});
