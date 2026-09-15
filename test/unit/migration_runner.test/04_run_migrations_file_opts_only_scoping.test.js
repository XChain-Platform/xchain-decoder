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

// Functional coverage of the per-file scoping (--file / opts.only): drive the real
// runMigrations() against a fake connection over a tmp migrations dir holding several
// pending manual files, and assert only the targeted file is applied while the others
// are left pending and untouched. This is the per-file rollout path: a single pending
// manual migration deploys to a fleet DB without a blanket migrate also applying every
// other pending manual migration in the tree.
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
        db.ensureMigrationsLedger = async () => {};
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

describe('runMigrations() --file / opts.only scoping @regression', function () {

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

});

describe('runMigrations() --file / opts.only scoping @regression', function () {

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

});

describe('runMigrations() --file / opts.only scoping @regression', function () {

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
