'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const assert = require('assert');
const sinon = require('sinon');

const observability = require('../../src/observability');
const CRASH_REPORTING_PATH = require.resolve('../../src/api/crash_reporting');

let addedListeners;
let errorStub;
let exitStub;

function loadCrashReporting({ loggerThrows = false } = {}) {
    exitStub = sinon.stub(process, 'exit');
    errorStub = sinon.stub();
    if (loggerThrows) errorStub.throws(new Error('logger unavailable'));
    sinon.stub(observability, 'getLogger').returns({ error: errorStub });
    delete require.cache[CRASH_REPORTING_PATH];
    return require(CRASH_REPORTING_PATH);
}

function rememberAddedListeners(event, before) {
    const added = process.listeners(event).filter((listener) => !before.includes(listener));
    for (const listener of added) addedListeners.push({ event, listener });
    return added;
}

function restoreCrashReportingTest() {
    for (const { event, listener } of addedListeners) process.removeListener(event, listener);
    delete require.cache[CRASH_REPORTING_PATH];
    sinon.restore();
}

describe('reportStartFailure', function () {
    beforeEach(function () { addedListeners = []; });
    afterEach(restoreCrashReportingTest);

    it('logs an Error with reorg halt context and exits once', function () {
        const { reportStartFailure } = loadCrashReporting();

        reportStartFailure(
            { reorgHalted: true, reorgHaltReason: 'depth' },
            new Error('boom')
        );

        assert.strictEqual(exitStub.calledOnceWithExactly(1), true);
        assert.strictEqual(errorStub.calledOnce, true);
        const [message, fields] = errorStub.firstCall.args;
        assert.strictEqual(message, 'CRASH');
        assert.strictEqual(fields.kind, 'startFailure');
        assert.strictEqual(fields.err, 'boom');
        assert.match(fields.stack, /Error: boom/);
        assert.strictEqual(fields.reorgHalted, true);
        assert.strictEqual(fields.reorgHaltReason, 'depth');
    });

    it('normalizes a non-Error without a stack or halt context', function () {
        const { reportStartFailure } = loadCrashReporting();

        reportStartFailure({}, 'plain');

        assert.strictEqual(exitStub.calledOnceWithExactly(1), true);
        const [message, fields] = errorStub.firstCall.args;
        assert.strictEqual(message, 'CRASH');
        assert.strictEqual(fields.kind, 'startFailure');
        assert.strictEqual(fields.err, 'plain');
        assert.strictEqual(fields.stack, undefined);
        assert.strictEqual(fields.reorgHalted, false);
        assert.strictEqual(fields.reorgHaltReason, null);
    });

    it('exits exactly once when the logger throws', function () {
        const { reportStartFailure } = loadCrashReporting({ loggerThrows: true });

        reportStartFailure({}, new Error('boom'));

        assert.strictEqual(errorStub.calledOnce, true);
        assert.strictEqual(exitStub.calledOnceWithExactly(1), true);
    });
});

describe('installCrashHandlers', function () {
    beforeEach(function () { addedListeners = []; });
    afterEach(restoreCrashReportingTest);

    it('installs one handler per event with the required log and exit behavior', function () {
        const uncaughtBefore = process.listeners('uncaughtException');
        const rejectionBefore = process.listeners('unhandledRejection');
        const { installCrashHandlers } = loadCrashReporting();

        installCrashHandlers({});

        const uncaught = rememberAddedListeners('uncaughtException', uncaughtBefore);
        const rejection = rememberAddedListeners('unhandledRejection', rejectionBefore);
        assert.strictEqual(uncaught.length, 1);
        assert.strictEqual(rejection.length, 1);

        uncaught[0](new Error('uncaught boom'));
        assert.strictEqual(exitStub.calledOnceWithExactly(1), true);
        assert.strictEqual(errorStub.firstCall.args[0], 'CRASH');
        assert.strictEqual(errorStub.firstCall.args[1].kind, 'uncaughtException');
        assert.strictEqual(errorStub.firstCall.args[1].err, 'uncaught boom');

        rejection[0]('nope');
        assert.strictEqual(errorStub.secondCall.args[0], 'CRASH');
        assert.strictEqual(errorStub.secondCall.args[1].kind, 'unhandledRejection');
        assert.strictEqual(errorStub.secondCall.args[1].err, 'nope');
        assert.strictEqual(exitStub.calledOnce, true);
    });
});
