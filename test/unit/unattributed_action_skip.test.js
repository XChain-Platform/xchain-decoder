// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

// A tx carrying XChain data whose source address cannot be resolved is skipped
// without a row or an event. The skip must still reach parse_errors, the counter
// health, the probe and the metrics endpoint all read, so it is not log-only.
const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

// Build a decoder over one fake block whose single tx parses to `parseResult`.
function buildDecoder(parseResult) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    const calls = { insertBlock: 0, insertTransaction: 0, insertEvent: 0, commitTransaction: 0 }
    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => ''
    }
    decoder.db = fakeDb(decoder, calls)
    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({
            prevHash: Buffer.from(PREV_WIRE),
            timestamp: 1700000000,
            transactions: [{ getId: () => 'cafe01', outs: [] }]
        })
    }
    decoder.parseTransaction = async () => parseResult
    return { decoder, calls }
}

// Block-db stub that counts every write and stops the loop at the first commit.
function fakeDb(decoder, calls) {
    return {
        createDatabase: async () => true,
        verifyDatabase: async () => true,
        verifyTables: async () => true,
        runMigrations: async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1,
        getLastTxIndex: async () => 0,
        beginTransaction: async () => {},
        endTransaction: async () => {},
        commitTransaction: async () => { calls.commitTransaction++; decoder.stopFlag = true; return true },
        deleteOpenDispensers: async () => true,
        purgeExpiredDispensers: async () => {},
        getAllOpenDispenserAddresses: async () => new Set(),
        insertEvent: async () => { calls.insertEvent++; return true },
        insertTransaction: async () => { calls.insertTransaction++; return true },
        insertBlock: async () => { calls.insertBlock++; return true }
    }
}

function parseResultWith(data, source) {
    return { data, source, destination: null, amount: 0, dispenseOutputs: [], paymentOutputs: [] }
}

describe('XChainDecoder unattributed XChain payload skip', function () {
    this.timeout(0)

    it('counts a payload with no resolvable source toward parse_errors and stores nothing', async function () {
        const { decoder, calls } = buildDecoder(parseResultWith(Buffer.from('XYZ'), null))

        await decoder.start()

        assert.strictEqual(decoder.parseErrors, 1, 'the unattributed skip must reach parse_errors')
        assert.strictEqual(calls.insertTransaction, 0, 'no transactions row for an unattributed payload')
        assert.strictEqual(calls.insertEvent, 0, 'no event row: decoder content is replicated')
        assert.strictEqual(calls.insertBlock, 1, 'the block itself still commits')
        assert.strictEqual(calls.commitTransaction, 1)
    })

    it('leaves parse_errors untouched for a tx with no payload and no source', async function () {
        const { decoder, calls } = buildDecoder(parseResultWith(Buffer.alloc(0), null))

        await decoder.start()

        assert.strictEqual(decoder.parseErrors, 0, 'an ordinary non-XChain tx is not a parse error')
        assert.strictEqual(calls.insertTransaction, 0)
        assert.strictEqual(calls.insertBlock, 1)
    })
})
