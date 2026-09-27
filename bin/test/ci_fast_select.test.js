'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolveBase, selectFastTests } = require('../ci_fast_select');

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function list_tests() {
    return git(['ls-files', '--', 'test']).split('\n').filter(Boolean);
}

function find_requirers(needle) {
    try {
        return git(['grep', '-l', '-F', '--', needle, '--', 'src', 'test', 'bin']).split('\n').filter(Boolean);
    } catch (error) {
        if (error.status === 1) return [];
        throw error;
    }
}

function select(changed) {
    return selectFastTests(changed, { listTests: list_tests, findRequirers: find_requirers });
}

describe('ci fast selector', function() {
    it('maps a non-consensus source to basename and grep-discovered tests', function() {
        const plan = select(['src/api/crash_reporting.js']);
        assert.strictEqual(plan.consensus, false);
        assert(plan.tests.some((test) => test.group === 'unit' && test.file === 'test/unit/crash_reporting.test.js'));
        assert(plan.tests.some((test) => test.group === 'chaos' && test.file === 'test/chaos/ce08_signal_handling.test.js'));
    });

    it('widens changes to decoder and protocol internals', function() {
        for (const file of ['src/XChainDecoder/startup.js', 'src/protocol/constants.js']) {
            const plan = select([file]);
            assert.strictEqual(plan.consensus, true);
            assert(plan.reasons.some((reason) => reason.includes(file)));
        }
    });

    it('selects nothing for documentation alone', function() {
        assert.deepStrictEqual(select(['README.md']), { consensus: false, reasons: [], tests: [] });
    });

    it('widens a package manifest change', function() {
        const plan = select(['package.json']);
        assert.strictEqual(plan.consensus, true);
        assert(plan.reasons.some((reason) => reason.includes('package.json')));
    });

    it('defers a tracked integration test outside the runner groups', function() {
        const file = git(['ls-files', 'test/integration/*.test.js']).split('\n')[0];
        assert(file);
        const plan = select([file]);
        assert.strictEqual(plan.consensus, false);
        assert.deepStrictEqual(plan.tests, []);
        assert(plan.reasons.includes(`deferred: ${file}`));
    });

    it('returns null when neither base can be resolved', function() {
        const stub = (args) => {
            if (args[0] === 'cat-file') throw new Error('unknown commit');
            throw new Error('no merge base');
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git: stub }), null);
    });

    it('returns a push base accepted by git', function() {
        const sha = '0123456789abcdef';
        const calls = [];
        const stub = (args) => {
            calls.push(args);
            return '';
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: sha }, git: stub }), sha);
        assert.deepStrictEqual(calls, [['cat-file', '-e', `${sha}^{commit}`]]);
    });

    it('keeps the fast gate wiring and Docker tier names pinned', function() {
        const script = fs.readFileSync('bin/ci-full.sh', 'utf8');
        const plan_invocations = script.match(/^.*ci_fast_select\.js --plan.*$/gm) || [];
        assert.deepStrictEqual(plan_invocations, [
            '  if FAST_CI_PLAN="$(node bin/ci_fast_select.js --plan 2>&1)"; then'
        ]);
        assert(script.includes(
            'if [ "${CI_TIER:-full}" = "fast" ]; then\n' +
            '  if FAST_CI_PLAN="$(node bin/ci_fast_select.js --plan 2>&1)"; then'
        ));
        assert(script.includes('run_tier "docker: integration tier (test:integration)"'));
    });
});
