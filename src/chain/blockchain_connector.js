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
const config = require('../config');
const {
    envInt,
    nodeReachabilityFrom,
    normalizeEndpoint,
} = require('./blockchain_connector/rpc_helpers.js')
const {
    encodeVarintHex,
    skipAuxPow,
    stripAuxPowFromBlockHex,
} = require('./blockchain_connector/auxpow_codec.js')
const rpcTransport = require('./blockchain_connector/rpc_transport.js')
const blockQueries = require('./blockchain_connector/block_queries.js')
const transactionQueries = require('./blockchain_connector/transaction_queries.js')

axios.defaults.timeout = envInt(config.NODE_RPC_TIMEOUT, 30000, 'NODE_RPC_TIMEOUT')

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.port = port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword
        this.rpcErrors = 0
        // Node reachability, recorded at the single POST choke point below so every
        // RPC path through this class feeds it. Reported, never gated on: the healthy
        // verdict deliberately ignores an upstream node outage (a restart cannot fix
        // one, and gating re-opens the autoheal restart flap), which is exactly why the
        // outage needs a surface of its own.
        this.startedAt = Date.now()
        this.lastNodeOkAt = 0
        this.lastNodeFailAt = 0
        // RPC endpoint failover rotates past an unreachable primary, because
        // the block loop retries RPC failures
        // indefinitely by design (skipping a block would corrupt the index).
        // The ordered endpoint list (primary + comma-separated
        // NODE_URL_FALLBACK entries) rotates to the next endpoint after
        // NODE_FAILOVER_THRESHOLD consecutive connection-level failures.
        // Rotation is round-robin, so a recovered primary is retried again if
        // the fallback also dies.
        this.endpoints = [normalizeEndpoint(url, port)]
        const fallbacks = config.NODE_URL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean)
        for (const fallback of fallbacks) this.endpoints.push(normalizeEndpoint(fallback, port))
        this.activeEndpointIndex = 0
        this.connectionFailures = 0
        // envInt, not parseInt: a unit-suffixed value ('5m') truncates to a wrong
        // magnitude and a bare `VAR=` line yields NaN, both silently. Every RPC knob in
        // this file validates and reports the same way.
        this.failoverThreshold = envInt(config.NODE_FAILOVER_THRESHOLD, 3, 'NODE_FAILOVER_THRESHOLD')
    }

    // Active RPC base URL. A getter (not a stored string) so every retry loop
    // in this class picks up an endpoint rotation on its next attempt.
    get url() {
        return this.endpoints[this.activeEndpointIndex]
    }
}

Object.assign(
    BlockchainConnector.prototype,
    rpcTransport,
    blockQueries,
    transactionQueries,
)

// The class IS the export and the helpers hang off it, attached in one place so
// the file has a single export shape. `module.exports` already IS the class
// here, so this is the same assignment the run of property lines made, and
// `require('./blockchain_connector').skipAuxPow` still reads the same property.
Object.assign(BlockchainConnector, {
    // Exported for the malformed-AuxPoW reassembly regression test.
    encodeVarintHex,
    // Exported for the cross-repo strip-parity test.
    stripAuxPowFromBlockHex,
    skipAuxPow,
    // Exported for the env-parsing regression test.
    envInt,
    // Exported so the reachability reducer can be tested without a connector or a node.
    nodeReachabilityFrom,
});

module.exports = BlockchainConnector
