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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers migrationMode() header parsing and the invariant that every committed
 * migration declares its intent explicitly, so a destructive file can never
 * default-silently into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');

const scanOf = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const scanSql = (sql) => scanOf(splitOf(sql));

// Mirrors the xchain-indexer suite for the same splitter. The decoder's naive
// `.split(';')` in both runMigrations and createTable let a semicolon
// inside a quoted literal tore one statement into invalid fragments (a boot-breaking
// migration, and a destructive-DDL guard classifying fragments rather than real
// statements). These pin the quote-aware behaviour in the decoder too.
describe('Database.splitSqlStatements() @regression', function () {

    it('does not split on a ; inside a single-quoted string literal', function () {
        assert.deepStrictEqual(splitOf("UPDATE t SET data = 'a;b' WHERE id = 1;"),
            ["UPDATE t SET data = 'a;b' WHERE id = 1"]);
    });

    it('does not split on a ; inside double-quoted or backtick-quoted spans', function () {
        assert.deepStrictEqual(splitOf('UPDATE t SET data = "a;b" WHERE id = 1;'),
            ['UPDATE t SET data = "a;b" WHERE id = 1']);
        assert.deepStrictEqual(splitOf('UPDATE `we;ird` SET x = 1;'),
            ['UPDATE `we;ird` SET x = 1']);
    });

    it('treats doubled quotes as escapes (a ; inside stays inside)', function () {
        assert.deepStrictEqual(splitOf("INSERT INTO t (m) VALUES ('it''s; fine');"),
            ["INSERT INTO t (m) VALUES ('it''s; fine')"]);
    });

    it('does not split on a ; inside a -- line comment', function () {
        assert.deepStrictEqual(splitOf('SELECT 1; -- trailing; note\nSELECT 2;'),
            ['SELECT 1', 'SELECT 2']);
    });

    it('does not split on a ; inside a # line comment, and drops the comment', function () {
        assert.deepStrictEqual(splitOf('SELECT 1; # see foo; bar\nSELECT 2;'),
            ['SELECT 1', 'SELECT 2']);
        assert.deepStrictEqual(splitOf('# cleanup\nDROP TABLE transactions;'),
            ['DROP TABLE transactions']);
    });

    it('leaves a # or an apostrophe inside a block comment alone', function () {
        // A naive #-to-end-of-line strip would eat the closing */ and the rest of the line.
        assert.deepStrictEqual(splitOf('/* see issue #4413 */ SELECT 1;'),
            ['/* see issue #4413 */ SELECT 1']);
        assert.deepStrictEqual(splitOf("/* don't do this */ SELECT 1; SELECT 2;"),
            ["/* don't do this */ SELECT 1", 'SELECT 2']);
    });

    it('splits ordinary multi-statement SQL into the same statements as before', function () {
        assert.deepStrictEqual(splitOf('CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);'),
            ['CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
    });

    it('guard classifies real statements, not fragments (both directions)', function () {
        // A ;DROP TABLE buried in a string literal is ONE non-destructive statement.
        assert.strictEqual(scanSql(
            "INSERT INTO notes (body) VALUES ('watch for ;DROP TABLE x');"
        ), null);
        // A genuine trailing DROP TABLE is still caught.
        const offender = scanSql("INSERT INTO notes (body) VALUES ('ok'); DROP TABLE x;");
        assert.ok(offender && /DROP TABLE x/i.test(offender));
    });
});
