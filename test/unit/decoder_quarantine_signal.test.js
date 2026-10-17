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

// A quarantined transaction is skipped for good, so it gets a signal of its own on every
// polled surface, apart from parse_errors, which routine rejections also raise.
const assert = require('assert');
const http = require('http');
const express = require('express');
const XChainDecoder = require('../../src/XChainDecoder');
const { registerLiveRoute } = require('../../src/api');
const { registerDecoderMetrics } = require('../../src/metrics/decoder_metrics');
const { Registry } = require('../../src/observability/metrics');

function caughtUpDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    );
    decoder.lastProcessedBlockIndex = 150;
    decoder.blockchainInfoLastBlock = 150;
    decoder.blockchainInfoLastRefreshAt = Date.now();
    decoder.lastAdvanceAt = Date.now();
    decoder.lastPollAt = Date.now();
    decoder.synced = true;
    decoder.db = { ping: async () => true };
    decoder.connector = { rpcErrors: 0 };
    return decoder;
}

function getLive(decoder) {
    const app = express();
    registerLiveRoute(app, decoder, () => true);
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: '/live' }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(body) }); });
            }).on('error', (e) => { server.close(); reject(e); });
        });
    });
}

describe('decoder quarantine signal', function () {
    it('/live reports zero and nulls on a decoder that never skipped a transaction', async function () {
        const res = await getLive(caughtUpDecoder());
        assert.strictEqual(res.body.quarantined_txs, 0);
        assert.strictEqual(res.body.last_quarantined_block, null);
        assert.strictEqual(res.body.last_quarantined_tx_hash, null);
        assert.strictEqual(res.body.last_quarantined_at, null);
    });

    it('/live reports a quarantine and stays 200, since a restart cannot undo a skip', async function () {
        const decoder = caughtUpDecoder();
        decoder.parseErrors = 40;
        decoder.quarantinedTxs = 1;
        decoder.lastQuarantinedBlock = 0;
        decoder.lastQuarantinedTxHash = 'cafe01';
        decoder.lastQuarantinedAt = '2026-10-12T00:00:00.000Z';
        const res = await getLive(decoder);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.quarantined_txs, 1);
        assert.strictEqual(res.body.parse_errors, 40, 'the routine-rejection count stays separate');
        assert.strictEqual(res.body.last_quarantined_block, 0, 'height 0 is a height, not a missing value');
        assert.strictEqual(res.body.last_quarantined_tx_hash, 'cafe01');
        assert.strictEqual(res.body.last_quarantined_at, '2026-10-12T00:00:00.000Z');
    });

    it('exports the skip count as its own Prometheus counter', function () {
        const registry = new Registry();
        const decoder = caughtUpDecoder();
        decoder.parseErrors = 40;
        decoder.quarantinedTxs = 2;
        registerDecoderMetrics(registry, decoder);
        const body = registry.render();
        assert.match(body, /^xchain_decoder_quarantined_tx_total 2$/m);
        assert.match(body, /^xchain_decoder_parse_errors_total 40$/m);
    });
});
