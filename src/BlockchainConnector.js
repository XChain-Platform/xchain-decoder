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
 * XChain Decoder - Blockchain Connector Class
 * 
 * This file handles pulling blockchain data from a coin daemon
 * 
 ********************************************************************/

const axios = require('axios');

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
        if (raw !== undefined && raw !== null) console.warn(`[config] ${name} is set but empty; using ${fallback}`)
        return fallback
    }
    const n = /^-?\d+$/.test(s) ? Number(s) : NaN
    if (!Number.isInteger(n) || n < min) {
        console.warn(`[config] ${name}="${s}" is not an integer >= ${min}; using ${fallback}`)
        return fallback
    }
    return n
}

axios.defaults.timeout = envInt(process.env.NODE_RPC_TIMEOUT, 30000, 'NODE_RPC_TIMEOUT')

// Sanitize an axios error before it is logged or re-thrown. Every RPC call passes
// `auth: { username: rpcUser, password: rpcPassword }`, and axios attaches the request
// config to the thrown error, so `console.error(msg, error)` serializes NODE_USER /
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

// Decode a Bitcoin-style varint from `buf` at `offset`.
// Returns { value, bytes } where `bytes` is the number of bytes consumed.
// Keep in sync with xchain-utxo-tracker/src/BlockchainConnector.js readVarint.
function readVarint(buf, offset) {
    const first = buf[offset]
    if (first < 0xFD) return { value: first, bytes: 1 }
    if (first === 0xFD) return { value: buf.readUInt16LE(offset + 1), bytes: 3 }
    if (first === 0xFE) return { value: buf.readUInt32LE(offset + 1), bytes: 5 }
    // 0xFF: 8-byte varint; safe for our sizes (branch counts are small)
    const lo = buf.readUInt32LE(offset + 1)
    const hi = buf.readUInt32LE(offset + 5)
    return { value: hi * 0x100000000 + lo, bytes: 9 }
}

// Encode a Bitcoin-style varint as lowercase hex (inverse of readVarint).
// Keep in sync with xchain-utxo-tracker/src/BlockchainConnector.js encodeVarintHex.
function encodeVarintHex(value) {
    if (value < 0xFD) {
        return value.toString(16).padStart(2, '0')
    }
    if (value <= 0xFFFF) {
        const buf = Buffer.alloc(3)
        buf[0] = 0xFD
        buf.writeUInt16LE(value, 1)
        return buf.toString('hex')
    }
    if (value <= 0xFFFFFFFF) {
        const buf = Buffer.alloc(5)
        buf[0] = 0xFE
        buf.writeUInt32LE(value, 1)
        return buf.toString('hex')
    }
    // A block can never hold 2^32 txs; refuse rather than emit a wrong varint.
    throw new Error('encodeVarintHex: value out of supported range: ' + value)
}

// Parse the AuxPoW section from a raw block Buffer starting at byte offset `start`
// (immediately after the 80-byte standard header). Returns the byte offset of the
// first byte after the AuxPoW section (i.e. where the tx-count varint begins).
// AuxPoW layout: coinbase tx | parent block hash (32 B) |
//                coinbase merkle branch (varint count + count*32 B + 4 B index) |
//                chain merge-mining branch (same layout) |
//                parent block header (80 B)
// Throws if the buffer is too short or structurally invalid.
// Keep in sync with xchain-utxo-tracker/src/BlockchainConnector.js skipAuxPow.
function skipAuxPow(buf, start) {
    let offset = start

    // Skip the coinbase transaction (a full serialized Bitcoin tx).
    // version (4) | [segwit marker+flag (2, optional)] | inputs | outputs | [witness] | locktime (4)
    if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase version')
    offset += 4  // version

    // Detect SegWit marker (0x00 flag byte means segwit)
    const hasSegwit = (buf[offset] === 0x00)
    if (hasSegwit) offset += 2  // skip marker + flag

    // Inputs
    const insVI = readVarint(buf, offset)
    offset += insVI.bytes
    const nIns = insVI.value
    for (let i = 0; i < nIns; i++) {
        if (offset + 36 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase input prevout')
        offset += 36  // prev hash (32) + prev index (4)
        const scriptVI = readVarint(buf, offset)
        offset += scriptVI.bytes + scriptVI.value  // script length + script bytes
        if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase input sequence')
        offset += 4  // sequence
    }

    // Outputs
    const outsVI = readVarint(buf, offset)
    offset += outsVI.bytes
    const nOuts = outsVI.value
    for (let i = 0; i < nOuts; i++) {
        if (offset + 8 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase output value')
        offset += 8  // value (8 bytes)
        const scriptVI = readVarint(buf, offset)
        offset += scriptVI.bytes + scriptVI.value
    }

    // Witness data (only if segwit coinbase)
    if (hasSegwit) {
        for (let i = 0; i < nIns; i++) {
            const stackVI = readVarint(buf, offset)
            offset += stackVI.bytes
            const stackItems = stackVI.value
            for (let j = 0; j < stackItems; j++) {
                const itemVI = readVarint(buf, offset)
                offset += itemVI.bytes + itemVI.value
            }
        }
    }

    if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase locktime')
    offset += 4  // locktime

    // Parent block hash (32 bytes)
    if (offset + 32 > buf.length) throw new Error('AuxPoW parse: buffer too short for parent block hash')
    offset += 32

    // Coinbase merkle branch: varint count, count*32 B hashes, 4 B index
    const cbVI = readVarint(buf, offset)
    offset += cbVI.bytes
    if (offset + cbVI.value * 32 + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase branch')
    offset += cbVI.value * 32 + 4

    // Chain merge-mining branch: same layout
    const chainVI = readVarint(buf, offset)
    offset += chainVI.bytes
    if (offset + chainVI.value * 32 + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for chain branch')
    offset += chainVI.value * 32 + 4

    // Parent block header (80 bytes)
    if (offset + 80 > buf.length) throw new Error('AuxPoW parse: buffer too short for parent block header')
    offset += 80

    return offset
}

// Strip the AuxPoW section from a merge-mined block's hex, preserving the 80-byte
// (160 hex char) standard header. Two daemon behaviors are handled: an older daemon
// whose getblockheader already includes the AuxPoW bytes (length-based strip via the
// header/block length delta), and Dogecoin Core 1.14 whose getblockheader always
// returns exactly 160 chars, requiring the AuxPoW size to be parsed structurally from
// the block hex (skipAuxPow). Non-AuxPoW blocks pass through unchanged.
// Keep in sync with xchain-utxo-tracker/src/BlockchainConnector.js stripAuxPowFromBlockHex.
// test/unit/auxpowStripParity.test.js asserts byte identity of the two function bodies,
// so a strip correction cannot land in one repo alone.
function stripAuxPowFromBlockHex(headerHex, blockHex) {
    const dataToRemove = headerHex.length - 160  // 160 hex chars = 80-byte standard header
    if (dataToRemove > 0) {
        // Legacy path: getblockheader included AuxPoW bytes (older daemon).
        return blockHex.substring(0, 160) + blockHex.substring(160 + dataToRemove)
    }
    if (blockHex.length >= 8) {
        const versionLE = parseInt(blockHex.substring(0, 8), 16)
        const version = ((versionLE & 0xFF) << 24) | (((versionLE >> 8) & 0xFF) << 16) |
                        (((versionLE >> 16) & 0xFF) << 8) | ((versionLE >> 24) & 0xFF)
        if (version & 0x100) {
            // AuxPoW version bit set but getblockheader returned no extra bytes
            // (Dogecoin Core 1.14). Parse the AuxPoW size from the block hex directly.
            const blockBuf = Buffer.from(blockHex, 'hex')
            const afterAuxPow = skipAuxPow(blockBuf, 80)
            return blockHex.substring(0, 160) + blockHex.substring(afterAuxPow * 2)
        }
    }
    return blockHex
}

// Error codes that mean "could not reach the node at all" (socket / DNS /
// timeout level), as opposed to an HTTP or JSON-RPC level error from a node
// that is alive. Only these count toward endpoint failover.
const CONNECTION_ERROR_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'
])

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

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.port = port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword
        this.rpcErrors = 0
        // RPC endpoint failover. A dead primary endpoint used to stall the
        // decoder forever, because the block loop retries RPC failures
        // indefinitely by design (skipping a block would corrupt the index).
        // The ordered endpoint list (primary + comma-separated
        // NODE_URL_FALLBACK entries) rotates to the next endpoint after
        // NODE_FAILOVER_THRESHOLD consecutive connection-level failures.
        // Rotation is round-robin, so a recovered primary is retried again if
        // the fallback also dies.
        this.endpoints = [normalizeEndpoint(url, port)]
        const fallbacks = (process.env.NODE_URL_FALLBACK ?? '').split(',').map(s => s.trim()).filter(Boolean)
        for (const fallback of fallbacks) this.endpoints.push(normalizeEndpoint(fallback, port))
        this.activeEndpointIndex = 0
        this.connectionFailures = 0
        // envInt, not parseInt: a unit-suffixed value ('5m') truncates to a wrong
        // magnitude and a bare `VAR=` line yields NaN, both silently. Every RPC knob in
        // this file validates and reports the same way.
        this.failoverThreshold = envInt(process.env.NODE_FAILOVER_THRESHOLD, 3, 'NODE_FAILOVER_THRESHOLD')
    }

    // Active RPC base URL. A getter (not a stored string) so every retry loop
    // in this class picks up an endpoint rotation on its next attempt.
    get url() {
        return this.endpoints[this.activeEndpointIndex]
    }

    // Single POST path for every RPC method: resets the consecutive-failure
    // counter on any answer from the node, and counts connection-level errors
    // toward failover before re-throwing for the caller's own retry handling.
    async rpcPost(data) {
        try {
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                }
            })
            this.connectionFailures = 0
            return response
        } catch (error) {
            if (error && error.response) {
                // An HTTP-level error (auth, queue-full 500, etc.) still proves
                // the endpoint is reachable; only unreachability drives failover.
                this.connectionFailures = 0
            } else if (error && CONNECTION_ERROR_CODES.has(error.code)) {
                this.noteConnectionFailure(error.code)
            }
            throw error
        }
    }

    noteConnectionFailure(code) {
        if (this.endpoints.length < 2) return
        if (++this.connectionFailures >= this.failoverThreshold) {
            const failing = this.url
            this.activeEndpointIndex = (this.activeEndpointIndex + 1) % this.endpoints.length
            this.connectionFailures = 0
            console.warn(`RPC endpoint ${failing} unreachable (${code} x${this.failoverThreshold}); failing over to ${this.url}`)
        }
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Backoff between timeout (ECONNABORTED) retries in the block-path RPC
    // methods. Each attempt has already burned the full RPC timeout before
    // aborting, and an instant re-fire stacks retries onto a node that is
    // timing out precisely because it is overloaded. Matches getRawTransaction's
    // sleep-based backoff. Env-tunable so tests can set it to 0.
    async backoffOnTimeout() {
        // min 0, not 1: the comment above documents 0 as a supported test setting
        // (test/unit/setup.js relies on it), so it must survive the validation.
        const delay = envInt(process.env.RPC_TIMEOUT_RETRY_DELAY_MS, 500, 'RPC_TIMEOUT_RETRY_DELAY_MS', 0)
        if (delay > 0) await this.sleep(delay)
    }

    // The single retry-and-classify ladder for the block-path RPC methods. Seven of
    // them carried a byte-identical copy of it, differing only in the payload and two
    // log strings, while the eighth (getRawTransaction, which owns its own ladder for
    // the -5 eviction and -429 queue-full cases) drifted away from them: a correction
    // to what the node's failure modes ARE could land in one place and miss the rest.
    //
    // The retry semantics here are the seven copies' own, deliberately unchanged. Only
    // ECONNABORTED retries; every other error is logged and rethrown at once with
    // error.code, error.rpcCode and error.rpcMessage intact. Adding getRawTransaction's
    // 5s-x10 queue-full ladder here would be a behaviour change, not a de-duplication:
    // the decoder's wedge signal counts CONSECUTIVE fetch failures at one height
    // (XChainDecoder._fetchErrorCount, STALL_FETCH_ATTEMPTS) and reaches its verdict in
    // about a minute at the block loop's 3s sleep. At ~50s per in-call ladder the same
    // twenty attempts take a quarter of an hour, so isStalled() and the container
    // healthcheck would go blind for exactly the outage they exist to report.
    //
    // Exhaustion is the one behaviour correction: it now counts toward rpcErrors and
    // carries the last sanitized cause, matching getRawTransaction. A node that
    // black-holed every request timed out ten times and threw a bare sentence, leaving
    // rpc_errors_total ("Node RPC errors seen since process start") flat throughout.
    //
    // `label` names the subject in the timeout and error logs; `resultLabel` and
    // `exhausted` override the two messages whose wording differs per method.
    async rpcCallWithTimeoutRetry(data, label, { resultLabel, exhausted } = {}){
        let tries = 10
        let lastErrorSummary = null

        while (tries > 0) {
            try {
                const response = await this.rpcPost(data)

                return rpcResult(response, resultLabel || `Error getting ${label}`);
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log(`Getting timeout trying to get ${label}, trying again...`)
                    lastErrorSummary = sanitizeRpcError(error)
                    await this.backoffOnTimeout()
                } else {
                    this.rpcErrors++
                    console.error(`Error getting ${label}:`, sanitizeRpcError(error));
                    throw error;
                }
            }
        }

        this.rpcErrors++
        const message = exhausted || `There were problems getting ${label}.`
        throw new Error(lastErrorSummary ? `${message} ${lastErrorSummary}` : message)
    }

    async getNetworkInfo(){
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getnetworkinfo',
            id: 1
        }, 'network info')
    }

    async getBlockchainInfo(){
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblockchaininfo',
            id: 1
        }, 'blockchain info')
    }

    async getBlockHash(blockindex) {
        // getblockhash takes an integer height; a BigInt (BIGINT UNSIGNED columns decode as
        // BigInt) is never a valid JSON-RPC param and makes axios' JSON.stringify throw
        // "Do not know how to serialize a BigInt". Coerce defensively at the RPC boundary.
        blockindex = Number(blockindex)

        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblockhash',
            params: [blockindex],
            id: 1,
        }, 'block hash')
    }

    async getBlockHeader(blockhash, hexFormat = true) {
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblockheader',
            params: [blockhash, !hexFormat],
            id: 1,
        }, 'block header', { exhausted: 'There were problems getting a block header. ' })
    }

    // The RPC fetches below are deliberately OUTSIDE the try. A transport fault (a
    // Dogecoin 1.14 node dropping the TCP connection when its RPC queue fills, a node
    // restart, a network blip) must propagate unwrapped, with error.code intact, so
    // callers can tell it apart from a block whose AuxPoW section cannot be traversed.
    // A catch-all here once wrapped every throw in a bare Error, discarding error.code,
    // and the decoder counted the result toward the malformed-AuxPoW escalation: ~15s
    // of node unavailability flipped it into per-tx block reassembly aimed at the node
    // that was already saturated. Only the header-strip/parse block is wrapped, and its
    // errors carry auxPowParseFailure = true, the signal escalation actually wants.
    async getBlockWithoutAuxPow(blockhash) {
        let blockHeaderHex = await this.getBlockHeader(blockhash, true)
        let blockHex = await this.getBlock(blockhash, true)

        try {
            // Strip logic lives in stripAuxPowFromBlockHex, which is byte-identical to
            // the xchain-utxo-tracker twin. Only the framing differs between the repos
            // and that difference is deliberate: the decoder fetches the header and
            // block OUTSIDE this try so an RPC fault is not mislabeled a content
            // fault, and tags a traversal failure with auxPowParseFailure so
            // fetchBlockHex can escalate to getBlockReassembled.
            blockHex = stripAuxPowFromBlockHex(blockHeaderHex, blockHex)

            return blockHex
        } catch (err) {
            // Content fault: the bytes this node served cannot be traversed. Tag it so
            // fetchBlockHex escalates to getBlockReassembled on THIS signal only.
            const parseErr = new Error("There were problems getting a block hex without auxpow. " + err.message)
            parseErr.auxPowParseFailure = true
            parseErr.cause = err
            throw parseErr
        }
    }

    // Recovery path for a block whose AuxPoW section skipAuxPow cannot traverse:
    // rebuild the pure (AuxPoW-free) block from RPC parts instead of
    // stripping the raw block hex. getblockheader gives the 80-byte header,
    // verbose getblock gives the in-block txid order, and getrawtransaction
    // gives each tx's canonical serialization, so the result is byte-identical
    // to what getBlockWithoutAuxPow would have produced. Every RPC here is one
    // the decoder already depends on (Dogecoin 1.14 has no verbosity-2
    // getblock, so per-txid fetches are the portable route). Deterministic
    // across instances: the output depends only on chain content.
    async getBlockReassembled(blockhash) {
        try {
            // Older daemons append the AuxPoW bytes to getblockheader; the pure
            // header is always the first 80 bytes either way.
            const headerHex = (await this.getBlockHeader(blockhash, true)).substring(0, 160)
            const verboseBlock = await this.getBlockVerbose(blockhash)
            if (!verboseBlock || !Array.isArray(verboseBlock.tx)) {
                throw new Error('verbose getblock returned no tx array')
            }
            // Fetch via the bounded-concurrency batch helper: serial per-tx
            // fetches with per-tx retry backoff made a large DOGE block take
            // minutes to reassemble, wedging the decoder at this height.
            const txHexes = await this.getRawTransactions(verboseBlock.tx)
            for (let i = 0; i < txHexes.length; i++) {
                // getRawTransaction resolves null for a missing tx (mempool-eviction
                // tolerance); for a confirmed in-block tx that is an RPC fault, and
                // assembling without it would emit a corrupt block. Fail instead.
                if (!txHexes[i]) throw new Error('no raw tx for in-block txid ' + verboseBlock.tx[i])
            }
            return headerHex + encodeVarintHex(txHexes.length) + txHexes.join('')
        } catch (err) {
            // Carry the fault's identity out with the message. The three RPC fetches above
            // sit INSIDE this try, so a transport fault (an ECONNRESET from a saturated
            // Dogecoin 1.14 RPC queue, an ECONNABORTED timeout, a node restart) lands here
            // beside a genuine content fault, and only error.code and the rpcCode/rpcMessage
            // sanitizeRpcError attaches separate the two. _auxPowParseErrorCount never
            // decays, so once a height has escalated to this path every later failure at
            // that height arrives through this catch, which is precisely where an operator
            // has to tell an unreachable node from a block whose bytes are unusable.
            // Mirrors the cause attachment getBlockWithoutAuxPow makes above.
            //
            // Deliberately NOT tagged auxPowParseFailure: that flag is the only signal
            // fetchBlockHex escalates on, and aiming a per-tx fan-out at a node that is
            // merely unreachable is the failure the comment above getBlockWithoutAuxPow
            // describes. Errors leaving these RPC helpers have already passed through
            // sanitizeRpcError, which scrubs config.auth, the Authorization header and
            // error.request in place, so attaching one as cause carries no credential.
            const reassembleErr = new Error("There were problems reassembling a block without auxpow. " + err.message)
            reassembleErr.cause = err
            if (err && err.code !== undefined) reassembleErr.code = err.code
            throw reassembleErr
        }
    }

    async getBlockVerbose(blockhash) {
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [blockhash, true],
            id: 1,
        }, 'verbose block')
    }

    async getRawMempool(){
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getrawmempool',
            id: 1
        }, 'raw mempool', { resultLabel: 'Error getting raw mempool info' })
    }

    async getRawTransaction(txid){
        return new Promise(async (resolve, reject) => {
            let maxTries = 10
            let tries = 0
            // Carries the last error's sanitized cause into the final rejection so a
            // deterministic misconfiguration (401/404/DNS) is diagnosable instead of
            // surfacing as a bare "failed after 10 attempts" line.
            let lastErrorSummary = null
            while (tries < maxTries){
                tries++
                try {
                    const data = {
                        jsonrpc: '2.0',
                        method: 'getrawtransaction',
                        params: [txid],
                        id: 1
                    }

                    const response = await this.rpcPost(data)

                    // A JSON-RPC 2.0 node (Bitcoin Core >= v28) answers an RPC error with
                    // HTTP 200 and a body error object, so axios never throws and the
                    // classifier below is never reached. Re-shape a coded error into the
                    // same error the HTTP-500 transport produces so both transports are
                    // classified at one point: -429 keeps its 5s backoff, -28 and auth
                    // faults keep their retries, and rpcErrors still counts them.
                    // -5 is the node's "tx absent" answer and stays the tolerant path
                    // below; an error object with no numeric code is not classifiable, so
                    // it keeps the pre-existing tolerant behaviour rather than gaining a
                    // new failure mode here.
                    const httpRpcError = response.data?.error
                    if (httpRpcError && typeof httpRpcError.code === 'number' && httpRpcError.code !== -5) {
                        // Build a fresh error each attempt and copy (never alias) the axios
                        // response: sanitizeRpcError scrubs error.response in place, so a
                        // shared object would carry the JSON body only on the first read.
                        const err = new Error(`getRawTransaction: RPC error ${httpRpcError.code}: ${httpRpcError.message}`)
                        err.response = { status: response.status, data: { error: { code: httpRpcError.code, message: httpRpcError.message } } }
                        throw err
                    }

                    // Return (not break) so
                    // a success on the final attempt cannot fall through to the failure
                    // guard below and inflate rpcErrors on a recovered fetch.
                    if (response.data.result) {
                        resolve(response.data.result);
                        return
                    } else {
                        // Tx no longer retrievable (mined/evicted between getRawMempool and this
                        // call, or an empty RPC result): resolve null so a single missing tx does
                        // not fail the whole Promise.all batch. Callers filter nulls. Surface the
                        // node's own error object if it sent one rather than swallowing it.
                        const rpcError = response.data?.error
                        if (rpcError) {
                            console.error(`getRawTransaction: node error for txid ${txid}: code ${rpcError.code} ${rpcError.message}`)
                        } else {
                            console.log(`getRawTransaction: no result for txid ${txid} (evicted/confirmed?)`)
                        }
                        resolve(null);
                        return
                    }
                } catch (error){
                    // JSON-RPC error -5 ("No such mempool or blockchain transaction") is the
                    // node's deterministic "tx not found" answer, delivered as HTTP 500 with a
                    // JSON error body. The tx was mined/evicted between getRawMempool and this
                    // call: resolve null immediately (the eviction path) instead of burning all
                    // retries and rejecting the whole Promise.all batch. Read the code before any
                    // sanitize call, since sanitizeRpcError scrubs error.response in place.
                    if (error.response?.data?.error?.code === -5) {
                        console.log(`getRawTransaction: tx not found (RPC -5) for txid ${txid} (evicted/confirmed?)`)
                        resolve(null)
                        return
                    }
                    if (error.code === 'ECONNABORTED') {
                        console.log("Getting timeout trying to get raw transaction, trying again...")
                    }
                    // Work queue depth exceeded: back off longer before retrying.
                    // Bitcoin/Litecoin Core signal this with HTTP 500 + a JSON body
                    // carrying error.code === -429 (they never return HTTP 429).
                    // Dogecoin v1.14 instead drops the TCP connection outright when its
                    // RPC queue fills, surfacing as an ECONNRESET/ECONNREFUSED socket error
                    // with no HTTP response at all.
                    const httpStatus = error.response?.status
                    const rpcCode = error.response?.data?.error?.code
                    const isQueueFull = rpcCode === -429
                        || error.code === 'ECONNRESET'
                        || error.code === 'ECONNREFUSED'
                    const isTimeout = error.code === 'ECONNABORTED'
                    // sanitizeRpcError scrubs error.response in place; the code/status
                    // above were read first. Keep the sanitized cause for the final
                    // rejection message regardless of error class.
                    lastErrorSummary = sanitizeRpcError(error)
                    // Deterministic faults (auth 401, 404, DNS) are neither the
                    // eviction (-5), timeout, nor queue-full cases: the sibling RPC
                    // methods log+surface those immediately. Match that fail-loud
                    // contract by logging the sanitized cause on each attempt instead
                    // of silently burning all retries.
                    if (!isTimeout && !isQueueFull) {
                        console.error(`getRawTransaction: attempt ${tries}/${maxTries} for txid ${txid} failed: HTTP ${httpStatus !== undefined ? httpStatus : 'n/a'} rpcCode ${rpcCode !== undefined ? rpcCode : 'n/a'}: ${lastErrorSummary}`)
                    }
                    await this.sleep(isQueueFull ? 5000 : 500)
                }
            }

            if (tries >= maxTries){
                this.rpcErrors++
                reject(new Error(`getRawTransaction failed after ${maxTries} attempts for txid ${txid}${lastErrorSummary ? ': ' + lastErrorSummary : ''}`))
            }
        })
    }
    
    // Fetch raw transactions for a list of txids with bounded concurrency.
    // updateMempool hands this method chunks of up to 1000 txids; firing them
    // all at once held up to 1000 simultaneous sockets against the operator's
    // own node: descriptor pressure plus RPC work-queue churn (-429 /
    // connection drops) on a large mempool, each retried up to 10x. Requests
    // now run in order-preserving sub-batches; tune via DECODER_RPC_CONCURRENCY.
    async getRawTransactions(txIdArray){
        // envInt, not parseInt: 'DECODER_RPC_CONCURRENCY=100x' truncated to 100 sockets
        // against the operator's node with no log line, which is the fan-out this bound
        // exists to cap. Read per call, not cached, so a test (and an operator) can
        // retune it without rebuilding the connector.
        const concurrency = envInt(process.env.DECODER_RPC_CONCURRENCY, 50, 'DECODER_RPC_CONCURRENCY')
        const results = []
        for (let i = 0; i < txIdArray.length; i += concurrency){
            const slice = txIdArray.slice(i, i + concurrency)
            results.push(...await Promise.all(slice.map((txid) => this.getRawTransaction(txid))))
        }
        return results
    }
    
    // Startup probe for txindex availability. getBlockReassembled (the
    // malformed-AuxPoW recovery path above) calls getrawtransaction WITHOUT a
    // blockhash param, which requires the node to run with txindex=1. On a node
    // without it, recovery fails deterministically forever, turning a one-block
    // recovery into a permanent quarantine loop with no hint why. Probe once at
    // boot: fetch the tip's coinbase txid via verbose getblock, then try
    // getrawtransaction on it. Returns true (txindex works), false (missing),
    // or null (inconclusive: tip is genesis, whose coinbase is unretrievable by
    // design, or the probe RPCs themselves failed). Never throws.
    async probeTxIndex() {
        try {
            const info = await this.getBlockchainInfo()
            if (!info || !info.bestblockhash) return null
            if (info.blocks === 0) return null  // genesis coinbase is never indexed
            const block = await this.getBlockVerbose(info.bestblockhash)
            if (!block || !Array.isArray(block.tx) || block.tx.length === 0) return null
            const txHex = await this.getRawTransaction(block.tx[0])
            return txHex ? true : false
        } catch (_) {
            return null
        }
    }

    async getBlock(blockhash, hexFormat=true) {
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [blockhash, !hexFormat],
            id: 1,
        }, 'block', { resultLabel: 'Error getting block hex' })
    }
}

module.exports = BlockchainConnector
// Exported for the malformed-AuxPoW reassembly regression test.
module.exports.encodeVarintHex = encodeVarintHex
// Exported for the cross-repo strip-parity test.
module.exports.stripAuxPowFromBlockHex = stripAuxPowFromBlockHex
module.exports.skipAuxPow = skipAuxPow
// Exported for the env-parsing regression test.
module.exports.envInt = envInt