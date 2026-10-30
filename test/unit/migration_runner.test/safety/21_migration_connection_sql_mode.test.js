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
 * Schema migration runner: sql_mode on the connection that applies the files.
 *
 * Drives the real runMigrations() against fake connections whose reported sql_mode
 * differs per connection, and pins that the connection running GET_LOCK and the files
 * is itself checked, and closed rather than pooled when it is refused.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const Database = require('../../../../src/db');

const FILE = '2026-06-13-some-targeted-manual.sql';
const BODY = '-- xchain:migration mode=manual\nALTER TABLE t MODIFY c BIGINT UNSIGNED;\n';

// Fake conn reporting `mode` for sql_mode; `calls` records every query and the counts track hand-back.
function makeConn(mode) {
    const calls = [];
    const counts = { release: 0, destroy: 0 };
    const conn = {
        calls, counts,
        async query(sql) {
            calls.push(sql);
            if (/@@SESSION\.sql_mode/.test(sql)) return [{ mode }];
            if (/GET_LOCK/.test(sql)) return [{ l: '1' }];
            if (/SELECT name, checksum FROM schema_migrations/.test(sql)) return [];
            if (/information_schema\.tables/.test(sql)) return [{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }];
            return [];
        },
        async release() { counts.release += 1; },
        async destroy() { counts.destroy += 1; },
    };
    return conn;
}

// A db whose getConnection hands out `conns` in order (the last one repeats).
function makeDb(conns) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-mconn-'));
    fs.mkdirSync(path.join(root, 'migrations'));
    fs.writeFileSync(path.join(root, 'migrations', FILE), BODY);
    const db = Object.create(Database.prototype);
    Object.assign(db, { sqlPath: root, dbName: 'fake_db', connectionPoolParams: { queryTimeout: 30000 } });
    let n = 0;
    db.getConnection = async () => conns[Math.min(n++, conns.length - 1)];
    db.ensureMigrationsLedger = async () => {};
    return db;
}

describe('runMigrations() checks sql_mode on the migration connection @regression', function () {

    it('refuses a lax migration connection before GET_LOCK and closes it', async function () {
        const lax = makeConn('NO_ENGINE_SUBSTITUTION');
        const db = makeDb([lax]);
        await assert.rejects(db.runMigrationsInner({ includeManual: true }), /must be strict/);
        assert.ok(!lax.calls.some((sql) => /GET_LOCK/.test(sql)), 'no lock taken on a refused session');
        assert.deepStrictEqual(lax.counts, { release: 0, destroy: 1 });
    });

    it('refuses when the wrapper check passed on a strict connection but the migration connection is lax', async function () {
        const strict = makeConn('STRICT_TRANS_TABLES');
        const lax = makeConn('');
        const db = makeDb([strict, lax]);
        await assert.rejects(db.runMigrations({ includeManual: true }), /must be strict/);
        assert.strictEqual(strict.counts.release, 1, 'the wrapper check releases its own connection');
        assert.ok(!lax.calls.some((sql) => /GET_LOCK|MODIFY c BIGINT/.test(sql)), 'no lock and no file on the lax session');
        assert.deepStrictEqual(lax.counts, { release: 0, destroy: 1 });
    });

    it('refuses NO_BACKSLASH_ESCAPES on the migration connection', async function () {
        const conn = makeConn('STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES');
        const db = makeDb([conn]);
        await assert.rejects(db.runMigrationsInner({ includeManual: true }), /NO_BACKSLASH_ESCAPES/);
        assert.strictEqual(conn.counts.destroy, 1);
    });

    it('checks the migration connection before GET_LOCK and applies the file on a strict session', async function () {
        const conn = makeConn('STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION');
        const db = makeDb([conn]);
        const result = await db.runMigrationsInner({ includeManual: true });
        assert.deepStrictEqual(result.applied, [FILE]);
        const modeAt = conn.calls.findIndex((sql) => /@@SESSION\.sql_mode/.test(sql));
        const lockAt = conn.calls.findIndex((sql) => /GET_LOCK/.test(sql));
        assert.ok(modeAt >= 0 && modeAt < lockAt, 'sql_mode read precedes GET_LOCK');
    });

    it('assertStrictSqlMode(conn) checks a caller-owned connection without releasing it', async function () {
        const conn = makeConn('STRICT_TRANS_TABLES');
        const db = makeDb([makeConn('STRICT_TRANS_TABLES')]);
        await db.assertStrictSqlMode(conn);
        assert.deepStrictEqual(conn.counts, { release: 0, destroy: 0 });
        assert.deepStrictEqual(conn.calls, ['SELECT @@SESSION.sql_mode AS mode']);
    });
});
