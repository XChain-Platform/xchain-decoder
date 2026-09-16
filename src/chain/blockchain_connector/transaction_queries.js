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

const config = require('../../config');
const { logger } = require('./constants.js')
const { envInt, sanitizeRpcError } = require('./rpc_helpers.js')

function rawTransactionResponse(response, txid) {
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
    if (response.data.result) return response.data.result

    // Tx no longer retrievable (mined/evicted between getRawMempool and this
    // call, or an empty RPC result): resolve null so a single missing tx does
    // not fail the whole Promise.all batch. Callers filter nulls. Surface the
    // node's own error object if it sent one rather than swallowing it.
    const rpcError = response.data?.error
    if (rpcError) {
        logger.error(`getRawTransaction: node error for txid ${txid}: code ${rpcError.code} ${rpcError.message}`)
    } else {
        logger.info(`getRawTransaction: no result for txid ${txid} (evicted/confirmed?)`)
    }
    return null
}

function rawTransactionFailureDetails(error) {
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
    const lastErrorSummary = sanitizeRpcError(error)
    return { httpStatus, rpcCode, isQueueFull, isTimeout, lastErrorSummary }
}

async function handleRawTransactionFailure(connector, error, txid, tries, maxTries) {
    // JSON-RPC error -5 ("No such mempool or blockchain transaction") is the
    // node's deterministic "tx not found" answer, delivered as HTTP 500 with a
    // JSON error body. The tx was mined/evicted between getRawMempool and this
    // call: resolve null immediately (the eviction path) instead of burning all
    // retries and rejecting the whole Promise.all batch. Read the code before any
    // sanitize call, since sanitizeRpcError scrubs error.response in place.
    if (error.response?.data?.error?.code === -5) {
        logger.info(`getRawTransaction: tx not found (RPC -5) for txid ${txid} (evicted/confirmed?)`)
        return { resolved: true, value: null }
    }
    if (error.code === 'ECONNABORTED') {
        logger.info("Getting timeout trying to get raw transaction, trying again...")
    }
    const details = rawTransactionFailureDetails(error)
    // Deterministic faults (auth 401, 404, DNS) are neither the
    // eviction (-5), timeout, nor queue-full cases: the sibling RPC
    // methods log+surface those immediately. Match that fail-loud
    // contract by logging the sanitized cause on each attempt instead
    // of silently burning all retries.
    if (!details.isTimeout && !details.isQueueFull) {
        logger.error(`getRawTransaction: attempt ${tries}/${maxTries} for txid ${txid} failed: HTTP ${details.httpStatus !== undefined ? details.httpStatus : 'n/a'} rpcCode ${details.rpcCode !== undefined ? details.rpcCode : 'n/a'}: ${details.lastErrorSummary}`)
    }
    await connector.sleep(details.isQueueFull ? 5000 : 500)
    return { resolved: false, lastErrorSummary: details.lastErrorSummary }
}

async function runRawTransactionRetries(connector, txid, resolve, reject) {
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

            const response = await connector.rpcPost(data)
            resolve(rawTransactionResponse(response, txid));
            return
        } catch (error){
            const outcome = await handleRawTransactionFailure(connector, error, txid, tries, maxTries)
            if (outcome.resolved) {
                resolve(outcome.value)
                return
            }
            lastErrorSummary = outcome.lastErrorSummary
        }
    }

    if (tries >= maxTries){
        connector.rpcErrors++
        reject(new Error(`getRawTransaction failed after ${maxTries} attempts for txid ${txid}${lastErrorSummary ? ': ' + lastErrorSummary : ''}`))
    }
}

module.exports = {
    async getRawTransaction(txid){
        return new Promise((resolve, reject) => runRawTransactionRetries(this, txid, resolve, reject))
    },

    // Fetch raw transactions for a list of txids with bounded concurrency.
    // updateMempool hands this method chunks of up to 1000 txids; firing them
    // all at once held up to 1000 simultaneous sockets against the operator's
    // own node: descriptor pressure plus RPC work-queue churn (-429 /
    // connection drops) on a large mempool, each retried up to 10x. Requests
    // run in order-preserving sub-batches; tune via DECODER_RPC_CONCURRENCY.
    async getRawTransactions(txIdArray){
        // envInt, not parseInt: 'DECODER_RPC_CONCURRENCY=100x' truncated to 100 sockets
        // against the operator's node with no log line, which is the fan-out this bound
        // exists to cap. Read per call, not cached, so a test (and an operator) can
        // retune it without rebuilding the connector.
        const concurrency = envInt(config.DECODER_RPC_CONCURRENCY, 50, 'DECODER_RPC_CONCURRENCY')
        const results = []
        for (let i = 0; i < txIdArray.length; i += concurrency){
            const slice = txIdArray.slice(i, i + concurrency)
            results.push(...await Promise.all(slice.map((txid) => this.getRawTransaction(txid))))
        }
        return results
    },

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
    },

    async getBlock(blockhash, hexFormat=true) {
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [blockhash, !hexFormat],
            id: 1,
        }, 'block', { resultLabel: 'Error getting block hex' })
    },
}
