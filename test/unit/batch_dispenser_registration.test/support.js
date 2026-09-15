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
const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        collapseDispenserRegistrations } = require('../../../src/protocol/batch_sub_command_capture.js')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0         = 1700000000
const SOURCE     = 'bcrt1qdispenseroperator'
const DELEGATE_A = 'bcrt1qdelegatedaaa'
const DELEGATE_B = 'bcrt1qdelegatedbbb'
const ORACLE_A   = 'bcrt1qoracleoperatoraaa'
const ORACLE_B   = 'bcrt1qoracleoperatorbbb'
const BUYER      = 'bcrt1qbuyeraddress'
const SELLER     = 'bcrt1qselleraddress'
const FEE_DEST   = 'bcrt1qprotocolfeedest'
const CHANGE     = 'bcrt1qchangeaddress'

const EXP_EARLY = T0 + 100000
const EXP_LATE  = T0 + 900000

// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//   GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
// Split indices are offset by one from the indexer's field list because the decoder splits
// the ACTION token too; see hasRequiredDispenserCreateFields.
function create(opts) {
    const o = opts || {}
    return ['DISPENSER', '0',
            o.giveCoin === undefined ? 'BTC' : o.giveCoin, 'TICK', '1', '', '10',
            o.getCoin === undefined ? 'BTC' : o.getCoin, '', '0',
            o.getAddress || '', 'USD', '',
            o.oracle || '',
            o.expiration === undefined ? String(EXP_LATE) : String(o.expiration)].join('|')
}

// The 10-token shape the wallet emits when the seller keeps the default expiry: every
// optional field from GET_ADDRESS on is omitted rather than padded.
const CREATE_NO_TAIL = 'DISPENSER|0|BTC|TICK|1||10|BTC||0'
// DISPENSER|1|DISPENSER_ACTION_INDEX|MEMO
const CANCEL = 'DISPENSER|1|7|'
// DISPENSER|2|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
const refill = (expiration) => `DISPENSER|2|7|100|${expiration}|||`

// Mainnet at a block time below its sub-command gate instant: the legacy top-level-only view
// a re-decode of pre-flag-day history must reproduce.
const BELOW_GATE = { network: 'bitcoin-mainnet', blockTime: T0 }
// regtest is genesis-on for the gate.
const ABOVE_GATE = { network: 'bitcoin-regtest', blockTime: T0 }

class DispenserModel {
    constructor() { this.rows = []; this.insertCalls = 0; this.extendCalls = [] }

    // PRIMARY KEY(tx_index, address_id) (src/sql/dispensers.sql). A colliding INSERT raises
    // errno 1062, which db.insertDispenser reports as DUPLICATED_TRANSACTION (=1), a TRUTHY
    // value the block loop reads as "stored" - so a collapse failure here is silent in
    // production and must not be silent in this harness.
    async insertDispenser({ txIndex, address, expiration, oracleAddress, sourceAddress }) {
        this.insertCalls++
        if (this.rows.some(r => r.txIndex === txIndex && r.address === address))
            return 1
        this.rows.push({ txIndex, address, expiration: Number(expiration),
                         oracleAddress: oracleAddress || null,
                         sourceAddress: (sourceAddress && sourceAddress !== address) ? sourceAddress : null,
                         expiredBlockIndex: null })
        return true
    }

    // GREATEST(expiration, ?) over every open row of the source, matched on the operating
    // address OR the stored create SOURCE; extend-only, no target selection.
    async extendOpenDispenserExpirationBySource(sourceAddress, newExpiration, blockIndex) {
        this.extendCalls.push({ sourceAddress, newExpiration: Number(newExpiration) })
        for (const row of this.rows) {
            if (row.address !== sourceAddress && row.sourceAddress !== sourceAddress) continue
            if (row.expiredBlockIndex !== null && row.expiredBlockIndex !== blockIndex) continue
            row.expiration = Math.max(row.expiration, Number(newExpiration))
            if (row.expiredBlockIndex === blockIndex) row.expiredBlockIndex = null
        }
        return true
    }

    async deleteOpenDispensers() { return true }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
    _openFor(sourceAddress) {
        return this.rows.filter(r => (r.address === sourceAddress || r.sourceAddress === sourceAddress) &&
                                     r.expiredBlockIndex === null)
    }
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const open = this._openFor(sourceAddress).sort((a, b) => b.txIndex - a.txIndex)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    async getOpenDispenserOracleAddressesBySource(sourceAddress) {
        return [...new Set(this._openFor(sourceAddress).map(r => r.oracleAddress).filter(a => !!a))]
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
            data: buf, source: spec.source, destination: null, amount: 0,
            dispenseOutputs, paymentOutputs, compiledDataLength: buf.length, rawData: null,
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
        insertDispenser: (d) => model.insertDispenser(d),
        extendOpenDispenserExpirationBySource: (s, e, b) =>
            model.extendOpenDispenserExpirationBySource(s, e, b),
        deleteOpenDispensers: (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers: (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses: () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource: (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) =>
            model.getOpenDispenserOracleAddressesBySource(s),
    }
}

// txSpecs: [{ id, action, source, outputs: [{destinationAddress, vout, amount}] }]
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

    // Mirrors the real parseTransaction's output split (XChainDecoder.js ~1344): an output
    // paying an address in the OPEN-DISPENSER set is a dispense output, every other
    // resolvable output a payment output. That set is exactly what registration feeds, so
    // the split has to be modelled for any of these assertions to mean anything.
    decoder.parseTransaction = transactionParser(byId)
    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash: async () => 'aabbccdd',
        getBlock: async () => '',
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

// One transaction, run through the block loop.
async function runOne(action, venue, extra) {
    return runAll([{ id: 'tx01', action, source: SOURCE, outputs: [] }], venue, extra)
}

async function runAll(txSpecs, venue, extra) {
    const model = new DispenserModel()
    const decoder = buildDecoder(txSpecs, model, Object.assign({}, venue, extra || {}))
    await decoder.start()
    return decoder
}

const rowFor = (model, address) => model.rows.find(r => r.address === address)
const addressesOf = (rows) => rows.map(r => r.address).sort()

module.exports = {
    ABOVE_GATE,
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
    BELOW_GATE,
    BUYER,
    CANCEL,
    CHANGE,
    CREATE_NO_TAIL,
    DELEGATE_A,
    DELEGATE_B,
    EXP_EARLY,
    EXP_LATE,
    FEE_DEST,
    ORACLE_A,
    ORACLE_B,
    SELLER,
    SOURCE,
    T0,
    DispenserModel,
    addressesOf,
    assert,
    buildDecoder,
    collapseDispenserRegistrations,
    create,
    refill,
    rowFor,
    runAll,
    runOne,
}
