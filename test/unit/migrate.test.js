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

const ENV_KEYS = ['DECODER_DB_HOST', 'DECODER_DB_PORT', 'DECODER_DB_NAME',
                  'DECODER_DB_USER', 'DECODER_DB_PASS'];

describe('migrate.js operator CLI @regression', function () {

    let savedEnv, savedExitCode, exitStub, consoleErrStub, consoleLogStub;

    beforeEach(function () {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        savedExitCode = process.exitCode;
        exitStub       = sinon.stub(process, 'exit');
        consoleErrStub = sinon.stub(console, 'error');
        consoleLogStub = sinon.stub(console, 'log');
    });

    afterEach(function () {
        sinon.restore();
        process.exitCode = savedExitCode;
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        delete require.cache[MIGRATE_PATH];
        delete require.cache[DB_PATH];
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
});
