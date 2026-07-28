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
 * Chaos Engineering test helpers.
 *
 * Provides mock factories and fault injection utilities for testing
 * the decoder's resilience without requiring real infrastructure.
 */
const sinon = require('sinon')
const EventEmitter = require('events')

// The stored-tip hash the mock DB reports AND the hash the mock node reports for
// that height. These MUST agree: verifyReorg compares them, and when they differ
// the decoder booted on the default mocks detects a phantom reorg at startup and
// walks the rollback (deleteBlockByIndex is a no-op stub, so getLastBlockIndex
// never retreats) until it hits the DISPENSER_EXPIRE_SAFE_DEPTH abort. That is
// what rotted the CE-01 outage tests: they assert node-retry behaviour and never
// meant to be inside a reorg at all.
const MOCK_TIP_HASH = '0000000000000000000000000000000000000000000000000000000000000001'

/**
 * Creates a mock Database instance with controllable behavior.
 * All methods return success by default; use stubs to inject faults.
 */
function createMockDatabase(overrides = {}) {
    const db = {
        _transactionLock: false,
        _transactionLockQueue: [],
        transactionConnection: null,

        getLastBlockIndex: sinon.stub().resolves(0),
        getLastTxIndex: sinon.stub().resolves(0),
        getBlockByIndex: sinon.stub().resolves({ block_hash: MOCK_TIP_HASH, block_index: 0 }),
        createDatabase: sinon.stub().resolves(true),
        verifyDatabase: sinon.stub().resolves(true),
        verifyTables: sinon.stub().resolves(true),
        runMigrations: sinon.stub().resolves({ applied: [], pending: [] }),
        beginTransaction: sinon.stub().resolves(),
        commitTransaction: sinon.stub().resolves(true),
        endTransaction: sinon.stub().resolves(),
        insertBlock: sinon.stub().resolves(true),
        insertTransaction: sinon.stub().resolves(true),
        insertMempoolTransaction: sinon.stub().resolves(true),
        insertTransactionOutput: sinon.stub().resolves(true),
        insertDispenser: sinon.stub().resolves(true),
        insertEvent: sinon.stub().resolves(true),
        deleteOpenDispensers: sinon.stub().resolves(true),
        purgeExpiredDispensers: sinon.stub().resolves(true),
        deleteAndCompareTxsNotInList: sinon.stub().resolves({ transactionsDeleted: 0 }),
        isThereADispenserForAddress: sinon.stub().resolves(false),
        getAllOpenDispenserAddresses: sinon.stub().resolves(new Set()),
        deleteBlockByIndex: sinon.stub().resolves(true),
        dropDatabase: sinon.stub().resolves(),
        getConnection: sinon.stub().resolves({
            query: sinon.stub().resolves([]),
            release: sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves()
        }),
        releaseConnection: sinon.stub().resolves(),
        createTransaction: sinon.stub().resolves(1),
        createAddress: sinon.stub().resolves(1),

        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        ...overrides
    }
    return db
}

/**
 * Creates a mock BlockchainConnector with controllable responses.
 */
function createMockConnector(overrides = {}) {
    return {
        getNetworkInfo: sinon.stub().resolves({ version: 210000 }),
        getBlockchainInfo: sinon.stub().resolves({
            blocks: 100,
            verificationprogress: 1.0
        }),
        getBlockHash: sinon.stub().resolves(MOCK_TIP_HASH),
        getBlockHeader: sinon.stub().resolves('0'.repeat(160)),
        getBlock: sinon.stub().resolves(null),
        getBlockWithoutAuxPow: sinon.stub().resolves(null),
        getRawMempool: sinon.stub().resolves([]),
        getRawTransaction: sinon.stub().resolves('0'.repeat(100)),
        getRawTransactions: sinon.stub().resolves([]),
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        ...overrides
    }
}

/**
 * Creates a minimal valid regtest block hex with a single coinbase tx.
 * This is a pre-built block that bitcoinjs-lib can parse.
 */
function createMinimalBlockHex() {
    // A minimal valid block: 80-byte header + 1 coinbase tx
    // Version 1, prev hash all zeros, merkle root, timestamp, bits, nonce
    const header = '01000000' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' +
        '29ab5f49' +
        'ffff001d' +
        '1dac2b7c'
    // varint 1 tx
    const txCount = '01'
    // Minimal coinbase tx
    const coinbaseTx =
        '01000000' + // version
        '01' + // 1 input
        '0000000000000000000000000000000000000000000000000000000000000000' + // prev hash (coinbase)
        'ffffffff' + // prev index
        '07' + // script length
        '04ffff001d0104' + // coinbase script
        'ffffffff' + // sequence
        '01' + // 1 output
        '00f2052a01000000' + // 50 BTC in satoshis
        '43' + // script length (67 bytes)
        '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac' +
        '00000000' // locktime

    return header + txCount + coinbaseTx
}

/**
 * Wait helper for chaos tests.
 */
function wait(ms) {
    return new Promise(r => setTimeout(r, ms))
}

/**
 * Captures console output during a function execution.
 */
async function captureConsole(fn) {
    const logs = []
    const errors = []
    const origLog = console.log
    const origError = console.error
    console.log = (...args) => logs.push(args.join(' '))
    console.error = (...args) => errors.push(args.join(' '))
    try {
        await fn()
    } finally {
        console.log = origLog
        console.error = origError
    }
    return { logs, errors }
}

/**
 * Creates a fault injector that fails N times then succeeds.
 */
function failNTimes(n, successValue, errorMsg = 'Injected chaos fault') {
    let callCount = 0
    return sinon.stub().callsFake(async () => {
        callCount++
        if (callCount <= n) {
            throw new Error(errorMsg)
        }
        return successValue
    })
}

/**
 * Creates a stub that alternates between success and failure.
 */
function intermittentFault(successValue, failRate = 0.5, errorMsg = 'Intermittent fault') {
    return sinon.stub().callsFake(async () => {
        if (Math.random() < failRate) {
            throw new Error(errorMsg)
        }
        return successValue
    })
}

/**
 * Creates a stub that adds latency before resolving.
 */
function withLatency(value, minMs, maxMs) {
    return sinon.stub().callsFake(async () => {
        const delay = minMs + Math.random() * (maxMs - minMs)
        await new Promise(r => setTimeout(r, delay))
        return value
    })
}

/**
 * Removes // line comments and block comments from JS source, preserving line
 * structure and offsets by replacing each stripped character with a space.
 * Source-shape assertions must scan code, not prose: this codebase's comments
 * routinely quote the very keywords those assertions search for.
 */
function stripJsComments(source) {
    // States: 0 code, 1 line comment, 2 block comment, 3 single-quote string,
    // 4 double-quote string, 5 template string. Regex literals are not tracked;
    // a `//` inside one would over-strip, which is acceptable for shape checks.
    let out = ''
    let state = 0
    for (let i = 0; i < source.length; i++) {
        const c = source[i]
        const next = source[i + 1]
        if (state === 0) {
            if (c === '/' && next === '/') { state = 1; out += '  '; i++; continue }
            if (c === '/' && next === '*') { state = 2; out += '  '; i++; continue }
            if (c === "'") state = 3
            else if (c === '"') state = 4
            else if (c === '`') state = 5
            out += c
            continue
        }
        if (state === 1) {
            if (c === '\n') { state = 0; out += c } else out += ' '
            continue
        }
        if (state === 2) {
            if (c === '*' && next === '/') { state = 0; out += '  '; i++ }
            else out += (c === '\n' ? c : ' ')
            continue
        }
        // Inside a string literal: copy through, honouring backslash escapes.
        out += c
        if (c === '\\') { out += (next === undefined ? '' : next); i++; continue }
        if ((state === 3 && c === "'") || (state === 4 && c === '"') || (state === 5 && c === '`')) state = 0
    }
    return out
}

module.exports = {
    createMockDatabase,
    createMockConnector,
    createMinimalBlockHex,
    MOCK_TIP_HASH,
    wait,
    captureConsole,
    failNTimes,
    intermittentFault,
    withLatency,
    stripJsComments
}
