// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { resolveQueryTimeout, jsonBigIntSafe, opensBackslashEscape } = require('../../src/db/query_helpers.js');

describe('db/query_helpers', () => {
    describe('resolveQueryTimeout', () => {
        it('keeps an explicit 0 (no timeout)', () => {
            assert.strictEqual(resolveQueryTimeout('0'), 0);
        });

        it('falls back to the 30000 default when unset', () => {
            assert.strictEqual(resolveQueryTimeout(undefined), 30000);
        });

        it('falls back to the default for a negative value', () => {
            assert.strictEqual(resolveQueryTimeout('-5'), 30000);
        });

        it('parses a positive value', () => {
            assert.strictEqual(resolveQueryTimeout('45000'), 45000);
        });
    });

    describe('jsonBigIntSafe', () => {
        it('converts a safe BigInt to a plain number', () => {
            assert.strictEqual(jsonBigIntSafe('k', 123n), 123);
            assert.strictEqual(typeof jsonBigIntSafe('k', 123n), 'number');
        });

        it('passes non-BigInt values through unchanged', () => {
            assert.strictEqual(jsonBigIntSafe('k', 'abc'), 'abc');
        });

        it('converts an unsafe BigInt to its decimal string', () => {
            const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
            assert.strictEqual(jsonBigIntSafe('k', unsafe), unsafe.toString());
        });
    });

    describe('opensBackslashEscape', () => {
        it('is true for a backslash before the closing quote inside a single-quoted span', () => {
            assert.strictEqual(opensBackslashEscape("a\\'b", 1, "'"), true);
        });

        it('is false for the same position inside a backtick-quoted span', () => {
            assert.strictEqual(opensBackslashEscape("a\\'b", 1, '`'), false);
        });

        it('is false for a trailing backslash at end of string', () => {
            const str = 'a\\';
            assert.strictEqual(opensBackslashEscape(str, 1, "'"), false);
        });
    });
});
