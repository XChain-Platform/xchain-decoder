/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Mocha root hook for E2E tests.
 *
 * Sets up: bitcoind regtest, MariaDB decoder DB, XChainDecoder instance.
 * Exposes globals: db, nodeClientTest, mainTestAddress, decoder
 *
 * This is similar to the integration setup but uses a dedicated E2E database
 * and provides additional control over the decoder lifecycle for multi-block
 * and reorg tests.
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

// E2E-specific DB name to avoid conflicts with integration tests
const E2E_DB_NAME = DB_NAME + '_e2e_regtest'

function exec(cmd) {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim()
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

/**
 * Create a fresh decoder instance pointed at the E2E database.
 * Exposed so tests can stop/restart the decoder for catch-up and reorg tests.
 */
function createDecoder() {
    return new XChainDecoder(
        NETWORK, DB_URL, DB_PORT, E2E_DB_NAME, DB_USER, DB_PASSWORD,
        NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD
    )
}

exports.mochaHooks = {
    async beforeAll() {
        this.timeout(120000)
        console.log('[e2e] Setting up regtest environment')

        // Prepare DB
        global.db = new Database(DB_URL, DB_PORT, E2E_DB_NAME, DB_USER, DB_PASSWORD)
        await global.db.createDatabase()
        await global.db.dropDatabase()
        await global.db.verifyTables()

        // Prepare node
        if (checkNode()) {
            console.log('[e2e] Stopping existing bitcoind')
            try { exec('bitcoin-cli -regtest stop') } catch (e) { /* ignore */ }
            await wait(2000)
        }

        console.log('[e2e] Cleaning regtest data')
        try { exec('rm -rf ~/.bitcoin/regtest') } catch (e) { /* ignore */ }

        console.log('[e2e] Starting bitcoind regtest')
        exec('bitcoind -regtest -daemon -fallbackfee=1.0 -maxtxfee=1.1')

        await wait(1000)
        let nodeWaitStart = Date.now()
        while (!checkNode()) {
            if (Date.now() - nodeWaitStart > 30000) throw new Error('bitcoind failed to start')
            console.log('[e2e] Waiting for node...')
            await wait(3000)
        }

        console.log('[e2e] Creating wallet and funding')
        global.nodeClientTest = await nodeHelper.getWalletConnection('e2e-wallet')
        global.mainTestAddress = await global.nodeClientTest.getNewAddress()
        await global.nodeClientTest.generateToAddress(101, global.mainTestAddress)

        const balance = await global.nodeClientTest.getBalance()
        console.log(`[e2e] Wallet funded: ${balance} BTC`)

        // Start decoder
        global.createDecoder = createDecoder
        global.decoder = createDecoder()
        global.decoder.start()

        // Wait for decoder to sync initial blocks
        console.log('[e2e] Waiting for decoder to sync...')
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
            const lastBlock = await global.db.getLastBlockIndex()
            if (lastBlock >= 101) break
            await wait(1000)
        }

        const lastBlock = await global.db.getLastBlockIndex()
        if (lastBlock < 101) throw new Error(`Decoder did not sync. Last block: ${lastBlock}`)
        console.log(`[e2e] Decoder synced at block ${lastBlock}, ready for tests`)
    },

    async afterAll() {
        this.timeout(30000)
        console.log('[e2e] Tearing down')
        if (global.decoder) global.decoder.stop()
        await wait(2000)
    }
}
