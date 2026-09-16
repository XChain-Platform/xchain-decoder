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

const axios = require('axios');
const config = require('../../config');
const { format: formatLogLine } = require('node:util');
const { CONNECTION_ERROR_CODES, logger } = require('./constants.js')
const { envInt, nodeReachabilityFrom, rpcResult, sanitizeRpcError } = require('./rpc_helpers.js')

module.exports = {
    // Node reachability as the health surfaces publish it. Cheap and never throws,
    // so a probe can call it per request.
    nodeReachability(now = Date.now()) {
        return nodeReachabilityFrom(this.startedAt, this.lastNodeOkAt, this.lastNodeFailAt, now)
    },

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
            // The node answered. A JSON-RPC error carried in a 200 body (height out of
            // range, tx not found) still resolves here and still counts as reached:
            // this pair reports whether the node is ANSWERING, not whether the answer
            // was the one the caller wanted. rpcErrors already counts the latter.
            this.lastNodeOkAt = Date.now()
            return response
        } catch (error) {
            // Timeouts (ECONNABORTED), socket/DNS faults and RPC errors delivered as
            // HTTP 500 all land here, and all mean this attempt got no usable answer.
            this.lastNodeFailAt = Date.now()
            if (error && error.response) {
                // An HTTP-level error (auth, queue-full 500, etc.) still proves
                // the endpoint is reachable; only unreachability drives failover.
                this.connectionFailures = 0
            } else if (error && CONNECTION_ERROR_CODES.has(error.code)) {
                this.noteConnectionFailure(error.code)
            }
            throw error
        }
    },

    noteConnectionFailure(code) {
        if (this.endpoints.length < 2) return
        if (++this.connectionFailures >= this.failoverThreshold) {
            const failing = this.url
            this.activeEndpointIndex = (this.activeEndpointIndex + 1) % this.endpoints.length
            this.connectionFailures = 0
            logger.warn(`RPC endpoint ${failing} unreachable (${code} x${this.failoverThreshold}); failing over to ${this.url}`)
        }
    },

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Backoff between timeout (ECONNABORTED) retries in the block-path RPC
    // methods. Each attempt has already burned the full RPC timeout before
    // aborting, and an instant re-fire stacks retries onto a node that is
    // timing out precisely because it is overloaded. Matches getRawTransaction's
    // sleep-based backoff. Env-tunable so tests can set it to 0.
    async backoffOnTimeout() {
        // min 0, not 1: the comment above documents 0 as a supported test setting
        // (test/unit/setup.js relies on it), so it must survive the validation.
        const delay = envInt(config.RPC_TIMEOUT_RETRY_DELAY_MS, 500, 'RPC_TIMEOUT_RETRY_DELAY_MS', 0)
        if (delay > 0) await this.sleep(delay)
    },

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
    // Count exhaustion toward rpcErrors and carry the last sanitized cause, matching
    // getRawTransaction and keeping black-holed requests visible in rpc_errors_total.
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
                    logger.info(`Getting timeout trying to get ${label}, trying again...`)
                    lastErrorSummary = sanitizeRpcError(error)
                    await this.backoffOnTimeout()
                } else {
                    this.rpcErrors++
                    logger.error(formatLogLine(`Error getting ${label}:`, sanitizeRpcError(error)));
                    throw error;
                }
            }
        }

        this.rpcErrors++
        const message = exhausted || `There were problems getting ${label}.`
        throw new Error(lastErrorSummary ? `${message} ${lastErrorSummary}` : message)
    },
}
