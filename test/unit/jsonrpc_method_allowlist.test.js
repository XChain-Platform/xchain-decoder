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

// The JSON-RPC method table is an allowlist: only ping, health, getlatestblock and
// getmempool are callable. A plain-object table also resolves inherited
// Object.prototype members ("constructor", "toString", ...) by name; each must
// answer -32601 Method not found, never a 200 result.

const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');
const { createJsonRpcController } = require('../../src/api');

const DECLARED = ['getlatestblock', 'getmempool', 'health', 'ping'];

const stubDecoder = {
    db: null,
    getSyncStatus: () => ({ last_processed_block: 5, node_height: 7 }),
    isSynced: () => false
};

async function call(methods, method) {
    const app = express();
    app.use(bodyParser.json());
    app.use(jsonRouter({ methods }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method })
        });
        return { status: res.status, body: await res.json() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('JSON-RPC method allowlist', function () {
    this.timeout(10000);
    const methods = () => createJsonRpcController(stubDecoder, () => true, () => null);

    for (const m of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', '__defineGetter__', 'nosuch']) {
        it(`rejects ${m} with -32601 and no result`, async () => {
            const r = await call(methods(), m);
            assert.strictEqual(r.body.error && r.body.error.code, -32601, JSON.stringify(r.body));
            assert.ok(!('result' in r.body), JSON.stringify(r.body));
        });
    }

    it('still serves ping', async () => {
        const r = await call(methods(), 'ping');
        assert.deepStrictEqual(r.body.result, { status: 'success' });
    });

    it('still serves getlatestblock', async () => {
        const r = await call(methods(), 'getlatestblock');
        assert.strictEqual(r.body.result.block_index, 5);
    });

    it('still dispatches health without a method-not-found error', async () => {
        const r = await call(methods(), 'health');
        assert.notStrictEqual(r.body.error && r.body.error.code, -32601, JSON.stringify(r.body));
    });

    it('exposes exactly the declared methods on a prototype-free table', () => {
        const m = methods();
        assert.strictEqual(Object.getPrototypeOf(m), null);
        assert.deepStrictEqual(Object.keys(m).sort(), DECLARED);
    });
});
