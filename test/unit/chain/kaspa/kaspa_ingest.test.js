/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * kaspa_ingest: the projection, asserted where Stryker can see it.
 *
 * A Stryker run over ingest() scored 15.69% (8 killed / 43 survived) and every
 * survivor sat on the dispenser conditions — `if (dispenser && source)` could
 * become `if (true)` or `||` and nothing noticed, because the only dispenser
 * assertions lived outside this repository. The cases below are the ones that
 * distinguish those branches.
 **********************************************************************/
'use strict';
const assert = require('assert');

const { ingest, rollback, IngestState, chainTimeToSeconds } = require('../../../../src/chain/kaspa/kaspa_ingest.js');

const SRC = 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7';
const DST = 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7';
const B = (hash, prev, ts, txs) => ({ hash, previousBlockHash: prev, timestamp: ts, acceptedTransactions: txs });
const T = (id, carrier, { source = SRC, withInput = true } = {}) => ({
    verboseData: { transactionId: id },
    payload: carrier == null ? '' : Buffer.from(carrier, 'utf8').toString('hex'),
    inputs: withInput ? [{ previousOutpoint: { transactionId: 'aa'.repeat(32), index: 0 }, verboseData: { scriptPublicKeyAddress: source } }] : [],
    outputs: [{ amount: '5', verboseData: { scriptPublicKeyAddress: DST } }],
});

describe('kaspa_ingest: dispenser bookkeeping (the surviving-mutant branches)', function () {

    it('registers an open dispenser only when there is BOTH a dispenser action and a source', function () {
        const withSource = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'DISPENSER|0|DOGE||1000')])]).rows;
        assert.strictEqual(withSource.dispensers.length, 1, 'a funded dispenser open is registered');
        assert.strictEqual(withSource.dispensers[0].expiration, null, 'expiration stays NULL (never guessed)');
        assert.strictEqual(withSource.dispensers[0].expired_block_index, null, 'and it is open');

        // Same carrier, but no input at all: `dispenser && source` must be false here, which is
        // exactly what the `if (true)` and `||` mutants get wrong.
        const noSource = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'DISPENSER|0|DOGE||1000', { withInput: false })])]).rows;
        assert.strictEqual(noSource.dispensers.length, 0, 'a dispenser with no source must not be registered');
    });

    it('stamps the closing block on DISPENSER_CLOSE and leaves other actions alone', function () {
        const state = new IngestState();
        ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'DISPENSER|0|DOGE||1000')])], { state });
        const closed = ingest([B('b2'.repeat(32), 'b1'.repeat(32), 1001, [T('t2'.repeat(32), 'DISPENSER_CLOSE|0')])], { state }).rows;
        assert.strictEqual(closed.dispensers.length, 1);
        assert.strictEqual(closed.dispensers[0].expired_block_index, 2, 'closed at the block that carried the close');
        assert.strictEqual(state.openDispensers.size, 0, 'and the open map is emptied');

        const alsoState = new IngestState();
        const unrelated = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000,
            [T('t1'.repeat(32), 'DISPENSER|0|DOGE||1000'), T('t2'.repeat(32), 'ORDER|0|DOGE||1')])], { state: alsoState }).rows;
        assert.strictEqual(unrelated.dispensers.length, 1, 'ORDER must not touch the dispenser table');
        assert.strictEqual(alsoState.openDispensers.size, 1, 'and must not close anything');
    });
});

describe('kaspa_ingest: the projection invariants', function () {

    it('writes destination_id as the empty placeholder and keeps real addresses in outputs', function () {
        const rows = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'ORDER|0|DOGE||1')])]).rows;
        assert.strictEqual(rows.transactions[0].destination_id, 1);
        assert.strictEqual(rows.transaction_outputs.length, 1);
        const dest = rows.index_addresses.find((a) => a.id === rows.transaction_outputs[0].destination_id);
        assert.strictEqual(dest.address, DST);
    });

    it('is deterministic: the same slice twice is byte-identical, and split == whole', function () {
        const blocks = [
            B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'ORDER|0|DOGE||1')]),
            B('b2'.repeat(32), 'b1'.repeat(32), 1001, [T('t2'.repeat(32), 'SEND|0|DOGE||2')]),
        ];
        assert.deepStrictEqual(ingest(blocks).rows, ingest(blocks).rows, 'same input, same rows');
        const state = new IngestState();
        ingest([blocks[0]], { state });
        const split = ingest([blocks[1]], { state }).rows;
        assert.deepStrictEqual(split, ingest(blocks).rows, 'two appends == one append');
    });

    it('rolls back for real and rewinds the cursors', function () {
        const state = new IngestState();
        ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'ORDER|0|DOGE||1')])], { state });
        ingest([B('b2'.repeat(32), 'b1'.repeat(32), 1001, [T('t2'.repeat(32), 'SEND|0|DOGE||2')])], { state });
        rollback(state, ['b2'.repeat(32)]);
        const rows = state.rows();
        assert.strictEqual(rows.blocks.length, 1);
        assert.strictEqual(rows.transactions.length, 1);
        assert.strictEqual(rows.transaction_outputs.length, 1, 'child rows go with their parent');
        assert.strictEqual(state.nextBlockIndex, 2, 'the block cursor is rewound');
        assert.strictEqual(state.nextTxIndex, 2, 'and so is the tx cursor');
    });

    it('normalises chain time to the platform unit (seconds)', function () {
        assert.strictEqual(chainTimeToSeconds(1791716119613), 1791716119);
        assert.strictEqual(chainTimeToSeconds(1791716119), 1791716119);
        assert.strictEqual(chainTimeToSeconds(null), null);
    });
});

describe('kaspa_ingest: the platform storage gate (found on real data)', function () {
    // Surfaced only by the real-database run: a coinbase payload is BINARY, and it was landing
    // in `data`, where the indexer would have logged PARSE_ERROR on every block. The platform
    // rule is the storage gate: an unrecognised action is blanked, the row is still written,
    // and the bytes survive in raw_data.
    const coinbaseBytes = '0000000000000000' + Buffer.from('kaspa-simnet', 'utf8').toString('hex');
    const cbTx = {
        verboseData: { transactionId: 'cb'.repeat(32) },
        payload: coinbaseBytes,
        inputs: [{ previousOutpoint: null, verboseData: {} }],
        outputs: [{ amount: '5', verboseData: { scriptPublicKeyAddress: DST } }],
    };

    it('blanks a binary coinbase payload, writes the row anyway, keeps raw_data', function () {
        const rows = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [cbTx])]).rows;
        assert.strictEqual(rows.transactions.length, 1, 'the row is still written');
        assert.strictEqual(rows.transactions[0].data, null, 'binary never reaches data');
        assert.ok(rows.transactions[0].raw_data && rows.transactions[0].raw_data.length > 0, 'but raw_data keeps the bytes');
    });

    it('blanks an unknown-but-ASCII name and keeps a known ACTION', function () {
        const rows = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [
            T('t1'.repeat(32), 'MADEUP|0|X'), T('t2'.repeat(32), 'ORDER|0|DOGE||1'),
        ])]).rows;
        assert.strictEqual(rows.transactions[0].data, null, 'unknown name is blanked, as on the other chains');
        assert.strictEqual(rows.transactions[1].data, 'ORDER|0|DOGE||1', 'a known ACTION is stored');
    });

    it('still expands an alias before the gate (4.1 + gate together)', function () {
        const rows = ingest([B('b1'.repeat(32), 'b0'.repeat(32), 1000, [T('t1'.repeat(32), 'TRANSFER|0|X')])]).rows;
        assert.strictEqual(rows.transactions[0].data, 'SEND|0|X', 'the alias expands to a KNOWN name, so the gate keeps it');
    });
});
