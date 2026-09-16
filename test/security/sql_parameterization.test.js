// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const Database = require('../../src/db')

// The Database class body lives in the entry and the parts it requires under src/db/,
// so a source scan reads all of them, in the order the entry requires them.
function readDbSource() {
    const fs = require('fs')
    const path = require('path')
    const entryPath = require.resolve('../../src/db.js')
    const entry = fs.readFileSync(entryPath, 'utf-8')
    const parts = [...entry.matchAll(/require\('\.\/db\/([a-z_]+\.js)'\)/g)]
        .map(m => fs.readFileSync(path.join(path.dirname(entryPath), 'db', m[1]), 'utf-8'))
    return [entry, ...parts].join('\n')
}

describe('Security: SQL Parameterization', () => {

    // --- SEC-01: Database name whitelist ---

    describe('Database name validation', () => {
        it('should accept a valid alphanumeric database name', () => {
            assert.doesNotThrow(() => {
                new Database('localhost', 3306, 'XChain_BTC_Mainnet_Decoder', 'root', '')
            })
        })

        it('should accept a database name with underscores', () => {
            assert.doesNotThrow(() => {
                new Database('localhost', 3306, 'xchain_decoder_regtest', 'root', '')
            })
        })

        it('[REGRESSION P0] R-SEC-001: should reject a database name with SQL injection characters', () => {
            assert.throws(() => {
                new Database('localhost', 3306, 'xchain; DROP TABLE blocks;--', 'root', '')
            }, /Invalid database name/)
        })

        it('should reject a database name with backticks', () => {
            assert.throws(() => {
                new Database('localhost', 3306, 'xchain`; DROP TABLE blocks;--`', 'root', '')
            }, /Invalid database name/)
        })

        it('should reject a database name with spaces', () => {
            assert.throws(() => {
                new Database('localhost', 3306, 'xchain decoder', 'root', '')
            }, /Invalid database name/)
        })

    })
})

describe('Security: SQL Parameterization', () => {
    describe('Database name validation', () => {
        it('should reject a database name with parentheses', () => {
            assert.throws(() => {
                new Database('localhost', 3306, 'db()', 'root', '')
            }, /Invalid database name/)
        })

        it('should reject a database name with slashes', () => {
            assert.throws(() => {
                new Database('localhost', 3306, '../../../etc/passwd', 'root', '')
            }, /Invalid database name/)
        })

        it('should reject an empty database name', () => {
            assert.throws(() => {
                new Database('localhost', 3306, '', 'root', '')
            }, /Invalid database name/)
        })

        it('should reject a database name with newlines', () => {
            assert.throws(() => {
                new Database('localhost', 3306, 'xchain\nDROP TABLE blocks', 'root', '')
            }, /Invalid database name/)
        })

        it('should reject a database name with unicode characters', () => {
            assert.throws(() => {
                new Database('localhost', 3306, 'xchain_\u0000_decoder', 'root', '')
            }, /Invalid database name/)
        })
    })
})

describe('Security: SQL Parameterization', () => {

    // --- SEC-01: deleteAndCompareTxsNotInList parameterization ---

    describe('deleteAndCompareTxsNotInList parameterization', () => {
        it('[REGRESSION P0] R-SEC-001: should use parameterized placeholders instead of string concatenation', () => {
            // Verify by reading the source code: the fix replaces .join(",") with placeholders
            const dbSource = readDbSource()

            // The old vulnerable pattern should NOT exist
            assert.ok(
                !dbSource.includes("deletedTxHashIds.join"),
                'db.js should not use deletedTxHashIds.join() for SQL construction'
            )

            // The new safe pattern should exist
            assert.ok(
                dbSource.includes('.map(() =>'),
                'db.js should use parameterized placeholders'
            )
        })
    })
})
