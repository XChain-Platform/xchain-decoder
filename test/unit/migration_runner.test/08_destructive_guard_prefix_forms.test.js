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
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');

const modeOf  = Database.prototype.migrationMode.bind({});
const scanOf  = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const scanSql = (sql) => scanOf(splitOf(sql));

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

    it('catches ALTER IGNORE and CREATE TRIGGER end to end from raw file text', function () {
        for (const body of ['ALTER IGNORE TABLE transactions DROP COLUMN raw;',
            'CREATE TRIGGER purge AFTER INSERT ON blocks FOR EACH ROW DELETE FROM transactions;']) {
            const raw = '-- xchain:migration mode=auto\n' + body + '\n';
            assert.strictEqual(modeOf(raw), 'auto');
            assert.ok(scanSql(raw), body);
        }
    });
});
