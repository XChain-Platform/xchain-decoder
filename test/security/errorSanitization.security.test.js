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
const fs = require('fs')

describe('Security: Error Log Sanitization', () => {

    // --- SEC-08: Credential leakage in error logs ---

    describe('db.js error logging', () => {
        let dbSource

        before(() => {
            dbSource = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')
        })

        it('[REGRESSION P0] R-SEC-002: should not log full error objects in createDatabase', () => {
            // The old pattern was: console.log('e=',e)
            // This could leak MariaDB connection details including passwords
            const createDbSection = dbSource.substring(
                dbSource.indexOf('async createDatabase'),
                dbSource.indexOf('async verifyTables')
            )

            assert.ok(
                !createDbSection.includes("console.log('e=',e)"),
                'createDatabase should not log full error objects'
            )
            assert.ok(
                !createDbSection.includes('console.log(e)'),
                'createDatabase should not log raw error objects'
            )
        })

        it('should not log full error objects in verifyTables', () => {
            const verifySection = dbSource.substring(
                dbSource.indexOf('async verifyTables'),
                dbSource.indexOf('async createTable')
            )

            assert.ok(
                !verifySection.includes("console.log('e=',e)"),
                'verifyTables should not log full error objects'
            )
        })

        it('should not log full error objects in commitTransaction', () => {
            const commitSection = dbSource.substring(
                dbSource.indexOf('async commitTransaction'),
                dbSource.indexOf('bigIntSatoshiToDecimalsString')
            )

            assert.ok(
                !commitSection.includes('console.log(e)'),
                'commitTransaction should not log raw error objects'
            )
        })

        it('[REGRESSION P0] R-SEC-002: should use error.code instead of full error for connection failures', () => {
            // createDatabase should log e.code, not e itself
            assert.ok(
                dbSource.includes('e.code'),
                'Error logging should reference e.code for safe output'
            )
        })
    })

    describe('BlockchainConnector.js error logging', () => {
        let connectorSource

        before(() => {
            connectorSource = fs.readFileSync(require.resolve('../../src/BlockchainConnector.js'), 'utf-8')
        })

        it('should not log full error objects in getBlockHeader', () => {
            const headerSection = connectorSource.substring(
                connectorSource.indexOf('async getBlockHeader'),
                connectorSource.indexOf('async getBlockWithoutAuxPow')
            )

            assert.ok(
                !headerSection.includes("console.error('Error:', error)"),
                'getBlockHeader should not log full error objects (may contain auth details)'
            )
        })

        it('should log error.message instead of full error object', () => {
            assert.ok(
                connectorSource.includes('error.message'),
                'Connector should log error.message for safe output'
            )
        })
    })

    describe('api.js security headers', () => {
        let apiSource

        before(() => {
            apiSource = fs.readFileSync(require.resolve('../../src/api.js'), 'utf-8')
        })

        it('should use helmet middleware', () => {
            assert.ok(apiSource.includes('helmet()'), 'API should use helmet for security headers')
        })

        it('should use rate limiting', () => {
            assert.ok(apiSource.includes('rateLimit'), 'API should use rate limiting')
        })

        it('should set a body size limit on JSON parser', () => {
            assert.ok(
                apiSource.includes("limit:") || apiSource.includes("'100kb'") || apiSource.includes('"100kb"'),
                'API should set a body size limit'
            )
        })
    })
})
