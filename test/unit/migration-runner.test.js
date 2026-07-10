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
});

const scanOf = Database.prototype._destructiveAutoStatement.bind({});
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
