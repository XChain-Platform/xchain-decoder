// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const JsonRpcClient = require('../../helpers/json_rpc_client')

describe('test JSON-RPC client', function () {
    afterEach(() => sinon.restore())

    it('preserves base URL auth and named RPC argument order', async function () {
        const post = sinon.stub(axios, 'post').resolves({ data: { result: 'txid' } })
        const client = new JsonRpcClient({
            host: 'http://127.0.0.1:18443', username: 'rpc-user', password: 'rpc-pass'
        })

        assert.strictEqual(await client.sendToAddress('bcrt1qtest', 1.25), 'txid')
        assert.deepStrictEqual(post.firstCall.args, [
            'http://127.0.0.1:18443',
            { jsonrpc: '2.0', method: 'sendtoaddress', params: ['bcrt1qtest', 1.25], id: 1 },
            { auth: { username: 'rpc-user', password: 'rpc-pass' } }
        ])
    })

    it('scopes wallet calls with URL encoding and supports generic commands', async function () {
        const post = sinon.stub(axios, 'post').resolves({ data: { result: null } })
        const client = new JsonRpcClient({
            host: 'http://node:18443/', username: 'user', password: 'pass', wallet: 'fixture wallet'
        })

        await client.command('invalidateblock', '00ff')
        assert.strictEqual(post.firstCall.args[0], 'http://node:18443/wallet/fixture%20wallet')
        assert.strictEqual(post.firstCall.args[1].method, 'invalidateblock')
        assert.deepStrictEqual(post.firstCall.args[1].params, ['00ff'])
    })

    it('throws the daemon error with its numeric code', async function () {
        sinon.stub(axios, 'post').resolves({
            data: { error: { code: -8, message: 'Block height out of range' } }
        })
        const client = new JsonRpcClient({ host: 'http://node', username: 'user', password: 'pass' })

        await assert.rejects(client.getBlockHash(-1), error =>
            error.code === -8 && error.message === 'Block height out of range')
    })
})
