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

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..', '..')
const SRC_ROOT = path.join(REPO_ROOT, 'src')
const MIGRATE_RELATIVE = 'src/db/migrate.js'
const LEGACY_MIGRATE_HINT = 'node src/migrate.js'
const MIGRATE_HINT_PATTERN = /\bnode\s+([^\s`'"()]*migrate\.js)\b/g

function javascriptFiles(dir) {
    const files = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...javascriptFiles(absolute))
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute)
    }
    return files
}

describe('migration operator hints [REGRESSION P1]', () => {
    it('points every source hint at the existing migration entrypoint', () => {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATE_RELATIVE)))

        const hints = []
        const legacyHints = []
        for (const file of javascriptFiles(SRC_ROOT)) {
            const source = fs.readFileSync(file, 'utf8')
            const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/')
            if (source.includes(LEGACY_MIGRATE_HINT)) legacyHints.push(relative)
            for (const match of source.matchAll(MIGRATE_HINT_PATTERN)) {
                hints.push({ file: relative, entrypoint: match[1] })
            }
        }

        assert.deepStrictEqual(legacyHints, [], 'stale migration hints: ' + legacyHints.join(', '))
        assert.ok(hints.length > 0, 'expected at least one migration operator hint under src/')
        assert.deepStrictEqual(
            hints.filter(hint => hint.entrypoint !== MIGRATE_RELATIVE),
            [],
            'migration hints must name ' + MIGRATE_RELATIVE
        )
    })
})
