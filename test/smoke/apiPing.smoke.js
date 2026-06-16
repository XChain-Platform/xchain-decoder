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
const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')
const helmet = require('helmet')
const cors = require('cors')
const jsonRouter = require('express-json-rpc-router')

describe('Smoke: Express API & Ping Endpoint', () => {
    let server
    let port

    before((done) => {
        const app = express()
        app.use(helmet())
        app.use(bodyParser.json())
        app.use(cors())

        const jsonRpcController = {
            async ping() {
                return { status: 'success' }
            }
        }
        app.use(jsonRouter({ methods: jsonRpcController }))

        server = app.listen(0, () => {
            port = server.address().port
            done()
        })
    })

    after((done) => {
        if (server) server.close(done)
        else done()
    })

    function jsonRpcRequest(method) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ jsonrpc: '2.0', method, id: 1 })
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let data = ''
                res.on('data', (chunk) => { data += chunk })
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) })
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${data}`))
                    }
                })
            })
            req.on('error', reject)
            req.write(body)
            req.end()
        })
    }

    it('should start the Express server without errors', () => {
        assert.ok(server.listening)
        assert.ok(port > 0)
    })

    it('should respond to JSON-RPC ping with success', async () => {
        const res = await jsonRpcRequest('ping')
        assert.strictEqual(res.status, 200)
        assert.ok(res.body.result)
        assert.strictEqual(res.body.result.status, 'success')
    })

    it('should return a JSON-RPC error for unknown methods', async () => {
        const res = await jsonRpcRequest('nonexistent')
        assert.strictEqual(res.status, 200)
        assert.ok(res.body.error || res.body.result === undefined || res.body.result === null)
    })

    it('should include CORS headers', async () => {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                method: 'OPTIONS',
                headers: {
                    'Origin': 'http://test.example.com',
                    'Access-Control-Request-Method': 'POST'
                }
            }, (res) => {
                const acaoHeader = res.headers['access-control-allow-origin']
                assert.ok(acaoHeader, 'Missing Access-Control-Allow-Origin header')
                resolve()
            })
            req.on('error', reject)
            req.end()
        })
    })
})
