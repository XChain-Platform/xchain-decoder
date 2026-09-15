'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')

const XChainDecoder = require('../../../src/XChainDecoder')
const ACTION_ALIASES = require('../../../src/protocol/action_aliases.js')
const { captureCommands,
        expandSubCommandAlias } = require('../../../src/protocol/batch_sub_command_capture.js')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0        = 1700000000
const SOURCE    = 'bcrt1qbatchsource'
const SELLER    = 'bcrt1qselleraddress'
const CHANGE    = 'bcrt1qchangeaddress'

// COINPAY|VERSION|ORDER_ACTION_INDEX
const COINPAY = 'COINPAY|0|101'

// regtest is genesis-on for the gate.
const ABOVE_GATE = { network: 'bitcoin-regtest', blockTime: T0 }

class DispenserModel {
    constructor() { this.rows = []; this.insertCalls = 0 }
    async insertDispenser({ txIndex, address, expiration, oracleAddress }) {
        this.insertCalls++
        this.rows.push({ txIndex, address, expiration: Number(expiration),
                         oracleAddress: oracleAddress || null, expiredBlockIndex: null })
        return true
    }
    async extendOpenDispenserExpirationBySource() { return true }
    async deleteOpenDispensers() { return true }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
    _openFor(s) { return this.rows.filter(r => r.address === s && r.expiredBlockIndex === null) }
    async getOpenDispenserOracleAddressBySource(s) {
        const open = this._openFor(s).sort((a, b) => b.txIndex - a.txIndex)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    async getOpenDispenserOracleAddressesBySource(s) {
        return [...new Set(this._openFor(s).map(r => r.oracleAddress).filter(a => !!a))]
    }
}

function fakeTx(id) { return { getId: () => id, outs: [] } }

function transactionParser(byId) {
    return async (tx, openDispenserAddresses) => {
        const spec = byId[tx.getId()]
        const buf = Buffer.from(spec.action || '')
        const dispenseOutputs = []
        const paymentOutputs  = []
        for (const output of (spec.outputs || [])) {
            const row = Object.assign({}, output)
            if (openDispenserAddresses && openDispenserAddresses.has(output.destinationAddress))
                dispenseOutputs.push(row)
            else
                paymentOutputs.push(row)
        }
        return {
            data:               buf,
            source:             spec.source,
            destination:        null,
            amount:             0,
            dispenseOutputs:    dispenseOutputs,
            paymentOutputs:     paymentOutputs,
            compiledDataLength: buf.length,
            rawData:            null,
        }
    }
}

function databaseFor(decoder, model, captured) {
    return {
        createDatabase:  async () => true,
        verifyDatabase:  async () => true,
        verifyTables:    async () => true,
        runMigrations:   async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1,
        getLastTxIndex:  async () => 0,
        beginTransaction:  async () => {},
        endTransaction:    async () => {},
        commitTransaction: async () => { decoder.stopFlag = true; return true },
        insertBlock:       async () => true,
        insertEvent:       async () => true,
        insertTransaction: async () => true,
        insertTransactionOutput: async (o) => { captured.push(o); return true },
        POISON_ROW: 2,
        DUPLICATED_TRANSACTION: 1,
        insertDispenser:                     (d) => model.insertDispenser(d),
        extendOpenDispenserExpirationBySource: (s, e, b) => model.extendOpenDispenserExpirationBySource(s, e, b),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource:   (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) => model.getOpenDispenserOracleAddressesBySource(s),
    }
}

// txSpecs: [{ id, action, source, outputs: [{destinationAddress, vout, amount}] }]
// Drives the REAL block loop, with parseTransaction's dispense/payment split modelled the
// way the production one splits it (an output paying an address in the OPEN-DISPENSER set
// is a dispense output): the registry is only meaningful through that split.
function buildDecoder(txSpecs, model, opts) {
    opts = opts || {}
    const decoder = new XChainDecoder(
        opts.network || ABOVE_GATE.network, 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p',
        false, opts.feeDestination === undefined ? null : opts.feeDestination
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = s

    decoder.parseTransaction = transactionParser(byId)

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash:      async () => 'aabbccdd',
        getBlock:          async () => '',
    }

    const captured = []
    decoder.db = databaseFor(decoder, model, captured)

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE),
                               timestamp: opts.blockTime === undefined ? T0 : opts.blockTime,
                               transactions })
    }

    decoder.captured = captured
    decoder.model = model
    return decoder
}

async function runAll(txSpecs, venue, extra) {
    const model = new DispenserModel()
    const decoder = buildDecoder(txSpecs, model, Object.assign({}, venue, extra || {}))
    await decoder.start()
    return decoder
}

async function runOne(action, venue, extra) {
    return runAll([{ id: 'tx01', action, source: SOURCE, outputs: (extra || {}).outputs || [] }],
        venue, extra)
}

const addressesOf = (rows) => rows.map(o => o.destinationAddress).sort()

// Two settlement outputs plus change, the shape a two-obligation COINPAY pays.
const SETTLEMENTS = [
    { destinationAddress: SELLER, vout: 0, amount: '1.00000000' },
    { destinationAddress: CHANGE, vout: 1, amount: '5.00000000' },
]

const OUTER_TITLE = 'BATCH sub-command ACTION-name gate and alias expansion'
const BLOCK_TITLE = 'sub-command ACTION names are alias-expanded above the gate'

describe(OUTER_TITLE, function () {
    this.timeout(0)

    // Half 2: alias expansion over the sub-command view.
    describe(BLOCK_TITLE, function () {

        it('rewrites the NAME and returns every later byte verbatim', function () {
            assert.strictEqual(expandSubCommandAlias('TRANSFER|0|BTC|TICK|1|x', ACTION_ALIASES),
                'SEND|0|BTC|TICK|1|x')
            assert.strictEqual(expandSubCommandAlias('MSG|0|a|b|c', ACTION_ALIASES),
                'MESSAGE|0|a|b|c')
            assert.strictEqual(expandSubCommandAlias('SEND|0|x', ACTION_ALIASES), 'SEND|0|x',
                'a canonical name is returned unchanged')
            assert.strictEqual(expandSubCommandAlias('TRANSFERX|0|x', ACTION_ALIASES), 'TRANSFERX|0|x',
                'the name must match WHOLE: an alias is not a prefix')
            assert.strictEqual(expandSubCommandAlias('', ACTION_ALIASES), '')
        })

        it('reads only OWN properties, so a prototype name is not a table hit', function () {
            // These are untrusted wire bytes. A bare lookup would find Object.prototype's
            // members and splice a function's whole source onto the command.
            for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
                assert.strictEqual(expandSubCommandAlias(name + '|0|x', ACTION_ALIASES),
                    name + '|0|x', name + ' must not resolve through the prototype chain')
            }
            // The case that isolates the own-property rule from the string-type rule
            // beside it: an INHERITED entry whose value IS a string. Only hasOwnProperty
            // refuses this one. Unreachable for the real table (an object literal, whose
            // prototype carries no enumerable members), which is why it is driven with a
            // constructed one rather than left to argument.
            assert.strictEqual(
                expandSubCommandAlias('FOO|0|x', Object.create({ FOO: 'COINPAY' })),
                'FOO|0|x', 'an alias reached through the prototype is not this table\'s alias')
        })

        it('ignores a table entry that is not a non-empty string', function () {
            // The case that isolates the string-type rule: an OWN entry of the wrong type.
            // Without it the concatenation splices a number, an object or nothing at all
            // onto the head of a command the capture sites then prefix-match.
            assert.strictEqual(expandSubCommandAlias('FOO|0|x', { FOO: 42 }), 'FOO|0|x')
            assert.strictEqual(expandSubCommandAlias('FOO|0|x', { FOO: '' }), 'FOO|0|x')
            assert.strictEqual(expandSubCommandAlias('FOO|0|x', { FOO: null }), 'FOO|0|x')
            assert.strictEqual(expandSubCommandAlias('FOO|0|x', { FOO: ['COINPAY'] }), 'FOO|0|x')
        })

        it('is load-bearing: a table naming a capture ACTION changes what capture sees', function () {
            // The real table resolves to no capture-selecting name, so the mechanism is
            // driven with a synthetic one. This is the case that turns money-bearing the
            // day such an alias is added, and it is what the expansion exists for.
            assert.strictEqual(expandSubCommandAlias('PAY|0|101', { PAY: 'COINPAY' }),
                'COINPAY|0|101')
            assert.strictEqual(expandSubCommandAlias('DISP|0|BTC', { DISP: 'DISPENSER' }),
                'DISPENSER|0|BTC')
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {

        it('expands inside the real capture view above the gate', function () {
            assert.deepStrictEqual(captureCommands('BATCH|0|MSG|0|a', 'regtest', T0),
                ['MESSAGE|0|a'])
            assert.deepStrictEqual(
                captureCommands('BATCH|0|TRANSFER|0|BTC|TICK|1|x;' + COINPAY, 'regtest', T0),
                ['SEND|0|BTC|TICK|1|x', COINPAY])
        })

        it('leaves the wire spelling alone BELOW the gate', function () {
            assert.deepStrictEqual(captureCommands('BATCH|0|MSG|0|a', 'mainnet', T0),
                ['BATCH|0|MSG|0|a'])
        })

        it('changes NO capture decision under the real table, which is why it is cheap now', async () => {
            // Every alias, batched beside a COINPAY: the captured set must be exactly what
            // the COINPAY alone captures. Pins that this expansion is a no-op on chain
            // today, so the flag-day it rides carries no behaviour change from this half.
            const baseline = await runOne('BATCH|0|' + COINPAY, ABOVE_GATE, { outputs: SETTLEMENTS })
            const expected = addressesOf(baseline.captured)
            for (const alias of Object.keys(ACTION_ALIASES)) {
                const decoder = await runOne(
                    'BATCH|0|' + alias + '|0|BTC|TICK|1|x;' + COINPAY, ABOVE_GATE,
                    { outputs: SETTLEMENTS })
                assert.deepStrictEqual(addressesOf(decoder.captured), expected,
                    alias + ' must not move the captured output set')
            }
        })

        it('no alias resolves to a capture-selecting ACTION, which is the no-op argument', function () {
            // The invariant the previous test rests on, stated where a change to
            // ACTION_ALIASES will trip it: add an alias for COINPAY or DISPENSER and the
            // "nothing moves today" claim above stops being true, deliberately - the
            // expansion is then load-bearing and the flag day it rides must say so.
            for (const canonical of Object.values(ACTION_ALIASES)) {
                assert.ok(canonical !== 'COINPAY' && canonical !== 'DISPENSER',
                    'an alias resolves to ' + canonical + ', a capture-selecting ACTION: ' +
                    'sub-command alias expansion is no longer a no-op and this file\'s ' +
                    'no-op assertions must be re-derived rather than re-run')
            }
        })
    })
})
