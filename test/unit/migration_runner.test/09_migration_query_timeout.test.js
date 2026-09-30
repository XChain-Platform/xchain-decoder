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
 * Schema migration runner: the migration-scoped statement timeout.
 *
 * Drives the real runMigrations() against a fake connection that records every query
 * in order, and pins that the pool's runtime limit is lifted only while migrations run
 * and restored before the advisory lock is released.
 *
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const Database = require('../../../src/db');

const FILE = '2026-06-13-some-targeted-manual.sql';
const BODY = '-- xchain:migration mode=manual\nALTER TABLE t MODIFY c BIGINT UNSIGNED;\n';
const SET_RE = /^SET SESSION max_statement_time/;

// Fake conn: `calls` is every query in order; `opts` flips the lock, a failing body or restore.
function makeDb(ledgerRows = [], opts = {}) {
    const calls = [];
    const counts = { release: 0, destroy: 0 };
    const conn = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (/GET_LOCK/.test(sql)) return [{ l: opts.lock === false ? '0' : '1' }];
            if (SET_RE.test(sql) && opts.failRestore && params[0] === 30) throw new Error('restore boom');
            if (/SELECT name, checksum FROM schema_migrations/.test(sql)) return ledgerRows.slice();
            if (/information_schema\.tables/.test(sql)) return [{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }];
            if (/MODIFY c BIGINT/.test(sql) && opts.failBody) throw new Error('body boom');
            return [];
        },
        async release() { counts.release += 1; },
        async destroy() { counts.destroy += 1; },
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-mqt-'));
    fs.mkdirSync(path.join(root, 'migrations'));
    fs.writeFileSync(path.join(root, 'migrations', FILE), BODY);
    const db = Object.create(Database.prototype);
    Object.assign(db, { sqlPath: root, dbName: 'fake_db', connectionPoolParams: { queryTimeout: 30000 } });
    db.getConnection = async () => conn;
    db.ensureMigrationsLedger = async () => {};
    return { db, calls, counts };
}

function sessionValues(calls) {
    return calls.filter((c) => SET_RE.test(c.sql)).map((c) => c.params[0]);
}

function indexOf(calls, re) {
    return calls.findIndex((c) => re.test(c.sql));
}

// Run `fn` with MIGRATE_QUERY_TIMEOUT set to `value` (undefined unsets it), then restore it.
async function withTimeoutEnv(value, fn) {
    const saved = process.env.MIGRATE_QUERY_TIMEOUT;
    if (value === undefined) delete process.env.MIGRATE_QUERY_TIMEOUT;
    else process.env.MIGRATE_QUERY_TIMEOUT = value;
    try { return await fn(); }
    finally {
        if (saved === undefined) delete process.env.MIGRATE_QUERY_TIMEOUT;
        else process.env.MIGRATE_QUERY_TIMEOUT = saved;
    }
}

describe('runMigrations() migration-scoped statement timeout @regression', function () {

    it('raises the limit after GET_LOCK and restores it before RELEASE_LOCK', async function () {
        const { db, calls } = makeDb();
        await withTimeoutEnv(undefined, () => db.runMigrations({ includeManual: true }));
        assert.deepStrictEqual(sessionValues(calls), [3600, 30]);
        const [raise, restore] = calls.map((c, i) => (SET_RE.test(c.sql) ? i : -1)).filter((i) => i >= 0);
        assert.ok(indexOf(calls, /GET_LOCK/) < raise && raise < indexOf(calls, /SELECT name, checksum/));
        assert.ok(indexOf(calls, /MODIFY c BIGINT/) < restore && restore < indexOf(calls, /RELEASE_LOCK/));
    });

    for (const [raw, want] of [['0', [0, 30]], ['900000', [900, 30]], ['abc', [3600, 30]], ['-5', [3600, 30]]]) {
        it(`reads MIGRATE_QUERY_TIMEOUT=${raw} as session values ${want.join(', ')}`, async function () {
            const { db, calls } = makeDb();
            await withTimeoutEnv(raw, () => db.runMigrations({ includeManual: true }));
            assert.deepStrictEqual(sessionValues(calls), want);
        });
    }

    it('restores the limit before RELEASE_LOCK when a statement fails', async function () {
        const { db, calls } = makeDb([], { failBody: true });
        await assert.rejects(() => db.runMigrations({ includeManual: true }), /body boom/);
        assert.deepStrictEqual(sessionValues(calls), [3600, 30]);
        assert.ok(calls.findLastIndex((c) => SET_RE.test(c.sql)) < indexOf(calls, /RELEASE_LOCK/));
    });

    it('never touches the session when the lock is not acquired', async function () {
        const { db, calls } = makeDb([], { lock: false });
        const res = await db.runMigrationsInner({ includeManual: true });
        assert.strictEqual(res.lockSkipped, true);
        assert.deepStrictEqual(sessionValues(calls), []);
    });

});

describe('runMigrations() migration-scoped statement timeout on scoped runs @regression', function () {

    it('leaves the session alone for a scoped run with nothing to apply', async function () {
        const sum = crypto.createHash('sha256').update(BODY).digest('hex');
        const { db, calls } = makeDb([{ name: FILE, checksum: sum }]);
        await db.runMigrations({ includeManual: true, only: FILE });
        assert.deepStrictEqual(sessionValues(calls), []);
    });

    it('raises and restores the limit for a scoped run that applies its file', async function () {
        const { db, calls } = makeDb();
        await withTimeoutEnv(undefined, () => db.runMigrations({ includeManual: true, only: FILE }));
        assert.deepStrictEqual(sessionValues(calls), [3600, 30]);
    });

    it('destroys instead of pooling the connection when the restore fails', async function () {
        const { db, counts } = makeDb([], { failRestore: true });
        const res = await withTimeoutEnv(undefined, () => db.runMigrationsInner({ includeManual: true }));
        assert.deepStrictEqual(res.applied, [FILE]);
        assert.deepStrictEqual(counts, { release: 0, destroy: 1 });
    });

});
