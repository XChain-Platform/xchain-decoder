// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const XChainDecoder = require('../../../../src/XChainDecoder')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}

function createCalls() {
    return {
        insertBlock: 0,
        endTransaction: 0,
        commitTransaction: 0,
        insertEvent: [],
        insertTransaction: [],
        insertTransactionOutput: 0,
        deleteOpenDispensers: 0,
        getAllOpenDispenserAddresses: 0,
    }
}

function databaseFor(decoder, calls) {
    return {
        createDatabase: async () => true,
        verifyDatabase: async () => true,
        verifyTables: async () => true,
        runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1,
        getLastTxIndex: async () => 0,
        beginTransaction: async () => {},
        endTransaction: async () => { calls.endTransaction++ },
        commitTransaction: async () => {
            calls.commitTransaction++
            // The block made it all the way through: stop the loop.
            decoder.stopFlag = true
            return true
        },
        deleteOpenDispensers: async () => { calls.deleteOpenDispensers++; return true },
        purgeExpiredDispensers: async () => true,
        getAllOpenDispenserAddresses: async () => { calls.getAllOpenDispenserAddresses++; return new Set() },
        insertEvent: async (code, data) => {
            calls.insertEvent.push({ code, data })
            return true
        },
        insertBlock: async () => {
            calls.insertBlock++
            return true
        },
        insertTransaction: async (tx) => {
            calls.insertTransaction.push({ ...tx })
            return true
        },
        insertTransactionOutput: async () => {
            calls.insertTransactionOutput++
            return true
        },
        DUPLICATED_TRANSACTION: 1,
    }
}

function buildDecoder({ transactions = [] } = {}) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const calls = createCalls()

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => ''
    }
    decoder.db = databaseFor(decoder, calls)
    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({
            prevHash: Buffer.from(PREV_WIRE),
            timestamp: 1700000000,
            transactions
        })
    }

    return { decoder, calls }
}

module.exports = { buildDecoder, fakeTx }
