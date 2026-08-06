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
const { installObservability } = require('./observability');   // : default-off /metrics + structured log shim


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
    decoder.start().catch((err) => {
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
    // Allow CORS for development
    app.use(cors());

    // : Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. The coin/network
    // labels let one Prometheus scrape distinguish the per-chain decoders.
    // See src/observability/README.md.
    let decoderVersion = '';
    try { decoderVersion = require('../package.json').version; } catch { /* version label is cosmetic */ }
    installObservability(app, {
        service: 'xchain-decoder',
        version: decoderVersion,
        // The decoder has no coin env of its own (chain identity comes from the
        // node it is pointed at), so COIN is optional and the label stays empty
        // unless a deploy sets it.
        coin:    process.env.COIN || '',
        network: NETWORK || ''
    });


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

            // Latent REORG_HALT marker . TTL-cached inside checkReorgHalt, so a
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
        // Latent halt marker , reported here too so an operator can see it on
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

    // GET /live: the LIVENESS probe, and the route the Docker HEALTHCHECK runs (see
    // SERVICE_HEALTHCHECK[XCHAIN_DECODER] in xchain-node's ModuleService, which sets
    // path:'/live'). It is /status plus the one thing /status structurally cannot see:
    // the block loop retrying a block forever. decoderRunning only goes false when
    // start() REJECTS, and the loop is written never to reject on a fetch/parse fault
    // (skipping a block would corrupt the index), so a wedged decoder kept answering
    // /status with 200 while lag grew without bound and autoheal, whose only input is
    // docker inspect's Health.Status, never saw a thing.
    //
    // Kept separate from /status rather than folded into it: /status is the
    // load-balancer / uptime signal and its running+db semantics are relied on
    // elsewhere. Same split, same reason, as sync's /health override.
    app.get('/live', async (req, res) => {
        let dbOk = false
        if (decoder.db) {
            try { dbOk = await decoder.db.ping() } catch (_) {}
        }
        const stalled = typeof decoder.isStalled === 'function' ? decoder.isStalled() : false
        const syncStatus = decoder.getSyncStatus()
        const healthy = decoderRunning && dbOk && !stalled
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'healthy' : 'unhealthy',
            db: dbOk,
            running: decoderRunning,
            stalled,
            last_processed_block: syncStatus.last_processed_block,
            node_height: syncStatus.node_height,
            lag: syncStatus.lag,
            parse_errors: decoder.parseErrors,
            rpc_errors: decoder.rpcErrors + decoder.connector.rpcErrors
        })
    })

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

module.exports = { makeRpcBatchGuard }