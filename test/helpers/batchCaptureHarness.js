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

// Shared block-loop harness for the BATCH output-capture suites.
//
// It drives the REAL XChainDecoder block loop with a stubbed node and database, so a test can
// assert on the rows that actually reach insertTransactionOutput / insertDispenser rather
// than on the pure helper's return value. parseTransaction is modelled the way the production
// one splits outputs (an output paying an address in the OPEN-DISPENSER set is a dispense
// output), because the registry is only observable through that split.
//
// Extracted for batchWholeBatchRejection.test.js. batchSubCommandNameGate.test.js keeps its
// own equivalent copy deliberately: it is landed consensus evidence and rewiring it to a
// shared helper would change what that file proves without changing what it tests.

const XChainDecoder = require('../../src/XChainDecoder');

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
);

const T0     = 1700000000;
const SOURCE = 'bcrt1qbatchsource';
const SELLER = 'bcrt1qselleraddress';
const CHANGE = 'bcrt1qchangeaddress';
const ORACLE = 'bcrt1qoracleoperatoraaa';

// Mainnet at a block time below the DISARMED sub-command gate: the legacy top-level-only
// view a re-decode of pre-flag-day history must reproduce.
const BELOW_GATE = { network: 'bitcoin-mainnet', blockTime: T0 };
// regtest is genesis-on for the gate.
const ABOVE_GATE = { network: 'bitcoin-regtest', blockTime: T0 };

class DispenserModel {
    constructor() { this.rows = []; this.insertCalls = 0; }
    async insertDispenser({ txIndex, address, expiration, oracleAddress }) {
        this.insertCalls++;
        this.rows.push({ txIndex, address, expiration: Number(expiration),
                         oracleAddress: oracleAddress || null, expiredBlockIndex: null });
        return true;
    }
    async extendOpenDispenserExpirationBySource() { return true; }
    async deleteOpenDispensers() { return true; }
    async purgeExpiredDispensers() { return true; }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address));
    }
    _openFor(s) { return this.rows.filter(r => r.address === s && r.expiredBlockIndex === null); }
    async getOpenDispenserOracleAddressBySource(s) {
        const open = this._openFor(s).sort((a, b) => b.txIndex - a.txIndex);
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null;
    }
    async getOpenDispenserOracleAddressesBySource(s) {
        return [...new Set(this._openFor(s).map(r => r.oracleAddress).filter(a => !!a))];
    }
}

function fakeTx(id) { return { getId: () => id, outs: [] }; }

function buildDecoder(txSpecs, model, opts) {
    opts = opts || {};
    const decoder = new XChainDecoder(
        opts.network || ABOVE_GATE.network, 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p',
        false, opts.feeDestination === undefined ? null : opts.feeDestination
    );
    decoder.startBlockIndex = 0;
    decoder.sleep = async () => {};

    const transactions = txSpecs.map(s => fakeTx(s.id));
    const byId = {};
    for (const s of txSpecs) byId[s.id] = s;

    decoder.parseTransaction = async (tx, openDispenserAddresses) => {
        const spec = byId[tx.getId()];
        const buf = Buffer.from(spec.action || '');
        const dispenseOutputs = [];
        const paymentOutputs  = [];
        for (const output of (spec.outputs || [])) {
            const row = Object.assign({}, output);
            if (openDispenserAddresses && openDispenserAddresses.has(output.destinationAddress))
                dispenseOutputs.push(row);
            else
                paymentOutputs.push(row);
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
        };
    };

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash:      async () => 'aabbccdd',
        getBlock:          async () => '',
    };

    const captured = [];
    decoder.db = {
        createDatabase:  async () => true,
        verifyDatabase:  async () => true,
        verifyTables:    async () => true,
        runMigrations:   async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1,
        getLastTxIndex:  async () => 0,
        beginTransaction:  async () => {},
        endTransaction:    async () => {},
        commitTransaction: async () => { decoder.stopFlag = true; return true; },
        insertBlock:       async () => true,
        insertEvent:       async () => true,
        insertTransaction: async () => true,
        insertTransactionOutput: async (o) => { captured.push(o); return true; },
        POISON_ROW: 2,
        DUPLICATED_TRANSACTION: 1,
        insertDispenser:                     (d) => model.insertDispenser(d),
        extendOpenDispenserExpirationBySource: (s, e, b) => model.extendOpenDispenserExpirationBySource(s, e, b),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource:   (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) => model.getOpenDispenserOracleAddressesBySource(s),
    };

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE),
                               timestamp: opts.blockTime === undefined ? T0 : opts.blockTime,
                               transactions })
    };

    decoder.captured = captured;
    decoder.model = model;
    return decoder;
}

async function runAll(txSpecs, venue, extra) {
    const model = new DispenserModel();
    const decoder = buildDecoder(txSpecs, model, Object.assign({}, venue, extra || {}));
    await decoder.start();
    return decoder;
}

async function runOne(action, venue, extra) {
    return runAll([{ id: 'tx01', action, source: SOURCE, outputs: (extra || {}).outputs || [] }],
        venue, extra);
}

module.exports = {
    T0, SOURCE, SELLER, CHANGE, ORACLE,
    BELOW_GATE, ABOVE_GATE,
    DispenserModel, buildDecoder, runAll, runOne,
};
