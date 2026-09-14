/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The file-level half of the platform code-style rules, for editors and
 * `npm run lint`.
 *
 * VENDORED BY COPY, NOT IMPORTED. The platform keeps the master copy of this
 * preset and every service repo carries its own duplicate, because a public
 * clone of this repo stands alone: there is no platform tree beside it to
 * import from. Core rules only, no plugins, so the copy has one dependency.
 *
 * THE GATE IS WHAT BINDS. The pre-push structure check depends on neither
 * eslint nor this file. The two agree on the rules; this one is the fast
 * feedback a writer gets in the editor, and it is advisory.
 *
 * WHAT THIS COPY ADDS TO THE MASTER, and why each one:
 *   - the two vendored trees are ignored. src/coins/ is refreshed from the hub
 *     and src/observability/ from the same place; this repo holds copies it may
 *     not edit, so grading them would report violations nobody here can fix.
 *   - src/clear_reorg_halt.js joins the entry-point list. It is a third `node
 *     src/...` npm script alongside the api and the migrator, and its output IS
 *     its product, so the one-logger rule does not reach it.
 */
'use strict';

// Copies this repo holds of files owned by another repo. Refreshed by the
// platform's sync scripts, so an edit here would be drift rather than a fix.
const vendored = {
    ignores: ['src/coins/**', 'src/observability/**'],
};

const src = {
    files: ['src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', Buffer: 'readonly',
            __dirname: 'readonly', __filename: 'readonly', console: 'readonly', setTimeout: 'readonly',
            clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
            URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        },
    },
    rules: {
        // Naming: camelCase everywhere except property keys, which carry
        // protocol fields and DB columns through one-to-one.
        camelcase: ['error', { properties: 'never', ignoreDestructuring: true, ignoreImports: true }],
        'no-underscore-dangle': ['error', { enforceInMethodNames: true, allowAfterThis: false, allowFunctionParams: false }],
        // Logging: one logger. Entry points override this below.
        'no-console': 'error',
        // Module shape: requires at the top, environment in config.js only,
        // one export shape per file.
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
            {
                selector: 'MemberExpression[object.name="process"][property.name="env"]',
                message: 'environment is read in config.js only (CODE-STYLE.md, Module shape)',
            },
        ],
        'prefer-const': 'error',
        'no-var': 'error',
        eqeqeq: ['error', 'smart'],
    },
};

const configAndEntry = {
    files: ['src/config.js', 'src/api.js', 'src/migrate.js', 'src/index.js', 'src/clear_reorg_halt.js', 'bin/**/*.js'],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

const tests = {
    files: ['test/**/*.js'],
    languageOptions: src.languageOptions,
    rules: {
        camelcase: src.rules.camelcase,
        'no-underscore-dangle': src.rules['no-underscore-dangle'],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};

module.exports = [vendored, src, configAndEntry, tests];
