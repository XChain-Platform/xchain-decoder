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


const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const XChainDecoder  = require('./XChainDecoder');
const { resolveFeeDestination } = require('./feeDestination');
const jsonRouter = require('express-json-rpc-router')
const { installObservability } = require('./observability');   // default-off /metrics + structured log shim
const { registerDecoderMetrics } = require('./decoderMetrics'); // decoder feed-freshness gauges


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
// non-mainnet-only env override (see src/feeDestination.js). When resolved, the decoder persists
// outputs paying it to transaction_outputs so the indexer can validate native-coin fee payments.
const FEE_DESTINATION = resolveFeeDestination(NETWORK, process.env.FEE_DESTINATION || null)

// Express middleware that bounds JSON-RPC batch size. express-json-rpc-router runs
// Promise.all over every element of a batch array, while the per-IP rate limiter counts
// the whole batch as ONE request. Without a cap, a single ~100kb array of thousands of
// {"method":"health"} calls fans out into thousands of concurrent invocations - each
// health() draws a pooled MariaDB connection - amplifying one unauthenticated request
// into pool contention against the liveness-critical block loop. Only trivial status
// methods are exposed, so a small cap is ample.
function makeRpcBatchGuard(maxBatch){
    return (req, res, next) => {
        if (Array.isArray(req.body) && req.body.length > maxBatch){
            return res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32600, message: 'Batch too large (max ' + maxBatch + ' requests per call)' },
                id: null
            })
        }
        next()
    }
}

// GET /live, the LIVENESS probe the Docker HEALTHCHECK runs. It is /status plus the
// one thing /status structurally cannot see: the block loop retrying a block forever.
// decoderRunning only goes false when start() REJECTS, and the loop never rejects on a
// fetch/parse fault (skipping a block would corrupt the index), so a wedged decoder
// answered /status with 200 while lag grew without bound and autoheal, whose only input
// is the container's health status, never saw it.
//
// Kept separate from /status rather than folded in: /status is the load-balancer /
// uptime signal and its running+db semantics are relied on elsewhere.
//
// A module-scope registrar rather than an inline route so a test can drive THIS
// handler; a reimplementation inside a test would get exactly the 503 states this
// exists for wrong, and so would prove nothing about the probe that ships.
//
// isDecoderRunning is a getter, not a boolean: the flag it reads flips from start()'s
// settle and from shutdown(), long after this route is registered.
function registerLiveRoute(app, decoder, isDecoderRunning){
    app.get('/live', async (req, res) => {
        const decoderRunning = isDecoderRunning()
        let dbOk = false
        if (decoder.db) {
            try { dbOk = await decoder.db.ping() } catch (_) {}
        }
        const stalled = typeof decoder.isStalled === 'function' ? decoder.isStalled() : false
        // The parse loop has stopped ITERATING, which every other field here is
        // structurally blind to: isStalled() reports chain progress, and a caught-up
        // decoder makes none while being perfectly healthy. So a loop that dies while
        // caught up, or hangs inside an await, left running+db true and stalled false
        // and /live answered 200 forever. GATES health, unlike node_height_stale
        // below: a dead loop is exactly the wedge a restart does fix.
        const pollSilent = typeof decoder.isPollSilent === 'function' ? decoder.isPollSilent() : false
        // Latent REORG_HALT marker, reported on the one surface the monitor and the
        // container healthcheck actually poll. /status and the JSON-RPC health method
        // already carry it, and neither is polled, so a decoder carrying a durable halt
        // row rendered fully green everywhere an operator looks. TTL-cached inside
        // checkReorgHalt (60s) with concurrent probes collapsed, so a healthcheck burst
        // costs at most one DB query per minute.
        //
        // Deliberately NOT in the healthy gate below, for the reason given at /status
        // and the health method: the marker survives restarts and is cleared only by a
        // resync, while the halted decoder keeps parsing forward, so gating would make
        // autoheal restart-loop a service that is doing useful work and fix nothing.
        let reorgHalt = { halted: false, reason: null, at: null }
        if (dbOk && typeof decoder.checkReorgHalt === 'function'){
            try { reorgHalt = await decoder.checkReorgHalt() } catch (_) {}
        }
        const syncStatus = decoder.getSyncStatus()
        const healthy = decoderRunning && dbOk && !stalled && !pollSilent
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'healthy' : 'unhealthy',
            db: dbOk,
            running: decoderRunning,
            stalled,
            poll_silent: pollSilent,
            last_poll_at: decoder.lastPollAt || null,
            reorg_halted:      reorgHalt.halted === true,
            reorg_halt_reason: reorgHalt.reason || null,
            reorg_halted_at:   reorgHalt.at || null,
            // A frozen node tip, reported but deliberately NOT gating. isStalled()
            // returns false while the tip is stale on purpose: restarting the container
            // cannot fix an upstream node outage, and gating on it re-opens the
            // restart flap where a healthy decoder was recycled repeatedly for an
            // outage it could not affect. So the outage stays invisible to autoheal by
            // design and visible HERE, as a stable boolean a dashboard or watchdog can
            // read (getSyncStatus omits the key entirely when fresh).
            node_height_stale: syncStatus.node_height_stale === true,
            last_processed_block: syncStatus.last_processed_block,
            node_height: syncStatus.node_height,
            lag: syncStatus.lag,
            parse_errors: decoder.parseErrors,
            rpc_errors: decoder.rpcErrors + decoder.connector.rpcErrors
        })
    })
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
    decoder.start().then(() => {
        // start() awaits the parse loop, so it RESOLVES only when the loop breaks:
        // the SIGTERM/stopFlag path, or any fall-through out of `while (true)`.
        // Without this, decoderRunning only ever went false on a REJECTION, so a
        // cleanly-stopped decoder kept answering /live with 200 while parsing
        // nothing. Reported immediately, ahead of the poll-silence window.
        console.log('Decoder parse loop exited; reporting not-running.')
        decoderRunning = false
    }).catch((err) => {
        console.error('Decoder crashed:', err)
        decoderRunning = false
        decoderError = err
        // A decoder whose start() rejected does no work: the parse loop never runs and
        // the process would otherwise linger as a permanently-unhealthy but RUNNING
        // container that `--restart unless-stopped` never recycles. Exit non-zero so the
        // container restart policy (or a supervisor) can act, mirroring the sibling
        // xchain-indexer fatal handler. Faults that require an operator resync (durable
        // REORG_HALT) surface as a visible Exited(1) rather than a silent wedge.
        process.exit(1)
    })

    // Graceful shutdown on process signals
    const shutdown = () => {
        console.log('Received shutdown signal, stopping decoder...')
        // Flip BEFORE stop(): stop() only sets stopFlag, and the loop may take a
        // whole iteration to notice. A drain must not answer /live with 200 in the
        // window between the signal and the loop actually breaking.
        decoderRunning = false
        decoder.stop()
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection:', reason)
    })

    const app = express();
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

    // Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. The coin/network
    // labels let one Prometheus scrape distinguish the per-chain decoders.
    // See src/observability/README.md.
    let decoderVersion = '';
    try { decoderVersion = require('../package.json').version; } catch { /* version label is cosmetic */ }
    const observability = installObservability(app, {
        service: 'xchain-decoder',
        version: decoderVersion,
        // The decoder has no coin env of its own (chain identity comes from the
        // node it is pointed at), so COIN is optional and the label stays empty
        // unless a deploy sets it.
        coin:    process.env.COIN || '',
        network: NETWORK || ''
    });

    // The log shim is a console passthrough when shipping is off, so the stale-tip
    // warn works in every deployment; only its DESTINATION depends on the env.
    decoder.setObservabilityLogger(observability.logger)

    // Decoder feed-freshness gauges. registry is null unless
    // METRICS_ENABLED, and registerDecoderMetrics is then a no-op: nothing is
    // registered and no collector runs, matching the module's default-off contract.
    registerDecoderMetrics(observability.registry, decoder)


    // getmempool's shared snapshot cache (see the method's comment). Held here so
    // every request, whatever its limit, slices one cached 500-row window.
    let getmempoolCache = null;

    const jsonRpcController = {
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
            const syncStatus = decoder.getSyncStatus();

            // Live DB reachability probe. decoder.db is null until start()
            // creates the Database instance, so a null db means we are still
            // before the DB-connect phase. db.ping() draws its own pooled
            // connection; probing via getConnection() would grab (and then
            // release!) the block loop's open transaction connection mid-block.
            let dbOk = false
            let dbPhase = 'starting'
            if(decoder.db){
                try {
                    await decoder.db.ping()
                    dbOk = true
                    dbPhase = 'running'
                } catch(_) {
                    dbPhase = 'db-unreachable'
                }
            }

            // Latent REORG_HALT marker. TTL-cached inside checkReorgHalt, so a
            // monitoring burst costs at most one DB query per minute. Deliberately does
            // NOT flip `status` to unhealthy: the decoder healthcheck carries autoheal,
            // and a halted decoder still parses forward, so reporting unhealthy would
            // restart-loop a service that is doing useful work while fixing nothing (the
            // marker survives restarts and is only cleared by a resync). Report it as its
            // own field instead, and let the operator/watchdog act on it.
            let reorgHalt = { halted: false, reason: null, at: null, checked_at: null }
            if (dbOk && typeof decoder.checkReorgHalt === 'function'){
                try { reorgHalt = await decoder.checkReorgHalt() } catch (_) {}
            }

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

    // GET /status: returns 200 when the decoder is running and the DB is reachable,
    // or 503 when not. Distinct from the JSON-RPC `health` method so load-balancer /
    // uptime monitors can rely on the HTTP status code directly (the JSON-RPC
    // catch-all routes all GETs to 200 today).
    app.get('/status', async (req, res) => {
        let dbOk = false
        if (decoder.db) {
            // db.ping() uses its own pooled connection; see the health method note.
            try { dbOk = await decoder.db.ping() } catch (_) {}
        }
        // Latent halt marker, reported here too so an operator can see it on
        // the cheap probe. The HTTP code stays keyed on running+db for the reason given
        // in health() above: a dormant halt must not make an advancing decoder look dead.
        let reorgHalt = { halted: false, reason: null, at: null, checked_at: null }
        if (dbOk && typeof decoder.checkReorgHalt === 'function'){
            try { reorgHalt = await decoder.checkReorgHalt() } catch (_) {}
        }
        const healthy = decoderRunning && dbOk
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'healthy' : 'unhealthy',
            db: dbOk,
            running: decoderRunning,
            reorg_halted:      reorgHalt.halted,
            reorg_halt_reason: reorgHalt.reason,
            reorg_halted_at:   reorgHalt.at
        })
    })

    registerLiveRoute(app, decoder, () => decoderRunning)

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
    app.use(jsonRouter({methods: jsonRpcController}))

    app.listen(DECODER_API_PORT, () => {
      console.log('API listening on port '+DECODER_API_PORT);
    });
}

// Auto-start only when run directly (node src/api.js), so the module can be required by
// tests without opening a DB connection / listening socket.
if (require.main === module) startApi()

module.exports = { makeRpcBatchGuard, registerLiveRoute }