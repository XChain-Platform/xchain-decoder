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
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const modeOf = Database.prototype.migrationMode.bind({});

describe('Database.migrationMode() @regression', function () {

    it('reads mode=auto from the header tag', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=auto\nALTER TABLE x ADD COLUMN y INT;'), 'auto');
    });

    it('reads mode=manual from the header tag', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=manual\nDROP INDEX z ON x;'), 'manual');
    });

    it('defaults to manual when no tag is present (never auto-runs unknown DDL)', function () {
        assert.strictEqual(modeOf('-- just a normal migration comment\nALTER TABLE x ADD COLUMN y INT;'), 'manual');
    });

    it('is case-insensitive and tolerant of spacing', function () {
        assert.strictEqual(modeOf('--   XChain:Migration   mode = AUTO  (additive)\n'), 'auto');
    });

    it('a non-auto/manual value falls through to manual', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=yolo\n'), 'manual');
    });

    it('does not let a tag below the first SQL statement arm auto-apply (prologue window only)', function () {
        // The tag is a leading-comment-prologue directive; once the first SQL
        // statement (or any non-comment line) appears, a later `mode=auto` in a data
        // literal or in trailing prose must not flip an untagged file to auto. The
        // prologue scan stops at the first non-comment, non-blank line.
        const body = 'ALTER TABLE events ADD COLUMN note TEXT;\n' +
            '-- xchain:migration mode=auto (trailing prose, below the first statement)\nDROP TABLE events;';
        assert.strictEqual(modeOf(body), 'manual');
    });

    it('reads the tag past a multi-line comment banner (banner does not push it out of view)', function () {
        // Regression for the license-banner case: a 13-line `--` banner plus a blank
        // line put the real tag on line 15, outside the old 10-line window, silently
        // gating a mode=auto migration to manual. The prologue scan must still see it.
        const banner = Array(13).fill('-- license banner line').join('\n');
        const file = banner + '\n\n-- xchain:migration mode=auto\nALTER TABLE t MODIFY COLUMN d MEDIUMTEXT;';
        assert.strictEqual(modeOf(file), 'auto');
    });
});

// Bind to the prototype so destructiveAutoStatement can reach isIdRepairUpdate
// (both pure, no instance state).
const scanOf = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
// Split exactly the way runMigrations does, through the real quote-aware splitter,
// so the guard is exercised on the statements it actually classifies at runtime
// rather than on a naive re-split that the runner no longer uses.
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const scanSql = (sql) => scanOf(splitOf(sql));

describe('Database.destructiveAutoStatement() @regression', function () {

    it('flags DROP TABLE', function () {
        assert.ok(scanSql('DROP TABLE events;'));
    });

    it('flags DROP DATABASE / DROP SCHEMA', function () {
        assert.ok(scanSql('DROP DATABASE xchain;'));
        assert.ok(scanSql('DROP SCHEMA public;'));
    });

    it('flags TRUNCATE', function () {
        assert.ok(scanSql('TRUNCATE transactions;'));
    });

    it('flags RENAME TABLE', function () {
        assert.ok(scanSql('RENAME TABLE a TO b;'));
    });

    it('flags DELETE FROM', function () {
        assert.ok(scanSql('DELETE FROM dispensers;'));
    });

    it('flags non-canonical DELETE forms that omit an immediate FROM', function () {
        // Every DELETE removes rows; the guard must not depend on `DELETE FROM` word order.
        assert.ok(scanSql('DELETE LOW_PRIORITY FROM dispensers WHERE id = 1;'));
        assert.ok(scanSql('DELETE IGNORE FROM dispensers WHERE id = 1;'));
        assert.ok(scanSql('DELETE t1 FROM events t1 JOIN blocks t2 ON t1.block_index=t2.block_index;'));
    });

    it('flags REPLACE INTO (atomic DELETE+INSERT), matching the DELETE guard', function () {
        assert.ok(scanSql('REPLACE INTO dispensers (id, source) VALUES (1, \'x\');'));
    });

    it('flags a bare UPDATE but not the committed AUTO_INCREMENT id=0 repair', function () {
        assert.ok(scanSql('UPDATE blocks SET block_hash = \'x\' WHERE block_index = 1;'));
        assert.strictEqual(
            scanSql('UPDATE mirror SET id = (SELECT MAX(id)+1 FROM t) WHERE id = 0;'), null);
    });

    it('flags UPDATE bypasses that smuggle past the id-repair carve-out', function () {
        // Unanchored/paren-greedy carve-out let these rewrite every row; now flagged.
        assert.ok(scanSql('UPDATE mirror SET id = (SELECT 1) WHERE id = 0 OR 1=1;'));
        assert.ok(scanSql('UPDATE mirror SET id = (SELECT id), amount = (SELECT \'0\') WHERE id = 0;'));
        assert.ok(scanSql('UPDATE mirror SET id = (SELECT 1) WHERE id = 0 LIMIT 1;'));
        // Nested-subquery repair with commas must still pass.
        assert.strictEqual(
            scanSql('UPDATE mirror SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id),0)+1 AS next_id FROM mirror) t) WHERE id = 0;'), null);
    });

    it('flags a NOT NULL-narrowing clause even when a sibling clause is AUTO_INCREMENT', function () {
        // A statement-wide AUTO_INCREMENT test would let the first clause exempt the
        // sibling NOT NULL narrowing; the per-clause scan must still flag it.
        assert.ok(scanSql(
            'ALTER TABLE t MODIFY id BIGINT NOT NULL AUTO_INCREMENT, MODIFY source VARCHAR(255) NOT NULL;'));
    });

});

describe('Database.destructiveAutoStatement() @regression', function () {

    it('flags CREATE OR REPLACE TABLE (atomic DROP+CREATE wipes rows) but not plain/IF NOT EXISTS', function () {
        assert.ok(scanSql('CREATE OR REPLACE TABLE dispensers (id BIGINT) ENGINE=InnoDB;'));
        assert.ok(scanSql('CREATE OR REPLACE TEMPORARY TABLE t (id INT);'));
        // Additive create forms stay safe (must not false-positive and block fleet boot).
        assert.strictEqual(scanSql('CREATE TABLE IF NOT EXISTS dispensers (id BIGINT) ENGINE=InnoDB;'), null);
        assert.strictEqual(scanSql('CREATE TABLE new_thing (id BIGINT) ENGINE=InnoDB;'), null);
    });

    it('flags ALTER TABLE ... DROP COLUMN and a bare column drop', function () {
        assert.ok(scanSql('ALTER TABLE t DROP COLUMN c;'));
        assert.ok(scanSql('ALTER TABLE t DROP c;'));
    });

    it('flags ALTER TABLE ... RENAME (TO / COLUMN) and CHANGE', function () {
        assert.ok(scanSql('ALTER TABLE t RENAME TO t2;'));
        assert.ok(scanSql('ALTER TABLE t RENAME COLUMN a TO b;'));
        assert.ok(scanSql('ALTER TABLE t CHANGE a b INT;'));
    });

    it('flags MODIFY ... NOT NULL narrowing (but not the AUTO_INCREMENT repair)', function () {
        assert.ok(scanSql('ALTER TABLE t MODIFY c INT NOT NULL;'));
        assert.strictEqual(scanSql('ALTER TABLE t MODIFY id BIGINT NOT NULL AUTO_INCREMENT;'), null);
    });

    it('flags a destructive statement hidden after a safe one (scans all statements)', function () {
        assert.ok(scanSql('ALTER TABLE t ADD COLUMN c INT; DROP TABLE events;'));
    });

    it('does not flag metadata-only drops (INDEX/KEY/FOREIGN KEY/CONSTRAINT/PRIMARY KEY)', function () {
        assert.strictEqual(scanSql('DROP INDEX i ON t;'), null);
        assert.strictEqual(scanSql('ALTER TABLE t DROP INDEX i;'), null);
        assert.strictEqual(scanSql('ALTER TABLE t DROP FOREIGN KEY fk;'), null);
        assert.strictEqual(scanSql('ALTER TABLE t DROP PRIMARY KEY;'), null);
    });

    it('does not flag additive / widening statements', function () {
        assert.strictEqual(scanSql('ALTER TABLE t ADD COLUMN c INT;'), null);
        assert.strictEqual(scanSql('CREATE TABLE IF NOT EXISTS t (id INT);'), null);
        assert.strictEqual(scanSql('CREATE INDEX i ON t (c);'), null);
        assert.strictEqual(scanSql('ALTER TABLE t MODIFY c MEDIUMTEXT;'), null);
        assert.strictEqual(scanSql('ALTER TABLE t RENAME INDEX i TO j;'), null);
    });

});

describe('Database.destructiveAutoStatement() @regression', function () {

    it('does not let a destructive keyword inside a block comment trigger a hit', function () {
        assert.strictEqual(scanSql('ALTER TABLE t ADD COLUMN c INT /* not a DROP TABLE */;'), null);
    });

    it('flags dynamic-SQL / stored-routine indirection (PREPARE/EXECUTE/CALL/SET @)', function () {
        // A prefix classifier cannot see SQL assembled at runtime or a routine body,
        // so these are non-auto-eligible regardless of what they resolve to.
        assert.ok(scanSql('PREPARE stmt FROM @s;'));
        assert.ok(scanSql('EXECUTE stmt;'));
        assert.ok(scanSql('CALL some_proc();'));
        assert.ok(scanSql("SET @s = 'DROP TABLE events';"));
    });

    it('flags the SET @/PREPARE/EXECUTE dynamic-SQL bypass as a whole', function () {
        assert.ok(scanSql("SET @s = 'DROP TABLE events'; PREPARE stmt FROM @s; EXECUTE stmt;"));
    });

    it('does NOT flag benign system-variable SETs (SET NAMES / SET sql_mode / SET @@)', function () {
        assert.strictEqual(scanSql('SET NAMES utf8mb4;'), null);
        assert.strictEqual(scanSql('SET sql_mode = "STRICT_ALL_TABLES";'), null);
        assert.strictEqual(scanSql('SET @@session.foreign_key_checks = 0;'), null);
    });

    // The indexer twin carries the same cases; keep the two suites in step.

    it('flags a DROP hidden behind a `#` line comment (the server honours `#`)', function () {
        // Before the strip knew `#`, this reached the classifier as one chunk starting
        // with `#`, matched no ^-anchored check, and auto-ran the DROP at startup.
        const offender = scanSql('# cleanup\nDROP TABLE transactions;');
        assert.ok(offender && /DROP TABLE transactions/i.test(offender));
    });

    it('flags a statement still carrying a `#` line comment (strip-regression guard)', function () {
        assert.ok(scanOf(['# cleanup\nDROP TABLE transactions']));
    });

    it('does not flag a `#` inside a quoted literal or a block comment', function () {
        assert.strictEqual(scanSql("INSERT INTO notes (body) VALUES ('#tag');"), null);
        assert.strictEqual(scanSql('/* see issue #4413 */ ALTER TABLE t ADD COLUMN y INT;'), null);
    });

});

describe('Database.destructiveAutoStatement() @regression', function () {

    it('flags INSERT ... ON DUPLICATE KEY UPDATE but not a plain INSERT', function () {
        assert.ok(scanSql("INSERT INTO dispensers (id, source) VALUES (1,'x') ON DUPLICATE KEY UPDATE source='y';"));
        assert.strictEqual(scanSql("INSERT INTO dispensers (id, source) VALUES (1,'x');"), null);
    });

    it('flags LOAD DATA (rows come from a file the classifier cannot read)', function () {
        assert.ok(scanSql("LOAD DATA INFILE '/tmp/x.csv' REPLACE INTO TABLE transactions;"));
        assert.ok(scanSql("LOAD DATA LOCAL INFILE '/tmp/x.csv' INTO TABLE transactions;"));
    });

    it('flags ALTER TABLE partition and tablespace clauses', function () {
        assert.ok(scanSql('ALTER TABLE events DROP PARTITION p2025;'));
        assert.ok(scanSql('ALTER TABLE events TRUNCATE PARTITION p0;'));
        assert.ok(scanSql('ALTER TABLE events EXCHANGE PARTITION p0 WITH TABLE events_old;'));
        assert.ok(scanSql('ALTER TABLE events DISCARD TABLESPACE;'));
        // Additive partition DDL is not separable by prefix, so it is non-auto too.
        assert.ok(scanSql('ALTER TABLE events ADD PARTITION (PARTITION p2 VALUES LESS THAN (200));'));
    });

    it('does not flag an ordinary column whose name merely contains "partition"', function () {
        assert.strictEqual(scanSql('ALTER TABLE t ADD COLUMN partition_id INT NULL;'), null);
    });
});

describe('Database.backdatedFrontierViolation() @regression', function () {

    it('reports the frontier when a pending file is dated before an applied one', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql',
                ['2026-06-10-a.sql', '2026-08-10-b.sql']),
            '2026-08-10-b.sql');
    });

    it('stays silent for a pending file dated after everything applied', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-08-11-new.sql',
                ['2026-06-10-a.sql', '2026-08-10-b.sql']),
            null);
    });

    it('never trips on a fresh install (empty ledger)', function () {
        assert.strictEqual(Database.backdatedFrontierViolation('2026-01-01-first.sql', []), null);
        assert.strictEqual(Database.backdatedFrontierViolation('2026-01-01-first.sql', null), null);
    });

    it('accepts a Map keys() iterator, which is what the apply loop passes', function () {
        const applied = new Map([['2026-06-10-a.sql', 'h1'], ['2026-08-10-b.sql', 'h2']]);
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql', applied.keys()),
            '2026-08-10-b.sql');
    });

    it('compares against the MAXIMUM applied name, not the last one seen', function () {
        // Ledger rows arrive in whatever order the SELECT returns them.
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql',
                ['2026-08-10-b.sql', '2026-06-10-a.sql']),
            '2026-08-10-b.sql');
    });

    it('treats an equal name as applied, not backdated', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-08-10-b.sql', ['2026-08-10-b.sql']),
            null);
    });

});

describe('Database.backdatedFrontierViolation() @regression', function () {

    // An undated ledger name sorts ABOVE every 2026-* name in ASCII ('a' 0x61 > '2'
    // 0x32), so an unfiltered maximum makes the frontier a garbage value that every
    // ordinary new migration sorts below. No undated decoder migration ever shipped,
    // so this pins the filter rather than healing a known row.
    it('ignores an undated legacy ledger row when computing the frontier', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-08-11-new.sql', [
                '2026-06-15-events-data-mediumtext.sql',
                'add_legacy_columns.sql',
                '2026-08-10-action-data-utf8mb4.sql',
            ]),
            null,
            'an undated legacy row must never become the frontier');
    });

    it('still reports a real violation when an undated legacy row is present', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql', [
                'add_legacy_columns.sql',
                '2026-08-10-action-data-utf8mb4.sql',
            ]),
            '2026-08-10-action-data-utf8mb4.sql',
            'the filter must narrow the frontier, not disable the guard');
    });

    // The two shipped auto files are the live callers of this guard; a resumed partial
    // run must not trip on them, because the ledger prefix a crash leaves behind always
    // sorts below whatever is still pending.
    it('does not trip a resumed partial run over the shipped auto files', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-06-15-events-data-mediumtext.sql',
                ['2026-05-28-unique-index-tables.sql', '2026-06-13-dispensers-expiration-bigint.sql']),
            null);
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-06-17-pubkeys-add-monotonic-id.sql',
                ['2026-06-15-events-data-mediumtext.sql']),
            null);
    });
});
