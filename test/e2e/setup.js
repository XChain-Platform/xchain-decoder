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
 * Mocha root hook for E2E tests.
 *
 * Sets up: a containerised regtest node, a containerised MariaDB decoder DB,
 * and an XChainDecoder wired to both.
 * Exposes globals: db, nodeClientTest, mainTestAddress, decoder, createDecoder
 *
 * The venue is fixtures/docker-compose.test.yml; `npm run test:e2e`
 * (bin/run-e2e.sh) brings it up and tears it down. It is the same shape as the
 * integration venue on different ports, so both tiers can run side by side.
 * Both containers keep their state on tmpfs, so every run starts from an empty
 * chain and an empty database.
 *
 * Unlike the integration setup this one hands the tests a decoder FACTORY as
 * well as a running decoder, because the multi-block tier stops and restarts
 * the decoder to exercise bulk catch-up and reorg recovery.
 *
 * This fixture owns NOTHING on the host. It used to: it ran `bitcoin-cli
 * -regtest stop` and then deleted ~/.bitcoin/regtest before any test, which
 * made the tier unrunnable on any machine that kept a real regtest chain and
 * silently destructive on the machines where it did run. Both the daemon
 * lifecycle and the wipe are gone, replaced by RPC against the container, so
 * there is no longer a host path for this tier to delete.
 *
 * Deliberately does NOT load .env. The fixture drops and recreates a database,
 * mines on the node it is pointed at and invalidates blocks on it, so it must
 * not inherit a developer's real connection settings by accident. The defaults
 * below are the compose fixture's own throwaway values; the XCHAIN_E2E_*
 * overrides exist for a differently-published venue, and the regtest assertion
 * in beforeAll is what keeps an override honest.
 */

const BitcoinCore = require('bitcoin-core')
const nodeHelper = require('../nodeHelper')
const XChainDecoder = require('../../src/XChainDecoder')
const Database = require('../../src/db.js')

// Fixture venue. Must match fixtures/docker-compose.test.yml.
const NODE_HOST = process.env.XCHAIN_E2E_NODE_HOST || '127.0.0.1'
const NODE_PORT = process.env.XCHAIN_E2E_NODE_PORT || '18545'
const NODE_USER = process.env.XCHAIN_E2E_NODE_USER || 'e2efixture'
const NODE_PASSWORD = process.env.XCHAIN_E2E_NODE_PASS || 'e2efixture'
const DB_HOST = process.env.XCHAIN_E2E_DB_HOST || '127.0.0.1'
const DB_PORT = process.env.XCHAIN_E2E_DB_PORT || '13319'
const DB_USER = process.env.XCHAIN_E2E_DB_USER || 'root'
const DB_PASSWORD = process.env.XCHAIN_E2E_DB_PASS || 'e2efixture'
const DB_NAME = 'xchain_decoder_e2e_regtest'
const NETWORK = 'bitcoin-regtest'

// Blocks mined to make the coinbase spendable (100 maturity + 1).
const FUNDING_BLOCKS = 101

// Let the shared node helper, and therefore the tx builders that sit on it,
// reach the same containerised node. Set before any helper call rather than at
// require time so the helper's host-node defaults stay intact for anything else
// that uses it.
process.env.XCHAIN_TEST_NODE_HOST = NODE_HOST
process.env.XCHAIN_TEST_NODE_PORT = NODE_PORT
process.env.XCHAIN_TEST_NODE_USER = NODE_USER
process.env.XCHAIN_TEST_NODE_PASS = NODE_PASSWORD

async function wait(ms) {
    return new Promise(r => setTimeout(r, ms))
}

// Wait for the node container to answer RPC, and return its chain info. Bounded:
// a node that never comes up is a venue failure and should say so, not hang the
// suite until mocha's (disabled) timeout.
async function waitForNode(timeoutMs) {
    const probe = new BitcoinCore({
        host: 'http://' + NODE_HOST + ':' + NODE_PORT,
        username: NODE_USER,
        password: NODE_PASSWORD
    })
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
        try {
            return await probe.getBlockchainInfo()
        } catch (e) {
            lastError = e
            await wait(1000)
        }
    }
    throw new Error(
        'e2e venue: no RPC response from the regtest node at ' + NODE_HOST + ':' + NODE_PORT +
        ' after ' + Math.round(timeoutMs / 1000) + 's. Start it with `npm run test:e2e:up`. ' +
        'Last error: ' + (lastError ? lastError.message : 'none'))
}

/**
 * Create a fresh decoder instance pointed at the E2E database.
 * Exposed so tests can stop/restart the decoder for catch-up and reorg tests.
 */
function createDecoder() {
    return new XChainDecoder(
        NETWORK, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
        NODE_HOST, NODE_PORT, NODE_USER, NODE_PASSWORD
    )
}

exports.mochaHooks = {
    async beforeAll() {
        this.timeout(180000)
        console.log('[e2e] Setting up regtest environment')

        // Connect to the node first and refuse anything that is not regtest. This
        // fixture mines blocks, invalidates them and drops a database, so the one
        // thing it must never do is that against a real chain. The old host-wipe
        // guard covered the same hazard for the host datadir; this covers the
        // endpoint, which is the only thing left that a misconfiguration can
        // redirect.
        const chainInfo = await waitForNode(60000)
        if (chainInfo.chain !== 'regtest') {
            throw new Error(
                'e2e setup REFUSES to run: the node at ' + NODE_HOST + ':' + NODE_PORT +
                ' reports chain "' + chainInfo.chain + '", not regtest. This fixture mines and ' +
                'invalidates blocks and drops its database; point it at the throwaway container ' +
                'from test/e2e/fixtures/docker-compose.test.yml.')
        }

        // Prepare DB
        global.db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
        await global.db.createDatabase()
        await global.db.dropDatabase()
        await global.db.verifyTables()

        console.log('[e2e] Funding test wallet')
        global.nodeClientTest = await nodeHelper.getWalletConnection('e2e-wallet')
        global.mainTestAddress = await global.nodeClientTest.getNewAddress()
        await global.nodeClientTest.generateToAddress(FUNDING_BLOCKS, global.mainTestAddress)

        const balance = await global.nodeClientTest.getBalance()
        console.log(`[e2e] Wallet funded: ${balance} BTC`)

        // Start decoder
        global.createDecoder = createDecoder
        global.decoder = createDecoder()
        global.decoder.start()

        // Wait for the decoder to catch up to the funding blocks. The chain can be
        // taller than FUNDING_BLOCKS when the venue is reused without a teardown, so
        // target the node's own height rather than a constant.
        const targetHeight = await global.nodeClientTest.getBlockCount()
        console.log(`[e2e] Waiting for decoder to sync to block ${targetHeight}...`)
        const deadline = Date.now() + 120000
        let lastBlock = -1
        while (Date.now() < deadline) {
            lastBlock = await global.db.getLastBlockIndex()
            if (lastBlock >= targetHeight) break
            await wait(1000)
        }
        if (lastBlock < targetHeight) {
            throw new Error(`Decoder did not sync. Last block: ${lastBlock}, expected >= ${targetHeight}`)
        }
        console.log(`[e2e] Decoder synced at block ${lastBlock}, ready for tests`)
    },

    async afterAll() {
        this.timeout(30000)
        console.log('[e2e] Tearing down')
        if (global.decoder) global.decoder.stop()
        await wait(1000)
    }
}
