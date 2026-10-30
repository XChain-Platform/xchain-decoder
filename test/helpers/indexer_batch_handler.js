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

// Drive the sibling xchain-indexer's real Batch handler for the BATCH limit conformance tier.

const fs   = require('fs');
const path = require('path');
const ACTION_ALIASES = require('../../src/protocol/action_aliases.js');
const sync = require('../../bin/sync-batch-limits.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
const T0 = 1700000000;
function siblingOrSkip(ctx, file) {
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}
// A real xchain-indexer Batch handler, wired to the REAL Utility and the REAL ProtocolChanges
// registry, with only the database and the dispatch stubbed out.
//
// What is stubbed and why it does not weaken the comparison:
//   * isActionAllowed -> true. Address-sleep state is one of the causes deliberately NOT
//     mirrored, so holding it off keeps the comparison about the causes that ARE.
//   * detectFeePaymentMode -> 'native'. The aggregate gas pre-check is likewise not mirrored;
//     the native path is its documented first exit.
//   * getTickerId -> one id per DISTINCT tick STRING. That is the boundary case for the MINT
//     mirror: it makes the real handler's per-distinct-token count equal the mirror's
//     per-identical-string count, so the two must agree exactly. The OPPOSITE case (two
//     spellings of one token) is driven separately below, where the mirror is expected to
//     stay silent and the handler to reject.
function realBatch(opts) {
    opts = opts || {};
    const Batch           = require(sync.INDEXER_BATCH);
    // From the checkout root, not from the handler path: the handler is one directory deeper
    // once the indexer splits it into src/actions/batch/, and walking up from it lands in
    // src/actions/ instead of src/.
    const Utility         = require(path.join(sync.INDEXER_ROOT, 'src', 'utility.js'));
    const ProtocolChanges = require(sync.INDEXER_CHANGES);
    const util = new Utility({ config: {}, indexerDb: {}, decoderDb: {}, util: {} });
    util.addAddressTicker      = () => {};
    util.detectFeePaymentMode  = () => 'native';
    // Network and block time are overridable so the weight-budget cases can drive the SAME
    // handler where BATCH_COST_WEIGHTING is armed and where it is not.
    const blockTime = (opts.blockTime === undefined) ? T0 : opts.blockTime;
    const changes = new ProtocolChanges({
        config:    { NETWORK: opts.network || 'regtest' },
        util:      util,
        decoderDb: { getBlockTime: async () => blockTime },
    });
    const ids = opts.tickIds || new Map();
    let nextId = 1000;
    const indexerDb = {
        suppressIndexIdCreation: false,
        async createBatch() {},
        async isActionAllowed() { return true; },
        async getTokenInfo() { return null; },
        async getTickerId(tick) {
            if (!ids.has(tick)) ids.set(tick, nextId++);
            return ids.get(tick);
        },
        async getAddressBalances() { return []; },
        async createActionIndex() { return 1; },
    };
    return new Batch({
        // The handler's own NETWORK is unset unless a case asks for it, so the height gates
        // it reads through gateRegistry stay inactive for every case that does not.
        config:          Object.assign({ GAS: 'XCHAIN' }, opts.handlerConfig),
        decoderDb:       {},
        indexerDb:       indexerDb,
        util:            util,
        mapper:          { async createMappings() {} },
        protocolChanges: changes,
        actionAliases:   Object.assign({}, ACTION_ALIASES),
        async processAction() {},
    });
}
// The real handler's verdict for one wire payload. Returns the STATUS string.
async function indexerStatus(wire, opts) {
    const batch = realBatch(opts);
    const data = {
        TX_DATA:     wire,
        FORMAT:      0,
        BLOCK_INDEX: 10,
        ACTION_INDEX: 5,
        SOURCE:      'bcrt1qbatchsource',
        IS_GENESIS:  false,
        IS_EMISSION: false,
        TX_OUTPUTS:  [],
    };
    const log = console.log;
    console.log = () => {};
    try {
        await batch.parse(String(wire).split('|').slice(1), data, false);
    } finally {
        console.log = log;
    }
    return data['STATUS'];
}

module.exports = { T0, siblingOrSkip, realBatch, indexerStatus };
