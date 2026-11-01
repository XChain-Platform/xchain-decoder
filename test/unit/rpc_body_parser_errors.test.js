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
 *********************************************************************/


'use strict';

// Body-parser failures (malformed, non-object, oversized JSON) must come back as
// a JSON-RPC error envelope, never Express's default HTML page with a stack trace.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');
const { rpcErrorHandler } = require('../../src/api/rpc_error_handler');

const METHODS = { ping: () => 'pong' };

function buildApp(withHandler) {
    const app = express();
    app.use(bodyParser.json({ limit: '100kb' }));
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({ methods: METHODS }));
    if (withHandler) app.use(rpcErrorHandler);
    else app.use((err, req, res, next) => { res.status(err.status || 500).type('html').send('<pre>' + err.stack + '</pre>'); }); // eslint-disable-line no-unused-vars
    return app;
}

async function post(app, body) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body
        });
        return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function assertCleanRpcError(r, status, code) {
    assert.strictEqual(r.status, status);
    assert.ok(/application\/json/.test(r.type), `content-type ${r.type}`);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.jsonrpc, '2.0');
    assert.strictEqual(j.error.code, code);
    assert.strictEqual(j.id, null);
    for (const bad of ['SyntaxError', 'node_modules', 'body-parser', ' at ', 'PayloadTooLarge']) {
        assert.ok(!r.text.includes(bad), `response leaks ${bad}: ${r.text}`);
    }
}

describe('JSON-RPC body-parser error handling', function () {
    this.timeout(10000);

    it('control: without the handler a malformed body leaks an HTML stack', async () => {
        const r = await post(buildApp(false), '{"jsonrpc":"2.0","id":1,"method":"pi');
        assert.ok(/html/.test(r.type));
        assert.ok(r.text.includes('SyntaxError'));
    });

    it('truncated JSON -> 400 with -32700', async () => {
        assertCleanRpcError(await post(buildApp(true), '{"jsonrpc":"2.0","id":1,"method":"pi'), 400, -32700);
    });

    it('body null -> 400 with -32700', async () => {
        assertCleanRpcError(await post(buildApp(true), 'null'), 400, -32700);
    });

    it('body "x" -> 400 with -32700', async () => {
        assertCleanRpcError(await post(buildApp(true), '"x"'), 400, -32700);
    });

    it('body over 100kb -> 413 with -32600', async () => {
        const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(153600) } });
        assertCleanRpcError(await post(buildApp(true), big), 413, -32600);
    });

    it('a valid ping still returns a result', async () => {
        const r = await post(buildApp(true), '{"jsonrpc":"2.0","id":1,"method":"ping"}');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(JSON.parse(r.text).result, 'pong');
    });

    it('src/api.js mounts the handler after the router', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const router = src.indexOf('app.use(jsonRouter(');
        const handler = src.indexOf('app.use(rpcErrorHandler)');
        assert.ok(router > 0 && handler > router, 'rpcErrorHandler must be mounted after the router');
    });
});
