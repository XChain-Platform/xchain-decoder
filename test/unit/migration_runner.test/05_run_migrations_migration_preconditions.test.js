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

const Database = require('../../../src/db');

// Migration applicability preconditions. The 2026-06-13 file converts a legacy
// DATETIME expiration to BIGINT UNSIGNED. It is mode=manual, so on a database
// created from the current dispensers.sql - already BIGINT UNSIGNED - it stays PENDING,
// and the blanket `npm run migrate` its own header advertises applies every pending
// manual file. Run there, UNIX_TIMESTAMP() reads raw epoch seconds as a date-form number
// and yields NULL, after which the file drops the good column and renames the all-NULL
// holding column over it. These drive the REAL committed file through the REAL runner.
    const crypto = require('crypto');
    const os     = require('os');

    const FILE = '2026-06-13-dispensers-expiration-bigint.sql';
    const REAL = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations', FILE), 'utf8');

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
        db.ensureMigrationsLedger = async () => {};
        return { db, ledgered, executed };
    }

    function tmpDirWithRealFile() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-precond-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        fs.writeFileSync(path.join(root, 'migrations', FILE), REAL);
        return root;
    }

describe('runMigrations() migration preconditions @regression', function () {

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

});

describe('runMigrations() migration preconditions @regression', function () {

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

});

describe('runMigrations() migration preconditions @regression', function () {

    it('every precondition entry names a committed migration file', function () {
        const dir = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
        for (const name of Object.keys(Database.MIGRATION_PRECONDITIONS)) {
            assert.ok(fs.existsSync(path.join(dir, name)),
                name + ': precondition pins a migration that is not in the tree');
        }
    });

    it('a file with no precondition entry is never baselined', function () {
        const db = Object.create(Database.prototype);
        db.dbName = 'fake_db';
        const conn = { query: async () => { throw new Error('must not query'); } };
        return db.migrationPreconditionSkip('2026-06-15-events-data-mediumtext.sql', conn)
            .then((r) => assert.strictEqual(r, null, 'unlisted files short-circuit without a query'));
    });
});
