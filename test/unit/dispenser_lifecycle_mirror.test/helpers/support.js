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
const { DISPENSER_EXPIRY_REALIGN_ACTIVATION } = require('../../../../src/protocol/dispenser_expiry_realign')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0 = 1700000000            // block timestamp used for the single processed block
// The indexer's cancel close-delay. Kept here as a local test value ONLY to express "a
// block time past where the indexer would have closed a cancelled dispenser"; the decoder
// no longer carries this constant (its twin and drift guard went with the cancel mirror).
const INDEXER_CLOSE_DELAY = 3600

// A faithful in-memory model of the decoder `dispensers` table. Each method mirrors
// the corresponding db.js query so the open-view we assert on is the same one the
// real SQL would produce.
class DispenserModel {
    constructor() {
        this.rows  = []
        this.calls = { insert: [], extend: [] }
        this.stampsCleared = 0
    }
    async insertDispenser({ txIndex, address, sourceAddress, expiration, oracleAddress }) {
        this.calls.insert.push({ txIndex, address, sourceAddress, expiration: Number(expiration) })
        this.rows.push({ txIndex, address, expiration: Number(expiration), expiredBlockIndex: null,
                         oracleAddress: oracleAddress || null,
                         // Mirrors db.js: the create SOURCE is stored only when it differs
                         // from the operating address (NULL means "same as address").
                         sourceAddress: (sourceAddress && sourceAddress !== address) ? sourceAddress : null })
        return true
    }
    // Mirrors getOpenDispenserOracleAddressBySource's target resolution: open rows this
    // address may act on (operating address OR stored create SOURCE), operating-address
    // matches ranked first, then most recent. Only the oracle-address read uses that
    // ranking; the extend path deliberately takes the whole set (no ORDER BY, no LIMIT),
    // because ranking is the guess that closed wrong rows. `thisBlock` widens the
    // candidate set by exactly the rows THIS block's soft-expire stamped, matching the
    // extend UPDATE's
    // `(expired_block_index IS NULL OR expired_block_index = ?)`. Omitted by the readers,
    // which see only genuinely-open rows.
    _openFor(actingAddress, thisBlock) {
        return this.rows
            .filter(r => (r.expiredBlockIndex === null ||
                          (thisBlock !== undefined && r.expiredBlockIndex === thisBlock)) &&
                         (r.address === actingAddress || r.sourceAddress === actingAddress))
            .sort((a, b) => {
                const aKeyed = (a.address === actingAddress) ? 1 : 0
                const bKeyed = (b.address === actingAddress) ? 1 : 0
                if (aKeyed !== bKeyed) return bKeyed - aKeyed
                return b.txIndex - a.txIndex
            })
    }
    // Mirrors getOpenDispenserOracleAddressBySource: same target resolution as
    // cancel/edit.
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const open = this._openFor(sourceAddress)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    // Mirrors getOpenDispenserOracleAddressesBySource: the same target resolution with the
    // ranking dropped, de-duplicated, as the set the block loop tests membership against
    // at/above ORACLE_FEE_SET_CAPTURE_ACTIVATION.
    async getOpenDispenserOracleAddressesBySource(sourceAddress) {
        return [...new Set(this._openFor(sourceAddress)
            .map(r => r.oracleAddress)
            .filter(a => !!a))]
    }
    // Mirrors extendOpenDispenserExpirationBySource:
    //   UPDATE ... SET expiration = GREATEST(expiration, ?) ... (no ORDER BY, no LIMIT)
    // over EVERY open row the acting address may act on. Never shortens, never picks.
    // The candidate set also admits a row THIS block soft-expired, and clears that
    // stamp, because below DISPENSER_EXPIRY_REALIGN_ACTIVATION deleteOpenDispensers ran
    // before the transaction loop. `stampsCleared` counts the rows that clear actually
    // rescued, so a test asserting the rescue cannot pass vacuously in an era where the
    // block-start soft-expire never stamped anything to begin with.
    async extendOpenDispenserExpirationBySource(sourceAddress, newExpiration, blockIndex) {
        this.calls.extend.push({ sourceAddress, newExpiration: Number(newExpiration), blockIndex })
        for (const r of this._openFor(sourceAddress, blockIndex)) {
            r.expiration = Math.max(Number(r.expiration), Number(newExpiration))
            if (r.expiredBlockIndex === blockIndex) { r.expiredBlockIndex = null; this.stampsCleared++ }
        }
        return true
    }
    // Mirrors deleteOpenDispensers: soft-expire open rows whose expiration < minExpiration.
    async deleteOpenDispensers(blockIndex, minExpiration) {
        for (const r of this.rows)
            if (r.expiredBlockIndex === null && r.expiration < Number(minExpiration))
                r.expiredBlockIndex = blockIndex
        return true
    }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
}

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}

// A synthetic parseTransaction result carrying a decoded ACTION string + source.
function parseResultFor(dataStr, source) {
    const buf = Buffer.from(dataStr)
    return {
        data:               buf,
        source,
        destination:        null,
        amount:             0,
        dispenseOutputs:    [],
        paymentOutputs:     [],
        compiledDataLength: buf.length,
        rawData:            null,
    }
}

// Build a decoder wired to process exactly one block (height 0) whose transactions are
// `txSpecs` (each { id, action, source }). parseTransaction is stubbed to return the
// crafted parseResult per txid, so the test exercises the block loop's DISPENSER
// lifecycle decisions rather than the (separately tested) decode path.
function buildDecoder(txSpecs, model) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = parseResultFor(s.action, s.source)
    decoder.parseTransaction = async (tx) => byId[tx.getId()]

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash:      async () => 'aabbccdd',
        getBlock:          async () => '',
    }

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
        insertTransaction: async () => true,      // truthy, non-POISON, non-false -> success branch
        insertTransactionOutput: async () => true,
        POISON_ROW: 2,
        DUPLICATED_TRANSACTION: 1,
        // Dispenser lifecycle surface -> the in-memory model.
        insertDispenser:                     (d) => model.insertDispenser(d),
        extendOpenDispenserExpirationBySource: (s, e, b) => model.extendOpenDispenserExpirationBySource(s, e, b),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource: (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) => model.getOpenDispenserOracleAddressesBySource(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE), timestamp: T0, transactions })
    }

    return decoder
}

const ADDR = 'bcrt1qtestsource'
// A v0 create at ADDR (GET_ADDRESS empty -> operates on SOURCE) with a far-future expiry.
// Fields: DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|
//         GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
const CREATE = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${T0 + 1000000}`
// Delegated-dispenser pair: CREATOR signs the create, DELEGATE is the GET_ADDRESS the
// dispenser then operates on.
const CREATOR  = 'bcrt1qtestcreator'
const DELEGATE = 'bcrt1qtestdelegate'

module.exports = {
    DispenserModel,
    buildDecoder,
    T0,
    INDEXER_CLOSE_DELAY,
    ADDR,
    CREATE,
    CREATOR,
    DELEGATE,
    DISPENSER_EXPIRY_REALIGN_ACTIVATION,
}
