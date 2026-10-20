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
 * Schema migration runner: destructive-DDL guard prefix forms (no live DB).
 *
 * Covers the statement heads a plain `ALTER TABLE` anchor misses: MariaDB's
 * ALTER [ONLINE] [IGNORE] TABLE, non-table ALTERs, and CREATE of a trigger,
 * event, routine or view, whose bodies the prefix classifier cannot read.
 * Also covers the closing statement-form allow-list: a mode=auto statement must
 * open with ALTER [ONLINE] TABLE, CREATE [TEMPORARY] TABLE, CREATE
 * [UNIQUE|FULLTEXT|SPATIAL] INDEX, DROP INDEX, DROP TEMPORARY TABLE, INSERT,
 * UPDATE or SET.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');

const modeOf  = Database.prototype.migrationMode.bind({});
const scanOf  = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const scanSql = (sql) => scanOf(splitOf(sql));

// Top-level DROPs of an object other than an index or a temporary table
const NON_INDEX_DROPS = ['DROP SEQUENCE IF EXISTS s;', 'DROP TRIGGER trg;', 'DROP TRIGGER IF EXISTS trg;',
    'DROP VIEW v;', 'DROP EVENT e;', 'DROP PROCEDURE p;', 'DROP FUNCTION f;', 'DROP PACKAGE BODY pk;',
    'DROP USER u;', 'DROP ROLE r;', 'DROP SERVER s;', 'drop\n  trigger trg;', '/* note */ DROP VIEW v;'];

describe('Database.destructiveAutoStatement() prefix forms @regression', function () {
    it('runs the ALTER clause checks on ALTER ONLINE TABLE', function () {
        assert.ok(scanSql('ALTER ONLINE TABLE t DROP COLUMN c;'));
        assert.ok(scanSql('ALTER ONLINE TABLE t RENAME COLUMN a TO b;'));
        assert.ok(scanSql('ALTER ONLINE TABLE t CHANGE a b INT;'));
        assert.ok(scanSql('ALTER ONLINE TABLE t MODIFY c VARCHAR(10) NOT NULL;'));
        assert.ok(scanSql('alter   online\n  table t drop column c;'));
    });

    it('flags every ALTER IGNORE TABLE (IGNORE deletes duplicate-key rows)', function () {
        assert.ok(scanSql('ALTER IGNORE TABLE transactions DROP COLUMN raw;'));
        assert.ok(scanSql('ALTER IGNORE TABLE t ADD UNIQUE INDEX u (c);'));
        assert.ok(scanSql('ALTER ONLINE IGNORE TABLE t ADD COLUMN c INT NULL;'));
        assert.ok(scanSql('ALTER IGNORE ONLINE TABLE t ADD COLUMN c INT NULL;'));
    });

    it('still allows additive ALTER ONLINE TABLE and a table merely named ignore', function () {
        assert.strictEqual(scanSql('ALTER ONLINE TABLE t ADD COLUMN c INT NULL;'), null);
        assert.strictEqual(scanSql('ALTER ONLINE TABLE t DROP INDEX idx_c;'), null);
        assert.strictEqual(scanSql('ALTER TABLE ignore_list ADD COLUMN x INT NULL;'), null);
    });

    it('flags CREATE TRIGGER / EVENT / routine / view and any non-table ALTER', function () {
        assert.ok(scanSql('CREATE TRIGGER zero_bal BEFORE INSERT ON transactions FOR EACH ROW SET NEW.raw = NULL;'));
        assert.ok(scanSql('CREATE TRIGGER purge AFTER INSERT ON blocks FOR EACH ROW DELETE FROM transactions;'));
        assert.ok(scanOf(["CREATE OR REPLACE DEFINER='a b'@'%' TRIGGER t BEFORE UPDATE ON blocks FOR EACH ROW SET NEW.block_hash = ''"]));
        assert.ok(scanSql('CREATE DEFINER=CURRENT_USER EVENT e ON SCHEDULE AT CURRENT_TIMESTAMP DO TRUNCATE transactions;'));
        assert.ok(scanSql('CREATE PROCEDURE p() DELETE FROM transactions;'));
        assert.ok(scanSql('CREATE FUNCTION f() RETURNS INT RETURN 1;'));
        assert.ok(scanSql('CREATE VIEW v AS SELECT 1;'));
        assert.ok(scanSql('ALTER EVENT e DO TRUNCATE transactions;'));
    });

    it('still allows the committed CREATE TABLE / CREATE INDEX forms', function () {
        assert.strictEqual(scanSql('CREATE TABLE t (id BIGINT, event VARCHAR(32), trigger_name VARCHAR(32));'), null);
        assert.strictEqual(scanSql('CREATE TEMPORARY TABLE t (id INT);'), null);
        assert.strictEqual(scanSql('CREATE INDEX IF NOT EXISTS i ON t (a);'), null);
        assert.strictEqual(scanSql('CREATE UNIQUE INDEX u ON t (a);'), null);
    });

    it('flags every top-level DROP other than a standalone index or temporary-table drop', function () {
        for (const sql of NON_INDEX_DROPS) assert.ok(scanSql(sql), sql);
    });

    it('still allows a standalone DROP INDEX and a DROP TEMPORARY TABLE', function () {
        assert.strictEqual(scanSql('DROP INDEX IF EXISTS address ON index_addresses;'), null);
        assert.strictEqual(scanSql('DROP INDEX i ON t;'), null);
        assert.strictEqual(scanSql('DROP TEMPORARY TABLE IF EXISTS _dup_index_addresses;'), null);
    });

    it('catches ALTER IGNORE and CREATE TRIGGER end to end from raw file text', function () {
        for (const body of ['ALTER IGNORE TABLE transactions DROP COLUMN raw;', 'DROP TRIGGER trg;',
            'CREATE TRIGGER purge AFTER INSERT ON blocks FOR EACH ROW DELETE FROM transactions;']) {
            const raw = '-- xchain:migration mode=auto\n' + body + '\n';
            assert.strictEqual(modeOf(raw), 'auto');
            assert.ok(scanSql(raw), body);
        }
    });
});

// Statement forms outside the closing allow-list; each can make the server act unseen
const UNLISTED_FORMS = ["BINLOG 'AAAA'", 'DO purge_stale_rows()', 'SELECT purge_stale_rows()',
    'WITH x AS (SELECT 1) SELECT * FROM x', '(SELECT 1)', 'PURGE BINARY LOGS BEFORE NOW()', 'RESET MASTER',
    "INSTALL SONAME 'ha_example'", 'UNINSTALL PLUGIN example', 'FLUSH TABLES', 'KILL 1',
    "GRANT ALL ON *.* TO 'u'@'%'", "REVOKE ALL ON *.* FROM 'u'@'%'", 'HANDLER transactions OPEN',
    'LOCK TABLES transactions WRITE', 'ANALYZE TABLE transactions', 'OPTIMIZE TABLE transactions',
    'BEGIN NOT ATOMIC DELETE FROM transactions; END', 'XA START 1'];

// One example of every form the closing allow-list admits
const ALLOWED_FORMS = ['ALTER TABLE transactions ADD COLUMN note TEXT NULL',
    'ALTER ONLINE TABLE transactions ADD INDEX note_idx (note)', 'CREATE TABLE IF NOT EXISTS notes (id INT)',
    'CREATE TEMPORARY TABLE scratch (id INT)', 'CREATE INDEX note_idx ON notes (id)',
    'CREATE UNIQUE INDEX note_uq ON notes (id)', 'DROP INDEX IF EXISTS note_idx ON notes',
    'DROP TEMPORARY TABLE scratch', "INSERT INTO notes (body) VALUES ('a')",
    'UPDATE notes SET id = (SELECT MAX(id) + 1 FROM notes) WHERE id = 0', "SET time_zone = '+00:00'"];

describe('Database.destructiveAutoStatement() statement-form allow-list @regression', function () {
    it('flags every statement form outside the allow-list', function () {
        for (const stmt of UNLISTED_FORMS) {
            assert.strictEqual(scanOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('keeps every allowed form auto-eligible', function () {
        for (const stmt of ALLOWED_FORMS) {
            assert.strictEqual(scanOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });

    it('flags an unlisted form that follows an allowed one in the same file', function () {
        assert.strictEqual(scanOf(['ALTER TABLE notes ADD COLUMN x INT NULL', 'DO purge_stale_rows()']),
            'DO purge_stale_rows()');
    });
});
