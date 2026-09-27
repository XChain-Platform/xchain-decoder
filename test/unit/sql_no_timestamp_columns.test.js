// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Database = require('../../src/db.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const SQL_DIR = path.join(ROOT_DIR, 'src', 'sql');
const FIRST_SEEN_MIGRATION = path.join(
    SQL_DIR,
    'migrations',
    '2026-09-27-mempool-first-seen-datetime.sql'
);

const inventoryOnly = process.argv.includes('--dry-run');

if(!inventoryOnly) describe('SQL DATETIME completeness', function () {
    it('declares no TIMESTAMP columns in top-level SQL definitions', function () {
        const offenders = [];
        const definitions = fs.readdirSync(SQL_DIR, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
            .map(entry => entry.name)
            .sort();

        for(const filename of definitions){
            const sql = fs.readFileSync(path.join(SQL_DIR, filename), 'utf8');
            sql.split(/\r?\n/).forEach((line, index) => {
                const declaration = line.replace(/--.*$/, '').trim();
                if(/^(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)\s+TIMESTAMP\b/i.test(declaration)){
                    offenders.push(`src/sql/${filename}:${index + 1}`);
                }
            });
        }

        assert.deepStrictEqual(
            offenders,
            [],
            `TIMESTAMP column declarations found: ${offenders.join(', ')}`
        );
    });

    it('declares the migration ledger applied_at column as DATETIME', async function () {
        const statements = [];
        const conn = {
            query: async statement => {
                statements.push(statement);
                return /^SELECT DATA_TYPE/i.test(statement) ? [{ dataType: 'timestamp' }] : [];
            }
        };
        await Database.prototype.ensureMigrationsLedger(conn);
        const create = statements.find(statement => /^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(statement));

        assert.ok(create, 'missing schema_migrations CREATE TABLE statement');
        assert.match(create, /\bapplied_at\s+DATETIME\b/i);
        assert.doesNotMatch(statements.join('\n'), /\bapplied_at\s+TIMESTAMP\b/i);
    });

    it('sets UTC before converting mempool first_seen to DATETIME', function () {
        const migration = fs.readFileSync(FIRST_SEEN_MIGRATION, 'utf8')
            .replace(/--.*$/gm, '');
        const timezoneIndex = migration.search(/SET\s+time_zone\s*=\s*'\+00:00'\s*;/i);
        const modifyIndex = migration.search(/MODIFY\s+first_seen\s+DATETIME\b/i);

        assert.notStrictEqual(timezoneIndex, -1, "missing SET time_zone = '+00:00';");
        assert.notStrictEqual(modifyIndex, -1, 'missing MODIFY first_seen DATETIME');
        assert.ok(timezoneIndex < modifyIndex, 'SET time_zone must precede MODIFY first_seen');
    });

    it('pins direct and pooled database connections to UTC', function () {
        const db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass');

        assert.strictEqual(db.connectionPoolParams.timezone, 'Z');
        assert.strictEqual(db.connectionParams.timezone, 'Z');
    });
});
