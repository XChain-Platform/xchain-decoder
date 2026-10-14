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
 *********************************************************************
 *
 * Kaspa ingest part.
 *
 * The bitcoinjs families run through runSyncLoop(); Kaspa cannot (blake3
 * txids, borsh framing, no raw-hex block RPC), so the family gets its own
 * loop that writes the SAME tables. Everything family-specific already lives
 * under src/chain/kaspa/, and this part is only the wiring:
 *
 *   this.startKaspaIngest({ rpc | rpcUrl, intervalMs, checkpointFile })
 *
 * Deliberately NOT started automatically. The decoder has no way to know
 * whether it is the writer for this chain in a given deployment (two
 * decoders against one database would double-ingest), and a silently started
 * background writer is exactly the kind of surprise this codebase avoids
 * elsewhere. startup.js calls it once it has decided this process owns the
 * Kaspa ingest, and calls stopKaspaIngest() on shutdown so the loop finishes
 * its current tick instead of cutting a transaction in half.
 *
 * The chain blocks come from the node's wRPC endpoint. Pass `rpc` to reuse an
 * existing connection, or `rpcUrl` to let the family build one (which loads
 * the optional `ws` dependency lazily and fails loudly if it is missing).
 ********************************************************************/
'use strict';

const { createRpcClient } = require('../chain/kaspa/kaspa_node_client.js');
const { KaspaDecoderService } = require('../chain/kaspa/kaspa_service.js');

module.exports = {
    // exported so the platform-logger preference is directly testable
    kaspaLogger,
    wrap,

    // Start the Kaspa loop. Returns the service so a caller can inspect stats,
    // and throws with a reason when this instance is already running one.
    startKaspaIngest({ rpc = null, rpcUrl = null, intervalMs = 5000, checkpointFile = null,
        networkId = null, minConfirmationCount = 10, maxTicks = Infinity, onTick = null } = {}) {

        if (this.kaspaService) throw new Error('startKaspaIngest: this decoder is already running a Kaspa ingest');
        if (this.xchainBlockDecoder && this.xchainBlockDecoder.wireFormat !== 'kaspa') {
            throw new Error('startKaspaIngest: this decoder is configured for wireFormat "'
                + this.xchainBlockDecoder.wireFormat + '", not "kaspa"');
        }

        const client = rpc || createRpcClient({ url: rpcUrl });
        const service = new KaspaDecoderService({
            rpc: client,
            conn: this.db,                       // the platform Database exposes query(sql, values)
            networkId: networkId || this.network,
            minConfirmationCount,
            checkpointFile,
            logger: kaspaLogger(this.log),
        });

        this.kaspaService = service;
        this.kaspaIngestPromise = (async () => {
            try {
                if (client.connect) await client.connect();
                // service.init() is deliberately NOT called here any more: run() initialises inside its
                // own retry loop, so a node that is not up yet is retried instead of rejecting the
                // start promise and leaving this chain unread until an operator restarts the process.
                await service.run({ intervalMs, maxTicks, onTick });
            } finally {
                if (client.disconnect) await client.disconnect().catch(() => {});
                this.kaspaService = null;
            }
        })();

        return service;
    },

    // Graceful stop: finishes the tick in flight, then settles.
    async stopKaspaIngest() {
        if (!this.kaspaService) return false;
        this.kaspaService.requestStop();
        await this.kaspaIngestPromise.catch(() => {});   // the promise rethrows only for the caller
        return true;
    },

    // Stats for the health/status surface. Null when this instance is not the
    // Kaspa writer, which is a normal state, not an error.
    kaspaIngestStats() {
        return this.kaspaService ? { ...this.kaspaService.stats, ticks: this.kaspaService.ticks,
            checkpoint: this.kaspaService.checkpoint } : null;
    },
};

// The platform's log() takes a string; the family service wants the four-level
// object shape. Adapt rather than assume either side changes.
// Prefer the platform's own logger (observability/logger), which carries real levels:
// the decoder's this.log is a single info-level sink, so routing errors through it lost
// the level entirely (found in the 2026-10-11 review). Falls back to that sink.
// Resolved at module scope (CODE-STYLE: require inside a body only for a computed path). A
// standalone run may not have the platform's logger on disk, so the failure is captured here
// instead of being thrown: kaspaLogger() then falls back to the sink the decoder hands us.
let platformGetLogger = null;
try { platformGetLogger = require('../observability/logger').getLogger; } catch (error) { platformGetLogger = null; }

function kaspaLogger(fallbackLog) {
    if (typeof platformGetLogger === 'function') {
        try {
            const logger = platformGetLogger();
            if (logger) return logger;
        } catch (error) {
            // the logger exists but cannot initialise here: fall through to the sink
        }
    }
    return typeof fallbackLog === 'function' ? wrap(fallbackLog) : undefined;
}
function wrap(log) {
    const call = (level, message, fields) => log.call(null, '[' + level + '] ' + message
        + (fields ? ' ' + JSON.stringify(fields) : ''));
    return {
        error: (m, f) => call('error', m, f),
        warn: (m, f) => call('warn', m, f),
        info: (m, f) => call('info', m, f),
        debug: (m, f) => call('debug', m, f),
        child() { return this; },
    };
}
