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

    it('the  blessed files are pinned toward the committed content', function () {
        // The two files whose fleet-recorded checksums predate the comment-only
        // edits (follower-ordering note, header-comment fix, license header).
        // If a rebaseline entry is ever dropped, un-healed fleet DBs go back to
        // failing every operator migrate run; pin their presence.
        const blessed = [
            '2026-06-15-events-data-mediumtext.sql',
            '2026-06-17-pubkeys-add-monotonic-id.sql',
        ];
        for (const file of blessed) {
            const r = Database.MIGRATION_CHECKSUM_REBASELINES[file];
            assert.ok(r, file + ': expected an  rebaseline entry');
            assert.strictEqual([].concat(r.from).length, 2,
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
// immutability guard. This is the fleet-wide re-bless path : the same code
// runs at decoder startup and under `node src/migrate.js`, so the heal deploys
// through code, never through direct SQL.
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
                // Post-run schema-contract assertion (dispensers.expiration type check).
                if (/information_schema\.columns/.test(sql)) return [{ DATA_TYPE: 'bigint' }];
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
        assert.deepStrictEqual(res, { applied: [], pending: [], lockSkipped: false });
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
        assert.deepStrictEqual(res, { applied: [], pending: [], lockSkipped: false });
    });
});

// Functional coverage of the per-file scoping (--file / opts.only): drive the real
// runMigrations() against a fake connection over a tmp migrations dir holding several
// pending manual files, and assert only the targeted file is applied while the others
// are left pending and untouched. This is the fleet per-file rollout path :
// a single pending manual migration deploys to a fleet DB without a blanket migrate
// also applying every other pending manual migration in the tree.
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
                if (/information_schema\.columns/.test(sql))                   return [{ DATA_TYPE: 'bigint' }];
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

    const FILE_A = '2026-06-13-dispensers-expiration-bigint.sql';
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
            _assertDispenserExpirationIsInteger: async () => { calls.push('dispenser'); },
            _assertPubkeyColumnIsUncompressedWide: async () => { calls.push('pubkey'); }
        };
        const result = await Database.prototype.runMigrations.call(ctx);
        assert.deepStrictEqual(calls, ['dispenser', 'pubkey']);
        assert.strictEqual(result.lockSkipped, true);
    });
});
