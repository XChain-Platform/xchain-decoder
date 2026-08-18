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
 * Endpoint chain-tier identity gate.
 *
 * The block loop's getblockchaininfo gate validated shape only, so a node on a
 * different chain was accepted: its blocks were decoded under the configured
 * network's rules and its tip could drive deleteBlockByIndex() over valid local
 * state. These pin the pure decision AND its two deliberate fail-open holes, so
 * neither can be tightened into a fleet stall or loosened into silence without a
 * failing test.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { chainTierMismatch, chainFieldMissing, CHAIN_TO_NETWORK } = require('../../src/chainIdentity.js');

describe('endpoint chain-tier identity gate @regression', function () {

    describe('agreeing endpoints are accepted', function () {
        const AGREE = [
            ['mainnet', 'main'],
            ['testnet', 'test'],
            ['testnet', 'testnet3'],
            ['testnet', 'testnet4'],
            ['regtest', 'regtest'],
        ];
        for (const [net, chain] of AGREE) {
            it(`${net} decoder accepts chain="${chain}"`, function () {
                assert.strictEqual(chainTierMismatch(net, chain), null);
            });
        }
    });

    describe('a recognized chain on the wrong tier is refused', function () {
        const REFUSE = [
            ['mainnet', 'test'],
            ['mainnet', 'testnet4'],
            ['mainnet', 'regtest'],
            ['mainnet', 'signet'],
            ['testnet', 'main'],
            ['testnet', 'regtest'],
            ['testnet', 'signet'],
            ['regtest', 'main'],
            ['regtest', 'test'],
        ];
        for (const [net, chain] of REFUSE) {
            it(`${net} decoder refuses chain="${chain}"`, function () {
                const reason = chainTierMismatch(net, chain);
                assert.ok(reason, `expected a refusal for ${net} vs ${chain}`);
                assert.ok(reason.includes(chain), 'the reason names the reported chain');
                assert.ok(reason.includes(net), 'the reason names the configured network');
            });
        }
    });

    describe('the two deliberate fail-open holes', function () {
        it('an absent chain field is not a mismatch (a trimmed RPC proxy must not stall the fleet)', function () {
            assert.strictEqual(chainTierMismatch('mainnet', undefined), null);
            assert.strictEqual(chainTierMismatch('mainnet', null), null);
            assert.strictEqual(chainTierMismatch('mainnet', ''), null);
            assert.strictEqual(chainTierMismatch('mainnet', 42), null);
        });

        it('an unrecognized chain string is not a mismatch (a future Core tier must not halt a healthy node)', function () {
            assert.strictEqual(chainTierMismatch('testnet', 'testnet5'), null);
            assert.strictEqual(chainTierMismatch('mainnet', 'whatever'), null);
        });

        it('chainFieldMissing reports the unchecked state so silence is never read as agreement', function () {
            assert.strictEqual(chainFieldMissing(undefined), true);
            assert.strictEqual(chainFieldMissing(''), true);
            assert.strictEqual(chainFieldMissing(7), true);
            assert.strictEqual(chainFieldMissing('main'), false);
        });
    });

    describe('the gate is wired into the block loop, not merely exported', function () {
        const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'XChainDecoder.js'), 'utf8');

        it('XChainDecoder requires the module', function () {
            assert.ok(/require\('\.\/chainIdentity'\)/.test(SRC));
        });

        it('the refresh gate calls chainTierMismatch against the configured network', function () {
            assert.ok(/chainTierMismatch\(this\.consensusNetwork,\s*lastBlockchainInfo\["chain"\]\)/.test(SRC),
                'the getblockchaininfo refresh must check the reported chain against this.consensusNetwork');
        });

        it('a mismatch aborts the refresh rather than falling through to the height comparisons', function () {
            const idx = SRC.indexOf('chainTierMismatch(this.consensusNetwork, lastBlockchainInfo');
            assert.ok(idx > 0);
            const after = SRC.slice(idx, idx + 700);
            assert.ok(/lastBlockchainInfo = null/.test(after), 'the stale/foreign info is discarded');
            assert.ok(/continue/.test(after), 'the loop re-polls instead of decoding the foreign tip');
        });

        // The gate is worth only as much as its least-guarded caller. getBlockchainInfo()
        // has two call sites, and the one inside verifyReorg assigns nodeTip, which the
        // above-tip branch deletes valid local blocks against.
        it('EVERY getBlockchainInfo call site is gated, not just the block loop', function () {
            const callSites = SRC.split('this.connector.getBlockchainInfo()').length - 1;
            const gateCalls = SRC.split('chainTierMismatch(this.consensusNetwork').length - 1;
            assert.strictEqual(gateCalls, callSites,
                'a getBlockchainInfo() caller exists with no chainTierMismatch check; any tip that ' +
                'reaches ingestion or deleteBlockByIndex must pass the gate');
        });

        it("verifyReorg's tip re-read refuses a foreign endpoint instead of moving nodeTip", function () {
            const idx = SRC.indexOf('chainTierMismatch(this.consensusNetwork, info["chain"])');
            assert.ok(idx > 0, "verifyReorg's getBlockchainInfo re-read must check the reported chain");
            const window = SRC.slice(idx, idx + 1400);
            // The tier gate cannot separate a same-tier foreign chain (BTC-mainnet and
            // DOGE-mainnet both report chain="main"), so the re-read re-proves chain
            // identity with the block-0 pin too before it trusts the refreshed tip,
            // exactly as the block loop does. Both gates must precede the assignment.
            const genesisIdx = window.indexOf('await this.verifyChainGenesis()');
            const tipIdx = window.indexOf('nodeTip = info.blocks');
            assert.ok(genesisIdx > 0,
                'the tip re-read must also re-prove chain identity via verifyChainGenesis()');
            assert.ok(tipIdx > 0, 'the guarded assignment is the one under test');
            assert.ok(genesisIdx < tipIdx,
                'verifyChainGenesis() must gate the tip assignment: a foreign block-0 keeps the call-time tip');
            assert.ok(/\}\s*else\s*\{\s*nodeTip = info\.blocks/.test(window),
                'the tip assignment must be the ELSE of the genesis-mismatch branch, so a foreign tip is never taken');
        });
    });

    describe('the coin-identity half is documented as NOT closed here', function () {
        it('chainIdentity.js records that chain does not distinguish coins', function () {
            const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'chainIdentity.js'), 'utf8');
            assert.ok(/never the coin/.test(doc),
                'the module must state that a BTC-mainnet and a DOGE-mainnet node both report chain="main", ' +
                'so nobody reads this gate as cross-coin protection');
        });

        // testnet3 and testnet4 are different Bitcoin chains, not different spellings.
        // The table collapses them because `chain` carries nothing that separates them,
        // which leaves a wrong-CHAIN hole INSIDE the tier this gate is said to close.
        it('the testnet3/testnet4 collapse is pinned as a known hole, not read as coverage', function () {
            assert.strictEqual(CHAIN_TO_NETWORK.testnet3, 'testnet');
            assert.strictEqual(CHAIN_TO_NETWORK.testnet4, 'testnet');
            assert.strictEqual(chainTierMismatch('testnet', 'testnet4'), null,
                'a testnet4 node still passes a testnet-configured decoder; only a block-0 pin can refuse it');
            const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'chainIdentity.js'), 'utf8');
            assert.ok(/DIFFERENT chains with different genesis blocks/.test(doc),
                'the module must record that the tier gate does not separate testnet3 from testnet4');
        });

        it('signet maps to its own tier so it matches no configured network', function () {
            assert.strictEqual(CHAIN_TO_NETWORK.signet, 'signet');
        });
    });
});
