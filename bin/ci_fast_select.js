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

function has_consensus_prefix(file, consensusPrefixes = CONSENSUS) {
    return consensusPrefixes.some((prefix) => file.startsWith(prefix));
}

function is_consensus_path(file, consensusPrefixes = CONSENSUS) {
    return file === 'package.json' || has_consensus_prefix(file, consensusPrefixes)
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

function indirect_consensus_reasons(changed_file, findRequirers, consensusPrefixes) {
    if (!changed_file.startsWith('src/') || !changed_file.endsWith('.js')) return [];
    const basename = path.basename(changed_file, '.js');
    const importers = findRequirers(basename);
    return importers.filter((file) => has_consensus_prefix(file, consensusPrefixes)
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

function selectFastTests(
    changedFiles,
    { listTests, findRequirers },
    { consensusPrefixes = CONSENSUS } = {}
) {
    const changed = [...new Set(changedFiles.filter(Boolean))];
    const reasons = [];
    for (const file of changed) {
        if (is_consensus_path(file, consensusPrefixes)) reasons.push(`consensus: ${file}`);
        reasons.push(...indirect_consensus_reasons(file, findRequirers, consensusPrefixes));
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

function without_consensus_prefixes(prefixes) {
    const removed = new Set(prefixes.flatMap((prefix) => {
        const trimmed = prefix.trim();
        if (!trimmed) return [];
        return [trimmed, trimmed.endsWith('/') ? trimmed.slice(0, -1) : `${trimmed}/`];
    }));
    return CONSENSUS.filter((prefix) => !removed.has(prefix));
}

function changed_files_for_commit(commit) {
    const revision = run_git(['rev-list', '--parents', '-n', '1', commit]);
    const [, parent] = revision.split(' ');
    if (parent) {
        const output = run_git(['diff', '--name-only', `${parent}..${commit}`]);
        return output ? output.split('\n') : [];
    }
    const output = run_git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]);
    return output ? output.split('\n') : [];
}

function empty_replay_counts() {
    return { wholeUnit: 0, changedTests: 0, testOnly: 0, noTests: 0 };
}

function count_replay_plan(counts, changed, plan) {
    if (plan.consensus) {
        counts.wholeUnit++;
    } else if (plan.tests.length && changed.every((file) => file.startsWith('test/'))) {
        counts.testOnly++;
    } else if (plan.tests.length) {
        counts.changedTests++;
    } else {
        counts.noTests++;
    }
}

function replay_plans(limit, narrowPrefixes) {
    const output = run_git([
        'log', '--first-parent', '-n', String(limit), '--format=%H', 'origin/develop'
    ]);
    const commits = output ? output.split('\n') : [];
    const current = empty_replay_counts();
    const narrowed = empty_replay_counts();
    const consensusPrefixes = without_consensus_prefixes(narrowPrefixes);
    const dependencies = { listTests: list_tests, findRequirers: find_requirers };
    for (const commit of commits) {
        const changed = changed_files_for_commit(commit);
        count_replay_plan(current, changed, selectFastTests(changed, dependencies));
        count_replay_plan(narrowed, changed, selectFastTests(changed, dependencies, {
            consensusPrefixes
        }));
    }
    return { commits, current, narrowed, consensusPrefixes, dependencies };
}

function fraction(value, total) {
    return `${value}/${total}`;
}

function print_replay_row(name, total, counts) {
    console.log([
        name,
        total,
        fraction(counts.wholeUnit, total),
        fraction(counts.changedTests, total),
        fraction(counts.testOnly, total),
        fraction(counts.noTests, total)
    ].join(' '));
}

function parse_list(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parse_must_select(value) {
    return parse_list(value).map((pair) => {
        const separator = pair.indexOf(':');
        if (separator <= 0 || separator === pair.length - 1) {
            throw new Error(`invalid --must-select pair: ${pair}`);
        }
        return { source: pair.slice(0, separator), test: pair.slice(separator + 1) };
    });
}

function replay_options(args) {
    const limit = Number(args[0]);
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('--replay requires a positive integer');
    }
    const options = { limit, narrowPrefixes: [], mustSelect: [] };
    for (let index = 1; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value || (flag !== '--narrow' && flag !== '--must-select')) {
            throw new Error(`invalid replay option: ${flag || ''}`.trim());
        }
        if (flag === '--narrow') options.narrowPrefixes.push(...parse_list(value));
        else options.mustSelect.push(...parse_must_select(value));
    }
    return options;
}

function run_replay(args) {
    try {
        const options = replay_options(args);
        const result = replay_plans(options.limit, options.narrowPrefixes);
        console.log('plan commits consensus-1 changed-tests test-only no-tests');
        print_replay_row('current', result.commits.length, result.current);
        if (options.narrowPrefixes.length) {
            print_replay_row('narrowed', result.commits.length, result.narrowed);
        }
        let failed = false;
        for (const pair of options.mustSelect) {
            const plan = selectFastTests([pair.source], result.dependencies, {
                consensusPrefixes: result.consensusPrefixes
            });
            const selected = plan.tests.some((test) => test.file === pair.test);
            console.log(`must-select ${selected ? 'PASS' : 'FAIL'} ${pair.source}:${pair.test}`);
            if (!selected) failed = true;
        }
        return failed ? 1 : 0;
    } catch (error) {
        console.error(`replay-error ${error.message}`);
        return 2;
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
    const mode = process.argv[2];
    if (mode === '--replay') return run_replay(process.argv.slice(3));
    if (!['--plan', '--run'].includes(mode)) {
        console.error('usage: node bin/ci_fast_select.js --plan|--run|--replay N ' +
            '[--narrow prefix,...] [--must-select file:testfile,...]');
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
    if (mode === '--plan') {
        print_plan(plan);
        return 0;
    }
    return run_plan(plan);
}

module.exports = { replayPlans: replay_plans, resolveBase, selectFastTests };

if (require.main === module) process.exitCode = main();
