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
 * Mocha root hook for integration tests.
 *
 * Sets up: bitcoind regtest, MariaDB decoder DB, XChainDecoder instance.
 * Exposes globals: db, nodeClientTest, mainTestAddress, decoder
 */

const dotenv = require('dotenv')
dotenv.config()

const { execSync } = require('child_process')
const nodeHelper = require('../nodeHelper')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db.js')

const NETWORK = process.env.NETWORK
const NODE_URL = process.env.NODE_URL
const NODE_PORT = process.env.NODE_PORT
const NODE_USER = process.env.NODE_USER
const NODE_PASSWORD = process.env.NODE_PASSWORD
const DB_URL = process.env.DECODER_DB_HOST
const DB_PORT = process.env.DECODER_DB_PORT
const DB_NAME = process.env.DECODER_DB_NAME
const DB_USER = process.env.DECODER_DB_USER
const DB_PASSWORD = process.env.DECODER_DB_PASS

function exec(cmd) {
    return execSync(cmd, { stdio: 'pipe' })
}

function checkNode() {
    try {
        const info = JSON.parse(exec('bitcoin-cli -regtest getnetworkinfo'))
        return info.networkactive === true
    } catch (e) {
        return false
    }
}

async function wait(ms) {
    return new Promise(r => setTimeout(r, ms))
}

exports.mochaHooks = {
    async beforeAll() {
        console.log('[integration] Setting up regtest environment')

        // Prepare DB
        const dbName = DB_NAME + '_regtest'
        global.db = new Database(DB_URL, DB_PORT, dbName, DB_USER, DB_PASSWORD)
        await global.db.dropDatabase()
        await global.db.verifyTables()

        // Prepare node
        if (checkNode()) {
            console.log('[integration] Stopping existing bitcoind')
            exec('bitcoin-cli -regtest stop')
            await wait(2000)
        }

        console.log('[integration] Cleaning regtest data')
        exec('rm -rf ~/.bitcoin/regtest')

        console.log('[integration] Starting bitcoind regtest')
        exec('bitcoind -regtest -daemon -fallbackfee=1.0 -maxtxfee=1.1')

        await wait(1000)
        while (!checkNode()) {
            console.log('[integration] Waiting for node...')
            await wait(3000)
        }

        console.log('[integration] Creating wallet and funding')
        global.nodeClientTest = await nodeHelper.getWalletConnection('test-wallet')
        global.mainTestAddress = await global.nodeClientTest.getNewAddress()
        await global.nodeClientTest.generateToAddress(101, global.mainTestAddress)

        const balance = await global.nodeClientTest.getBalance()
        console.log(`[integration] Wallet funded: ${balance} BTC`)

        // Start decoder
        global.decoder = new XChainDecoder(
            NETWORK, DB_URL, DB_PORT, dbName, DB_USER, DB_PASSWORD,
            NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD
        )
        global.decoder.start()

        // Wait for decoder to sync initial blocks
        console.log('[integration] Waiting for decoder to sync...')
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
            const lastBlock = await global.db.getLastBlockIndex()
            if (lastBlock >= 101) break
            await wait(1000)
        }
        console.log('[integration] Decoder synced, ready for tests')
    },

    async afterAll() {
        console.log('[integration] Tearing down')
        if (global.decoder) global.decoder.stop()
    }
}
