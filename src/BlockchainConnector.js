/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Decoder - Blockchain Connector Class
 * 
 * This file handles pulling blockchain data from a coin daemon
 * 
 ********************************************************************/

// Load required libraries
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

                // Make the request to the node
                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                // Verify if there is a result and return it
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
                    console.error('Error getting network info:', error.message);
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

                // Make the request to the node
                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                // Verify if there is a result and return it
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
                    console.error('Error getting blockchain info:', error.message);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting blockchain info.")
    }

    async getBlockHash(blockindex) {
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getblockhash',
                    params: [blockindex],
                    id: 1,
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
                    console.error('Error getting block hash:', error.message);
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

                // Make the request to the node
                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                // Verify if there is a result and return it
                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting block hex');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get block hex, trying again...")
                    //Do nothing, let the while to try again
                } else {
                    this.rpcErrors++
                    console.error('Error getting block header:', error.message);
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

                // Make the request to the node
                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                // Verify if there is a result and return it
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
                    console.error('Error getting raw mempool:', error.message);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting raw mempool.")
    }

    async getMempoolEntry(txid){
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getmempoolentry',
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
                    return response.data.result;
                } else {
                    throw new Error('Error getting mempool entry');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get mempool entry, trying again...")
                } else {
                    this.rpcErrors++
                    console.error('Error getting mempool entry:', error.message);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting mempool entry.")
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
                        // call, or an empty RPC result) — resolve null so a single missing tx does
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
    
    async getRawTransactions(txIdArray){
        let requests = []
    
        for (let nextTxIdIndex in txIdArray){
            let nextTxId = txIdArray[nextTxIdIndex]
            
            requests.push(this.getRawTransaction(nextTxId))
        }
        
        return Promise.all(requests)
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

                // Make the request to the node
                const response = await axios.post(this.url, data, {
                    auth: {
                        username: this.rpcUser,
                        password: this.rpcPassword,
                    }
                })

                // Verify if there is a result and return it
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
                    console.error('Error getting block:', error.message);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting block.")
    }
}

module.exports = BlockchainConnector