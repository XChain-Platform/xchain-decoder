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
axios.defaults.timeout = parseInt(process.env.NODE_RPC_TIMEOUT ?? '30000', 10)

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        let protocol = (url.startsWith("https://") || url.startsWith("http://")) ? "" : "http://"
        this.url = protocol + url + ":" + port
        this.port = port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword
        this.rpcErrors = 0
        }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async getNetworkInfo(){
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getnetworkinfo',
                    id: 1
                }

                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting network info');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get network info, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting network info:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting network info.")
    }
    
    async getBlockchainInfo(){
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getblockchaininfo',
                    id: 1
                }

                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting blockchain info');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get blockchain info, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting blockchain info:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting blockchain info.")
    }

    async getBlockHash(blockindex) {
        let tries = 10

        // getblockhash takes an integer height; a BigInt (BIGINT UNSIGNED columns decode as
        // BigInt) is never a valid JSON-RPC param and makes axios' JSON.stringify throw
        // "Do not know how to serialize a BigInt". Coerce defensively at the RPC boundary.
        blockindex = Number(blockindex)

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getblockhash',
                    params: [blockindex],
                    id: 1,
                }

                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting block hash');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get block hash, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting block hash:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting block hash.")
    }

    async getBlockHeader(blockhash, hexFormat = true) {
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getblockheader',
                    params: [blockhash, !hexFormat],
                    id: 1,
                }

                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting block hex');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get block hex, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting block header:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting a block hex. ")
    }

    async getBlockWithoutAuxPow(blockhash) {
        try {
            let blockHeaderHex = await this.getBlockHeader(blockhash, true)
            let blockHex = await this.getBlock(blockhash, true)

		let dataToRemove = blockHeaderHex.length - 160 //80 bytes of bitcoin block header

            // Sanity guard: the block version is the first 4 bytes of blockHex
            // (little-endian). Dogecoin sets bit 8 (0x100) on merge-mined blocks.
            // If that bit is set but getblockheader returned exactly 160 hex chars
            // (80 bytes, no AuxPoW), the assumption that getblockheader includes
            // AuxPoW has been violated; parsing the unstripped block would corrupt
            // every txid in this block. Fail loud so the retry loop catches it
            // rather than silently passing a corrupt block into the indexer DB.
            if (dataToRemove === 0 && blockHex.length >= 8) {
                const versionLE = parseInt(blockHex.substring(0, 8), 16)
                const version = ((versionLE & 0xFF) << 24) | (((versionLE >> 8) & 0xFF) << 16) |
                                (((versionLE >> 16) & 0xFF) << 8) | ((versionLE >> 24) & 0xFF)
                if (version & 0x100) {
                    throw new Error(
                        'AuxPoW strip invariant violated for block ' + blockhash +
                        ': version 0x' + version.toString(16) + ' has AuxPoW bit set but ' +
                        'getblockheader returned only 160 hex chars (no AuxPoW bytes). ' +
                        'Re-verify the getblockheader serialization for this dogecoind version.'
                    )
                }
            }

            if (dataToRemove > 0) {
                blockHex = blockHex.substring(0,160)+blockHex.substring(160+dataToRemove)
            }

            return blockHex
        } catch (err) {
            throw new Error("There were problems getting a block hex without auxpow. ")
        }
    }
    
    async getRawMempool(){
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getrawmempool',
                    id: 1
                }

                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting raw mempool info');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get raw mempool, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting raw mempool:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting raw mempool.")
    }

    async getRawTransaction(txid){
        return new Promise(async (resolve, reject) => {
            let maxTries = 10
            let tries = 0
            while (tries < maxTries){
                tries++
                try {
                    const data = {
                        jsonrpc: '2.0',
                        method: 'getrawtransaction',
                        params: [txid],
                        id: 1
                    }

                    // Make the request to the node
                    const response = await axios.post(this.url, data, {
                        auth: {
                            username: this.rpcUser,
                            password: this.rpcPassword,
                        }
                    })

                    // Verify if there is a result and return it
                    if (response.data.result) {
                        resolve(response.data.result);
                        break
                    } else {
                        // Tx no longer retrievable (mined/evicted between getRawMempool and this
                        // call, or an empty RPC result): resolve null so a single missing tx does
                        // not fail the whole Promise.all batch. Callers filter nulls.
                        console.log(`getRawTransaction: no result for txid ${txid} (evicted/confirmed?)`)
                        resolve(null);
                        break
                    }
                } catch (error){
                    if (error.code === 'ECONNABORTED') {
                        console.log("Getting timeout trying to get raw transaction, trying again...")
                    }
                    // Work queue depth exceeded: back off longer before retrying.
                    // Bitcoin/Litecoin Core signal this with HTTP 500 + a JSON body
                    // carrying error.code === -429 (they never return HTTP 429).
                    // Dogecoin v1.14 instead drops the TCP connection outright when its
                    // RPC queue fills, surfacing as an ECONNRESET/ECONNREFUSED socket error
                    // with no HTTP response at all.
                    const isQueueFull = error.response?.data?.error?.code === -429
                        || error.code === 'ECONNRESET'
                        || error.code === 'ECONNREFUSED'
                    await this.sleep(isQueueFull ? 5000 : 500)
                }
            }

            if (tries >= maxTries){
                this.rpcErrors++
                reject(new Error(`getRawTransaction failed after ${maxTries} attempts for txid ${txid}`))
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
        const concurrency = Math.max(1, parseInt(process.env.DECODER_RPC_CONCURRENCY, 10) || 50)
        const results = []
        for (let i = 0; i < txIdArray.length; i += concurrency){
            const slice = txIdArray.slice(i, i + concurrency)
            results.push(...await Promise.all(slice.map((txid) => this.getRawTransaction(txid))))
        }
        return results
    }
    
    async getBlock(blockhash, hexFormat=true) {
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getblock',
                    params: [blockhash, !hexFormat],
                    id: 1,
                }

                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting block hex');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get block, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting block:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting block.")
    }
}

module.exports = BlockchainConnector