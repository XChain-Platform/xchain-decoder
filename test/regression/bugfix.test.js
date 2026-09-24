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
 * Bug-fix regression tests.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout')

const REPO_ROOT = path.join(__dirname, '..', '..')
const pkg = require('../../package.json')

const MIGRATE_RELATIVE = 'src/db/migrate.js'
const MIGRATE_OLD_RELATIVE = 'src/migrate.js'

describe('migrate CLI path [REGRESSION P1]', () => {
    it('pins the package script to the current path', () => {
        assert.strictEqual(pkg.scripts.migrate, 'node ./' + MIGRATE_RELATIVE)
    })

    it('keeps the current path resolvable', () => {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATE_RELATIVE)))
    })

    it('does not restore the stale path', () => {
        assert.ok(!fs.existsSync(path.join(REPO_ROOT, MIGRATE_OLD_RELATIVE)))
    })

    it('keeps the unit test require string on the current path', () => {
        const source = fs.readFileSync(path.join(REPO_ROOT, 'test', 'unit', 'migrate.test.js'), 'utf8')
        assert.ok(source.includes("require.resolve('../../" + MIGRATE_RELATIVE + "')"))
    })
})

const TWIN_REGISTRY = [{
    name: 'bufferutils',
    localPath: 'src/chain/bufferutils.js',
    twinRepo: 'xchain-utxo-tracker',
    twinPath: 'src/chain/bufferutils.js',
    declarations: [
        'verifuint',
        'readUInt64LE',
        'writeUInt64LE',
        'reverseBuffer',
        'cloneBuffer',
        'BufferWriter',
        'BufferReader'
    ]
}]

function extractDeclaration(source, name) {
    const lines = source.split('\n')
    const start = lines.findIndex(line =>
        line.startsWith('function ' + name + '(') || line.startsWith('class ' + name + ' '))
    assert.notStrictEqual(start, -1, `top-level declaration ${name} not found`)
    const end = lines.indexOf('}', start)
    assert.notStrictEqual(end, -1, `closing brace for ${name} not found`)
    return lines.slice(start, end + 1).join('\n')
}

describe('vendored twin parity [REGRESSION P1]', () => {
    for (const twin of TWIN_REGISTRY) {
        const localFile = path.join(REPO_ROOT, twin.localPath)
        const trackerDir = process.env.XCHAIN_UTXO_TRACKER_DIR ||
            path.join(REPO_ROOT, '..', twin.twinRepo)
        const twinFile = path.join(trackerDir, twin.twinPath)

        describe(`${twin.localPath} vs ${twin.twinRepo}/${twin.twinPath}`, () => {
            before(function () {
                const verdict = siblingCheckout(__dirname, twinFile)
                if (!verdict.usable) {
                    skipOrFail(this, verdict, twin.name + ' twin parity')
                }
            })

            for (const name of twin.declarations) {
                it(`${name} is byte-identical in both repos`, () => {
                    const local = fs.readFileSync(localFile, 'utf8')
                    const sibling = fs.readFileSync(twinFile, 'utf8')
                    assert.strictEqual(
                        extractDeclaration(local, name),
                        extractDeclaration(sibling, name),
                        `${name} has drifted from ${twin.twinRepo}`
                    )
                })
            }
        })
    }

    it('registers the bufferutils twin', () => {
        assert.ok(TWIN_REGISTRY.some(twin => twin.name === 'bufferutils'))
    })
})

const MUTATORS_DIR = path.join(REPO_ROOT, 'test', 'fuzz', 'support', 'mutators')
const FUZZ_HARNESS_DIR = path.join(REPO_ROOT, 'test', 'fuzz', 'harness')
const FUZZ_MOCHA_BIN = path.join(REPO_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js')
const MUTATOR_BACKED_ENTRYPOINTS = [
    'block_decoder.fuzz.js',
    'parse_transaction.fuzz.js',
    'pipeline.fuzz.js',
    'remove_obfuscation.fuzz.js'
]

function mutatorDrawsUnderSeed(seed) {
    const script = [
        `const { flipBits } = require(${JSON.stringify(path.join(MUTATORS_DIR, 'bit_flip.js'))})`,
        `const { mutateRandom } = require(${JSON.stringify(path.join(MUTATORS_DIR, 'byte_manipulate.js'))})`,
        `const { randomDispenserString } = require(${JSON.stringify(path.join(MUTATORS_DIR, 'structure_aware.js'))})`,
        "const input = Buffer.from('0011223344556677', 'hex')",
        "console.log(JSON.stringify([flipBits(input, 8).toString('hex'), mutateRandom(input).toString('hex'), randomDispenserString()]))"
    ].join(';')
    return execFileSync(process.execPath, ['-e', script], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, FUZZ_SEED: String(seed) }
    }).trim()
}

function runFuzzEntrypoint(entrypoint, seed) {
    return spawnSync(process.execPath, [
        FUZZ_MOCHA_BIN,
        '--timeout', '15000',
        '--require', './test/fuzz/support/setup.js',
        path.join('test', 'fuzz', 'harness', entrypoint)
    ], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, FUZZ_ITERATIONS: '1', FUZZ_SEED: String(seed) }
    })
}

describe('fuzz seeding [REGRESSION P1]', () => {
    it('replays the same mutation sequence for the same FUZZ_SEED', () => {
        assert.strictEqual(mutatorDrawsUnderSeed(13579), mutatorDrawsUnderSeed(13579))
    })

    it('changes the mutation sequence for a different FUZZ_SEED', () => {
        assert.notStrictEqual(mutatorDrawsUnderSeed(13579), mutatorDrawsUnderSeed(97531))
    })

    it('accounts for every top-level fuzz harness', () => {
        const actual = fs.readdirSync(FUZZ_HARNESS_DIR)
            .filter(name => name.endsWith('.fuzz.js'))
            .sort()
        const expected = [...MUTATOR_BACKED_ENTRYPOINTS, 'dispenser_parsing.fuzz.js'].sort()
        assert.deepStrictEqual(actual, expected)
    })

    for (const entrypoint of MUTATOR_BACKED_ENTRYPOINTS) {
        it(`${entrypoint} prints the FUZZ_SEED it ran with`, function () {
            this.timeout(20000)
            const seed = 271828
            const result = runFuzzEntrypoint(entrypoint, seed)
            assert.strictEqual(result.status, 0, result.stderr)
            assert.match(
                (result.stdout || '') + (result.stderr || ''),
                new RegExp(`FUZZ_SEED=${seed}\\b`)
            )
        })
    }

    it('the standalone dispenser harness threads and reports FUZZ_SEED', () => {
        const source = fs.readFileSync(path.join(FUZZ_HARNESS_DIR, 'dispenser_parsing.fuzz.js'), 'utf8')
        assert.match(source, /process\.env\.FUZZ_SEED/)
        assert.match(source, /console\.log\(`FUZZ_SEED=\$\{FUZZ_SEED\}/)
    })
})
