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
 * verifyTables() must skip non-.sql entries in src/sql.
 *
 * src/sql now contains a `migrations/` subdirectory alongside the table .sql
 * files. verifyTables iterates the directory; its guard was `if(file.indexOf('.sql'))`,
 * but indexOf returns -1 (which is truthy) for a name without '.sql', so it tried
 * to treat `migrations` as a table and read a directory as a file (EISDIR), crashing
 * decoder startup. Unit tests never ran the real verifyTables, so CI missed it; this
 * exercises it against the real src/sql directory with a stubbed DB.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');

describe('Database.verifyTables() file filtering @regression', function () {

    it('src/sql contains a non-.sql entry (the migrations dir): the regression trigger', function () {
        const entries = fs.readdirSync(SQL_DIR);
        const nonSql = entries.filter(e => !e.endsWith('.sql'));
        assert.ok(nonSql.includes('migrations'),
            'expected src/sql/migrations to exist (this test guards verifyTables against it)');
    });

    it('completes without choking on the migrations/ directory (no EISDIR)', async function () {
        // All real table names "already exist", so each .sql takes the (stubbed)
        // alterTableForDrift path and no real DDL runs. The migrations/ dir must be
        // skipped entirely; before the fix it threw EISDIR here.
        const tableNames = fs.readdirSync(SQL_DIR)
            .filter(f => f.endsWith('.sql'))
            .map(f => f.slice(0, f.indexOf('.sql')));

        let alterCalls = [];
        const dbLike = {
            sqlPath: SQL_DIR,
            dbName: 'TEST_DB',
            getConnection: async () => ({
                query: async (sql) => {
                    if (/SHOW TABLES/i.test(sql)) return tableNames.map(t => ({ 'Tables_in_TEST_DB': t }));
                    return [];
                },
            }),
            releaseConnection: async () => {},
            alterTableForDrift: async (file) => { alterCalls.push(file); },
            reconcileTableIndexes: async () => {},
            createTable: async (file) => { alterCalls.push('CREATE:' + file); },
        };

        const result = await Database.prototype.verifyTables.call(dbLike);
        assert.strictEqual(result, true, 'verifyTables should succeed');
        assert.ok(!alterCalls.some(f => /migrations/.test(f)),
            'the migrations/ directory must never be treated as a table');
        assert.ok(alterCalls.length >= tableNames.length, 'every real .sql table should be reconciled');
    });
});
