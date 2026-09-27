#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CONSENSUS = [
    'src/XChainDecoder.js',
    'src/XChainDecoder/',
    'src/protocol/',
    'src/chain/',
    'src/coins/',
    'src/sql/',
    'src/db/',
    'src/db.js',
    'src/config.js',
    'src/util.js',
    'bin/pins/',
    'bin/pin-identity.js',
    'bin/sync-batch-limits.js'
];

const GROUPS = [
    { name: 'unit', pattern: /^test\/unit\/.+\.test\.js$/, args: ['--timeout', '5000', '--exit', '--require', './test/unit/support/setup.js'] },
    { name: 'security', pattern: /^test\/security\/.+\.test\.js$/, args: ['--timeout', '10000', '--exit', '--require', './test/security/support/setup.js'] },
    { name: 'smoke', pattern: /^test\/smoke\/.+\.test\.js$/, args: ['--timeout', '5000', '--exit', '--require', './test/unit/support/setup.js'] },
    { name: 'regression', pattern: /^test\/regression\/.+\.test\.js$/, args: ['--timeout', '10000', '--exit', '--require', './test/regression/support/setup.js'] },
    { name: 'chaos', pattern: /^test\/chaos\/.+\.test\.js$/, args: ['--timeout', '60000', '--exit', '--require', './test/chaos/support/setup.js'] },
    { name: 'fuzz', pattern: /^test\/fuzz\/harness\/.+\.fuzz\.js$/, args: ['--timeout', '60000', '--exit', '--require', './test/fuzz/support/setup.js'], env: { FUZZ_ITERATIONS: '100' } }
];

function run_git(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function resolveBase({ env, git }) {
    const candidate = env.PROM_CI_BASE_SHA;
    if (candidate) {
        try {
            git(['cat-file', '-e', `${candidate}^{commit}`]);
            return candidate;
        } catch (_) {
            // Fall through to the shared branch when the push base is unavailable locally.
        }
    }
    try {
        return git(['merge-base', 'HEAD', 'origin/develop']).trim() || null;
    } catch (_) {
        return null;
    }
}

function group_for(file) {
    return GROUPS.find((group) => group.pattern.test(file));
}

function has_consensus_prefix(file) {
    return CONSENSUS.some((prefix) => file.startsWith(prefix));
}

function is_consensus_path(file) {
    return file === 'package.json' || has_consensus_prefix(file)
        || /^test\/[^/]+\/support\//.test(file)
        || file.startsWith('test/helpers/')
        || file.startsWith('test/fixtures/');
}

function resolved_require_matches(file, changed_file) {
    let source;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch (_) {
        return false;
    }
    const changed = path.resolve(changed_file);
    const requires = source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g);
    for (const match of requires) {
        const resolved = path.resolve(path.dirname(file), match[1]);
        if ([resolved, `${resolved}.js`, path.join(resolved, 'index.js')].includes(changed)) return true;
    }
    return false;
}

function indirect_consensus_reasons(changed_file, findRequirers) {
    if (!changed_file.startsWith('src/') || !changed_file.endsWith('.js')) return [];
    const basename = path.basename(changed_file, '.js');
    const importers = findRequirers(basename);
    return importers.filter((file) => has_consensus_prefix(file)
        && resolved_require_matches(file, changed_file))
        .map((file) => `consensus importer: ${file} requires ${changed_file}`);
}

function source_matches_test(source_file, test_file) {
    const tail = source_file.slice(4).replace(/\.js$/, '');
    const name = path.posix.basename(tail);
    const source_dir = path.posix.dirname(tail);
    const test_tail = test_file.replace(/^test\/[^/]+\//, '');
    if (name !== 'index' && path.posix.basename(test_file) === `${name}.test.js`) return true;
    if (test_tail.split('/').includes(`${name}.test`)) return true;
    return path.posix.dirname(test_tail) === source_dir;
}

function add_source_tests(source_file, candidates, selected, findRequirers) {
    for (const file of candidates) {
        if (source_matches_test(source_file, file)) selected.add(file);
    }
    const module_tail = source_file.replace(/\.js$/, '');
    for (const file of findRequirers(module_tail)) {
        if (group_for(file)) selected.add(file);
    }
}

function selectFastTests(changedFiles, { listTests, findRequirers }) {
    const changed = [...new Set(changedFiles.filter(Boolean))];
    const reasons = [];
    for (const file of changed) {
        if (is_consensus_path(file)) reasons.push(`consensus: ${file}`);
        reasons.push(...indirect_consensus_reasons(file, findRequirers));
    }
    if (reasons.length) {
        return { consensus: true, reasons: [...new Set(reasons)].sort(), tests: [] };
    }

    const candidates = listTests().filter((file) => group_for(file));
    const existing = new Set(candidates);
    const selected = new Set();
    for (const file of changed) {
        if (group_for(file) && existing.has(file)) selected.add(file);
        else if (file.startsWith('test/')) reasons.push(`deferred: ${file}`);
        if (file.startsWith('src/') && file.endsWith('.js')) {
            add_source_tests(file, candidates, selected, findRequirers);
        }
    }
    const tests = [...selected].filter((file) => existing.has(file)).sort()
        .map((file) => ({ group: group_for(file).name, file }));
    return { consensus: false, reasons: [...new Set(reasons)].sort(), tests };
}

function list_tests() {
    const output = run_git(['ls-files', '--', 'test']);
    return output ? output.split('\n').filter((file) => fs.existsSync(file)) : [];
}

function find_requirers(needle) {
    try {
        const output = run_git(['grep', '-l', '-F', '--', needle, '--', 'src', 'test', 'bin']);
        return output ? output.split('\n') : [];
    } catch (error) {
        if (error.status === 1) return [];
        throw error;
    }
}

function build_plan() {
    const base = resolveBase({ env: process.env, git: run_git });
    if (!base) return { no_base: 'no valid push base or origin/develop merge base' };
    const output = run_git(['diff', '--name-only', `${base}...HEAD`]);
    const changed = output ? output.split('\n') : [];
    return selectFastTests(changed, { listTests: list_tests, findRequirers: find_requirers });
}

function print_plan(plan) {
    console.log(`consensus ${plan.consensus ? 1 : 0}`);
    for (const reason of plan.reasons) console.log(`reason ${reason}`);
    for (const test of plan.tests) console.log(`test ${test.group} ${test.file}`);
}

function run_plan(plan) {
    if (!plan.tests.length) {
        console.log('ci:fast: no test maps to this push');
        return 0;
    }
    let failed = false;
    for (const group of GROUPS) {
        const files = plan.tests.filter((test) => test.group === group.name).map((test) => test.file);
        if (!files.length) continue;
        const env = { ...process.env, ...(group.env || {}) };
        const result = spawnSync('./node_modules/.bin/mocha', ['--no-config', ...group.args, ...files], { stdio: 'inherit', env });
        if (result.status !== 0) failed = true;
    }
    return failed ? 1 : 0;
}

function main() {
    if (!['--plan', '--run'].includes(process.argv[2])) {
        console.error('usage: node bin/ci_fast_select.js --plan|--run');
        return 2;
    }
    let plan;
    try {
        plan = build_plan();
    } catch (error) {
        console.error(`selector-error ${error.message}`);
        return 3;
    }
    if (plan.no_base) {
        console.log(`no-base ${plan.no_base}`);
        return 3;
    }
    if (process.argv[2] === '--plan') {
        print_plan(plan);
        return 0;
    }
    return run_plan(plan);
}

module.exports = { resolveBase, selectFastTests };

if (require.main === module) process.exitCode = main();
