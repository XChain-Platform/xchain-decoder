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

const { getLogger } = require('../observability');

// Records a health probe that threw, so the route's answer is not the only thing
// an operator has. The failure this closes is specific: when checkReorgHalt()
// throws, /live and /status answer reorg_halted false, so a decoder carrying a
// durable halt marker reads as clean on every surface an operator or the
// container healthcheck polls. db.ping() is the same shape: the probe fails, the
// route still answers, and nothing names which probe it was.
//
// Throttled per probe because these routes are caller-driven: the express rate
// limiter admits 100 requests per minute per IP, and a DB outage would otherwise
// turn each of them into a log line, spending the retention window this service's
// log caps are sized for on one repeated fault. The count of what was suppressed
// rides the next line out, so a throttled flood stays measurable.
const PROBE_LOG_WINDOW_MS = 60000;
const _probeLogState = new Map();   // probe key -> { suppressed, lastLoggedAt }

function noteProbeFailure(probe, route, err) {
    try {
        const key = probe + '|' + route;
        const now = Date.now();
        const seen = _probeLogState.get(key);
        if (seen && (now - seen.lastLoggedAt) < PROBE_LOG_WINDOW_MS) {
            seen.suppressed += 1;
            return null;
        }
        const suppressed = seen ? seen.suppressed : 0;
        _probeLogState.set(key, { suppressed: 0, lastLoggedAt: now });
        const fields = {
            probe,
            route,
            err: err && err.message ? err.message : String(err)
        };
        if (suppressed > 0) fields.suppressed = suppressed;
        return getLogger().warn('HEALTH_PROBE_FAILED', fields);
    } catch (_) {
        // A health route must answer even when the thing describing it is broken.
        return null;
    }
}

// Tests only: the throttle table is module-wide, so a case asserting a first line
// must not inherit the previous case's window.
function resetProbeLogState() { _probeLogState.clear(); }

// Tests only: rewinds every window past its edge while KEEPING the suppressed
// counts, so a case can assert what the next line reports about the flood it
// swallowed. Clearing the table instead would drop exactly the number under test.
function ageProbeLogState() {
    for (const entry of _probeLogState.values()) {
        entry.lastLoggedAt -= (PROBE_LOG_WINDOW_MS + 1);
    }
}

// Node reachability for the health payloads: `node_last_ok_at` (the last successful
// node RPC, null if there has never been one) and `node_unreachable` (null, or the
// outage with its age in seconds). A decoder whose node never answered a single RPC
// is otherwise indistinguishable from a healthy one on every surface an operator polls;
// these two fields are that difference, reported and never gating.
//
// Fail-soft: an absent connector, or one from a build/test stub predating the method,
// reports the unknown-but-not-failing pair rather than throwing inside a probe.
function nodeReachabilityFields(decoder){
    const connector = decoder && decoder.connector
    if (!connector || typeof connector.nodeReachability !== 'function'){
        return { node_last_ok_at: null, node_unreachable: null }
    }
    try {
        return connector.nodeReachability()
    } catch (e) {
        return { node_last_ok_at: null, node_unreachable: null }
    }
}

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
async function getLiveProbeState(decoder, isDecoderRunning) {
    const decoderRunning = isDecoderRunning()
    let dbOk = false
    if (decoder.db) {
        try { dbOk = await decoder.db.ping() } catch (e) { noteProbeFailure('db_ping', '/live', e) }
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
    // and the health method: the marker survives restarts and is released only by an
    // audited operator clear, so gating would have autoheal restart-loop a container
    // for a fault no restart touches. That holds in both halt shapes, latent (the
    // decoder keeps parsing forward and is doing useful work) and parked (it has
    // stopped on purpose and is waiting for the clear, which lands while it runs).
    let reorgHalt = { halted: false, reason: null, at: null }
    if (dbOk && typeof decoder.checkReorgHalt === 'function'){
        try { reorgHalt = await decoder.checkReorgHalt() } catch (e) { noteProbeFailure('reorg_halt', '/live', e) }
    }
    const syncStatus = decoder.getSyncStatus()
    const healthy = decoderRunning && dbOk && !stalled && !pollSilent
    return { decoderRunning, dbOk, stalled, pollSilent, reorgHalt, syncStatus, healthy }
}

function sendLiveResponse(res, decoder, state) {
    const { decoderRunning, dbOk, stalled, pollSilent, reorgHalt, syncStatus, healthy } = state
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
        // { node_height, stored_height, since } while the parse loop is waiting out
        // a node in initial block download below our tip, null otherwise.
        node_catching_up:  (decoder && decoder.nodeCatchingUp) || null,
        // node_last_ok_at + node_unreachable. Same reporting-not-gating contract as
        // node_height_stale below, and the only surface that separates "the node has
        // never answered" from "the node is fine".
        ...nodeReachabilityFields(decoder),
        // Reported, never gated on, like the halt itself: the parse loop parks on a
        // REORG_HALT deliberately, and this route drives autoheal, so a parked
        // decoder answering 503 here would restart-loop it for a marker no restart
        // clears. isStalled() carries the matching gate.
        reorg_halt_parked: reorgHalt.parked === true,
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
}

function registerLiveRoute(app, decoder, isDecoderRunning){
    app.get('/live', async (req, res) => {
        sendLiveResponse(res, decoder, await getLiveProbeState(decoder, isDecoderRunning))
    })
}

module.exports = { makeRpcBatchGuard, registerLiveRoute, noteProbeFailure, nodeReachabilityFields, resetProbeLogState, ageProbeLogState, PROBE_LOG_WINDOW_MS }
