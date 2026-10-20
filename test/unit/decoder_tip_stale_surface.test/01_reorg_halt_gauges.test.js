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

// A parked decoder skips the tip refresh, so without the REORG_HALT gauges a scrape
// shows only node_height_stale 1 beside stalled 0, which reads as a node outage.

const assert = require('assert');
const XChainDecoder = require('../../../src/XChainDecoder');
const { registerDecoderMetrics } = require('../../../src/metrics/decoder_metrics');
const { Registry } = require('../../../src/observability/metrics');

// src/XChainDecoder.js BLOCKCHAIN_INFO_REFRESH_MS; stale is > 2x this.
const REFRESH_MS = 30000;

// A decoder mid-catch-up with a fresh tip, before any marker probe has answered.
function makeRunningDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    );
    decoder.lastProcessedBlockIndex = 100;
    decoder.blockchainInfoLastBlock = 150;
    decoder.blockchainInfoLastRefreshAt = Date.now();
    decoder.lastAdvanceAt = Date.now();
    return decoder;
}

describe('registerDecoderMetrics() REORG_HALT gauges', function () {
    it('exports a parked halt beside the stale tip it causes', function () {
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        decoder.blockchainInfoLastRefreshAt = Date.now() - (3 * REFRESH_MS);
        decoder.reorgHalted = true;
        decoder.reorgHaltParked = true;
        decoder.reorgHaltCheckedAt = Date.now();
        registerDecoderMetrics(registry, decoder);

        const body = registry.render();
        assert.match(body, /^xchain_decoder_reorg_halted 1$/m);
        assert.match(body, /^xchain_decoder_reorg_halt_parked 1$/m);
        assert.match(body, /^xchain_decoder_node_height_stale 1$/m);
        assert.match(body, /^xchain_decoder_stalled 0$/m);
    });

    it('exports a latent halt on a decoder that is still parsing', function () {
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        decoder.reorgHalted = true;
        decoder.reorgHaltCheckedAt = Date.now();
        registerDecoderMetrics(registry, decoder);

        const body = registry.render();
        assert.match(body, /^xchain_decoder_reorg_halted 1$/m);
        assert.match(body, /^xchain_decoder_reorg_halt_parked 0$/m);
    });

    it('omits the halt flag until the first marker probe, then reports a clear decoder as 0', function () {
        // "Never looked" is not "not halted": /ready reports reorg_halt_unchecked for it.
        const registry = new Registry();
        const decoder = makeRunningDecoder();
        registerDecoderMetrics(registry, decoder);
        assert.ok(!/^xchain_decoder_reorg_halted /m.test(registry.render()));
        assert.match(registry.render(), /^xchain_decoder_reorg_halt_parked 0$/m);

        decoder.reorgHaltCheckedAt = Date.now();
        assert.match(registry.render(), /^xchain_decoder_reorg_halted 0$/m);
    });
});
