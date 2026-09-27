'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const schema = fs.readFileSync(path.join(SQL_DIR, 'mempool_transactions.sql'), 'utf8');
const migration = fs.readFileSync(
    path.join(SQL_DIR, 'migrations', '2026-09-27-mempool-first-seen-datetime.sql'),
    'utf8'
);

describe('mempool first_seen DATETIME migration @regression', function () {
    it('declares no TIMESTAMP column and declares first_seen DATETIME NOT NULL', function () {
        const declarations = schema.replace(/--.*$/gm, '').split(/\r?\n/).map(line => line.trim());
        const timestampColumn = declarations.find(line =>
            /^[A-Za-z_][A-Za-z0-9_]*\s+TIMESTAMP\b/i.test(line));
        assert.strictEqual(timestampColumn, undefined);
        assert.ok(declarations.some(line => /^first_seen\s+DATETIME\s+NOT\s+NULL\b/i.test(line)));
    });

    it('is manual without a deploy precondition and orders the conversion statements', function () {
        assert.strictEqual(Database.prototype.migrationMode(migration), 'manual');
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(migration), false);
        assert.deepStrictEqual(Database.prototype.splitSqlStatements(migration), [
            "SET time_zone = '+00:00'",
            'ALTER TABLE mempool_transactions MODIFY first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'
        ]);
    });

    it('baselines only when first_seen is already DATETIME', function () {
        const precondition = Database.MIGRATION_PRECONDITIONS[
            '2026-09-27-mempool-first-seen-datetime.sql'
        ];
        assert.strictEqual(typeof precondition.skipWhen([{ dataType: 'DATETIME' }]), 'string');
        assert.strictEqual(precondition.skipWhen([{ dataType: 'timestamp' }]), null);
        assert.strictEqual(precondition.skipWhen([]), null);
    });
});
