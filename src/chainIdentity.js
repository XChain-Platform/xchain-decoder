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
 * XChain Decoder - node endpoint chain-tier identity ()
 *
 * The block loop's getblockchaininfo gate validated only that `blocks` and
 * `verificationprogress` were numbers, so an endpoint serving a DIFFERENT chain
 * passed it: its blocks were decoded under the configured network's address
 * rules and start height, and its reported tip drove verifyReorg() /
 * deleteBlockByIndex(), deleting valid local blocks. This module holds the pure
 * half of the identity decision so it is testable outside the loop, mirroring
 * how oracleFeeOutput.js holds the capture decisions.
 *
 * SCOPE, and what is deliberately NOT closed here. `chain` distinguishes the
 * network TIER, never the coin: a Bitcoin-mainnet node and a Dogecoin-mainnet
 * node both report chain="main". Closing the cross-COIN case needs a block-0
 * genesis-hash pin per coin/network, and those constants belong in the coin
 * registry (src/coins/{BTC,LTC,DOGE}.js), which is vendored byte-identically
 * from canonical xchain-hub/src/coins into ten repos and guarded by
 * test/unit/coins-conformance.test.js. That is a cross-repo sync wave, not a
 * decoder-local edit, so it is tracked separately and this file covers the
 * wrong-TIER half only.
 *
 * A SECOND hole survives inside the tier, and it is not the coin axis: `test`,
 * `testnet3` and `testnet4` all map to `testnet` below, yet Bitcoin testnet3 and
 * testnet4 are DIFFERENT chains with different genesis blocks and different
 * history. A testnet4 node under a testnet3-configured decoder therefore agrees
 * with this gate and still walks the finding's whole failure path: its blocks
 * decode under the configured rules and its tip drives the reorg branch. The
 * collapse is deliberate, because `chain` carries no evidence that separates
 * them - the address rules are identical and the only distinguishing constant is
 * the block-0 hash, i.e. the same registry pin the cross-COIN half waits on. Read
 * "wrong-TIER half closed" as "a recognized chain string proving a different
 * tier is refused", never as "the endpoint is proven to be on our chain".
 *
 * BOTH tip-refresh paths are gated, not just the loop's. getBlockchainInfo() is
 * called in two places: the block loop's throttled refresh, and verifyReorg's
 * best-effort re-read after a failed getBlockHash (XChainDecoder.js, the item-1301
 * recovery). The second one assigns `nodeTip`, which the above-tip branch deletes
 * valid local blocks against, so leaving it ungated would have left the evidenced
 * data-loss path open behind a closed front door. Any THIRD caller of
 * getBlockchainInfo whose result reaches ingestion or a delete has to call
 * chainTierMismatch as well.
 *
 ********************************************************************/

'use strict';

// Chain strings the coin nodes report from getblockchaininfo, mapped to the
// consensus network name the decoder is configured with. Bitcoin Core, Litecoin
// Core and Dogecoin all emit the same vocabulary; `testnet3`/`testnet4` are the
// post-v28 Bitcoin Core spellings alongside the historical bare `test`, and all
// three are the same tier as far as the decoder's address rules are concerned.
// `signet` maps to itself so it matches no configured network and is rejected.
const CHAIN_TO_NETWORK = {
    main:     'mainnet',
    test:     'testnet',
    testnet3: 'testnet',
    testnet4: 'testnet',
    regtest:  'regtest',
    signet:   'signet',
};

// Does `reportedChain` (getblockchaininfo.chain) contradict the configured
// network? Returns a human reason string on a DEFINITE mismatch, else null.
//
// Fails OPEN in two cases, both deliberate:
//
//   1. The field is absent or not a string. A trimmed RPC-proxy response is the
//      same shape the existing `blocks`/`verificationprogress` guard was written
//      against, and promoting `chain` to required would stall every fleet whose
//      proxy omits it - a self-inflicted outage against a hazard that is only
//      possible under a misconfiguration. The caller logs it instead.
//   2. The string is not in the table. A future Core release naming a new tier
//      must not halt a healthy node; an unknown string carries no evidence of a
//      mismatch, only of an unrecognized vocabulary.
//
// It fails CLOSED on the case it can actually prove: a recognized chain string
// that maps to a different network than the one configured. There the endpoint
// is demonstrably serving another chain, and continuing is the data-loss path.
function chainTierMismatch(consensusNetwork, reportedChain){
    if (typeof reportedChain !== 'string' || reportedChain === '') return null;
    const mapped = CHAIN_TO_NETWORK[reportedChain];
    if (!mapped) return null;
    if (mapped === String(consensusNetwork)) return null;
    return 'node reports chain="' + reportedChain + '" (' + mapped +
        ') but this decoder is configured for ' + consensusNetwork;
}

// True when the response carries no usable `chain` field, so the caller can say
// so once rather than treating silence as agreement.
function chainFieldMissing(reportedChain){
    return typeof reportedChain !== 'string' || reportedChain === '';
}

module.exports = { CHAIN_TO_NETWORK, chainTierMismatch, chainFieldMissing };
