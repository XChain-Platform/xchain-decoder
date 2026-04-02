const assert = require('assert')
const Database = require('../../src/db')

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

        it('should reject a database name with SQL injection characters', () => {
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

    // --- SEC-01: deleteAndCompareTxsNotInList parameterization ---

    describe('deleteAndCompareTxsNotInList parameterization', () => {
        it('should use parameterized placeholders instead of string concatenation', () => {
            // Verify by reading the source code — the fix replaces .join(",") with placeholders
            const fs = require('fs')
            const dbSource = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

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
