// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const XChainDecoder = require('../../../../src/XChainDecoder')
const { isOracleFeeCaptureActive, isOracleFeeSetCaptureActive, oracleAddressFromCreate,
        isCompactedOracleAddress } = require('../../../../src/protocol/oracle_fee_output')
const { ORACLE_FEE_OUTPUT_ACTIVATION, ORACLE_FEE_SET_CAPTURE_ACTIVATION } =
    require('../../../../src/protocol/constants.js')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0        = 1700000000
const SOURCE    = 'bcrt1qdispenseroperator'
const ORACLE    = 'bcrt1qoracleoperator'
// A second and third oracle operator, for the multi-dispenser cases: one SOURCE holding
// several open Mode B dispensers whose oracles differ.
const ORACLE_A  = 'bcrt1qoracleoperatoraaa'
const ORACLE_B  = 'bcrt1qoracleoperatorbbb'
const FEE_DEST  = 'bcrt1qprotocolfeedest'
const OTHER     = 'bcrt1qsomeoneelse'

// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//   GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
const createWith = (oracleToken) =>
    `DISPENSER|0|BTC|TICK|1||10|BTC||0||USD||${oracleToken}|${T0 + 1000000}`
// DISPENSER|2|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
const REFILL = 'DISPENSER|2|7|100|||'

class DispenserModel {
    constructor() { this.rows = [] }
    async insertDispenser({ txIndex, address, expiration, oracleAddress }) {
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
    _openFor(sourceAddress) {
        return this.rows.filter(r => r.address === sourceAddress && r.expiredBlockIndex === null)
    }
    // Legacy single-pick (below ORACLE_FEE_SET_CAPTURE_ACTIVATION): most recent open row.
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const open = this._openFor(sourceAddress).sort((a, b) => b.txIndex - a.txIndex)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    // Set membership (at/above the gate): every open row's oracle, de-duplicated, unranked.
    async getOpenDispenserOracleAddressesBySource(sourceAddress) {
        return [...new Set(this._openFor(sourceAddress).map(r => r.oracleAddress).filter(a => !!a))]
    }
}

function fakeTx(id) { return { getId: () => id, outs: [] } }

function parseResultFor(dataStr, source, paymentOutputs) {
    const buf = Buffer.from(dataStr)
    return {
        data:               buf,
        source,
        destination:        null,
        amount:             0,
        dispenseOutputs:    [],
        paymentOutputs:     paymentOutputs || [],
        compiledDataLength: buf.length,
        rawData:            null,
    }
}

// txSpecs: [{ id, action, source, outputs: [{destinationAddress, vout, amount}] }]
function buildDecoder(txSpecs, model, opts) {
    opts = opts || {}
    const decoder = new XChainDecoder(
        opts.network || 'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p',
        false, opts.feeDestination === undefined ? FEE_DEST : opts.feeDestination
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = parseResultFor(s.action, s.source, s.outputs)
    decoder.parseTransaction = async (tx) => byId[tx.getId()]

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
        extendOpenDispenserExpirationBySource: (s, e) => model.extendOpenDispenserExpirationBySource(s, e),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        // opts.oracleLookup stands in for whichever accessor the flag-day routes to, so a
        // fault-injection case does not have to know which side of the gate it is on.
        getOpenDispenserOracleAddressBySource: (s) => (opts.oracleLookup || ((x) => model.getOpenDispenserOracleAddressBySource(x)))(s),
        getOpenDispenserOracleAddressesBySource: (s) => (opts.oracleLookup || ((x) => model.getOpenDispenserOracleAddressesBySource(x)))(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE), timestamp: opts.blockTime || T0, transactions })
    }

    decoder.captured = captured
    return decoder
}

module.exports = {
    DispenserModel,
    buildDecoder,
    T0,
    SOURCE,
    ORACLE,
    ORACLE_A,
    ORACLE_B,
    FEE_DEST,
    OTHER,
    createWith,
    REFILL,
    isOracleFeeCaptureActive,
    isOracleFeeSetCaptureActive,
    oracleAddressFromCreate,
    isCompactedOracleAddress,
    ORACLE_FEE_OUTPUT_ACTIVATION,
    ORACLE_FEE_SET_CAPTURE_ACTIVATION,
}
