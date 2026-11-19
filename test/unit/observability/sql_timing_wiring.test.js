// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const Database = require('../../../src/db');
const { registerRoutes } = require('../../../src/api');
const observability = require('../../../src/observability');

const TIMING_ENV = {
    SQL_TIMING_ENABLED: '1',
    SQL_TIMING_URL: 'https://timing.invalid/intake',
    SQL_TIMING_KEY: 'unit-test-key',
    SQL_TIMING_PROJECT: 'xchain-platform',
    SQL_TIMING_REQUEST_RATE: '1',
    SQL_TIMING_STATEMENT_RATE: '0',
    SQL_TIMING_INTERVAL_MS: '60000'
};

function createDecoder(db) {
    return {
        db,
        connector: { rpcErrors: 0 },
        parseErrors: 0,
        rpcErrors: 0,
        getSyncStatus: () => ({ last_processed_block: 5, node_height: 7, lag: 2 }),
        isSynced: () => false
    };
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

async function rpc(server, method) {
    return fetch(`http://127.0.0.1:${server.address().port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method })
    });
}

describe('SQL timing decoder wiring', function () {
    this.timeout(10000);

    const originalEnv = {};
    let appObservability;
    let server;

    beforeEach(function () {
        for (const [name, value] of Object.entries(TIMING_ENV)) {
            originalEnv[name] = process.env[name];
            process.env[name] = value;
        }
        observability._resetObservability();
    });

    afterEach(async function () {
        if (server) await new Promise((resolve) => server.close(resolve));
        if (appObservability) await appObservability.shutdown();
        server = null;
        appObservability = null;
        for (const name of Object.keys(TIMING_ENV)) {
            if (originalEnv[name] === undefined) delete process.env[name];
            else process.env[name] = originalEnv[name];
        }
        observability._resetObservability();
    });

    it('emits the decoder RPC route with a wrapped pool query count', async function () {
        const posted = [];
        const db = new Database('127.0.0.1', 3306, 'decoder', 'decoder', 'unused');
        const decoder = createDecoder(db);
        const app = express();
        app.use(bodyParser.json());
        appObservability = observability.installObservability(app, {
            service: 'xchain-decoder',
            env: TIMING_ENV,
            sqlTimingTransport: async (request) => {
                posted.push(request);
                return { status: 200 };
            }
        });

        registerRoutes(app, decoder, () => true, () => null);
        server = await listen(app);

        const inherited = await rpc(server, 'constructor');
        assert.strictEqual((await inherited.json()).error.code, -32601);
        const response = await rpc(server, 'health');
        assert.strictEqual(response.status, 200);
        await appObservability.shutdown();
        appObservability = null;

        assert.strictEqual(posted.length, 1);
        const lines = posted[0].body.trim().split('\n').map(JSON.parse);
        assert.strictEqual(lines.length, 1);
        assert.strictEqual(lines[0].route, 'POST /xchain-decoder/rpc/health');
        assert.strictEqual(lines[0].query_count, 1);
    });
});
