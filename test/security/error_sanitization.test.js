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
const path = require('path')

// The Database class body lives in the entry and the parts it requires under src/db/,
// so a source scan reads all of them, in the order the entry requires them.
function readDbSource() {
    const entryPath = require.resolve('../../src/db.js')
    const entry = fs.readFileSync(entryPath, 'utf-8')
    const parts = [...entry.matchAll(/require\('\.\/db\/([a-z_]+\.js)'\)/g)]
        .map(m => fs.readFileSync(path.join(path.dirname(entryPath), 'db', m[1]), 'utf-8'))
    return [entry, ...parts].join('\n')
}

describe('Security: Error Log Sanitization', () => {

    // --- SEC-08: Credential leakage in error logs ---

    describe('db.js error logging', () => {
        let dbSource

        before(() => {
            dbSource = readDbSource()
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
    })
})

describe('Security: Error Log Sanitization', () => {
    describe('db.js error logging', () => {
        let dbSource

        before(() => {
            dbSource = readDbSource()
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
})

describe('Security: Error Log Sanitization', () => {

    describe('BlockchainConnector.js error logging', () => {
        let connectorSource

        before(() => {
            // The class body can live in the entry file or be split across sibling
            // part files, so the source scan below covers the entry plus every part.
            const entryPath = require.resolve('../../src/chain/blockchain_connector.js')
            const partsDir = path.join(path.dirname(entryPath), 'blockchain_connector')
            const sources = [fs.readFileSync(entryPath, 'utf-8')]
            if (fs.existsSync(partsDir)) {
                for (const name of fs.readdirSync(partsDir)) {
                    if (name.endsWith('.js')) sources.push(fs.readFileSync(path.join(partsDir, name), 'utf-8'))
                }
            }
            connectorSource = sources.join('\n')
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
})

// Behavioral lock for the credential-leak fix: every RPC call passes
// auth:{username,password} to axios, and axios attaches that config to the
// thrown error. Logging or re-throwing the raw error serializes the RPC
// password into the decoder logs. Drive a failing RPC and assert the
// password never reaches console.error and is scrubbed from the re-thrown
// error. FAKE_RPC_PASSWORD is a test sentinel, not a real credential.
describe('Security: Error Log Sanitization', () => {
    describe('BlockchainConnector.js error logging', () => {
        it('[REGRESSION P0] does not leak the RPC password when an axios call fails', async () => {
            const util = require('util')
            const axios = require('axios')
            const BlockchainConnector = require('../../src/chain/blockchain_connector.js')
            const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_9c3f'

            const err = new Error('Request failed with status code 401')
            err.code = 'ERR_BAD_REQUEST'
            err.config = {
                auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD },
                headers: { Authorization: 'Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
            }
            err.request = { _header: 'POST / HTTP/1.1\r\nAuthorization: Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') + '\r\n' }
            err.response = { status: 401, data: 'unauthorized', config: err.config }

            const connector = new BlockchainConnector('127.0.0.1', 8332, 'rpcuser', FAKE_RPC_PASSWORD)

            const originalPost = axios.post
            const originalError = console.error
            const logs = []
            axios.post = async () => { throw err }
            console.error = (...args) => {
                logs.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '))
            }

            let thrown
            try {
                await connector.getBlockchainInfo()
            } catch (e) {
                thrown = e
            } finally {
                axios.post = originalPost
                console.error = originalError
            }

            const combined = logs.join('\n')
            assert.ok(thrown, 'the failing RPC should propagate an error')
            assert.ok(
                !combined.includes(FAKE_RPC_PASSWORD),
                'the RPC password must never appear in connector error logs (got: ' + combined + ')'
            )
            assert.strictEqual(
                thrown.config && thrown.config.auth, undefined,
                'the re-thrown error must have its config.auth scrubbed'
            )
        })
    })
})

// getBlockWithoutAuxPow propagates RPC faults UNWRAPPED so the decoder can
// read error.code; the old rewrap incidentally hid the axios config, so the
// safety now rests entirely on sanitizeRpcError scrubbing the error in place
// inside getBlockHeader/getBlock before they rethrow. Lock that, or the
// unwrapped path becomes a credential leak.
describe('Security: Error Log Sanitization', () => {
    describe('BlockchainConnector.js error logging', () => {
        it('[REGRESSION P0] does not leak the RPC password through the unwrapped getBlockWithoutAuxPow path', async () => {
            const util = require('util')
            const axios = require('axios')
            const BlockchainConnector = require('../../src/chain/blockchain_connector.js')
            const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_7b1a'

            const err = new Error('Request failed with status code 401')
            err.code = 'ERR_BAD_REQUEST'
            err.config = {
                auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD },
                headers: { Authorization: 'Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
            }
            err.request = { _header: 'POST / HTTP/1.1\r\nAuthorization: Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') + '\r\n' }
            err.response = { status: 401, data: 'unauthorized', config: err.config }

            const connector = new BlockchainConnector('127.0.0.1', 8332, 'rpcuser', FAKE_RPC_PASSWORD)

            const originalPost = axios.post
            const originalError = console.error
            const logs = []
            axios.post = async () => { throw err }
            console.error = (...args) => {
                logs.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '))
            }

            let thrown
            try {
                await connector.getBlockWithoutAuxPow('hash')
            } catch (e) {
                thrown = e
            } finally {
                axios.post = originalPost
                console.error = originalError
            }

            const combined = logs.join('\n')
            assert.ok(thrown, 'the failing RPC should propagate an error')
            assert.ok(
                !combined.includes(FAKE_RPC_PASSWORD),
                'the RPC password must never appear in connector error logs (got: ' + combined + ')'
            )
            assert.ok(
                !util.inspect(thrown, { depth: 8 }).includes(FAKE_RPC_PASSWORD),
                'the propagated error must not carry the RPC password'
            )
            assert.strictEqual(
                thrown.config && thrown.config.auth, undefined,
                'the propagated error must have its config.auth scrubbed'
            )
        })
    })
})

describe('Security: Error Log Sanitization', () => {

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
