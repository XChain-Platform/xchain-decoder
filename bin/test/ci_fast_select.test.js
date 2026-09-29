'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
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

function scratch_git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write_scratch_file(cwd, file, source) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
}

function scratch_commit(cwd, message, files) {
    scratch_git(cwd, ['add', '--', ...files]);
    scratch_git(cwd, [
        '-c', 'user.name=Selector Test',
        '-c', 'user.email=selector-test',
        'commit', '-m', message
    ]);
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

    it('replays develop history, compares narrowing, and checks required selections', function() {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'));
        try {
            scratch_git(cwd, ['init', '--initial-branch=develop']);
            const initial = {
                'src/protocol/rule.js': "module.exports = 'rule';\n",
                'src/feature/plain.js': "module.exports = 'plain';\n",
                'test/unit/protocol/rule.test.js':
                    "require('../../../src/protocol/rule');\n",
                'test/unit/feature/plain.test.js': "require('../../../src/feature/plain');\n",
                'test/unit/only.test.js': "module.exports = 'only';\n",
                'test/unit/other/unrelated.test.js': "module.exports = 'unrelated';\n"
            };
            for (const [file, source] of Object.entries(initial)) {
                write_scratch_file(cwd, file, source);
            }
            scratch_commit(cwd, 'initial files', Object.keys(initial));

            const consensusFile = 'src/protocol/rule.js';
            fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed';\n");
            scratch_commit(cwd, 'consensus change', [consensusFile]);

            const plainFile = 'src/feature/plain.js';
            fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed';\n");
            scratch_commit(cwd, 'plain source change', [plainFile]);

            const testFile = 'test/unit/only.test.js';
            fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed';\n");
            scratch_commit(cwd, 'test only change', [testFile]);
            scratch_git(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);

            const selector = path.resolve(__dirname, '../ci_fast_select.js');
            const mustSelect = [
                'src/protocol/rule.js:test/unit/protocol/rule.test.js',
                'src/feature/plain.js:test/unit/other/unrelated.test.js'
            ].join(',');
            const result = spawnSync(process.execPath, [
                selector,
                '--replay', '3',
                '--narrow', 'src/protocol/',
                '--must-select', mustSelect
            ], { cwd, encoding: 'utf8' });

            assert.strictEqual(result.status, 1, result.stderr);
            const lines = result.stdout.trim().split(/\r?\n/);
            assert(lines.includes('plan commits consensus-1 changed-tests test-only no-tests'));
            assert(lines.includes('current 3 1/3 1/3 1/3 0/3'));
            assert(lines.includes('narrowed 3 0/3 2/3 1/3 0/3'));
            assert(lines.includes(
                'must-select PASS src/protocol/rule.js:test/unit/protocol/rule.test.js'));
            assert(lines.includes(
                'must-select FAIL src/feature/plain.js:test/unit/other/unrelated.test.js'));
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
