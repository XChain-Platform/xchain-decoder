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
    const expirationGuard = Database.prototype.assertDispenserExpirationIsBigintUnsigned;

describe('Database schema-contract guards @regression', function () {

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

});

describe('Database schema-contract guards @regression', function () {

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

});

    const pubkeyGuard = Database.prototype.assertPubkeyColumnIsUncompressedWide;

describe('Database schema-contract guards @regression', function () {

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
            runMigrationsInner: async () => ({ applied: [], pending: [], lockSkipped: true }),
            assertDispenserExpirationIsBigintUnsigned: async () => { calls.push('dispenser'); },
            assertPubkeyColumnIsUncompressedWide: async () => { calls.push('pubkey'); },
            assertActionDataIsUtf8mb4: async () => { calls.push('utf8mb4'); }
        };
        const result = await Database.prototype.runMigrations.call(ctx);
        assert.deepStrictEqual(calls, ['dispenser', 'pubkey', 'utf8mb4']);
        assert.strictEqual(result.lockSkipped, true);
    });

});

    // The action-text charset is a mode=manual widen (a charset conversion rewrites every
    // row), and alterTableForDrift never retypes an existing column, so nothing heals a
    // missed node. `transactions` is replicated by xchain-sync, so an un-migrated node
    // quarantines a non-BMP ACTION that a migrated node stores: a fleet divergence, which
    // is why this fails closed rather than warning.
    const utf8Guard = Database.prototype.assertActionDataIsUtf8mb4;

describe('Database schema-contract guards @regression', function () {

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
