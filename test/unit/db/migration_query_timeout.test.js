'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const CONFIG_PATH = require.resolve('../../../src/config');
const MODULE_PATH = require.resolve('../../../src/db/migration_query_timeout');
const RELEASE_LOCK_SQL = 'SELECT RELEASE_LOCK(?)';
const SET_TIMEOUT_SQL = 'SET SESSION max_statement_time = ?';

function reloadModule() {
    delete require.cache[CONFIG_PATH];
    delete require.cache[MODULE_PATH];
    return require(MODULE_PATH);
}

async function withTimeoutEnvironment(value, action) {
    const saved = process.env.MIGRATE_QUERY_TIMEOUT;
    process.env.MIGRATE_QUERY_TIMEOUT = value;
    try { return await action(reloadModule()); }
    finally {
        if (saved === undefined) delete process.env.MIGRATE_QUERY_TIMEOUT;
        else process.env.MIGRATE_QUERY_TIMEOUT = saved;
        delete require.cache[CONFIG_PATH];
        delete require.cache[MODULE_PATH];
    }
}

function recordingConnection(rejectedTimeoutSeconds) {
    const calls = [];
    let destroyCalls = 0;
    return {
        calls,
        get destroyCalls() { return destroyCalls; },
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === SET_TIMEOUT_SQL && params[0] === rejectedTimeoutSeconds) {
                throw new Error('restore failed');
            }
        },
        async destroy() { destroyCalls += 1; },
    };
}

describe('db/migration_query_timeout', function () {
    it('exports a one-hour default migration timeout', function () {
        const { DEFAULT_MIGRATE_QUERY_TIMEOUT_MS } = reloadModule();
        assert.strictEqual(DEFAULT_MIGRATE_QUERY_TIMEOUT_MS, 3600000);
    });

    for (const [raw, expected] of [['0', 0], ['5000', 5000], ['', 3600000], ['abc', 3600000], ['-1', 3600000]]) {
        it(`reads MIGRATE_QUERY_TIMEOUT=${JSON.stringify(raw)}`, async function () {
            await withTimeoutEnvironment(raw, ({ migrationQueryTimeoutMs }) => {
                assert.strictEqual(migrationQueryTimeoutMs(), expected);
            });
        });
    }

    it('releases an untouched session without changing its timeout', async function () {
        const { migrationSession } = reloadModule();
        const conn = recordingConnection();
        const released = await migrationSession(conn, 'migration-lock', 30000).release();

        assert.strictEqual(released, true);
        assert.deepStrictEqual(conn.calls, [
            { sql: RELEASE_LOCK_SQL, params: ['migration-lock'] },
        ]);
    });

    it('activates once, restores the runtime timeout, and releases the lock', async function () {
        await withTimeoutEnvironment('5000', async ({ migrationSession }) => {
            const conn = recordingConnection();
            const session = migrationSession(conn, 'migration-lock', 30000);

            await session.activate();
            await session.activate();
            const released = await session.release();

            assert.strictEqual(released, true);
            assert.deepStrictEqual(conn.calls, [
                { sql: SET_TIMEOUT_SQL, params: [5] },
                { sql: SET_TIMEOUT_SQL, params: [30] },
                { sql: RELEASE_LOCK_SQL, params: ['migration-lock'] },
            ]);
        });
    });

    it('releases and destroys the connection when timeout restoration fails', async function () {
        const { migrationSession } = reloadModule();
        const conn = recordingConnection(30);
        const session = migrationSession(conn, 'migration-lock', 30000);

        await session.activate();
        const released = await session.release();

        assert.strictEqual(released, false);
        assert.deepStrictEqual(conn.calls, [
            { sql: SET_TIMEOUT_SQL, params: [3600] },
            { sql: SET_TIMEOUT_SQL, params: [30] },
            { sql: RELEASE_LOCK_SQL, params: ['migration-lock'] },
        ]);
        assert.strictEqual(conn.destroyCalls, 1);
    });
});
