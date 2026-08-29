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
 **********************************************************************
 *
 * XChain Decoder - feed-freshness metrics
 *
 * Decoder-owned Prometheus gauges registered on the observability handle's
 * registry. The observability module itself is vendored byte-identically into
 * every xchain-* service and carries no domain metrics by design, so this lives
 * OUTSIDE src/observability/ where the vendored-copy parity check cannot see
 * it and a shared-module resync cannot delete it.
 *
 * Everything here reads decoder state at scrape time through one collector; no
 * timer is opened and no state is duplicated, so the metrics cannot drift from
 * what /live and the JSON-RPC health method report.
 *
 ********************************************************************/

// No labels: coin/network identity is already carried by xchain_service_info,
// and the registry caps series per metric.
const DECODER_GAUGES = [
    ['last_processed_block',                  'Height of the last block the decoder committed'],
    ['node_height',                           'Node chain tip height as of the last successful getblockchaininfo'],
    ['block_lag',                             'Blocks the decoder is behind the last-seen node tip'],
    ['last_tip_poll_timestamp_seconds',       'Unix time of the last successful getblockchaininfo poll'],
    ['tip_age_seconds',                       'Seconds since the last successful getblockchaininfo poll'],
    ['last_block_advance_timestamp_seconds',  'Unix time of the last forward block advance'],
    ['node_height_stale',                     '1 when the cached node tip is frozen (two or more consecutive tip polls failed)'],
    ['synced',                                '1 when the decoder is caught up to a fresh node tip'],
    ['stalled',                               '1 when the block loop is wedged on one height (/live gates on poll_silent too)'],
    ['poll_silent',                           '1 when the block loop has stopped ITERATING; gates /live health beside stalled'],
    ['last_poll_timestamp_seconds',           'Unix time of the last block-loop iteration, whether or not a block arrived'],
    ['last_reorg_depth',                      'Blocks rolled back by the most recent reorg']
];

const DECODER_COUNTERS = [
    ['parse_errors_total', 'Transactions the decoder failed to parse since process start'],
    ['rpc_errors_total',   'Node RPC errors seen since process start'],
    ['reorgs_total',       'Reorgs this decoder has rolled back since process start']
];

/**
 * Registers the decoder's feed-freshness metrics and one scrape-time collector.
 *
 * @param {object} registry  observability Registry (obs.registry; null when metrics are off)
 * @param {object} decoder   the live XChainDecoder instance
 * @returns {?object}        {gauges, counters, collector}, or null when nothing was registered
 */
function registerDecoderMetrics(registry, decoder) {
    if (!registry || !decoder) return null;

    const gauges = {};
    for (const [suffix, help] of DECODER_GAUGES) {
        gauges[suffix] = registry.gauge({ name: `xchain_decoder_${suffix}`, help });
    }
    const counters = {};
    for (const [suffix, help] of DECODER_COUNTERS) {
        counters[suffix] = registry.counter({ name: `xchain_decoder_${suffix}`, help });
    }

    // Only finite numbers reach the registry: Gauge#set throws on NaN/undefined,
    // and getSyncStatus() returns nulls before the first processed block. A metric
    // simply carries no series until its source has a real value.
    const setIf = (gauge, value) => { if (Number.isFinite(value)) gauge.set({}, value); };

    const collector = registry.addCollector(() => {
        const status = typeof decoder.getSyncStatus === 'function' ? decoder.getSyncStatus() : {};
        setIf(gauges.last_processed_block, status.last_processed_block);
        setIf(gauges.node_height,          status.node_height);
        setIf(gauges.block_lag,            status.lag);

        if (decoder.blockchainInfoLastRefreshAt > 0) {
            setIf(gauges.last_tip_poll_timestamp_seconds, decoder.blockchainInfoLastRefreshAt / 1000);
        }
        if (decoder.lastAdvanceAt > 0) {
            setIf(gauges.last_block_advance_timestamp_seconds, decoder.lastAdvanceAt / 1000);
        }
        if (typeof decoder.nodeTipAgeSeconds === 'function') {
            setIf(gauges.tip_age_seconds, decoder.nodeTipAgeSeconds());
        }
        if (typeof decoder.isNodeHeightStale === 'function') {
            gauges.node_height_stale.set({}, decoder.isNodeHeightStale() ? 1 : 0);
        }
        if (typeof decoder.isSynced === 'function')  gauges.synced.set({},  decoder.isSynced()  ? 1 : 0);
        if (typeof decoder.isStalled === 'function') gauges.stalled.set({}, decoder.isStalled() ? 1 : 0);

        // The dead-loop signal `stalled` is structurally blind to: isStalled() reports
        // chain progress, which a caught-up decoder makes none of while perfectly
        // healthy, so a loop that dies while caught up leaves stalled 0 forever. /live
        // gates health on this one alongside stalled (api.js registerLiveRoute); a
        // metrics-only deployment saw neither until now. Boolean always emits, matching
        // isPollSilent()'s own "0 means not silent" answer before the first iteration;
        // the timestamp stays absent until then, since 0 would read as 1970.
        if (typeof decoder.isPollSilent === 'function') {
            gauges.poll_silent.set({}, decoder.isPollSilent() ? 1 : 0);
        }
        if (decoder.lastPollAt > 0) {
            setIf(gauges.last_poll_timestamp_seconds, decoder.lastPollAt / 1000);
        }

        // setMonotonic, not inc: these mirror lifetime counters the decoder already
        // keeps, and a re-read must not double-count what the last scrape saw.
        const rpcErrors = (decoder.rpcErrors || 0) + ((decoder.connector && decoder.connector.rpcErrors) || 0);
        counters.rpc_errors_total.setMonotonic({}, rpcErrors);
        counters.parse_errors_total.setMonotonic({}, decoder.parseErrors || 0);

        // Reorg churn. The durable REORG rows and the indexer's reorgsProcessed cover
        // the completed handshake, but neither is scrapeable when only Prometheus is
        // deployed; these read the decoder's own lifetime counters at scrape time.
        setIf(gauges.last_reorg_depth, decoder.lastReorgDepth);
        counters.reorgs_total.setMonotonic({}, decoder.reorgCount || 0);
    });

    return { gauges, counters, collector };
}

module.exports = { registerDecoderMetrics, DECODER_GAUGES, DECODER_COUNTERS };
