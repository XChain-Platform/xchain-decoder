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

// Functional coverage of the heal path: drive the real runMigrations() against a
// fake connection whose ledger records a pinned historical checksum, and assert it
// UPDATEs schema_migrations to the blessed hash instead of tripping the
// immutability guard. The same code runs at decoder startup and under
// `node src/db/migrate.js`, so a fleet-wide re-bless deploys through code rather
// than through direct SQL against each node.
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
        db.ensureMigrationsLedger = async () => {};
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

describe('runMigrations() checksum re-bless path @regression', function () {

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

describe('runMigrations() checksum re-bless path @regression', function () {

    afterEach(function () { delete Database.MIGRATION_CHECKSUM_REBASELINES[FILE]; });

    // a production BTC decoder recorded 2026-05-28-unique-index-tables.sql at its ORIGINAL
    // shipped revision (8151979, deployed 2026-06-10 .. 2026-07-10), which predates the
    // `@mempool_has_ids` guard revision the table pinned. Only the guard revision was
    // blessed, so that node tripped the immutability guard at every startup. Drive the real
    // runMigrations() over the real committed file with the historical hash in the ledger:
    // it must heal to the committed sha256 rather than throw.
    describe('2026-05-28-unique-index-tables.sql historical revisions', function () {

        const REAL_FILE = '2026-05-28-unique-index-tables.sql';
        // sha256 of the file as shipped by 8151979, before the mempool guard landed. This is
        // what the affected fleet DBs carry in schema_migrations; it is a fixed historical
        // fact, so it is pinned here rather than recomputed.
        const SHIPPED_8151979 = 'e1f7df7973881b6fcaa5535fe5aca86b82bb7f45fa4e7e5fdcf9c5859c468207';
        const GUARDED_50a5e83 = '8845b9addc0990b0433f8862969b57cb472535474b4b4d5576c408db777b57ce';

        const realPath    = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations', REAL_FILE);
        const realContent = fs.readFileSync(realPath, 'utf8');
        const realSum     = crypto.createHash('sha256').update(realContent).digest('hex');

        for (const [label, recorded] of [
            ['the original shipped revision (8151979)', SHIPPED_8151979],
            ['the guarded revision (50a5e83)',          GUARDED_50a5e83],
        ]) {
            it('heals a ledger recording ' + label, async function () {
                const root = tmpMigrationsDir(REAL_FILE, realContent);
                const { db, updates } = makeDb(root, [{ name: REAL_FILE, checksum: recorded }]);
                const res = await db.runMigrations({ includeManual: true });
                assert.deepStrictEqual(updates, [[realSum, REAL_FILE]],
                    'expected the ledger to be healed to the committed checksum');
                assert.deepStrictEqual(res.applied, [], 'an already-applied file must not re-run');
            });
        }

        it('still fails closed on a revision that was never shipped', async function () {
            const root = tmpMigrationsDir(REAL_FILE, realContent);
            const { db, updates } = makeDb(root, [{ name: REAL_FILE, checksum: 'd'.repeat(64) }]);
            await assert.rejects(() => db.runMigrations({ includeManual: true }), /content CHANGED/);
            assert.deepStrictEqual(updates, [], 'an unpinned hash must not be healed');
        });
    });
});
