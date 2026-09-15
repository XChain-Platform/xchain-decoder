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
 * XChain Decoder - API
 * 
 * This file parses in environmental variables and starts up the decoder instance
 * 
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

// Before anything else logs. The env-validation failure at startApi()'s
// DECODER_API_PORT check is exactly the line an operator needs levelled and
// timestamped, and installObservability does not run until ~200 lines further
// down.
const { patchConsole } = require('./observability');
patchConsole({
    service: 'xchain-decoder',
    version: require('../package.json').version,
    coin:    process.env.COIN || '',
    network: process.env.NETWORK || ''
});

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createShutdown, createDecoderDrain } = require('./shutdown');
const XChainDecoder  = require('./XChainDecoder');
const { resolveFeeDestination } = require('./protocol/fee_destination');
const jsonRouter = require('express-json-rpc-router')
const {
    makeRpcBatchGuard,
    registerLiveRoute,
    noteProbeFailure,
    nodeReachabilityFields,
    resetProbeLogState,
    ageProbeLogState,
    PROBE_LOG_WINDOW_MS
} = require('./api/probe_routes');
const { reportStartFailure, installCrashHandlers } = require('./api/crash_reporting');
const { getHealthProbeState } = require('./api/health_probe');
const { installDecoderObservability } = require('./api/observability_wiring');

const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_PORT =  process.env.NODE_PORT
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const DB_URL =  process.env.DECODER_DB_HOST
const DB_PORT =  process.env.DECODER_DB_PORT
const DECODER_DB_NAME =  process.env.DECODER_DB_NAME
const DECODER_DB_USER =  process.env.DECODER_DB_USER
const DB_PASSWORD =  process.env.DECODER_DB_PASS
const DECODER_API_PORT = parseInt(process.env.DECODER_API_PORT, 10)
const AUX_POW = process.env.AUX_POW === 'true' || process.env.AUX_POW === '1'
// Native-coin protocol fee destination for this coin+network: registry-pinned default with a
// non-mainnet-only env override (see src/protocol/fee_destination.js). When resolved, the decoder persists
// outputs paying it to transaction_outputs so the indexer can validate native-coin fee payments.
const FEE_DESTINATION = resolveFeeDestination(NETWORK, process.env.FEE_DESTINATION || null)


// The JSON-RPC health payload, built from getHealthProbeState's result. The caller
// reads the running flag and the start error after that probe resolves, so both
// describe the moment the payload is built.
function buildHealthResult(decoder, state, decoderRunning, decoderError){
    const { syncStatus, dbOk, dbPhase, reorgHalt } = state
    const healthy = decoderRunning && dbOk
    return {
        status: healthy ? "healthy" : "unhealthy",
        phase: dbPhase,
        synced: decoder.isSynced(),
        // True when this decoder is carrying a durable REORG_HALT marker, whether
        // it was just written or has sat dormant since before the last restart.
        // Any database reporting true is unfit to publish as a bootstrap.
        reorg_halted:        reorgHalt.halted,
        reorg_halt_reason:   reorgHalt.reason,
        reorg_halted_at:     reorgHalt.at,
        // { node_height, stored_height, since } while the parse loop is waiting
        // out a node in initial block download below our tip, null otherwise.
        node_catching_up:    (decoder && decoder.nodeCatchingUp) || null,
        // node_last_ok_at + node_unreachable: whether the coin node is answering
        // this decoder at all, and since when it stopped. Reported, not gated on.
        ...nodeReachabilityFields(decoder),
        // True once the parse loop has stopped on the halt and is waiting for
        // the clear; a latent marker on a decoder still parsing reports false.
        reorg_halt_parked:   reorgHalt.parked === true,
        reorg_halt_parked_at: reorgHalt.parked_at || null,
        // Set once an operator cleared a halt (db.clearReorgHalt); null while a
        // halt is live or none was ever recorded.
        reorg_halt_cleared_at:     reorgHalt.cleared_at || null,
        reorg_halt_cleared_reason: reorgHalt.cleared_reason || null,
        reorg_halt_checked_at: reorgHalt.checked_at,
        ...syncStatus,
        lastProcessedBlock: syncStatus.last_processed_block,
        chainTipBlock: syncStatus.node_height,
        blockLag: syncStatus.lag,
        // null when either height is still unknown (-1 before the first
        // getBlockchainInfo, or nothing processed yet): the old Math.max(0, ...)
        // clamp turned a genuinely-unknown/negative gap into a false "synced 0",
        // disagreeing with blockLag above. Report the true gap or null.
        lag_blocks: (decoder.blockchainInfoLastBlock >= 0 && decoder.lastProcessedBlockIndex >= 0)
            ? (decoder.blockchainInfoLastBlock - decoder.lastProcessedBlockIndex)
            : null,
        rpc_errors: decoder.rpcErrors + decoder.connector.rpcErrors,
        parse_errors: decoder.parseErrors,
        error: decoderError ? decoderError.message : null
    }
}

// GET /status: returns 200 when the decoder is running and the DB is reachable,
// or 503 when not. Distinct from the JSON-RPC `health` method so load-balancer /
// uptime monitors can rely on the HTTP status code directly (the JSON-RPC
// catch-all routes all GETs to 200 today).
function registerStatusRoute(app, decoder, isDecoderRunning){
    app.get('/status', async (req, res) => {
        let dbOk = false
        if (decoder.db) {
            // db.ping() uses its own pooled connection; see the note in src/api/health_probe.js.
            try { dbOk = await decoder.db.ping() } catch (e) { noteProbeFailure('db_ping', '/status', e) }
        }
        // Halt marker, reported here too so an operator can see it on the cheap probe.
        // The HTTP code stays keyed on running+db for the reason given in
        // src/api/health_probe.js: neither a dormant halt nor a park is a fault a restart repairs.
        let reorgHalt = { halted: false, reason: null, at: null, checked_at: null }
        if (dbOk && typeof decoder.checkReorgHalt === 'function'){
            try { reorgHalt = await decoder.checkReorgHalt() } catch (e) { noteProbeFailure('reorg_halt', '/status', e) }
        }
        // RULED 2026-09-01: xchain-node's BootstrapHealthGate refuses any
        // /status payload with no lag key (lagKeys: lag_blocks, blockLag, lag) once it
        // falls back to this route. getSyncStatus() already reports the same
        // node-height-minus-processed-height gap the JSON-RPC health method and /live
        // publish, null before the first processed block rather than a false zero.
        const syncStatus = decoder.getSyncStatus()
        // A getter: the flag flips from start()'s settle and from the shutdown drain.
        const decoderRunning = isDecoderRunning()
        const healthy = decoderRunning && dbOk
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'healthy' : 'unhealthy',
            db: dbOk,
            running: decoderRunning,
            lag: syncStatus.lag,
            reorg_halted:      reorgHalt.halted,
            reorg_halt_reason: reorgHalt.reason,
            reorg_halted_at:   reorgHalt.at,
            // { node_height, stored_height, since } while the parse loop is waiting out
            // a node in initial block download below our tip, null otherwise.
            node_catching_up:  (decoder && decoder.nodeCatchingUp) || null,
            // node_last_ok_at + node_unreachable: whether the coin node is answering
            // this decoder at all, and since when it stopped. Reported, not gated on.
            ...nodeReachabilityFields(decoder),
            // Ships beside the boolean, never without it. "Not halted" is only an answer
            // if something looked, and the probe is fail-soft: its state starts at
            // not-halted with checked_at null, so a decoder that has NEVER completed a
            // probe publishes exactly what a clean one publishes. Consumers that gate on
            // this body (xchain-node's BootstrapHealthGate falls back to GET /status when
            // the JSON-RPC health surface is unavailable) can only tell those two apart
            // if this route carries the timestamp the health method already carries.
            reorg_halt_checked_at: reorgHalt.checked_at,
            // True only once the parse loop has STOPPED on the halt. A latent marker on a
            // decoder still parsing forward reports false; see getReorgHaltStatus().
            reorg_halt_parked: reorgHalt.parked === true,
            reorg_halt_parked_at: reorgHalt.parked_at || null
        })
    })
}

// The JSON-RPC methods, keyed by name for express-json-rpc-router. The health
// method's flag and error come through getters for the same reason as /status.
function createJsonRpcController(decoder, isDecoderRunning, getDecoderError){
    return {
        // Function to check if xchain-decoder is up
        async ping() {
            return {status:"success"};
        },
        // Health check that reports actual decoder state.
        // When the decoder is wedged waiting for MariaDB (verifyDatabase loops
        // forever), decoder.db is null or a SELECT 1 times out. In either case
        // we report phase "starting" and status "unhealthy" so monitoring can
        // distinguish "process up, DB unreachable" from "parse loop running".
        async health() {
            const state = await getHealthProbeState(decoder)
            return buildHealthResult(decoder, state, isDecoderRunning(), getDecoderError())
        },
        // Latest decoded block index alongside the coin-node's tip so the
        // decoder→node lag is visible in a single call.
        async getlatestblock() {
            let status = decoder.getSyncStatus();
            return {
                block_index:      status.last_processed_block,
                node_block_index: status.node_height,
                is_synced:        decoder.isSynced()
            };
        },
        ...createMempoolMethods(decoder)
    }
}

// getmempool's shared snapshot cache (see the method's comment). Held here so
// every request, whatever its limit, slices one cached 500-row window.
function createMempoolMethods(decoder){
    let getmempoolCache = null;
    return {
        // Current mempool snapshot for remote explorers. mempool_transactions is
        // deliberately excluded from xchain-sync replication (node-local,
        // non-deterministic observation), so an explorer serving from synced
        // replicas has no DB path to pending actions; this method is that path.
        // Returns the node's TOTAL mempool tx count (XChain or not, from the
        // last updateMempool poll; -1 until one has run), the count of
        // XChain-carrying rows, and a bounded row window (same 500-row cap and
        // tx_hash ordering as the explorer's colocated-DB read). Rows are
        // PRE-VALIDATION: the indexer can still reject them at confirmation.
        //
        // TTL-cached (default 5s, GETMEMPOOL_CACHE_MS) because this method, unlike
        // its trivial siblings above, reads the DB: without the cache an
        // unauthenticated request burst would amplify into pooled-connection
        // contention against the block loop (the same hazard the batch guard
        // below exists for). The full 500-row window is cached once and sliced
        // per-request, so differing limits share one read. A poll-cycle-stale
        // snapshot is fine: updateMempool itself only rewrites every 60s.
        async getmempool(params) {
            const ttl = parseInt(process.env.GETMEMPOOL_CACHE_MS, 10) || 5000;
            const now = Date.now();
            const db  = decoder.mempoolDb || decoder.db;
            if (!getmempoolCache || (now - getmempoolCache.t) >= ttl) {
                let rows = [], total = 0;
                if (db) {
                    try {
                        rows  = await db.getMempoolTransactions(500);
                        total = await db.getMempoolTransactionCount();
                    } catch (err) {
                        // Serve the stale snapshot if we have one; a mempool read
                        // must never surface as an API error to remote explorers.
                        console.error('getmempool: mempool read failed:', err);
                        rows  = getmempoolCache ? getmempoolCache.rows  : [];
                        total = getmempoolCache ? getmempoolCache.total : 0;
                    }
                }
                getmempoolCache = { t: now, rows, total };
            }
            const limit = Math.max(1, Math.min(parseInt(params && params.limit, 10) || 500, 500));
            return {
                node_tx_count: decoder.nodeMempoolTxCount,
                node_updated_at: decoder.nodeMempoolUpdatedAt,
                total: getmempoolCache.total,
                rows: getmempoolCache.rows.slice(0, limit).map(r => ({
                    tx_hash:    r.tx_hash,
                    source:     r.source,
                    // TEXT can come back as a Buffer depending on driver options;
                    // normalize so the JSON body always carries the UTF-8 string.
                    data:       Buffer.isBuffer(r.data) ? r.data.toString('utf8') : r.data,
                    first_seen: (r.first_seen instanceof Date) ? Math.floor(r.first_seen.getTime() / 1000)
                              : (r.first_seen != null ? r.first_seen : null)
                }))
            };
        }
    }
}

// The app's middleware in registration order: security headers, the per-IP rate
// limiter, the JSON body limit, CORS, then observability and the decoder's gauges.
function installAppMiddleware(app, decoder){
    app.use(helmet());

    // Rate limiting (requests per minute per IP; override with DECODER_RATE_LIMIT_RPM)
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: parseInt(process.env.DECODER_RATE_LIMIT_RPM, 10) || 100,
        standardHeaders: true,
        legacyHeaders: false
    }));

    app.use(bodyParser.json({ limit: '100kb' }));
    // Open CORS: every method this API exposes is a read-only status probe, so
    // there is nothing a cross-origin caller can reach that a direct one cannot.
    app.use(cors());

    installDecoderObservability(app, decoder, { COIN: process.env.COIN, NETWORK })
}

// Routes in registration order: GET /status, GET /live, the batch guard, the
// empty-body default, then the JSON-RPC router mounted at the root.
function registerRoutes(app, decoder, isDecoderRunning, getDecoderError){
    registerStatusRoute(app, decoder, isDecoderRunning)
    registerLiveRoute(app, decoder, isDecoderRunning)

    // Bound JSON-RPC batch size (see makeRpcBatchGuard). Must run after bodyParser
    // (req.body parsed) and before the router (dispatch).
    app.use(makeRpcBatchGuard(parseInt(process.env.DECODER_RPC_MAX_BATCH, 10) || 20))

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({methods: createJsonRpcController(decoder, isDecoderRunning, getDecoderError)}))
}

async function startApi(){
    // Validate required env vars that have no safe default: a missing port causes Node to
    // bind a random OS-assigned port, making the container appear healthy while every
    // downstream caller gets connection-refused. Checked here (not at module load) so the
    // module can be required by tests without a valid port set.
    if (!process.env.DECODER_API_PORT || isNaN(DECODER_API_PORT) || DECODER_API_PORT < 1 || DECODER_API_PORT > 65535) {
        console.error('DECODER_API_PORT is not set or invalid. Set a valid port (1-65535) in the environment.')
        process.exit(1)
    }
    const decoder = new XChainDecoder(NETWORK, DB_URL, DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DB_PASSWORD, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, AUX_POW, FEE_DESTINATION);
    let decoderRunning = true
    let decoderError = null
    // start() awaits the parse loop, so this promise SETTLES when the loop breaks:
    // on a fatal error here, or on the stopFlag the drain sets at a block boundary.
    const decoderExited = decoder.start().then(() => {
        // start() awaits the parse loop, so it RESOLVES only when the loop breaks:
        // the SIGTERM/stopFlag path, or any fall-through out of `while (true)`.
        // Without this, decoderRunning only ever went false on a REJECTION, so a
        // cleanly-stopped decoder kept answering /live with 200 while parsing
        // nothing. Reported immediately, ahead of the poll-silence window.
        console.log('Decoder parse loop exited; reporting not-running.')
        decoderRunning = false
    }).catch((err) => {
        decoderRunning = false
        decoderError = err
        reportStartFailure(decoder, err)
    })

    installCrashHandlers(decoder)

    const app = express();
    installAppMiddleware(app, decoder)
    registerRoutes(app, decoder, () => decoderRunning, () => decoderError)

    const server = app.listen(DECODER_API_PORT, () => {
      console.log('API listening on port '+DECODER_API_PORT);
    });

    // Graceful shutdown. node is PID 1 in the image, so `docker stop` delivers
    // SIGTERM here. The earlier handler only set stopFlag: the loop broke, but
    // this listener and the DB pool kept the process alive and nothing exited,
    // so every stop ended in docker's SIGKILL. The drain is bounded by its own
    // hard-exit timer (src/shutdown.js) because installing a handler removes
    // node's default terminate.
    const shutdown = createShutdown({
        drain: createDecoderDrain({
            decoder:     decoder,
            server:      server,
            loopSettled: decoderExited,
            // Flip BEFORE stop(): stop() only sets stopFlag and the loop may take a
            // whole iteration to notice. A drain must not answer /live with 200 in
            // the window between the signal and the loop actually breaking.
            onDraining:  () => { decoderRunning = false }
        })
    })
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
}

// Auto-start only when run directly (node src/api.js), so the module can be required by
// tests without opening a DB connection / listening socket.
if (require.main === module) startApi()

// startApi is exported so the crash handlers it installs can be driven for real
// rather than asserted against the source text; the require.main guard above
// still keeps a plain require from opening a port or a DB connection.
module.exports = { makeRpcBatchGuard, registerLiveRoute, startApi, noteProbeFailure, nodeReachabilityFields, resetProbeLogState, ageProbeLogState, PROBE_LOG_WINDOW_MS }