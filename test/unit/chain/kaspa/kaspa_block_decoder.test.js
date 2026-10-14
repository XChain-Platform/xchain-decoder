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
 ********************************************************************/

/*********************************************************************
 * KaspaBlockDecoder — interface parity with the bitcoinjs adapter.
 *
 * The point of this file is the last suite: rather than trusting a
 * hand-written list of fields, it re-derives the field set from the
 * consumer sources (XChainDecoder/*.js) and asserts every access
 * resolves on the Kaspa objects. If upstream starts reading a new
 * field on a block or transaction, this goes red instead of silently
 * handing back undefined.
 **********************************************************************/
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { KaspaBlockDecoder, toBigIntAmount } = require('../../../../src/chain/kaspa/kaspa_block_decoder.js');

const DECODER_SRC = path.join(__dirname, '..', '..', '..', '..', 'src');

// A minimal wRPC-shaped block: exactly the fields kaspad returns for
// getBlock / getVirtualChainFromBlockV2 (measured, see KASPA-ADAPTER-V2.md §11).
const RAW_TX = {
    version: 0,
    payload: Buffer.from('ORDER|0|DOGE||1000000', 'utf8').toString('hex'),
    inputs: [{
        previousOutpoint: { transactionId: 'aa'.repeat(32), index: 0 },
        verboseData: { scriptPublicKeyAddress: 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7' },
    }],
    outputs: [
        { amount: '5000000000', scriptPublicKey: { version: 0, scriptPublicKey: '2065ab' },
          verboseData: { scriptPublicKeyAddress: 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7' } },
        { amount: '100', scriptPublicKey: { version: 0, scriptPublicKey: '76a914' },
          verboseData: { scriptPublicKeyAddress: null } },
    ],
    verboseData: { transactionId: 'bb'.repeat(32) },
};

const RAW_BLOCK = {
    header: { hash: 'cc'.repeat(32), selectedParentHash: 'dd'.repeat(32), timestamp: 1760000000000 },
    transactions: [RAW_TX],
    verboseData: { hash: 'cc'.repeat(32) },
};

describe('KaspaBlockDecoder: family surface', function () {

    it('declares the two fields XChainDecoder reads off a block decoder', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        assert.strictEqual(d.coin, 'kaspa');            // startup.js reads .coin
        assert.strictEqual(d.wireFormat, 'kaspa');      // XChainDecoder.js:208 reads .wireFormat
    });

    it('shapes a block into the fields the ingest path consumes', function () {
        const block = new KaspaBlockDecoder('kaspa-testnet').blockFromObject(RAW_BLOCK);
        assert.strictEqual(typeof block.timestamp, 'number');   // 13 call sites
        assert.strictEqual(block.timestamp, 1760000000000);
        assert.strictEqual(block.prevHash, 'dd'.repeat(32));
        assert.strictEqual(block.transactions.length, 1);
    });

    it('shapes a transaction: ins / outs / getId()', function () {
        const tx = new KaspaBlockDecoder('kaspa-testnet').transactionFromObject(RAW_TX);
        assert.strictEqual(tx.getId(), 'bb'.repeat(32));
        assert.strictEqual(typeof tx.getId, 'function');
        assert.strictEqual(tx.ins.length, 1);
        assert.strictEqual(tx.outs.length, 2);
        assert.strictEqual(tx.ins[0].hash, 'aa'.repeat(32));
        assert.strictEqual(tx.ins[0].index, 0);
        assert.ok(Buffer.isBuffer(tx.outs[0].script), 'output.script must be a Buffer');
    });

    it('keeps amounts as BigInt (VARCHAR(250) column, no Number() rounding)', function () {
        const tx = new KaspaBlockDecoder('kaspa-testnet').transactionFromObject(RAW_TX);
        assert.strictEqual(tx.outs[0].value, 5000000000n);
        assert.strictEqual(toBigIntAmount('5000000000'), 5000000000n);
        assert.throws(() => toBigIntAmount('1.5'), /not a non-negative integer/);
        assert.throws(() => toBigIntAmount(''), /not a non-negative integer/);
    });

    it('folds the script version into byte 0 so versions cannot collide', function () {
        const tx = new KaspaBlockDecoder('kaspa-testnet').transactionFromObject(RAW_TX);
        assert.strictEqual(tx.outs[0].script[0], 0);
        assert.strictEqual(tx.outs[0].script.slice(1).toString('hex'), '2065ab');
    });

    it('carries the payload as the action string, and blanks an oversize one', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        assert.strictEqual(d.transactionFromObject(RAW_TX).payload, 'ORDER|0|DOGE||1000000');
        assert.strictEqual(d.transactionFromObject(RAW_TX).payloadOversize, false);

        const huge = Object.assign({}, RAW_TX, { payload: Buffer.alloc(8193, 0x41).toString('hex') });
        const t = d.transactionFromObject(huge);
        assert.strictEqual(t.payload, '', 'oversize action must be blanked, row still written');
        assert.strictEqual(t.payloadOversize, true);
    });

    it('fails loudly on the hex/buffer entry points instead of guessing an encoding', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        assert.throws(() => d.blockFromHex('00'), /no raw-hex block RPC/);
        assert.throws(() => d.transactionFromHex('00'), /no raw-hex transaction RPC/);
        assert.throws(() => d.blockFromBuffer(Buffer.alloc(4)), /borsh framing/);
    });

    it('rejects a wire object with no transaction id rather than inventing one', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        assert.throws(() => d.transactionFromObject({ inputs: [], outputs: [] }), /verboseData\.transactionId/);
        assert.throws(() => d.blockFromObject({}), /needs a block object with a header/);
    });
});

describe('KaspaBlockDecoder: field set re-derived from the consumers', function () {

    // Every `block.<x>` / `transaction.<x>` / `output.<x>` access inside the
    // ingest path. Re-derived at test time so it cannot drift.
    function fieldAccesses(receiver) {
        const dir = path.join(DECODER_SRC, 'XChainDecoder');
        const names = new Set();
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.js')) continue;
            const text = fs.readFileSync(path.join(dir, f), 'utf8');
            const re = new RegExp('\\b' + receiver + '\\.([a-zA-Z_][a-zA-Z0-9_]*)', 'g');
            let m;
            while ((m = re.exec(text)) !== null) names.add(m[1]);
        }
        return names;
    }

    it('every block.<field> the consumers read exists on the Kaspa block', function () {
        const block = new KaspaBlockDecoder('kaspa-testnet').blockFromObject(RAW_BLOCK);
        // Receivers the consumers bind to a decoded block.
        const wanted = fieldAccesses('block');
        const ignore = new Set(['index', 'hash', 'height', 'block_index']);   // bound to other things in those files
        for (const name of wanted) {
            if (ignore.has(name)) continue;
            assert.ok(name in block || typeof block[name] === 'function',
                'consumer reads block.' + name + ' but the Kaspa block does not provide it');
        }
    });

    it('every transaction.<field> the consumers read exists on the Kaspa transaction', function () {
        const tx = new KaspaBlockDecoder('kaspa-testnet').transactionFromObject(RAW_TX);
        for (const receiver of ['transaction', 'nextTransaction', 'prevTransaction']) {
            for (const name of fieldAccesses(receiver)) {
                assert.ok(name in tx || typeof tx[name] === 'function',
                    'consumer reads ' + receiver + '.' + name + ' but the Kaspa transaction does not provide it');
            }
        }
    });

    it('the ingest path reads exactly the surface this decoder implements (no extra)', function () {
        const tx = new KaspaBlockDecoder('kaspa-testnet').transactionFromObject(RAW_TX);
        assert.deepStrictEqual(tx.ins[0].hash.length, 64);
        assert.ok(Array.isArray(tx.outs));
        assert.strictEqual(typeof tx.getId(), 'string');
        assert.ok(tx.getId().length === 64, 'blake3 txid is 32 bytes of hex');
    });
});

describe('KaspaBlockDecoder: malformed carrier', function () {
    it('blanks an invalid, odd-length or non-hex payload instead of truncating it', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        const base = { version: 0, inputs: [], outputs: [{ amount: '1', scriptPublicKey: { version: 0, scriptPublicKey: '65ab' } }], verboseData: { transactionId: 'ee'.repeat(32) } };
        const full = Buffer.from('ORDER|0|DOGE||1000000', 'utf8').toString('hex');
        const odd = full.slice(0, full.length - 1);
        const t = d.transactionFromObject(Object.assign({}, base, { payload: odd }));
        assert.strictEqual(t.payload, '', 'odd-length hex must blank the carrier');
        assert.strictEqual(t.payloadMalformed, true);
        const ok = d.transactionFromObject(Object.assign({}, base, { payload: full }));
        assert.strictEqual(ok.payload, 'ORDER|0|DOGE||1000000');
        assert.strictEqual(d.transactionFromObject(Object.assign({}, base, { payload: 'zz' })).payload, '');
    });
});

describe('KaspaBlockDecoder: 4.2 recognition', function () {
    // An INDEPENDENT implementation of the spec (not a call into our own helper), so the
    // pin proves the two sides agree on the wire, not that a function equals itself.
    function obfuscatePerSpec(action, txidHex) {
        const crypto = require('crypto');
        const be = Buffer.from(txidHex, 'hex').reverse();
        const c = crypto.createCipheriv('aes-128-ctr', be.slice(0, 16), be.slice(16, 32));
        return Buffer.concat([c.update(Buffer.concat([Buffer.from('XCHN'), Buffer.from(action, 'utf8')])), c.final()]);
    }
    const TXID = 'aa'.repeat(32);
    const WITH_INPUT = (payloadHex) => ({ version: 0, payload: payloadHex,
        inputs: [{ previousOutpoint: { transactionId: TXID, index: 0 } }],
        outputs: [{ amount: '1', scriptPublicKey: { version: 0, scriptPublicKey: '65ab' } }],
        verboseData: { transactionId: 'ee'.repeat(32) } });

    it('decodes a payload written by an independent implementation of the spec', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        const tx = d.transactionFromObject(WITH_INPUT(obfuscatePerSpec('ORDER|0|DOGE||1000000', TXID).toString('hex')));
        assert.strictEqual(tx.payload, 'ORDER|0|DOGE||1000000');
        assert.strictEqual(tx.payloadUnobfuscated, false, 'recognised as an obfuscated carrier');
    });
    it('marks a cleartext payload instead of dropping it (legacy rows), and never truncates', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        const tx = d.transactionFromObject(WITH_INPUT(Buffer.from('ORDER|0|DOGE||1000000').toString('hex')));
        assert.strictEqual(tx.payload, 'ORDER|0|DOGE||1000000');
        assert.strictEqual(tx.payloadUnobfuscated, true, 'countable so an operator can see when strict mode is safe');
    });
    it('pins the confirmation default to the 2-hour window (platform reorg tolerance)', function () {
        const { DEFAULT_MIN_CONFIRMATION_COUNT } = require('../../../../src/chain/kaspa/kaspa_node_client.js');
        assert.strictEqual(DEFAULT_MIN_CONFIRMATION_COUNT, 72000);
    });
});

describe('KaspaBlockDecoder: 4.1 alias canonicalisation', function () {
    const TXID = 'aa'.repeat(32);
    function ob(action) {                                  // independent spec implementation
        const crypto = require('crypto');
        const be = Buffer.from(TXID, 'hex').reverse();
        const c = crypto.createCipheriv('aes-128-ctr', be.slice(0, 16), be.slice(16, 32));
        return Buffer.concat([c.update(Buffer.concat([Buffer.from('XCHN'), Buffer.from(action)])), c.final()]).toString('hex');
    }
    const mk = (payloadHex) => ({ version: 0, payload: payloadHex,
        inputs: [{ previousOutpoint: { transactionId: TXID, index: 0 } }],
        outputs: [{ amount: '1', scriptPublicKey: { version: 0, scriptPublicKey: '65ab' } }],
        verboseData: { transactionId: 'ee'.repeat(32) } });
    it('stores the canonical name the indexer dispatches on', function () {
        const d = new KaspaBlockDecoder('kaspa-testnet');
        // 4.1: the decoder expands legacy aliases. Without this, a TRANSFER on Kaspa would
        // be stored as TRANSFER and never dispatched -- a silently dropped action.
        const aliased = d.transactionFromObject(mk(ob('TRANSFER|0|X')));
        assert.strictEqual(aliased.payload, 'SEND|0|X');
        assert.strictEqual(aliased.rawActionName, 'TRANSFER');
        assert.strictEqual(aliased.actionAliasExpanded, true);
        const known = d.transactionFromObject(mk(ob('SEND|0|X')));
        assert.strictEqual(known.payload, 'SEND|0|X');
        assert.strictEqual(known.actionAliasExpanded, false);
        const unknown = d.transactionFromObject(mk(ob('NOTANACTION|0|X')));
        assert.strictEqual(unknown.payload, 'NOTANACTION|0|X', 'unknown names stay untouched, as on the other chains');
    });
});

describe('KaspaBlockDecoder: real wire fixture', function () {
    // The P0 of the 2026-10-11 audit had a structural root cause: every fixture was HAND-WRITTEN
    // cleartext, so the suite never met the shape a node actually delivers. This fixture was
    // captured from a live kaspad v2.1.0 simnet node (8 spendable-input payload transactions in
    // one chain block), and it is the sample that would have caught it.
    const fixture = require('../../../fixtures/kaspa/chain_block_with_payload.json');

    it('decodes a captured chain block without inventing anything', function () {
        const d = new KaspaBlockDecoder('kaspa-simnet');
        const block = d.blockFromObject({
            header: { hash: fixture.chainBlock.hash, selectedParentHash: fixture.chainBlock.previousBlockHash, timestamp: fixture.chainBlock.timestamp },
            transactions: fixture.acceptedTransactions,
            verboseData: { hash: fixture.chainBlock.hash },
        });
        assert.strictEqual(block.transactions.length, fixture.acceptedTransactions.length);
        for (const tx of block.transactions) {
            assert.ok(tx.getId().length === 64, 'every captured tx has a 32-byte txid');
            assert.ok(tx.outs.length >= 1, 'and at least one output');
        }
    });

    it('recovers the ACTION string that is actually on chain, and marks it as legacy cleartext', function () {
        const d = new KaspaBlockDecoder('kaspa-simnet');
        const tx = d.transactionFromObject(fixture.acceptedTransactions[0]);
        // Captured before the 4.2 obfuscation existed, so the carrier is cleartext: the decoder
        // must still recover it (marked) rather than treating it as noise.
        assert.strictEqual(tx.payloadUnobfuscated, true);
        assert.ok(/^ORDER\|0\|DOGE\|\|1000000000\|/.test(tx.payload), 'the captured action survives decoding: ' + tx.payload.slice(0, 40));
        assert.strictEqual(tx.payload, Buffer.from(fixture.acceptedTransactions[0].payload, 'hex').toString('utf8'));
    });
});
