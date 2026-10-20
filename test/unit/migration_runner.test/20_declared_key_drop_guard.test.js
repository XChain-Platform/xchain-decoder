'use strict';

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
 * Schema migration runner: the declared-key drop guard of the auto-apply path.
 *
 * verifyTables runs before runMigrations, so a mode=auto file that drops a key
 * src/sql still declares UNIQUE or PRIMARY would leave the table without it for the
 * whole process. The guard refuses that drop unless the same file re-creates the key.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const Database = require('../../../src/db');
const { assertNoDeclaredKeyDrop } = require('../../../src/db/migration_guards/declared_key_drop.js');

const SQL_DIR = path.join(__dirname, '../../../src/sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const sqlFor = (table) => {
    try { return fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
};
const guard = (sql) => assertNoDeclaredKeyDrop('t.sql', splitOf(sql), sqlFor);

describe('decoder declared-key drop guard @regression', function () {
    it('refuses a drop of a declared UNIQUE or PRIMARY key that the file never re-creates', function () {
        for (const sql of [
            'DROP INDEX address ON index_addresses;',
            'ALTER TABLE index_addresses DROP KEY address;',
            'ALTER TABLE `index_transactions` DROP INDEX IF EXISTS `hash`;',
            'ALTER TABLE index_transactions DROP PRIMARY KEY;',
            'ALTER TABLE index_addresses DROP INDEX address, ADD INDEX address (address);',
        ]) {
            assert.throws(() => guard(sql), /drops (UNIQUE|PRIMARY) key (address|hash|primary) on index_(addresses|transactions)/, sql);
        }
    });

    it('allows a drop the same file re-creates under the same name and kind', function () {
        for (const sql of [
            'ALTER TABLE index_transactions DROP PRIMARY KEY, ADD PRIMARY KEY (id);',
            'ALTER TABLE index_addresses DROP INDEX IF EXISTS address;\nCREATE UNIQUE INDEX IF NOT EXISTS address ON index_addresses (address);',
        ]) {
            assert.doesNotThrow(() => guard(sql), sql);
        }
    });

    it('allows a table with no src/sql file and fails closed on a drop it cannot read', function () {
        assert.doesNotThrow(() => guard('ALTER TABLE no_such_source_table DROP PRIMARY KEY;'));
        assert.throws(() => guard('DROP INDEX ON index_addresses;'), /drops a key this guard cannot read/);
    });

    it('passes every committed mode=auto migration', function () {
        for (const file of fs.readdirSync(MIG_DIR).filter((name) => name.endsWith('.sql')).sort()) {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            if (Database.prototype.migrationMode(raw) !== 'auto') continue;
            assert.doesNotThrow(() => assertNoDeclaredKeyDrop(file, splitOf(raw), sqlFor), file);
        }
    });
});

describe('decoder migration runner applies the declared-key drop guard to auto files @regression', function () {
    // A runner over a temp src/sql holding index_addresses.sql and one auto migration
    function makeDb(body) {
        const executed = [];
        const conn = {
            async query(sql) {
                if (/GET_LOCK|RELEASE_LOCK|^SET SESSION|CREATE TABLE|schema_migrations/.test(sql)) return /GET_LOCK/.test(sql) ? [{ l: '1' }] : [];
                if (/@@SESSION\.sql_mode/.test(sql)) return [{ mode: 'STRICT_TRANS_TABLES' }];
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-key-drop-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        fs.writeFileSync(path.join(root, 'index_addresses.sql'),
            'CREATE TABLE index_addresses (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, address VARCHAR(120) NOT NULL);\n' +
            'CREATE UNIQUE INDEX address ON index_addresses (address);\n');
        fs.writeFileSync(path.join(root, 'migrations', '2099-01-01-t.sql'), '-- xchain:migration mode=auto\n' + body);
        Object.assign(db, { sqlPath: root, dbName: 'fake_db', getConnection: async () => conn, ensureMigrationsLedger: async () => {} });
        return { db, executed };
    }

    it('refuses an auto drop of the declared UNIQUE address key before running it', async function () {
        const { db, executed } = makeDb('DROP INDEX address ON index_addresses;\n');
        await assert.rejects(() => db.runMigrations({}), /drops UNIQUE key address on index_addresses/);
        assert.ok(!executed.some((s) => /^DROP INDEX/i.test(s)), 'the DROP INDEX never ran');
    });

    it('runs the same drop when the file re-creates the key', async function () {
        const { db, executed } = makeDb('DROP INDEX address ON index_addresses;\nCREATE UNIQUE INDEX address ON index_addresses (address);\n');
        await db.runMigrations({});
        assert.ok(executed.some((s) => /^DROP INDEX address/i.test(s)), 'the DROP INDEX ran');
    });
});
