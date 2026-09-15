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

const { logger } = require('./constants.js')

// Read an integer env var, falling back on anything that is not a clean integer.
// `??` only substitutes for null/undefined, so a present-but-empty value (a bare
// `VAR=` line in a .env or compose file) reaches parseInt('') and yields NaN, and
// a unit-suffixed one ('30s') truncates to a wrong magnitude. Both matter for the
// RPC timeout below, which axios gates on `if (config.timeout)`: NaN is falsy, so
// no timeout is installed at all and a black-holed node hangs forever instead of
// raising ECONNABORTED, taking the whole timeout-retry and endpoint-failover
// ladder with it. Warn on a discarded value so a mis-set env is visible in logs.
function envInt(raw, fallback, name, min = 1) {
    const s = (raw === undefined || raw === null) ? '' : String(raw).trim()
    if (s === '') {
        if (raw !== undefined && raw !== null) logger.warn(`[config] ${name} is set but empty; using ${fallback}`)
        return fallback
    }
    const n = /^-?\d+$/.test(s) ? Number(s) : NaN
    if (!Number.isInteger(n) || n < min) {
        logger.warn(`[config] ${name}="${s}" is not an integer >= ${min}; using ${fallback}`)
        return fallback
    }
    return n
}

// Sanitize an axios error before it is logged or re-thrown. Every RPC call passes
// `auth: { username: rpcUser, password: rpcPassword }`, and axios attaches the request
// config to the thrown error, so `logger.error(formatLogLine(msg, error))` serializes NODE_USER /
// NODE_PASSWORD into the decoder logs (util.inspect walks error.config.auth). Scrub the
// credential-bearing fields IN PLACE so neither this logger nor any upstream handler that
// re-logs the re-thrown error can leak them, and return a compact, credential-free string
// (error.message never carries the auth block) for logging. Never let scrubbing throw.
function sanitizeRpcError(error){
    let rpcCode
    let rpcMessage
    try {
        if (error && error.config) {
            error.config.auth = undefined
            if (error.config.headers) delete error.config.headers.Authorization
        }
        // axios stores the raw request/response, which echo the request config (and its
        // Authorization/auth) back. Drop the request; keep only a response status.
        if (error && error.request) error.request = undefined
        if (error && error.response) {
            const status = error.response.status
            // Bitcoin/Litecoin Core deliver most RPC errors as HTTP 500 with the
            // JSON-RPC error body (response.data.error = {code, message}), which makes
            // axios throw before rpcResult() ever runs. Capture the node's own code and
            // message here, before the scrub replaces error.response with just its
            // status, so callers and logs keep the real cause (-8 out of range, -28
            // loading block index, -429 queue full) instead of a bare status line.
            const rpcErr = error.response.data && error.response.data.error
            if (rpcErr && typeof rpcErr === 'object') {
                rpcCode = rpcErr.code
                rpcMessage = (typeof rpcErr.message === 'string') ? rpcErr.message : undefined
            }
            error.response = (status !== undefined) ? { status: status } : undefined
        }
        if (error && (rpcCode !== undefined || rpcMessage !== undefined)) {
            // Non-enumerable so this does not alter JSON serialization of the error.
            Object.defineProperty(error, 'rpcCode', { value: rpcCode, enumerable: false, configurable: true })
            Object.defineProperty(error, 'rpcMessage', { value: rpcMessage, enumerable: false, configurable: true })
        }
    } catch (_) { /* sanitization must never mask the original failure */ }
    const base = (error && error.message) ? error.message : String(error)
    if (rpcCode !== undefined || rpcMessage !== undefined) {
        return `${base} (RPC error ${rpcCode !== undefined ? rpcCode : 'unknown'}: ${rpcMessage !== undefined ? rpcMessage : ''})`
    }
    return base
}

// Extract the JSON-RPC result from an axios response, surfacing the node's own
// error object when present. The JSON-RPC contract for failures is
// response.data.error = {code, message}; nodes and RPC proxies can return it
// with HTTP 200 and result: null, in which case the real cause (Block height
// out of range, Loading block index..., auth/queue errors) must not be masked
// by a hand-written placeholder. `label` is the existing per-method message.
//
// "Missing" is PRESENCE, not truthiness: a JSON-RPC success carries a `result`
// member that may legitimately be 0, false or "", and only undefined/null mean
// the node sent no result. Every method funnelled through here today answers
// with an object, an array or a non-empty hex string, so this changes nothing
// for them; it is the guard the first falsy-answering method (a count at
// genesis, a boolean) would otherwise be misread by and burned through the
// caller's retry loop as a hard RPC failure.
function rpcResult(response, label) {
    const rpcError = response && response.data && response.data.error
    if (rpcError) {
        const code = (rpcError.code !== undefined) ? rpcError.code : 'unknown'
        const message = (typeof rpcError.message === 'string') ? rpcError.message : JSON.stringify(rpcError)
        throw new Error(`${label}: RPC error ${code}: ${message}`)
    }
    if (!response || !response.data) throw new Error(label)
    const result = response.data.result
    if (result === undefined || result === null) throw new Error(label)
    return result
}

// Turn a host entry into a full RPC base URL. `entry` may carry its own
// protocol (http/https) and/or port; anything missing falls back to http and
// `defaultPort` (the primary NODE_PORT).
function normalizeEndpoint(entry, defaultPort) {
    const match = String(entry).trim().match(/^(https?:\/\/)?([^:/]+)(?::(\d+))?$/)
    if (!match) throw new Error('BlockchainConnector: invalid RPC endpoint: ' + entry)
    const protocol = match[1] || 'http://'
    const port = match[3] || defaultPort
    return protocol + match[2] + ':' + port
}

// Reduce the three timestamps the connector records into the two fields every health
// surface publishes. Pure and exported so the rule lives in one place: a surface that
// re-derived "is the node reachable" from a counter would disagree with this one.
//
// Unreachable means the LATEST attempt failed: either nothing has ever succeeded, or
// the last failure is newer than the last success. `since` dates the outage from the
// last success when there was one, and from connector construction when there was
// never one, which is the case the defect report describes: a decoder whose node
// answered nothing in five and a half days while every surface read green.
//
// All three inputs are ms epoch, 0 meaning "never".
function nodeReachabilityFrom(startedAt, lastNodeOkAt, lastNodeFailAt, now = Date.now()) {
    const lastOkIso = lastNodeOkAt > 0 ? new Date(lastNodeOkAt).toISOString() : null
    const failing = lastNodeFailAt > 0 && (lastNodeOkAt === 0 || lastNodeFailAt > lastNodeOkAt)
    if (!failing) return { node_last_ok_at: lastOkIso, node_unreachable: null }
    const sinceMs = lastNodeOkAt > 0 ? lastNodeOkAt : startedAt
    return {
        node_last_ok_at: lastOkIso,
        node_unreachable: {
            since: new Date(sinceMs).toISOString(),
            last_ok_at: lastOkIso,
            // Floor, and clamped at 0: a health probe racing the recorded instant
            // must never publish a negative age.
            seconds: Math.max(0, Math.floor((now - sinceMs) / 1000))
        }
    }
}

module.exports = {
    envInt,
    sanitizeRpcError,
    rpcResult,
    normalizeEndpoint,
    nodeReachabilityFrom,
}
