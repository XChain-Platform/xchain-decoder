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
 * Deploy-precondition contract.
 *
 * A startup assertion that requires an operator-gated migration is a deploy
 * precondition: build the code, ship it to a database that never applied the
 * migration, and the service crash-loops on boot. A v0.10.0 fleet deploy put five
 * of nine decoders into exactly that state, because none of the three migrations
 * this tree asserts at startup carried a header the deploy tool could read.
 *
 * The fix has two halves that must agree: Database.STARTUP_ASSERTED_MIGRATIONS
 * (what this code asserts) and the `deploy-precondition=required` header tag in
 * each migration file (what the deploy tool can read out of a source tree it has
 * only cloned). This suite is what keeps them in step. Mirrors the equivalent
 * suite in xchain-indexer.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

const modeOf = Database.prototype._migrationMode.bind({});
const readMigration = (file) => fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
const allMigrations = () => fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();

describe('Database.migrationDeclaresDeployPrecondition @regression @tier1', function () {

    it('reads the tag off the xchain:migration directive line', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE t MODIFY c VARCHAR(130);'), true);
    });

    it('tolerates spacing around the token', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '--   xchain:migration  mode = manual   deploy-precondition = required\nALTER TABLE t;'), true);
    });

    it('is false for an ordinary tagged migration', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '-- xchain:migration mode=manual\nALTER TABLE t;'), false);
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '-- xchain:migration mode=auto\nALTER TABLE t;'), false);
    });

    it('is false for an untagged file and for empty input', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition('ALTER TABLE t;'), false);
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(''), false);
    });

    it('ignores the token once the SQL body has started, so prose or a data literal cannot arm it', function () {
        // Same prologue anchoring as _migrationMode: a comment AFTER the first statement
        // is body text. Without this, a migration that merely discusses the convention
        // would be read as declaring itself a precondition and block every deploy.
        const raw = 'ALTER TABLE t;\n-- xchain:migration mode=manual deploy-precondition=required\n';
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(raw), false);
    });

    it('ignores the token on a comment line that is not the xchain:migration directive', function () {
        const raw = '-- deploy-precondition=required (prose about another file)\n-- xchain:migration mode=manual\nALTER TABLE t;';
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(raw), false);
    });

    it('sees the tag through a long license banner (the prologue is unbounded)', function () {
        const banner = Array(30).fill('-- license line').join('\n');
        const raw = banner + '\n\n-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE t;';
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(raw), true);
    });
});

describe('Database.STARTUP_ASSERTED_MIGRATIONS @regression @tier1', function () {

    it('registers exactly the three migrations this tree asserts at startup', function () {
        const files = Database.STARTUP_ASSERTED_MIGRATIONS.map(m => m.file).sort();
        assert.deepStrictEqual(files, [
            '2026-06-13-dispensers-expiration-bigint.sql',
            '2026-07-24-pubkeys-widen-uncompressed.sql',
            '2026-08-10-action-data-utf8mb4.sql',
        ].sort());
    });

    Database.STARTUP_ASSERTED_MIGRATIONS.forEach(function (entry) {

        it(entry.file + ': the registered migration exists on disk', function () {
            assert.ok(fs.existsSync(path.join(MIG_DIR, entry.file)),
                entry.file + ' is registered as a startup-asserted migration but is not in ' + MIG_DIR +
                '; the deploy guard would look for a row no file can ever produce.');
        });

        it(entry.file + ': carries the deploy-precondition header tag', function () {
            assert.strictEqual(Database.migrationDeclaresDeployPrecondition(readMigration(entry.file)), true,
                entry.file + ' is asserted at startup but does not declare `' + Database.DEPLOY_PRECONDITION_TAG +
                '` in its header, so the deploy tool cannot see the requirement and the next fleet deploy ' +
                'discovers it as a crash-loop.');
        });

        it(entry.file + ': is mode=manual (an auto migration cannot be a missing precondition)', function () {
            assert.strictEqual(modeOf(readMigration(entry.file)), 'manual',
                entry.file + ' is tagged auto, so it applies itself at the first startup that sees it and ' +
                'has no business being a deploy precondition. Either the tag or the registration is wrong.');
        });

        it(entry.file + ': names a real assertion method on Database', function () {
            assert.strictEqual(typeof Database.prototype[entry.assertion], 'function',
                entry.assertion + ' is registered but is not a method on Database.prototype - the registry ' +
                'names an assertion this class does not define.');
        });
    });

    it('every tagged migration file is registered (no tag without an assertion behind it)', function () {
        const registered = new Set(Database.STARTUP_ASSERTED_MIGRATIONS.map(m => m.file));
        const tagged = allMigrations().filter(f => Database.migrationDeclaresDeployPrecondition(readMigration(f)));
        const orphans = tagged.filter(f => !registered.has(f));
        assert.deepStrictEqual(orphans, [],
            'these files declare themselves deploy preconditions but no startup assertion is registered for ' +
            'them, so every deploy would be refused for a requirement this code does not actually have: ' +
            orphans.join(', '));
    });

    it('no mode=auto migration carries the tag', function () {
        const offenders = allMigrations().filter(f => {
            const raw = readMigration(f);
            return Database.migrationDeclaresDeployPrecondition(raw) && modeOf(raw) === 'auto';
        });
        assert.deepStrictEqual(offenders, [], 'auto migrations self-apply and can never be the missing ' +
            'precondition; tagging one makes the deploy guard refuse a deploy it should let through: ' + offenders.join(', '));
    });

    describe('startupAssertedMigrationFile()', function () {
        it('resolves each registered assertion to its migration filename', function () {
            assert.strictEqual(Database.startupAssertedMigrationFile('_assertDispenserExpirationIsBigintUnsigned'),
                '2026-06-13-dispensers-expiration-bigint.sql');
            assert.strictEqual(Database.startupAssertedMigrationFile('_assertPubkeyColumnIsUncompressedWide'),
                '2026-07-24-pubkeys-widen-uncompressed.sql');
            assert.strictEqual(Database.startupAssertedMigrationFile('_assertActionDataIsUtf8mb4'),
                '2026-08-10-action-data-utf8mb4.sql');
        });
        it('throws on an unregistered assertion rather than yielding undefined', function () {
            // "node src/migrate.js --file undefined" is worse than useless in the middle
            // of an outage; the lookup must fail where the registry is wrong.
            assert.throws(() => Database.startupAssertedMigrationFile('_assertSomethingNobodyRegistered'),
                /STARTUP_ASSERTED_MIGRATIONS/);
        });
    });
});

describe('startup assertion error text names the registered file @regression @tier1', function () {

    // Minimal fake connections: each assertion only reads its own information_schema
    // rows, so a bare object with getConnection is enough to exercise the error text.
    function ctxReturning(rows) {
        return {
            dbName: 'test_decoder',
            transactionConnection: null,
            getConnection: async () => ({
                query: async () => rows,
                release: async () => {}
            })
        };
    }

    it('_assertDispenserExpirationIsBigintUnsigned names the exact migration file', async function () {
        let message = null;
        try {
            await Database.prototype._assertDispenserExpirationIsBigintUnsigned.call(
                ctxReturning([{ dataType: 'datetime', columnType: 'datetime' }]));
        } catch (err) {
            message = err.message;
        }
        assert.ok(message, 'a DATETIME column must fail the assertion');
        assert.ok(message.includes('--file 2026-06-13-dispensers-expiration-bigint.sql'),
            'the halt message must name the migration; got: ' + message);
    });

    it('_assertPubkeyColumnIsUncompressedWide names the exact migration file', async function () {
        let message = null;
        try {
            await Database.prototype._assertPubkeyColumnIsUncompressedWide.call(ctxReturning([{ len: 66 }]));
        } catch (err) {
            message = err.message;
        }
        assert.ok(message, 'a 66-char column must fail the assertion');
        assert.ok(message.includes('--file 2026-07-24-pubkeys-widen-uncompressed.sql'),
            'the halt message must name the migration; got: ' + message);
    });

    it('_assertActionDataIsUtf8mb4 names the exact migration file', async function () {
        let message = null;
        try {
            await Database.prototype._assertActionDataIsUtf8mb4.call(
                ctxReturning([{ tbl: 'transactions', cs: 'utf8mb3' }]));
        } catch (err) {
            message = err.message;
        }
        assert.ok(message, 'a utf8mb3 column must fail the assertion');
        assert.ok(message.includes('--file 2026-08-10-action-data-utf8mb4.sql'),
            'the halt message must name the migration; got: ' + message);
    });
});

describe('Database.MIGRATION_PRECONDITIONS: pubkeys widen predicate @regression', function () {

    const skipWhen = Database.MIGRATION_PRECONDITIONS['2026-07-24-pubkeys-widen-uncompressed.sql'].skipWhen;

    it('baselines when the column already holds an uncompressed key (130 chars)', function () {
        const reason = skipWhen([{ len: 130 }]);
        assert.ok(reason, 'expected a baseline reason string');
        assert.match(reason, /already 130 characters wide/);
    });

    it('baselines when the column is wider than required', function () {
        assert.ok(skipWhen([{ len: 191 }]));
    });

    it('does NOT baseline at the pre-migration shape (narrow VARCHAR(66))', function () {
        assert.strictEqual(skipWhen([{ len: 66 }]), null);
    });

    it('does NOT baseline when the column is absent', function () {
        assert.strictEqual(skipWhen([]), null);
    });

    it('does NOT baseline when the length is unreadable (NULL)', function () {
        assert.strictEqual(skipWhen([{ len: null }]), null);
    });
});

describe('Database.MIGRATION_PRECONDITIONS: action-data utf8mb4 predicate @regression', function () {

    const skipWhen = Database.MIGRATION_PRECONDITIONS['2026-08-10-action-data-utf8mb4.sql'].skipWhen;

    it('baselines when both columns already carry utf8mb4', function () {
        const reason = skipWhen([
            { tbl: 'transactions', cs: 'utf8mb4' },
            { tbl: 'mempool_transactions', cs: 'utf8mb4' },
        ]);
        assert.ok(reason, 'expected a baseline reason string');
        assert.match(reason, /already utf8mb4/);
    });

    it('does NOT baseline at the pre-migration shape (both still utf8mb3)', function () {
        assert.strictEqual(skipWhen([
            { tbl: 'transactions', cs: 'utf8mb3' },
            { tbl: 'mempool_transactions', cs: 'utf8mb3' },
        ]), null);
    });

    it('does NOT baseline a half-converted pair (one column still lagging)', function () {
        assert.strictEqual(skipWhen([
            { tbl: 'transactions', cs: 'utf8mb4' },
            { tbl: 'mempool_transactions', cs: 'utf8mb3' },
        ]), null);
    });

    it('does NOT baseline when either column is absent', function () {
        assert.strictEqual(skipWhen([]), null);
        assert.strictEqual(skipWhen([{ tbl: 'transactions', cs: 'utf8mb4' }]), null);
    });

    it('does NOT baseline when a charset is unreadable (NULL)', function () {
        assert.strictEqual(skipWhen([
            { tbl: 'transactions', cs: null },
            { tbl: 'mempool_transactions', cs: 'utf8mb4' },
        ]), null);
    });
});
