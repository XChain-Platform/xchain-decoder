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
 **********************************************************************/

const { DEFAULT_QUERY_TIMEOUT_MS } = require('./constants.js')

// Resolve DB_QUERY_TIMEOUT into the pool's queryTimeout option. An explicit 0
// disables the timeout entirely (mariadb treats 0 as "no timeout"), which the
// old `parseInt(...) || 30000` pattern silently turned back into the 30s cap.
// Unset, non-numeric, or negative values fall back to the default.
function resolveQueryTimeout(raw, defaultMs = DEFAULT_QUERY_TIMEOUT_MS) {
    const parsed = parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 0) return defaultMs
    return parsed
}

// JSON.stringify replacer that keeps a stray BigInt in an event payload from killing
// the whole write. JSON has no BigInt literal, so the native serializer throws on one;
// a BigInt that fits a safe integer becomes a plain Number (a table id, a count), and
// one that does not becomes a decimal string so no precision is silently dropped.
function jsonBigIntSafe(key, value){
    if (typeof value !== 'bigint') return value
    return (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString()
}

// True when str[i] opens a backslash escape inside the currently open quoted span.
//
// MariaDB/MySQL honour `\<char>` inside `'` and `"` string literals by default, so a
// `\'` does NOT close the literal. Every quote walker below must consult this helper
// instead of closing a span on the next matching quote: a span closed at the `\'`
// desyncs the scan from the statements the server would run. `INSERT ... VALUES
// ('it\'s fine'); DROP TABLE balances;` then re-opens at the literal's real closing
// quote and swallows the `;` and the DROP into one chunk whose first keyword is
// INSERT - invisible to the ^-anchored destructive checks in
// destructiveAutoStatement, which would score the file auto-eligible.
//
// Backtick spans are excluded: a backslash inside an identifier quote is a literal
// character there, so consuming the next char would desync in the other direction.
// A trailing lone backslash opens nothing, so no walker indexes past end-of-input.
//
// Module-level, not a method: hasUnquotedHash is deliberately a local closure because
// runMigrations' callers build partial `this` objects, and a prototype hop would break
// the guard on those (see the comment at that closure).
//
// Holds only while sql_mode omits NO_BACKSLASH_ESCAPES. Nothing in this tree sets
// sql_mode and the pool params below set none; if that ever changes, every caller of
// this helper must be revisited. Kept byte-for-byte in sync with xchain-indexer/src/db/index.js.
function opensBackslashEscape(str, i, quote){
    return str[i] === '\\' && quote !== '`' && i + 1 < str.length;
}

module.exports = {
    resolveQueryTimeout,
    jsonBigIntSafe,
    opensBackslashEscape,
}
