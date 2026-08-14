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
//      (batch.js parse(): isEnabled(split('|')[0]) over every command) invalidates the
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

const XChainDecoder = require('../../src/XChainDecoder')
const ACTION_ALIASES = require('../../src/actionAliases.js')
const { captureCommands,
        subCommandActionName,
        hasProvablyRejectedSubCommand,
        expandSubCommandAlias } = require('../../src/batchSubCommandCapture.js')

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer')
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

    decoder.parseTransaction = async (tx, openDispenserAddresses) => {
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

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash:      async () => 'aabbccdd',
        getBlock:          async () => '',
    }

    const captured = []
    decoder.db = {
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

describe('BATCH sub-command ACTION-name gate and alias expansion', function () {
    this.timeout(0)

    // -----------------------------------------------------------------------------------
    // The premise, MEASURED. Every claim this file's fixes rest on is driven here rather
    // than argued, because three row premises on this spec turned out false when checked.
    describe('measured premise: sub-commands pass no name gate and no canonicalization', function () {

        // buildStoredActionRecord is the storage gate: alias expansion + the
        // VALID_ACTION_NAMES check, applied to the TOP-LEVEL token.
        function stored(actionString) {
            const decoder = new XChainDecoder(
                'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
            const buf = Buffer.from(actionString)
            return decoder.buildStoredActionRecord({
                data: buf, compiledDataLength: buf.length, rawData: null,
                dispenseOutputs: [], paymentOutputs: [] }, 'tx01', false)
        }

        it('canonicalizes an alias at the TOP LEVEL and not inside a BATCH', function () {
            assert.strictEqual(stored('TRANSFER|0|BTC|TICK|1|' + SELLER).data,
                'SEND|0|BTC|TICK|1|' + SELLER,
                'the top-level token is alias-expanded before storage')
            assert.strictEqual(stored('BATCH|0|TRANSFER|0|BTC|TICK|1|' + SELLER).data,
                'BATCH|0|TRANSFER|0|BTC|TICK|1|' + SELLER,
                'a batched alias is stored in its WIRE spelling: the gate saw only BATCH')
        })

        it('name-gates an unknown ACTION at the TOP LEVEL and not inside a BATCH', function () {
            assert.deepStrictEqual(stored('DISPENSERX|0|a'), { skip: true, data: '', rawData: null },
                'an unknown top-level name is blanked and the transaction skipped')
            assert.strictEqual(stored('BATCH|0|DISPENSERX|0|a').data, 'BATCH|0|DISPENSERX|0|a',
                'the same name inside a BATCH is stored verbatim: nothing re-checks the pieces')
        })
    })

    // -----------------------------------------------------------------------------------
    // Half 1: the whole-batch rejection the activation scan performs.
    describe('a provably-rejected sub-command suppresses the whole capture view', function () {

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

        it('still captures for the SAME batch without the trailing semicolon', async () => {
            const decoder = await runOne('BATCH|0|' + COINPAY, ABOVE_GATE,
                { outputs: SETTLEMENTS })
            assert.deepStrictEqual(addressesOf(decoder.captured), [SELLER, CHANGE].sort(),
                'row 26 intact: the only difference between these two payloads is the ";"')
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

    // -----------------------------------------------------------------------------------
    // Half 2: alias expansion over the sub-command view.
    describe('sub-command ACTION names are alias-expanded above the gate', function () {

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
                    'an alias now resolves to ' + canonical + ', a capture-selecting ACTION: ' +
                    'sub-command alias expansion is no longer a no-op and this file\'s ' +
                    'no-op assertions must be re-derived rather than re-run')
            }
        })
    })

    // -----------------------------------------------------------------------------------
    // The cross-repo evidence, DRIVEN against the sibling indexer rather than quoted.
    describe('the indexer side of the argument, driven not asserted', function () {

        function protocolChanges() {
            const ProtocolChanges = require(INDEXER_CHANGES)
            return new ProtocolChanges({
                config:    { NETWORK: 'regtest' },
                decoderDb: { getBlockTime: async () => T0 },
            })
        }

        it('really does reject the EMPTY ACTION name, which is what suppression rests on', async function () {
            if (!siblingOrSkip(this, INDEXER_CHANGES)) return
            const changes = protocolChanges()
            assert.strictEqual(await changes.isEnabled('', 1), false,
                "isEnabled('') must be false: one such sub-command invalidates the whole batch")
            assert.strictEqual(Object.prototype.hasOwnProperty.call(changes.changes, ''), false,
                'nothing may register the empty name; that is what makes the verdict provable')
            // The other half of the same claim: a real ACTION is enabled, so this is not a
            // registry that says no to everything.
            assert.strictEqual(await changes.isEnabled('COINPAY', 1), true)
            assert.strictEqual(await changes.isEnabled('DISPENSER', 1), true)
        })

        it('enables names this decoder does not know, which is why the gate stops at the empty one', async function () {
            if (!siblingOrSkip(this, INDEXER_CHANGES)) return
            const changes = protocolChanges()
            const known   = require('../../src/XChainDecoder').VALID_ACTION_NAMES
            const unknownButEnabled = []
            for (const name of Object.keys(changes.changes)) {
                if (!known.has(name) && await changes.isEnabled(name, 1))
                    unknownButEnabled.push(name)
            }
            // A gate keyed on VALID_ACTION_NAMES would suppress capture for every batch
            // carrying one of these, and the indexer dispatches those batches normally:
            // under-capture, the money-bearing direction. The measurement is the reason
            // hasProvablyRejectedSubCommand fires on the empty name ALONE.
            assert.ok(unknownButEnabled.length > 0,
                'if this ever reaches zero, a decoder-side name gate becomes buildable and ' +
                'the rest of this defect class can be closed; re-derive rather than delete')
            for (const name of ['DISPENSE', 'XCALL', 'UNIFIED_FEES'])
                assert.ok(unknownButEnabled.includes(name),
                    name + ' is enabled in the indexer and unknown here')
        })

        it('rejects an ALIAS name, so expansion must never run below BATCH_SUBACTION_NORMALIZATION', async function () {
            if (!siblingOrSkip(this, INDEXER_CHANGES)) return
            const changes = protocolChanges()
            for (const alias of Object.keys(ACTION_ALIASES))
                assert.strictEqual(await changes.isEnabled(alias, 1), false,
                    alias + ' is not registered, so below the normalization flag-day a batched ' +
                    alias + ' whole-batch-rejects instead of dispatching')
        })
    })
})
