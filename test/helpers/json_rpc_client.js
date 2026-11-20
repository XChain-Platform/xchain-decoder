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

const axios = require('axios')

function walletUrl(baseUrl, wallet){
    if (!wallet) return baseUrl
    return baseUrl.replace(/\/$/, '') + '/wallet/' + encodeURIComponent(wallet)
}

class JsonRpcClient {
    constructor({ host, username, password, wallet }){
        this.url = walletUrl(host, wallet)
        this.auth = { username, password }
        this.nextId = 1
    }

    async command(method, ...params){
        const response = await axios.post(this.url, {
            jsonrpc: '2.0', method, params, id: this.nextId++
        }, { auth: this.auth })
        if (response.data && response.data.error){
            const error = new Error(response.data.error.message || 'JSON-RPC request failed')
            error.code = response.data.error.code
            throw error
        }
        return response.data ? response.data.result : undefined
    }

    getBlockchainInfo(){ return this.command('getblockchaininfo') }
    listWallets(){ return this.command('listwallets') }
    createWallet(name){ return this.command('createwallet', name) }
    getNewAddress(){ return this.command('getnewaddress') }
    generateToAddress(count, address){ return this.command('generatetoaddress', count, address) }
    getBalance(){ return this.command('getbalance') }
    getBlockCount(){ return this.command('getblockcount') }
    getBlockHash(height){ return this.command('getblockhash', height) }
    sendToAddress(address, amount){ return this.command('sendtoaddress', address, amount) }
    getRawTransaction(txid, verbose = false){ return this.command('getrawtransaction', txid, verbose) }
}

module.exports = JsonRpcClient
