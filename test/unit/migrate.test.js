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
 * Operator migration CLI (src/migrate.js) contract tests (no live DB).
 *
 * migrate.js is the ONLY path that applies manual/destructive migrations,
 * so these pin its operator-facing contract: the env guard exits 2 before
 * any DB handle is built, the runner is invoked with includeManual:true,
 * a runner failure sets exitCode 1 (not a crash), and the pool is closed
 * in the finally block on both success and failure.
 *
 * migrate.js runs main() at require time, so each test injects a fake
 * Database into the require cache, fresh-requires the CLI, and awaits a
 * deferred that the fake's pool.end() resolves.
 *
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');

const DB_PATH      = require.resolve('../../src/db.js');
const MIGRATE_PATH = require.resolve('../../src/migrate.js');
const DOTENV_PATH  = require.resolve('dotenv');

const ENV_KEYS = ['DECODER_DB_HOST', 'DECODER_DB_PORT', 'DECODER_DB_NAME',
                  'DECODER_DB_USER', 'DECODER_DB_PASS'];

describe('migrate.js operator CLI @regression', function () {

    let savedEnv, savedExitCode, savedArgv, exitStub, consoleErrStub, consoleLogStub;

    beforeEach(function () {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        savedExitCode = process.exitCode;
        // Pin a clean argv baseline so the CLI's --file parser sees no stray flags
        // from the mocha invocation; individual tests append their own targeting args.
        savedArgv = process.argv;
        process.argv = ['node', 'migrate.js'];
        exitStub       = sinon.stub(process, 'exit');
        consoleErrStub = sinon.stub(console, 'error');
        consoleLogStub = sinon.stub(console, 'log');
    });

    afterEach(function () {
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
    });

    // Build a fake Database class; `done` resolves when pool.end() runs
    // (the CLI's finally block), which is the end of main() on every path.
    function makeFakeDb({ runMigrations }) {
        let resolveDone;
        const done = new Promise((res) => { resolveDone = res; });
        const state = { constructed: [], poolEnded: false, runArgs: null, done };
        class FakeDatabase {
            constructor(host, port, name, user, pass) {
                state.constructed.push({ host, port, name, user, pass });
                this.pool = {
                    end: async () => { state.poolEnded = true; resolveDone(); }
                };
            }
            async runMigrations(opts) {
                state.runArgs = opts;
                return runMigrations(opts);
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
        // Neutralize migrate.js's require-time dotenv.config(): a .env in the
        // checkout (CI renders one per run) would repopulate the DECODER_DB_*
        // vars these tests deliberately unset.
        require.cache[DOTENV_PATH] = {
            id: DOTENV_PATH, filename: DOTENV_PATH, loaded: true,
            exports: { config: () => ({ parsed: {} }) }
        };
        require(MIGRATE_PATH);
    }

    it('env guard: exits 2 when DECODER_DB_HOST/NAME/USER are unset', async function () {
        const fake = makeFakeDb({ runMigrations: async () => ({ applied: [], pending: [] }) });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done; // process.exit is stubbed, so main() runs through
        assert.strictEqual(exitStub.calledWith(2), true, 'expected process.exit(2)');
        assert.match(consoleErrStub.firstCall.args[0], /DECODER_DB_HOST \/ DECODER_DB_NAME \/ DECODER_DB_USER must be set/);
    });

    it('success path: applies with includeManual:true, reports, closes the pool, exit code stays clean', async function () {
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        const fake = makeFakeDb({
            runMigrations: async () => ({ applied: ['003-x.sql'], pending: ['004-manual.sql'] })
        });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(exitStub.called, false, 'no hard exit on success');
        assert.strictEqual(process.exitCode, savedExitCode, 'exitCode untouched on success');
        assert.strictEqual(fake.constructed.length, 1);
        assert.strictEqual(fake.constructed[0].name, 'decoder_test');
        assert.deepStrictEqual(fake.runArgs, { includeManual: true },
            'the CLI must arm the manual-apply path');
        assert.strictEqual(fake.poolEnded, true, 'pool closed in finally');
        const out = consoleLogStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.match(out, /applied=\["003-x\.sql"\]/);
        assert.match(out, /still-pending=\["004-manual\.sql"\]/);
    });

    it('failure path: runMigrations rejection sets exitCode 1 and still closes the pool', async function () {
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        const fake = makeFakeDb({
            runMigrations: async () => { throw new Error('duplicate column boom'); }
        });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(process.exitCode, 1, 'failure must set exitCode 1');
        assert.strictEqual(exitStub.called, false, 'no process.exit on runner failure');
        assert.strictEqual(fake.poolEnded, true, 'pool closed in finally even on failure');
        const err = consoleErrStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.match(err, /migrate: FAILED: .*duplicate column boom/);
    });

    it('lock-skip path: reports SKIPPED and exits 2 instead of a false done @regression', async function () {
        // A contended run examines nothing, so reporting 'done. applied=[]
        // still-pending=[]' with exit 0 tells the operator the schema is
        // migrated when it may not be. Matches the indexer CLI's behaviour.
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        const fake = makeFakeDb({
            runMigrations: async () => ({ applied: [], pending: [], lockSkipped: true })
        });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(process.exitCode, 2, 'a contended run must exit 2');
        assert.strictEqual(fake.poolEnded, true, 'pool closed in finally');
        const out = consoleLogStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.doesNotMatch(out, /migrate: done\./, 'must not claim the run completed');
        const err = consoleErrStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.match(err, /migrate: SKIPPED/);
        assert.match(err, /xchain_migrate_decoder_test/);
    });

    it('--file: scopes the run to the named migration (passes opts.only) @regression', async function () {
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        process.argv = ['node', 'migrate.js', '--file', '2026-06-13-dispensers-expiration-bigint.sql'];
        const fake = makeFakeDb({
            runMigrations: async () => ({ applied: ['2026-06-13-dispensers-expiration-bigint.sql'], pending: ['other.sql'] })
        });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(exitStub.called, false);
        assert.deepStrictEqual(fake.runArgs, {
            includeManual: true,
            only: ['2026-06-13-dispensers-expiration-bigint.sql']
        }, 'the CLI must scope the run to the targeted file while keeping manual apply armed');
        assert.strictEqual(fake.poolEnded, true);
        const out = consoleLogStub.getCalls().map((c) => c.args[0]).join('\n');
        assert.match(out, /applying ONLY targeted migration\(s\)/);
    });

    it('--file=NAME and repeated flags accumulate (comma-separated too) @regression', async function () {
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        process.argv = ['node', 'migrate.js', '--file=a.sql,b.sql', '--file', 'c.sql', '-f', 'd.sql'];
        const fake = makeFakeDb({ runMigrations: async () => ({ applied: [], pending: [] }) });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.deepStrictEqual(fake.runArgs, {
            includeManual: true,
            only: ['a.sql', 'b.sql', 'c.sql', 'd.sql']
        });
    });

    it('--file with no value exits 2 before building a DB handle @regression', async function () {
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        process.argv = ['node', 'migrate.js', '--file'];
        const fake = makeFakeDb({ runMigrations: async () => ({ applied: [], pending: [] }) });
        // process.exit is stubbed, so main() continues past the guard; assert the
        // exit(2) signal and the actionable error fired before any migration ran.
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(exitStub.calledWith(2), true, 'expected process.exit(2) on a valueless --file');
        assert.match(consoleErrStub.getCalls().map((c) => c.args[0]).join('\n'),
            /--file requires a migration filename argument/);
    });

    it('default run (no --file) still applies everything with includeManual only @regression', async function () {
        process.env.DECODER_DB_HOST = 'db.test';
        process.env.DECODER_DB_NAME = 'decoder_test';
        process.env.DECODER_DB_USER = 'tester';
        const fake = makeFakeDb({ runMigrations: async () => ({ applied: [], pending: [] }) });
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.deepStrictEqual(fake.runArgs, { includeManual: true },
            'a blanket run must NOT set opts.only');
    });
});
