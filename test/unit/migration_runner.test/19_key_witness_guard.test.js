/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Unique-key witness: an auto migration whose INSERT IGNORE, ON DUPLICATE KEY
 * UPDATE or REPLACE relies on a declared UNIQUE index that is not live is
 * refused before it runs.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const Database = require('../../../src/db');
const { keyDependentTargets, assertUniqueKeyWitness } = require('../../../src/db/migration_guards/key_witness.js');

const MIGRATIONS = path.join(__dirname, '../../../src/sql/migrations');
// Reviewed map of committed auto files to the tables their key-dependent writes target
const PINNED = {};

const declared = [{ name: 'uq_pair', unique: true, columns: ['a', 'b'] }];
const write = ['INSERT IGNORE INTO target (a, b) VALUES (1, 2)'];
const row = (name, nonUnique, column, seq) => ({
    INDEX_NAME: name, NON_UNIQUE: nonUnique, COLUMN_NAME: column, SEQ_IN_INDEX: seq,
});
const exists = (value) => ({ TABLE_EXISTS: value ? 1 : 0 });

// Every committed auto file's key-dependent write targets, keyed by file name
function committedKeyDependentTargets() {
    const found = {};
    for(const file of fs.readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()){
        const raw = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
        if(Database.prototype.migrationMode(raw) !== 'auto') continue;
        const targets = keyDependentTargets(Database.prototype.splitSqlStatements.call(Database.prototype, raw));
        if(targets.length) found[file] = targets;
    }
    return found;
}

describe('decoder migration unique-key witness @regression', function () {
    it('finds each key-dependent write and ignores one inside a quoted literal', function () {
        assert.deepStrictEqual(keyDependentTargets([
            'INSERT IGNORE INTO index_addresses (address) VALUES (1)',
            'INSERT INTO `PUBKEYS` (a) VALUES (1) ON DUPLICATE KEY UPDATE a=1',
            'REPLACE INTO db.blocks (a) VALUES (1)',
            'INSERT INTO events (code) VALUES (1)',
            "UPDATE x SET note='INSERT IGNORE INTO y'",
        ]), ['index_addresses', 'pubkeys', 'blocks']);
    });

    it('refuses a missing declared unique index and names its remedy', async function () {
        const conn = { query: async () => [] };
        await assert.rejects(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write, () => declared),
            /f\.sql[\s\S]*target[\s\S]*uq_pair[\s\S]*a, b[\s\S]*add the key by hand[\s\S]*earlier dated migration/);
    });

    it('passes a live unique index with the same ordered column set under another name', async function () {
        let reads = 0;
        const conn = { query: async sql => {
            if(/information_schema\.TABLES/.test(sql)) return [exists(true)];
            reads++;
            return [row('live_pair', 0, 'b', 2), row('live_pair', 0, 'a', 1)];
        } };
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write.concat(write), () => declared));
        assert.strictEqual(reads, 1, 'one target table must have one STATISTICS read');
    });

    it('refuses a non-unique live index holding the same name and columns', async function () {
        const conn = { query: async sql => /information_schema\.TABLES/.test(sql) ? [exists(true)] :
            [row('uq_pair', 1, 'a', 1), row('uq_pair', 1, 'b', 2)] };
        await assert.rejects(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write, () => declared), /uq_pair/);
    });

    it('passes a target table that does not exist live without reading its indexes', async function () {
        let indexReads = 0;
        const conn = { query: async sql => {
            if(/information_schema\.TABLES/.test(sql)) return [exists(false)];
            indexReads++;
            return [];
        } };
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write, () => declared));
        assert.strictEqual(indexReads, 0);
    });

    it('passes a table created earlier in the same file without reading live metadata', async function () {
        let reads = 0;
        const conn = { query: async () => { reads++; return []; } };
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', [
            'CREATE TABLE target (a INT, b INT, UNIQUE KEY uq_pair (a, b))',
            write[0],
        ], () => declared));
        assert.strictEqual(reads, 0);
    });

    it('keeps every committed auto file to the reviewed key-dependent map', function () {
        assert.deepStrictEqual(committedKeyDependentTargets(), PINNED);
    });
});

describe('decoder migration runner applies the unique-key witness to auto files @regression', function () {
    // A runner over a temp src/sql holding index_addresses.sql and one auto migration
    function makeDb(liveUnique) {
        const executed = [];
        const conn = {
            async query(sql) {
                if (/GET_LOCK|RELEASE_LOCK|^SET SESSION|CREATE TABLE|schema_migrations/.test(sql)) return /GET_LOCK/.test(sql) ? [{ l: '1' }] : [];
                if (/@@SESSION\.sql_mode/.test(sql)) return [{ mode: 'STRICT_TRANS_TABLES' }];
                if (/information_schema\.TABLES/.test(sql)) return [exists(true)];
                if (/information_schema\.STATISTICS/.test(sql)) return [row('address', liveUnique ? 0 : 1, 'address', 1)];
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-key-witness-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        fs.writeFileSync(path.join(root, 'index_addresses.sql'),
            'CREATE TABLE index_addresses (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, address VARCHAR(120) NOT NULL);\n' +
            'CREATE UNIQUE INDEX address ON index_addresses (address);\n');
        fs.writeFileSync(path.join(root, 'migrations', '2099-01-01-t.sql'),
            '-- xchain:migration mode=auto\nINSERT IGNORE INTO index_addresses (address) SELECT source FROM mempool_transactions;\n');
        Object.assign(db, { sqlPath: root, dbName: 'fake_db', getConnection: async () => conn, ensureMigrationsLedger: async () => {} });
        return { db, executed };
    }

    it('refuses an auto INSERT IGNORE while the declared UNIQUE address key is only a plain index', async function () {
        const { db, executed } = makeDb(false);
        await assert.rejects(() => db.runMigrations({}), /key-dependent write on index_addresses[\s\S]*address \(address\) is not live/);
        assert.ok(!executed.some((s) => /^INSERT IGNORE/i.test(s)), 'the INSERT IGNORE never ran');
    });

    it('runs the same file once the UNIQUE address key is live', async function () {
        const { db, executed } = makeDb(true);
        await db.runMigrations({});
        assert.ok(executed.some((s) => /^INSERT IGNORE INTO index_addresses/i.test(s)), 'the INSERT IGNORE ran');
    });
});
