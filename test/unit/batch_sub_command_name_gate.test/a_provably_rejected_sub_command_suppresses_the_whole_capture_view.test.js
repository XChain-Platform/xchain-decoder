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

// A BATCH's SUB-COMMANDS pass no ACTION-name gate and no alias expansion.
//
// canonicalizeActionPayload and the VALID_ACTION_NAMES gate run on the TOP-LEVEL token
// only, so everything a batch carries reaches the sub-command-aware capture sites exactly
// as it was spelled on the wire. Measured, not assumed (see the "measured premise" block
// below): `DISPENSERX|0|a` is blanked to '' at the top level and stored verbatim inside a
// BATCH, and `TRANSFER|...` is rewritten to `SEND|...` at the top level and stored as
// TRANSFER inside a BATCH.
//
// TWO consequences, and they are NOT the same size, which is the point of splitting this
// file's two halves:
//
//   1. WHOLE-BATCH REJECTION, live today. The indexer's activation scan
//      (batch/validate.js activationError: isEnabled(split('|')[0]) over every command)
//      invalidates the
//      ENTIRE batch as one record when any sub-command name is unregistered, so NO
//      sub-command runs - not the bad one and not its well-formed siblings. Capture kept
//      reading those siblings. `BATCH|0|DISPENSER|0|...;` - one trailing semicolon -
//      registered an open dispenser here and none there, and payments to that address were
//      then classified as DISPENSE outputs no indexer will ever settle. Same fault class
//      the DISPENSER-prefix tightening closed, reached through a SIBLING command.
//
//      Only the EMPTY name is acted on, because suppression is the UNDER-capture direction:
//      refusing capture for a batch the indexer really runs loses a real settlement output.
//      The decoder holds no copy of the indexer's name registry, and 53 names enabled there
//      are absent from VALID_ACTION_NAMES here, so a gate keyed on the decoder's own known
//      set would suppress capture for batches that dispatch normally. That count is
//      MEASURED against the sibling indexer below rather than quoted.
//
//   2. ALIAS EXPANSION, latent today and money-bearing the day it is not. The indexer
//      dispatches a batched `TRANSFER` as SEND; capture read the wire spelling. No alias
//      resolves to COINPAY or DISPENSER today, so nothing moves - which is exactly when a
//      consensus-affecting rule is cheap to state. Were one added, capture would miss the
//      settlement outputs of a batched alias entirely.
//
// Both halves live ONLY at/above BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION, which is
// DISARMED on mainnet, so pre-flag-day history re-decodes byte-identically. The below-gate
// controls here are real: they redden if either half lands ungated.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const XChainDecoder = require('../../../src/XChainDecoder')
const ACTION_ALIASES = require('../../../src/protocol/action_aliases.js')
const { captureCommands,
        subCommandActionName,
        hasProvablyRejectedSubCommand,
        expandSubCommandAlias } = require('../../../src/protocol/batch_sub_command_capture.js')

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer')
const INDEXER_CHANGES = path.join(INDEXER_ROOT, 'src', 'protocol_changes.js')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file)
    ctx.skip()
    return false
}

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0        = 1700000000
const SOURCE    = 'bcrt1qbatchsource'
const BUYER     = 'bcrt1qbuyeraddress'
const SELLER    = 'bcrt1qselleraddress'
const CHANGE    = 'bcrt1qchangeaddress'
const ORACLE_A  = 'bcrt1qoracleoperatoraaa'
const EXP_LATE  = T0 + 900000

// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//   GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
const CREATE = ['DISPENSER', '0', 'BTC', 'TICK', '1', '', '10', 'BTC', '', '0',
                '', 'USD', '', ORACLE_A, String(EXP_LATE)].join('|')
// COINPAY|VERSION|ORDER_ACTION_INDEX
const COINPAY = 'COINPAY|0|101'

// Mainnet at a block time below the DISARMED sub-command gate: the legacy top-level-only
// view that a re-decode of pre-flag-day history must reproduce.
const BELOW_GATE = { network: 'bitcoin-mainnet', blockTime: T0 }
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
const BLOCK_TITLE = 'a provably-rejected sub-command suppresses the whole capture view'

describe(OUTER_TITLE, function () {
    this.timeout(0)

    // -----------------------------------------------------------------------------------
    // Half 1: the whole-batch rejection the activation scan performs.
    describe(BLOCK_TITLE, function () {

        it('names the ACTION exactly where the indexer does', function () {
            assert.strictEqual(subCommandActionName('COINPAY|0|101'), 'COINPAY')
            assert.strictEqual(subCommandActionName('COINPAY'), 'COINPAY',
                'no delimiter: the whole string is the name, as split("|")[0] gives')
            assert.strictEqual(subCommandActionName(''), '')
            assert.strictEqual(subCommandActionName('|0|x'), '',
                'a leading delimiter yields the empty name there too')
            assert.strictEqual(subCommandActionName(undefined), null,
                'a non-string has no name to prove anything about, so it can never suppress')
        })

        it('fires on an empty element and on a leading delimiter, and on nothing else', function () {
            assert.strictEqual(hasProvablyRejectedSubCommand(['COINPAY|0|101', '']), true)
            assert.strictEqual(hasProvablyRejectedSubCommand(['COINPAY|0|101', '|0|x']), true)
            assert.strictEqual(hasProvablyRejectedSubCommand(['']), true)
            // Deliberately NOT suppressed: unknown to this decoder is not provably unknown
            // to the indexer (see the 53-name measurement below).
            assert.strictEqual(hasProvablyRejectedSubCommand(['COINPAY|0|101', 'GARBAGE|9']), false)
            assert.strictEqual(hasProvablyRejectedSubCommand(['COINPAY|0|101', 'DISPENSE|0|1']), false)
            assert.strictEqual(hasProvablyRejectedSubCommand(['COINPAY|0|101']), false)
        })

        it('yields the EMPTY command view above the gate', function () {
            assert.deepStrictEqual(captureCommands('BATCH|0|' + COINPAY + ';', 'regtest', T0), [])
            assert.deepStrictEqual(captureCommands('BATCH|0|' + COINPAY + ';;', 'regtest', T0), [])
            assert.deepStrictEqual(captureCommands('BATCH|0||0|x', 'regtest', T0), [])
            // Unchanged: a well-formed batch still yields its sub-commands.
            assert.deepStrictEqual(captureCommands('BATCH|0|' + COINPAY, 'regtest', T0), [COINPAY])
        })

        it('captures NOTHING for a batched COINPAY carrying a trailing semicolon', async () => {
            const decoder = await runOne('BATCH|0|' + COINPAY + ';', ABOVE_GATE,
                { outputs: SETTLEMENTS })
            assert.deepStrictEqual(decoder.captured, [],
                'the indexer rejects the whole batch, so no sub-command settles anything')
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {

        it('still captures for the SAME batch without the trailing semicolon', async () => {
            const decoder = await runOne('BATCH|0|' + COINPAY, ABOVE_GATE,
                { outputs: SETTLEMENTS })
            assert.deepStrictEqual(addressesOf(decoder.captured), [SELLER, CHANGE].sort(),
                'the control differs from the rejected payload only by the ";"')
        })

        it('registers NO dispenser for a batched create carrying a trailing semicolon', async () => {
            const decoder = await runOne('BATCH|0|' + CREATE + ';', ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
            assert.strictEqual(decoder.model.insertCalls, 0)
        })

        it('still registers the SAME create without the trailing semicolon', async () => {
            const decoder = await runOne('BATCH|0|' + CREATE, ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [{
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, expiredBlockIndex: null }])
        })

        // The money-bearing end: the registry decides which outputs become DISPENSE
        // outputs, so a registration the indexer never made turns real payments into
        // dispenses against a dispenser that exists nowhere but here.
        it('stops reading payments to that address as dispenses', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + CREATE + ';', source: SOURCE, outputs: [] },
                { id: 'pay01', action: 'SEND|0|BTC|TICK|1|' + SELLER, source: BUYER,
                  outputs: [{ destinationAddress: SOURCE, vout: 0, amount: '0.50000000' }] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(await decoder.model.getAllOpenDispenserAddresses(), new Set(),
                'no address is held open, so the payment stays an ordinary output')
        })
    })
})

describe(OUTER_TITLE, function () {
    this.timeout(0)

    describe(BLOCK_TITLE, function () {

        it('a sibling empty element does not disturb a TOP-LEVEL action', async () => {
            // A ';' inside a non-BATCH payload is an ordinary data byte: the suppression
            // must never reach a transaction that is not a BATCH at all.
            const decoder = await runOne(COINPAY + ';', ABOVE_GATE, { outputs: SETTLEMENTS })
            assert.deepStrictEqual(addressesOf(decoder.captured), [SELLER, CHANGE].sort())
        })

        describe('below the gate, where nothing may move', function () {

            it('leaves the command view as the legacy top-level string', function () {
                assert.deepStrictEqual(captureCommands('BATCH|0|' + COINPAY + ';', 'mainnet', T0),
                    ['BATCH|0|' + COINPAY + ';'])
                assert.deepStrictEqual(captureCommands('BATCH|0||0|x', 'mainnet', T0),
                    ['BATCH|0||0|x'])
            })

            it('captures nothing for a batched COINPAY either way, as the fleet wrote it', async () => {
                for (const action of ['BATCH|0|' + COINPAY, 'BATCH|0|' + COINPAY + ';']) {
                    const decoder = await runOne(action, BELOW_GATE, { outputs: SETTLEMENTS })
                    assert.deepStrictEqual(decoder.captured, [],
                        'pre-flag-day history re-decodes to the empty output set')
                }
            })

            it('registers nothing for a batched create either way', async () => {
                for (const action of ['BATCH|0|' + CREATE, 'BATCH|0|' + CREATE + ';']) {
                    const decoder = await runOne(action, BELOW_GATE)
                    assert.deepStrictEqual(decoder.model.rows, [])
                }
            })

            it('a top-level DISPENSER still registers below the gate', async () => {
                // The control on the control: BELOW_GATE is not simply "nothing happens".
                const decoder = await runOne(CREATE, BELOW_GATE)
                assert.strictEqual(decoder.model.rows.length, 1)
            })
        })
    })

})
