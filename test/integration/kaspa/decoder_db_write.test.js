/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL-3.0 disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The database write path, against a REAL MariaDB and a REAL captured chain block.
 *
 * Why this file exists: the real-database run is the only check that ever caught the
 * "non-action payload written into `data`" defect, and until now it lived entirely in a
 * throwaway probe - no automated test touched a real database at all. The chain side is
 * the captured fixture (test/fixtures/kaspa/chain_block_with_payload.json), so this test
 * needs no live node; the database side is real, and when none is reachable the suite
 * SKIPS LOUDLY rather than passing on a fake.
 *
 * Environment (defaults match .env.example):
 *   DECODER_DB_HOST=127.0.0.1  DECODER_DB_PORT=3306
 *   DECODER_DB_USER=xchain     DECODER_DB_PASSWORD=xchain
 * The scratch database is created and dropped by this test: `xchain_kaspa_it_decoder`.
 **********************************************************************/
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'kaspa', 'chain_block_with_payload.json');
const SQL_DIR = path.join(ROOT, 'src', 'sql');
const SCRATCH_DB = 'xchain_kaspa_it_decoder';

const cfg = () => ({
    host: process.env.DECODER_DB_HOST || '127.0.0.1',
    port: Number(process.env.DECODER_DB_PORT || 3306),
    user: process.env.DECODER_DB_USER || 'xchain',
    password: process.env.DECODER_DB_PASSWORD || 'xchain',
});

let mariadb = null;
try { mariadb = require('mariadb'); } catch (error) { mariadb = null; }

const quiet = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } };

// Apply the platform's own DDL, the way the real deployment does.
async function applySchema(conn) {
    const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
        const text = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        for (const raw of text.split(/;\s*\n/)) {
            const statement = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim();
            if (!statement) continue;
            try { await conn.query(statement); }
            catch (error) {
                if (!/already exists|Duplicate/i.test(String(error.message))) throw error;
            }
        }
    }
    return files.length;
}

describe('kaspa integration: the real database write path', function () {
    this.timeout(20000);

    let root = null;
    let conn = null;
    let skipReason = null;

    before(async function () {
        if (!mariadb) { skipReason = 'the optional dependency "mariadb" is not installed'; return; }
        if (!fs.existsSync(FIXTURE)) { skipReason = 'no captured fixture at test/fixtures/kaspa'; return; }
        try {
            root = await mariadb.createConnection(Object.assign(cfg(), { connectTimeout: 3000, multipleStatements: true }));
            await root.query('DROP DATABASE IF EXISTS `' + SCRATCH_DB + '`');
            await root.query('CREATE DATABASE `' + SCRATCH_DB + '`');
            conn = await mariadb.createConnection(Object.assign(cfg(), { database: SCRATCH_DB, multipleStatements: true }));
            await applySchema(conn);
        } catch (error) {
            skipReason = 'no reachable MariaDB at ' + cfg().host + ':' + cfg().port + ' (' + String(error.message).slice(0, 60) + ')';
            if (root) { try { await root.end(); } catch (e) { /* closing best-effort */ } root = null; }
            conn = null;
        }
    });

    after(async function () {
        if (conn) { try { await conn.end(); } catch (e) { /* closing best-effort */ } }
        if (root) {
            try { await root.query('DROP DATABASE IF EXISTS `' + SCRATCH_DB + '`'); } catch (e) { /* leaving the scratch db is harmless */ }
            try { await root.end(); } catch (e) { /* closing best-effort */ }
        }
    });

    beforeEach(function () {
        if (skipReason) this.skip();
    });

    it('writes a captured real chain block into the real schema, then reads it back', async function () {
        const { KaspaBlockDecoder } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_block_decoder.js'));
        const { ingest } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_ingest.js'));
        const { buildWritePlan, insertSql, SCHEMA } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_store.js'));

        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const decoder = new KaspaBlockDecoder('kaspa-simnet');
        const blocks = [{
            hash: fixture.chainBlock.hash,
            previousBlockHash: fixture.chainBlock.previousBlockHash,
            timestamp: fixture.chainBlock.timestamp,
            acceptedTransactions: fixture.acceptedTransactions,
        }];
        void decoder;

        const rows = ingest(blocks).rows;
        assert.ok(rows.blocks.length === 1, 'the captured block projects to one block row');
        assert.ok(rows.transactions.length === fixture.acceptedTransactions.length, 'every captured tx gets a row');

        const plan = buildWritePlan(rows, { sinceBlockIndex: 0, events: [] });
        for (const statement of plan) await conn.query(statement.sql, statement.values);

        // Read back with SQL, not with the projection: this is the part a fake connection cannot check.
        const counted = await conn.query('SELECT COUNT(*) AS n FROM `transactions`');
        assert.strictEqual(Number(counted[0].n), rows.transactions.length, 'rows are really in the table');
        const joined = await conn.query(
            'SELECT COUNT(*) AS n FROM `transactions` t JOIN `blocks` b ON b.block_index = t.block_index');
        assert.strictEqual(Number(joined[0].n), rows.transactions.length, 'and the indexer join resolves');

        // The platform storage gate: only a recognised ACTION may reach `data`; raw bytes stay raw.
        const binary = await conn.query(
            "SELECT COUNT(*) AS n FROM `transactions` WHERE data IS NOT NULL AND data REGEXP '[^ -~|]'");
        assert.strictEqual(Number(binary[0].n), 0, 'no non-printable payload may reach the data column');
        const kept = await conn.query('SELECT COUNT(*) AS n FROM `transactions` WHERE data IS NOT NULL');
        const raw = await conn.query('SELECT COUNT(*) AS n FROM `transactions` WHERE raw_data IS NOT NULL');
        assert.ok(Number(raw[0].n) > 0, 'and the raw bytes are preserved in raw_data');
        assert.ok(Number(kept[0].n) <= rows.transactions.length);

        // Every column the plan writes must exist in the table it targets.
        for (const name of Object.keys(SCHEMA)) {
            const described = await conn.query('DESCRIBE `' + name + '`');
            const columns = described.map((c) => c.Field);
            for (const column of SCHEMA[name]) {
                assert.ok(columns.includes(column), name + '.' + column + ' is missing from the real schema');
            }
        }
        void insertSql;
    });

    it('refuses a second insert of the same block unless the plan is idempotent', async function () {
        const { ingest } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_ingest.js'));
        const { buildWritePlan } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_store.js'));
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const blocks = [{ hash: fixture.chainBlock.hash, previousBlockHash: fixture.chainBlock.previousBlockHash,
            timestamp: fixture.chainBlock.timestamp, acceptedTransactions: fixture.acceptedTransactions }];

        const first = buildWritePlan(ingest(blocks).rows, { sinceBlockIndex: 0, events: [] });
        for (const s of first) await conn.query(s.sql, s.values);
        const before = await conn.query('SELECT COUNT(*) AS n FROM `transactions`');

        // Replay: the same slice again. Idempotent upserts mean no duplicate rows and no error.
        const replay = buildWritePlan(ingest(blocks).rows, { sinceBlockIndex: 0, events: [] });
        for (const s of replay) await conn.query(s.sql, s.values);
        const after = await conn.query('SELECT COUNT(*) AS n FROM `transactions`');
        assert.strictEqual(Number(after[0].n), Number(before[0].n), 'a replay must not duplicate rows');
    });
});
