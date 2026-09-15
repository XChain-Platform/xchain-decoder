/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const { installObservability } = require('../observability');   // default-off /metrics + structured log shim
const { registerDecoderMetrics } = require('../decoder_metrics'); // decoder feed-freshness gauges

// Observability for the decoder's app: /metrics and the log shim, then the
// decoder's feed-freshness gauges. COIN is the raw env value the caller read.
function installDecoderObservability(app, decoder, { COIN, NETWORK }) {
    // Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. The coin/network
    // labels let one Prometheus scrape distinguish the per-chain decoders.
    // See src/observability/README.md.
    let decoderVersion = '';
    try { decoderVersion = require('../../package.json').version; } catch { /* version label is cosmetic */ }
    const observability = installObservability(app, {
        service: 'xchain-decoder',
        version: decoderVersion,
        // The decoder has no coin env of its own (chain identity comes from the
        // node it is pointed at), so COIN is optional and the label stays empty
        // unless a deploy sets it.
        coin:    COIN || '',
        network: NETWORK || ''
    });

    // The log shim is a console passthrough when shipping is off, so the stale-tip
    // warn works in every deployment; only its DESTINATION depends on the env.
    decoder.setObservabilityLogger(observability.logger)

    // Decoder feed-freshness gauges. registry is null unless
    // METRICS_ENABLED, and registerDecoderMetrics is then a no-op: nothing is
    // registered and no collector runs, matching the module's default-off contract.
    registerDecoderMetrics(observability.registry, decoder)
}

module.exports = { installDecoderObservability }
