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
 * Covers _migrationMode() header parsing and the invariant that every committed
 * migration declares its intent explicitly, so a destructive file can never
 * default-silently into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const modeOf = Database.prototype._migrationMode.bind({});

describe('Database._migrationMode() @regression', function () {

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

    it('does not let a body-buried mode=auto tag arm auto-apply (header window only)', function () {
        // The tag is a header directive; a mode=auto token quoted in body prose or a
        // data literal below the header window must not flip an untagged file to auto.
        const body = Array(12).fill('-- filler line').join('\n') +
            '\n-- xchain:migration mode=auto (quoted convention prose)\nDROP TABLE events;';
        assert.strictEqual(modeOf(body), 'manual');
    });
});

// Bind to the prototype so _destructiveAutoStatement can reach _isIdRepairUpdate
// (both pure, no instance state).
const scanOf = Database.prototype._destructiveAutoStatement.bind(Database.prototype);
// Split the way runMigrations does (line-comment strip is done upstream; here the
// fixtures carry no line comments, so a plain ';'-split matches the runner's input).
const scanSql = (sql) => scanOf(sql.split(';').map(s => s.trim()).filter(Boolean));

describe('Database._destructiveAutoStatement() @regression', function () {

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

    it('flags UPDATE bypasses that smuggle past the id-repair carve-out (#1861)', function () {
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
});

describe('committed migrations declare intent @regression', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    it('migrations directory is present', function () {
        assert.ok(fs.existsSync(MIG_DIR), 'expected ' + MIG_DIR);
    });

    files.forEach(function (file) {
        it(file + ': carries an explicit `-- xchain:migration mode=auto|manual` tag', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const m = raw.match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
            assert.ok(m,
                file + ' has no explicit mode tag. Every migration must declare intent so a ' +
                'destructive change can never silently auto-run at startup. Add a first line: ' +
                '`-- xchain:migration mode=auto` (additive + idempotent) or `mode=manual` (gated).');
        });
    });

    files.forEach(function (file) {
        it(file + ': if tagged mode=auto, contains no destructive DDL', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const mode = modeOf(raw);
            if (mode !== 'auto') { this.skip(); return; }
            const statements = Database.prototype.stripSqlLineComments.call({}, raw)
                .split(';').map(s => s.trim()).filter(Boolean);
            const offender = scanOf(statements);
            assert.strictEqual(offender, null,
                file + ' is tagged mode=auto but contains destructive DDL: ' + offender);
        });
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression', function () {

    const crypto  = require('crypto');
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

    it('every rebaseline pins two distinct 64-hex sha256 values', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            assert.match(r.from, /^[0-9a-f]{64}$/, file + ': from must be a sha256 hex digest');
            assert.match(r.to,   /^[0-9a-f]{64}$/, file + ': to must be a sha256 hex digest');
            assert.notStrictEqual(r.from, r.to, file + ': from and to must differ');
        }
    });

    it('every rebaseline `to` hash matches the committed file content (heals TOWARD the repo, never away from it)', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const checksum = crypto.createHash('sha256').update(raw).digest('hex');
            assert.strictEqual(checksum, r.to,
                file + ': rebaseline target is stale - it must equal the current committed file sha256, ' +
                'otherwise the heal path would rewrite the ledger to a hash that still mismatches.');
        }
    });
});
