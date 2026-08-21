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

// Bind to the prototype so _destructiveAutoStatement can reach _isIdRepairUpdate
// (both pure, no instance state).
const scanOf = Database.prototype._destructiveAutoStatement.bind(Database.prototype);
// Split exactly the way runMigrations does, through the real quote-aware splitter,
// so the guard is exercised on the statements it actually classifies at runtime
// rather than on a naive re-split that the runner no longer uses.
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const scanSql = (sql) => scanOf(splitOf(sql));

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

describe('committed migrations declare intent @regression', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    it('migrations directory is present', function () {
        assert.ok(fs.existsSync(MIG_DIR), 'expected ' + MIG_DIR);
    });

    files.forEach(function (file) {
        it(file + ': carries a runner-visible `-- xchain:migration mode=auto|manual` tag', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const anywhere = raw.match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
            assert.ok(anywhere,
                file + ' has no explicit mode tag. Every migration must declare intent so a ' +
                'destructive change can never silently auto-run at startup. Add a first line: ' +
                '`-- xchain:migration mode=auto` (additive + idempotent) or `mode=manual` (gated).');
            // The runner must actually SEE that tag. A whole-file regex passes even when
            // the tag sits below the runner's prologue window (e.g. pushed past a fixed
            // line count by the license banner), which silently gates a declared
            // mode=auto migration to the manual default. Assert the real code path agrees
            // with the declared intent so a runner-invisible tag fails CI.
            assert.strictEqual(modeOf(raw), anywhere[1].toLowerCase(),
                file + ' declares mode=' + anywhere[1].toLowerCase() + ' but the runner reads mode=' +
                modeOf(raw) + '; the tag is outside the runner-visible comment prologue. Move it into ' +
                'the leading comment block, before the first SQL statement.');
        });
    });

    files.forEach(function (file) {
        it(file + ': if tagged mode=auto, contains no destructive DDL', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const mode = modeOf(raw);
            if (mode !== 'auto') { this.skip(); return; }
            const statements = splitOf(raw);
            const offender = scanOf(statements);
            assert.strictEqual(offender, null,
                file + ' is tagged mode=auto but contains destructive DDL: ' + offender);
        });
    });

    // Apply order is lexical (readdirSync().sort() in runMigrations), so the dated
    // prefix is what makes it chronological. Freeze the single YYYY-MM-DD- form: an
    // undashed 20260612_ sequence name would sort BEFORE every dashed file ('-' 0x2D
    // < '0' 0x30) and apply out of authorship order with no runtime error. The runner
    // now throws on an undated name; this pins the committed tree to the convention.
    const DATED_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
    files.forEach(function (file) {
        it(file + ': is named with the YYYY-MM-DD- dated prefix', function () {
            assert.ok(DATED_PREFIX.test(file),
                file + ' is not dated. Apply order is lexical, so every migration filename must ' +
                'start with a YYYY-MM-DD- prefix to apply in authorship order.');
        });
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression', function () {

    const crypto  = require('crypto');
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

    it('every rebaseline pins distinct 64-hex sha256 values (from may be a list)', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const fromList = [].concat(r.from);
            assert.ok(fromList.length >= 1, file + ': from must pin at least one hash');
            for (const from of fromList) {
                assert.match(from, /^[0-9a-f]{64}$/, file + ': from must be a sha256 hex digest');
                assert.notStrictEqual(from, r.to, file + ': from and to must differ');
            }
            assert.strictEqual(new Set(fromList).size, fromList.length,
                file + ': from list must not contain duplicates');
            assert.match(r.to, /^[0-9a-f]{64}$/, file + ': to must be a sha256 hex digest');
        }
    });

    it('the blessed files are pinned toward the committed content', function () {
        // These files' fleet-recorded checksums predate a series of comment-only
        // edits. If a rebaseline entry or one of its historical hashes is ever
        // dropped, un-healed fleet DBs go back to failing every operator migrate
        // run, so pin that each keeps at least its two original revisions. The
        // list only grows: a later comment edit appends another `from` hash.
        const blessed = [
            '2026-06-15-events-data-mediumtext.sql',
            '2026-06-17-pubkeys-add-monotonic-id.sql',
        ];
        for (const file of blessed) {
            const r = Database.MIGRATION_CHECKSUM_REBASELINES[file];
            assert.ok(r, file + ': expected a rebaseline entry');
            assert.ok([].concat(r.from).length >= 2,
                file + ': expected both historical revisions pinned');
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

// Functional coverage of the heal path: drive the real runMigrations() against a
// fake connection whose ledger records a pinned historical checksum, and assert it
// UPDATEs schema_migrations to the blessed hash instead of tripping the
// immutability guard. The same code runs at decoder startup and under
// `node src/migrate.js`, so a fleet-wide re-bless deploys through code rather
// than through direct SQL against each node.
describe('runMigrations() checksum re-bless path @regression', function () {

    const crypto = require('crypto');
    const os     = require('os');

    function makeDb(sqlPath, ledgerRows) {
        const updates = [];
        const conn = {
            async query(sql, params) {
                if (/GET_LOCK/.test(sql))       return [{ l: '1' }];
                if (/RELEASE_LOCK/.test(sql))   return [];
                if (/CREATE TABLE/.test(sql))   return [];
                if (/SELECT name, checksum FROM schema_migrations/.test(sql)) return ledgerRows;
                // Post-run schema-contract assertion (dispensers.expiration BIGINT UNSIGNED).
                // Tested first: that query names information_schema.tables AND .columns.
                if (/information_schema\.tables/.test(sql))  return [{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }];
                // Migration-precondition probe (no precondition file is used here, so this
                // only ever answers an unrelated lookup).
                if (/information_schema\.columns/.test(sql)) return [{ dataType: 'bigint' }];
                if (/^UPDATE schema_migrations SET checksum/.test(sql)) { updates.push(params); return []; }
                throw new Error('unexpected query in fake conn: ' + sql);
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.sqlPath = sqlPath;
        db.dbName  = 'fake_db';
        db.getConnection = async () => conn;
        db._ensureMigrationsLedger = async () => {};
        return { db, updates };
    }

    function tmpMigrationsDir(fileName, content) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-rebless-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        fs.writeFileSync(path.join(root, 'migrations', fileName), content);
        return root;
    }

    const FILE    = '2026-01-01-fake-widen.sql';
    const CONTENT = '-- xchain:migration mode=auto\nALTER TABLE t MODIFY COLUMN d MEDIUMTEXT;\n';
    const NEW_SUM = crypto.createHash('sha256').update(CONTENT).digest('hex');
    const OLD_A   = 'a'.repeat(64);
    const OLD_B   = 'b'.repeat(64);

    afterEach(function () { delete Database.MIGRATION_CHECKSUM_REBASELINES[FILE]; });

    it('heals a recorded checksum listed in `from` (list form) to the blessed hash', async function () {
        const root = tmpMigrationsDir(FILE, CONTENT);
        Database.MIGRATION_CHECKSUM_REBASELINES[FILE] = { from: [OLD_A, OLD_B], to: NEW_SUM };
        const { db, updates } = makeDb(root, [{ name: FILE, checksum: OLD_B }]);
        const res = await db.runMigrations({ includeManual: true });
        assert.deepStrictEqual(updates, [[NEW_SUM, FILE]], 'expected exactly one ledger heal UPDATE');
        assert.deepStrictEqual(res, { applied: [], pending: [], baselined: [], lockSkipped: false });
    });

    it('heals from a single-string `from` (indexer-parity form)', async function () {
        const root = tmpMigrationsDir(FILE, CONTENT);
        Database.MIGRATION_CHECKSUM_REBASELINES[FILE] = { from: OLD_A, to: NEW_SUM };
        const { db, updates } = makeDb(root, [{ name: FILE, checksum: OLD_A }]);
        await db.runMigrations({ includeManual: true });
        assert.deepStrictEqual(updates, [[NEW_SUM, FILE]]);
    });

    it('still fails closed on an unpinned recorded checksum (immutability guard intact)', async function () {
        const root = tmpMigrationsDir(FILE, CONTENT);
        Database.MIGRATION_CHECKSUM_REBASELINES[FILE] = { from: [OLD_A], to: NEW_SUM };
        const { db, updates } = makeDb(root, [{ name: FILE, checksum: 'c'.repeat(64) }]);
        await assert.rejects(() => db.runMigrations({ includeManual: true }), /content CHANGED/);
        assert.deepStrictEqual(updates, [], 'guard must not heal an unpinned hash');
    });

    it('is a no-op when the recorded checksum already matches the file', async function () {
        const root = tmpMigrationsDir(FILE, CONTENT);
        Database.MIGRATION_CHECKSUM_REBASELINES[FILE] = { from: [OLD_A], to: NEW_SUM };
        const { db, updates } = makeDb(root, [{ name: FILE, checksum: NEW_SUM }]);
        const res = await db.runMigrations({ includeManual: true });
        assert.deepStrictEqual(updates, []);
        assert.deepStrictEqual(res, { applied: [], pending: [], baselined: [], lockSkipped: false });
    });
});

// Functional coverage of the per-file scoping (--file / opts.only): drive the real
// runMigrations() against a fake connection over a tmp migrations dir holding several
// pending manual files, and assert only the targeted file is applied while the others
// are left pending and untouched. This is the per-file rollout path: a single pending
// manual migration deploys to a fleet DB without a blanket migrate also applying every
// other pending manual migration in the tree.
describe('runMigrations() --file / opts.only scoping @regression', function () {

    const crypto = require('crypto');
    const os     = require('os');

    // Fake conn that records applied statements + ledger inserts. `ledgerRows` is the
    // pre-existing schema_migrations content (already-applied files).
    function makeDb(sqlPath, ledgerRows) {
        const applied  = [];  // filenames INSERTed into schema_migrations this run
        const executed = [];  // raw non-bookkeeping statements executed
        const conn = {
            async query(sql, params) {
                if (/GET_LOCK/.test(sql))                                      return [{ l: '1' }];
                if (/RELEASE_LOCK/.test(sql))                                  return [];
                if (/CREATE TABLE (IF NOT EXISTS )?schema_migrations/.test(sql)) return [];
                if (/SELECT name, checksum FROM schema_migrations/.test(sql))  return ledgerRows.slice();
                // The BIGINT UNSIGNED contract assertion names both tables, so it is
                // matched first; the bare .columns lookup is the precondition probe.
                if (/information_schema\.tables/.test(sql))                    return [{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }];
                if (/information_schema\.columns/.test(sql))                   return [{ dataType: 'bigint' }];
                if (/^INSERT INTO schema_migrations/.test(sql)) { applied.push(params[0]); return []; }
                if (/^UPDATE schema_migrations SET checksum/.test(sql))        return [];
                // Anything else is a migration body statement.
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.sqlPath = sqlPath;
        db.dbName  = 'fake_db';
        db.getConnection = async () => conn;
        db._ensureMigrationsLedger = async () => {};
        return { db, applied, executed };
    }

    // Each committed file gets its own DDL body so `executed` can distinguish them.
    function tmpMigrationsDir(fileMap) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-only-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        for (const [name, content] of Object.entries(fileMap)) {
            fs.writeFileSync(path.join(root, 'migrations', name), content);
        }
        return root;
    }

    // Deliberately NOT the real 2026-06-13 filename: that file carries a
    // MIGRATION_PRECONDITIONS entry, so using its name here would make this suite
    // (which is about --file scoping) depend on that predicate's verdict.
    const FILE_A = '2026-06-13-some-targeted-manual.sql';
    const FILE_B = '2026-06-14-some-other-manual.sql';
    const BODY_A = '-- xchain:migration mode=manual\nALTER TABLE dispensers MODIFY expiration BIGINT UNSIGNED;\n';
    const BODY_B = '-- xchain:migration mode=manual\nALTER TABLE t ADD COLUMN unrelated INT;\n';

    it('applies ONLY the targeted file and leaves the other pending', async function () {
        const root = tmpMigrationsDir({ [FILE_A]: BODY_A, [FILE_B]: BODY_B });
        const { db, applied, executed } = makeDb(root, []);
        const res = await db.runMigrations({ includeManual: true, only: FILE_A });
        assert.deepStrictEqual(applied, [FILE_A], 'only the targeted file is recorded as applied');
        assert.deepStrictEqual(res.applied, [FILE_A]);
        assert.deepStrictEqual(res.pending, [FILE_B], 'the untargeted file stays pending');
        assert.ok(executed.some((s) => /MODIFY expiration BIGINT/.test(s)), 'targeted DDL ran');
        assert.ok(!executed.some((s) => /unrelated INT/.test(s)), 'untargeted DDL must NOT run');
    });

    it('accepts an array of targets', async function () {
        const root = tmpMigrationsDir({ [FILE_A]: BODY_A, [FILE_B]: BODY_B });
        const { db, applied } = makeDb(root, []);
        const res = await db.runMigrations({ includeManual: true, only: [FILE_A, FILE_B] });
        assert.deepStrictEqual(applied.sort(), [FILE_A, FILE_B].sort());
        assert.deepStrictEqual(res.pending, []);
    });

    it('is idempotent: re-targeting an already-applied file applies nothing', async function () {
        const root = tmpMigrationsDir({ [FILE_A]: BODY_A, [FILE_B]: BODY_B });
        const sumA = crypto.createHash('sha256').update(BODY_A).digest('hex');
        const { db, applied, executed } = makeDb(root, [{ name: FILE_A, checksum: sumA }]);
        const res = await db.runMigrations({ includeManual: true, only: FILE_A });
        assert.deepStrictEqual(applied, [], 'nothing re-applied (target already recorded)');
        assert.deepStrictEqual(res.applied, []);
        // The untargeted, still-unapplied FILE_B is surfaced as pending (remaining work),
        // but is never executed by this scoped run.
        assert.deepStrictEqual(res.pending, [FILE_B]);
        assert.ok(!executed.some((s) => /MODIFY expiration|unrelated INT/.test(s)));
    });

    it('fails loudly on an unknown target (typo protection), applying nothing', async function () {
        const root = tmpMigrationsDir({ [FILE_A]: BODY_A });
        const { db, applied } = makeDb(root, []);
        await assert.rejects(
            () => db.runMigrations({ includeManual: true, only: 'nope-not-a-file.sql' }),
            /target\(s\) not found/);
        assert.deepStrictEqual(applied, [], 'no migration applied when the target is unknown');
    });

    it('a scoped run is NOT blocked by an unrelated undated file in the tree', async function () {
        // A blanket run throws on any undated filename; a scoped run must ignore
        // untargeted files entirely so an unrelated tree quirk cannot block rollout.
        const root = tmpMigrationsDir({ [FILE_A]: BODY_A, 'undated-legacy.sql': BODY_B });
        const { db, applied } = makeDb(root, []);
        const res = await db.runMigrations({ includeManual: true, only: FILE_A });
        assert.deepStrictEqual(applied, [FILE_A]);
        assert.ok(res.pending.includes('undated-legacy.sql'), 'the undated untargeted file is reported pending, not fatal');
    });

    it('throws when opts.only is an empty array (guards a mis-wired caller)', async function () {
        const root = tmpMigrationsDir({ [FILE_A]: BODY_A });
        const { db } = makeDb(root, []);
        await assert.rejects(() => db.runMigrations({ includeManual: true, only: [] }), /empty/);
    });
});

// Migration applicability preconditions. The 2026-06-13 file converts a legacy
// DATETIME expiration to BIGINT UNSIGNED. It is mode=manual, so on a database
// created from the current dispensers.sql - already BIGINT UNSIGNED - it stays PENDING,
// and the blanket `npm run migrate` its own header advertises applies every pending
// manual file. Run there, UNIX_TIMESTAMP() reads raw epoch seconds as a date-form number
// and yields NULL, after which the file drops the good column and renames the all-NULL
// holding column over it. These drive the REAL committed file through the REAL runner.
describe('runMigrations() migration preconditions @regression', function () {

    const crypto = require('crypto');
    const os     = require('os');

    const FILE = '2026-06-13-dispensers-expiration-bigint.sql';
    const REAL = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'sql', 'migrations', FILE), 'utf8');

    // `expirationType` is what information_schema reports for dispensers.expiration:
    // the precondition probe and the post-run contract guard both read it.
    function makeDb(sqlPath, expirationType) {
        const ledgered = [];   // filenames INSERTed into schema_migrations
        const executed = [];   // migration body statements actually run
        const conn = {
            async query(sql, params) {
                if (/GET_LOCK/.test(sql))                                        return [{ l: '1' }];
                if (/RELEASE_LOCK/.test(sql))                                    return [];
                if (/CREATE TABLE (IF NOT EXISTS )?schema_migrations/.test(sql))  return [];
                if (/SELECT name, checksum FROM schema_migrations/.test(sql))     return [];
                // Contract guard first: its query names both information_schema tables.
                if (/information_schema\.tables/.test(sql))
                    return [{ dataType: expirationType,
                              columnType: expirationType === 'bigint' ? 'bigint(20) unsigned' : expirationType }];
                // A real information_schema.columns lookup returns NO ROW for an absent
                // column, which is what expirationType === null models here.
                if (/information_schema\.columns/.test(sql))
                    return (expirationType == null) ? [] : [{ dataType: expirationType }];
                if (/^INSERT INTO schema_migrations/.test(sql)) { ledgered.push(params[0]); return []; }
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.sqlPath = sqlPath;
        db.dbName  = 'fake_db';
        db.getConnection = async () => conn;
        db._ensureMigrationsLedger = async () => {};
        return { db, ledgered, executed };
    }

    function tmpDirWithRealFile() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-precond-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        fs.writeFileSync(path.join(root, 'migrations', FILE), REAL);
        return root;
    }

    it('the committed file still carries the UNCONDITIONAL conversion the precondition guards', function () {
        // Sensitivity anchor: if the SQL is ever made self-guarding, this precondition
        // becomes belt-and-braces and this suite should be revisited rather than trusted.
        assert.match(REAL, /UPDATE dispensers SET expiration_unix = UNIX_TIMESTAMP\(expiration\)/);
        assert.match(REAL, /DROP COLUMN IF EXISTS expiration/);
    });

    it('baselines the DATETIME converter on a BIGINT database instead of destroying it', async function () {
        const { db, ledgered, executed } = makeDb(tmpDirWithRealFile(), 'bigint');
        const res = await db.runMigrations({ includeManual: true });

        assert.deepStrictEqual(res.baselined, [FILE], 'the file is reported as baselined, not applied');
        assert.deepStrictEqual(res.applied, [], 'nothing was applied');
        assert.deepStrictEqual(res.pending, [], 'and it is not left pending to bite the next run');
        assert.deepStrictEqual(ledgered, [FILE], 'schema_migrations records it so it never re-enters this path');
        assert.deepStrictEqual(executed, [], 'NO statement ran: no UNIX_TIMESTAMP, no DROP COLUMN');
    });

    it('still applies the conversion on a legacy DATETIME database', async function () {
        // Teeth for the case above: the precondition must not disarm the migration on the
        // schema it was written for.
        const { db, ledgered, executed } = makeDb(tmpDirWithRealFile(), 'datetime');
        // The post-run contract guard fails closed on DATETIME (the fake reports the type
        // unchanged because nothing really altered it), so assert on what the body ran.
        await assert.rejects(() => db.runMigrations({ includeManual: true }), /BIGINT UNSIGNED is required/);

        assert.ok(executed.some((s) => /UNIX_TIMESTAMP\(expiration\)/.test(s)), 'the conversion ran');
        assert.ok(executed.some((s) => /DROP COLUMN IF EXISTS expiration/.test(s)), 'the drop ran');
        assert.deepStrictEqual(ledgered, [FILE], 'and it was recorded as genuinely applied');
    });

    it('a targeted --file rollout is guarded too, not just the blanket run', async function () {
        // The header advertises the blanket run, but the fleet path is --file; an operator
        // aiming this file at the wrong node must not be able to run it either.
        const { db, executed, ledgered } = makeDb(tmpDirWithRealFile(), 'bigint');
        const res = await db.runMigrations({ includeManual: true, only: FILE });
        assert.deepStrictEqual(res.baselined, [FILE]);
        assert.deepStrictEqual(executed, [], 'a targeted run on a BIGINT column still runs nothing');
        assert.deepStrictEqual(ledgered, [FILE]);
    });

    it('an unattended startup baselines it before an operator can reach for migrate', async function () {
        // includeManual is false at startup, so the old code left the file pending and the
        // hazard armed. The precondition runs ahead of the mode gate for exactly this.
        const { db, executed } = makeDb(tmpDirWithRealFile(), 'bigint');
        const res = await db.runMigrations();
        assert.deepStrictEqual(res.baselined, [FILE]);
        assert.deepStrictEqual(res.pending, [], 'no longer pending, so no later blanket run can apply it');
        assert.deepStrictEqual(executed, []);
    });

    it('does NOT baseline when the expiration column is missing (half-applied run needs an operator)', async function () {
        const { db, executed } = makeDb(tmpDirWithRealFile(), null);
        // An absent column is an absent ANSWER, not a "already converted" verdict: the
        // predicate must decline to baseline, so the body runs and the contract guard then
        // fails closed on the dropped column instead of quietly recording the file as done.
        await assert.rejects(() => db.runMigrations({ includeManual: true }), /has no `expiration` column/);
        assert.ok(executed.some((s) => /UNIX_TIMESTAMP\(expiration\)/.test(s)),
            'the migration body ran rather than being baselined away');
    });

    it('every precondition entry names a committed migration file', function () {
        const dir = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
        for (const name of Object.keys(Database.MIGRATION_PRECONDITIONS)) {
            assert.ok(fs.existsSync(path.join(dir, name)),
                name + ': precondition pins a migration that is not in the tree');
        }
    });

    it('a file with no precondition entry is never baselined', function () {
        const db = Object.create(Database.prototype);
        db.dbName = 'fake_db';
        const conn = { query: async () => { throw new Error('must not query'); } };
        return db._migrationPreconditionSkip('2026-06-15-events-data-mediumtext.sql', conn)
            .then((r) => assert.strictEqual(r, null, 'unlisted files short-circuit without a query'));
    });
});

// Mirrors the xchain-indexer suite for the same splitter. The decoder previously
// used a naive `.split(';')` in both runMigrations and createTable, so a semicolon
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

describe('Database schema-contract guards @regression', function () {

    // Both guards read information_schema through the pool, so a fake connection
    // is enough to exercise the contract without a live DB.
    function contextReturning(rows){
        let released = 0;
        const ctx = {
            dbName: 'decoder_test',
            transactionConnection: null,
            getConnection: async () => ({
                query: async () => rows,
                release: async () => { released++; }
            }),
            releasedCount: () => released
        };
        return ctx;
    }

    // dispensers.expiration must be exactly BIGINT UNSIGNED. The old guard
    // matched the whole integer family on DATA_TYPE alone, so a signed or narrower
    // column passed a check whose own error text demanded BIGINT UNSIGNED. Its query is
    // a LEFT JOIN from information_schema.tables, so an empty result means the table is
    // absent while a NULL dataType means the table exists without the column.
    const expirationGuard = Database.prototype._assertDispenserExpirationIsBigintUnsigned;

    it('accepts dispensers.expiration at BIGINT UNSIGNED', async function () {
        await expirationGuard.call(contextReturning([{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }]));
    });

    it('rejects a SIGNED bigint, which the old DATA_TYPE-only guard let through', async function () {
        await assert.rejects(
            expirationGuard.call(contextReturning([{ dataType: 'bigint', columnType: 'bigint(20)' }])),
            /SIGNED BIGINT\(20\).*BIGINT UNSIGNED is required/s);
    });

    it('rejects a narrower INT UNSIGNED, naming the truncation against the indexer', async function () {
        await assert.rejects(
            expirationGuard.call(contextReturning([{ dataType: 'int', columnType: 'int(10) unsigned' }])),
            /4294967295 does not fit.*xchain-indexer/s);
    });

    it('rejects a narrower signed INT too', async function () {
        await assert.rejects(
            expirationGuard.call(contextReturning([{ dataType: 'int', columnType: 'int(11)' }])),
            /BIGINT UNSIGNED is required/);
    });

    it('rejects the pre-migration DATETIME and names the migration that converts it', async function () {
        await assert.rejects(
            expirationGuard.call(contextReturning([{ dataType: 'datetime', columnType: 'datetime' }])),
            /2026-06-13-dispensers-expiration-bigint\.sql/);
    });

    it('never points a drifted INTEGER column at the DATETIME converter migration', async function () {
        // Naming that file here would tell an operator to run UNIX_TIMESTAMP() over raw
        // epoch seconds, which NULLs every row: the exact data loss the precondition
        // guard above exists to prevent.
        for (const row of [{ dataType: 'bigint', columnType: 'bigint(20)' },
                           { dataType: 'int',    columnType: 'int(10) unsigned' }]) {
            const err = await expirationGuard.call(contextReturning([row])).then(
                () => null, (e) => e);
            assert.ok(err, 'expected a throw for ' + row.columnType);
            assert.ok(!/2026-06-13-dispensers-expiration-bigint\.sql/.test(err.message),
                'a drifted integer column must not be sent to the DATETIME converter: ' + err.message);
            assert.match(err.message, /ALTER TABLE dispensers MODIFY expiration BIGINT UNSIGNED/);
        }
    });

    it('distinguishes a dropped column (drift, throws) from an absent table (skip)', async function () {
        // The LEFT JOIN yields one row with a NULL dataType when dispensers exists but
        // has no expiration column: a half-applied migration, which the old guard's
        // `if(!rows.length) return` silently treated as a fresh install.
        await assert.rejects(
            expirationGuard.call(contextReturning([{ dataType: null, columnType: null }])),
            /has no `expiration` column.*CHANGE COLUMN expiration_unix/s);
        // No row at all: the table itself does not exist yet.
        await expirationGuard.call(contextReturning([]));
    });

    it('releases the pooled connection on the expiration pass and throw paths', async function () {
        const ok = contextReturning([{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }]);
        await expirationGuard.call(ok);
        assert.strictEqual(ok.releasedCount(), 1);

        const bad = contextReturning([{ dataType: 'bigint', columnType: 'bigint(20)' }]);
        await assert.rejects(expirationGuard.call(bad));
        assert.strictEqual(bad.releasedCount(), 1);
    });

    const pubkeyGuard = Database.prototype._assertPubkeyColumnIsUncompressedWide;

    it('accepts a pubkeys.pubkey wide enough for an uncompressed key', async function () {
        await pubkeyGuard.call(contextReturning([{ len: 130 }]));
    });

    it('rejects the pre-widen VARCHAR(66), naming the seam field it would corrupt', async function () {
        await assert.rejects(
            pubkeyGuard.call(contextReturning([{ len: 66 }])),
            /pubkeys\.pubkey holds 66 chars.*source_pubkey/s);
    });

    it('is a no-op when the pubkeys table does not exist yet', async function () {
        await pubkeyGuard.call(contextReturning([]));
    });

    it('releases the pooled connection on both the pass and the throw path', async function () {
        const ok = contextReturning([{ len: 130 }]);
        await pubkeyGuard.call(ok);
        assert.strictEqual(ok.releasedCount(), 1);

        const bad = contextReturning([{ len: 66 }]);
        await assert.rejects(pubkeyGuard.call(bad));
        assert.strictEqual(bad.releasedCount(), 1);
    });

    it('runs the pubkey guard on every runMigrations exit path, lock-skip included', async function () {
        // The guard rides the public wrapper, not the body, so a contended run
        // (which applies nothing) still fails loud on a half-migrated schema.
        const calls = [];
        const ctx = {
            _runMigrationsInner: async () => ({ applied: [], pending: [], lockSkipped: true }),
            _assertDispenserExpirationIsBigintUnsigned: async () => { calls.push('dispenser'); },
            _assertPubkeyColumnIsUncompressedWide: async () => { calls.push('pubkey'); },
            _assertActionDataIsUtf8mb4: async () => { calls.push('utf8mb4'); }
        };
        const result = await Database.prototype.runMigrations.call(ctx);
        assert.deepStrictEqual(calls, ['dispenser', 'pubkey', 'utf8mb4']);
        assert.strictEqual(result.lockSkipped, true);
    });

    // The action-text charset is a mode=manual widen (a charset conversion rewrites every
    // row), and alterTableForDrift never retypes an existing column, so nothing heals a
    // missed node. `transactions` is replicated by xchain-sync, so an un-migrated node
    // quarantines a non-BMP ACTION that a migrated node stores: a fleet divergence, which
    // is why this fails closed rather than warning.
    const utf8Guard = Database.prototype._assertActionDataIsUtf8mb4;

    it('accepts both action-text columns already at utf8mb4', async function () {
        await utf8Guard.call(contextReturning([
            { tbl: 'transactions', cs: 'utf8mb4' },
            { tbl: 'mempool_transactions', cs: 'utf8mb4' }
        ]));
    });

    it('rejects a transactions.data still at utf8mb3, naming the quarantine it causes', async function () {
        await assert.rejects(
            utf8Guard.call(contextReturning([{ tbl: 'transactions', cs: 'utf8mb3' }])),
            /transactions\.data uses charset utf8mb3.*1366.*quarantined/s);
    });

    it('rejects a half-migrated pair where only the mempool column lagged', async function () {
        await assert.rejects(
            utf8Guard.call(contextReturning([
                { tbl: 'transactions', cs: 'utf8mb4' },
                { tbl: 'mempool_transactions', cs: 'utf8mb3' }
            ])),
            /mempool_transactions\.data uses charset utf8mb3/);
    });

    it('is a no-op when the tables do not exist yet', async function () {
        await utf8Guard.call(contextReturning([]));
    });

    it('releases the pooled connection on the utf8mb4 pass and throw paths', async function () {
        const ok = contextReturning([{ tbl: 'transactions', cs: 'utf8mb4' }]);
        await utf8Guard.call(ok);
        assert.strictEqual(ok.releasedCount(), 1);

        const bad = contextReturning([{ tbl: 'transactions', cs: 'utf8mb3' }]);
        await assert.rejects(utf8Guard.call(bad));
        assert.strictEqual(bad.releasedCount(), 1);
    });
});
