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
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const DB_PATH      = require.resolve('../../src/db.js');
const MIGRATE_PATH = require.resolve('../../src/db/migrate.js');
const DOTENV_PATH  = require.resolve('dotenv');
const ENV_KEYS = ['DECODER_DB_HOST', 'DECODER_DB_PORT', 'DECODER_DB_NAME',
                  'DECODER_DB_USER', 'DECODER_DB_PASS'];

let savedEnv, savedExitCode, savedArgv, exitStub, consoleErrStub, consoleLogStub;
let tmpDir, fileA, fileB, fileC;

function prepareMigrateTest() {
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    savedExitCode = process.exitCode;
    savedArgv = process.argv;
    process.argv = ['node', 'migrate.js'];
    exitStub       = sinon.stub(process, 'exit');
    consoleErrStub = sinon.stub(console, 'error');
    consoleLogStub = sinon.stub(console, 'log');
}

function restoreMigrateTest() {
    sinon.restore();
    process.exitCode = savedExitCode;
    process.argv = savedArgv;
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    delete require.cache[MIGRATE_PATH];
    delete require.cache[DB_PATH];
    delete require.cache[DOTENV_PATH];
}

function makeFakeDb({ runMigrations }) {
    const state = { constructed: [], poolEnded: false, runArgs: null };
    class FakeDatabase {
        constructor(host, port, name, user, pass) {
            state.constructed.push({ host, port, name, user, pass });
        }
        async runMigrations(opts) {
            state.runArgs = opts;
            return runMigrations(opts);
        }
    }
    state.FakeDatabase = FakeDatabase;
    return state;
}

function makeFakeDbForStatus({ sqlPath, appliedNames, queryError }) {
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    const state = {
        constructed: [], poolEnded: false, done,
        getConnectionCalls: 0, queries: [], releaseCalls: 0,
        runMigrationsCalled: false, runArgs: null,
    };
    class FakeDatabase {
        constructor(host, port, name, user, pass) {
            state.constructed.push({ host, port, name, user, pass });
            this.sqlPath = sqlPath;
            this.transactionConnection = null;
            this.pool = { end: async () => { state.poolEnded = true; resolveDone(); } };
        }
        async getConnection() {
            state.getConnectionCalls++;
            return {
                query: async (sql) => {
                    state.queries.push(sql);
                    if (queryError) throw queryError;
                    return (appliedNames || []).map((n) => ({ name: n }));
                },
                release: async () => { state.releaseCalls++; }
            };
        }
        async runMigrations(opts) {
            state.runMigrationsCalled = true;
            state.runArgs = opts;
            return { applied: [], pending: [] };
        }
    }
    state.FakeDatabase = FakeDatabase;
    return state;
}

function loadMigrateWith(fakeDbClass) {
    delete require.cache[MIGRATE_PATH];
    require.cache[DB_PATH] = {
        id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDbClass
    };
    require.cache[DOTENV_PATH] = {
        id: DOTENV_PATH, filename: DOTENV_PATH, loaded: true,
        exports: { config: () => ({ parsed: {} }) }
    };
    require(MIGRATE_PATH);
}

function prepareStatusTest() {
    prepareMigrateTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-migrate-status-'));
    const migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fileA = '2026-01-01-a.sql';
    fileB = '2026-01-02-b.sql';
    fileC = '2026-01-03-c.sql';
    for (const file of [fileA, fileB, fileC]) {
        fs.writeFileSync(path.join(migrationsDir, file), '-- xchain:migration mode=auto\nSELECT 1;\n');
    }
}

function restoreStatusTest() {
    restoreMigrateTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

function setEnv() {
    process.env.DECODER_DB_HOST = 'db.test';
    process.env.DECODER_DB_NAME = 'decoder_test';
    process.env.DECODER_DB_USER = 'tester';
}

function statusSuiteHooks() {
    beforeEach(prepareStatusTest);
    afterEach(restoreStatusTest);
}

describe('migrate.js operator CLI --status/--json @regression', function () {
    statusSuiteHooks();

    it('--status --json prints one JSON object with applied and pending arrays and applies nothing', async function () {
        setEnv();
        process.argv = ['node', 'migrate.js', '--status', '--json'];
        const fake = makeFakeDbForStatus({ sqlPath: tmpDir, appliedNames: [fileA] });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;

        assert.strictEqual(exitStub.called, false, 'a successful status run must not hard-exit');
        assert.strictEqual(process.exitCode, savedExitCode, 'exitCode must stay clean');
        assert.strictEqual(fake.runMigrationsCalled, false, '--status must never call runMigrations (applies nothing)');
        assert.strictEqual(fake.getConnectionCalls, 1);
        assert.strictEqual(fake.queries.length, 1, 'exactly one query: the status SELECT');
        assert.match(fake.queries[0], /SELECT\s+name\s+FROM\s+schema_migrations/i);
        assert.ok(!/INSERT|UPDATE|DELETE|CREATE\s+TABLE|GET_LOCK/i.test(fake.queries[0]),
            'status must issue no write and take no lock');
        assert.strictEqual(fake.releaseCalls, 1, 'the status connection must be released');
        assert.strictEqual(fake.poolEnded, true);

        const jsonLine = consoleLogStub.getCalls().map((c) => c.args[0]).find((l) => l.startsWith('{'));
        assert.ok(jsonLine, 'expected a JSON object line on stdout');
        assert.deepStrictEqual(JSON.parse(jsonLine), { applied: [fileA], pending: [fileB, fileC] });
    });

    it('--status --json on a fresh database (no ledger table) reports everything pending', async function () {
        setEnv();
        process.argv = ['node', 'migrate.js', '--status', '--json'];
        const noSuchTable = Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
        const fake = makeFakeDbForStatus({ sqlPath: tmpDir, queryError: noSuchTable });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;

        assert.strictEqual(fake.runMigrationsCalled, false);
        assert.strictEqual(fake.releaseCalls, 1, 'release must still run when the query rejects');
        const jsonLine = consoleLogStub.getCalls().map((c) => c.args[0]).find((l) => l.startsWith('{'));
        assert.deepStrictEqual(JSON.parse(jsonLine), { applied: [], pending: [fileA, fileB, fileC] });
    });
});

describe('migrate.js operator CLI --status/--json @regression', function () {
    statusSuiteHooks();

    it('--status without --json prints a human-readable line instead of JSON', async function () {
        setEnv();
        process.argv = ['node', 'migrate.js', '--status'];
        const fake = makeFakeDbForStatus({ sqlPath: tmpDir, appliedNames: [fileA, fileB] });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;

        assert.strictEqual(fake.runMigrationsCalled, false);
        const out = consoleLogStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.match(out, /migrate: status\. applied=\["2026-01-01-a\.sql","2026-01-02-b\.sql"\] pending=\["2026-01-03-c\.sql"\]/);
        assert.ok(!out.split('\n').some((l) => l.startsWith('{')), '--status alone must not print a JSON line');
    });

    it('a real query failure during --status still fails loudly and closes the pool', async function () {
        setEnv();
        process.argv = ['node', 'migrate.js', '--status', '--json'];
        const fake = makeFakeDbForStatus({ sqlPath: tmpDir, queryError: new Error('connection refused') });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;

        assert.strictEqual(process.exitCode, 1, 'a real status failure must set exitCode 1');
        assert.strictEqual(fake.poolEnded, true, 'pool closed in finally even on status failure');
        const err = consoleErrStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.match(err, /migrate: FAILED: .*connection refused/);
    });
});

describe('migrate.js operator CLI --status/--json @regression', function () {
    statusSuiteHooks();

    it('--json without --status is refused: exit 2, no DB handle opened, no run', function () {
        process.argv = ['node', 'migrate.js', '--json'];
        const fake = makeFakeDb({ runMigrations: async () => ({ applied: [], pending: [] }) });
        loadMigrateWith(fake.FakeDatabase);
        assert.strictEqual(exitStub.calledWith(2), true);
        assert.strictEqual(fake.runArgs, null, '--json alone must not run migrations');
        assert.strictEqual(fake.constructed.length, 0, '--json alone must never construct a DB handle');
        assert.match(consoleErrStub.getCalls().map((c) => c.args[0]).join('\n'), /--json requires --status/);
    });

    it('--status combined with --file is refused: exit 2, no DB handle opened, no run', function () {
        process.argv = ['node', 'migrate.js', '--status', '--file', 'a.sql'];
        const fake = makeFakeDb({ runMigrations: async () => ({ applied: [], pending: [] }) });
        loadMigrateWith(fake.FakeDatabase);
        assert.strictEqual(exitStub.calledWith(2), true);
        assert.strictEqual(fake.runArgs, null);
        assert.strictEqual(fake.constructed.length, 0);
        assert.match(consoleErrStub.getCalls().map((c) => c.args[0]).join('\n'), /--status cannot be combined with --file/);
    });
});
