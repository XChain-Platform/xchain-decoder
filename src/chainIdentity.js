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
 * XChain Decoder - node endpoint chain-tier identity
 *
 * The block loop's getblockchaininfo gate validated only that `blocks` and
 * `verificationprogress` were numbers, so an endpoint serving a DIFFERENT chain
 * passed it: its blocks were decoded under the configured network's address
 * rules and start height, and its reported tip drove verifyReorg() /
 * deleteBlockByIndex(), deleting valid local blocks. This module holds the pure
 * half of the identity decision so it is testable outside the loop, mirroring
 * how oracleFeeOutput.js holds the capture decisions.
 *
 * TWO independent decisions live here, because the endpoint lies about two
 * different things and the evidence for each is different.
 *
 * 1. TIER (chainTierMismatch). `chain` from getblockchaininfo distinguishes the
 *    network TIER, never the coin: a Bitcoin-mainnet node and a Dogecoin-mainnet
 *    node both report chain="main". So this decision can prove "wrong tier" and
 *    nothing more. Read "wrong-TIER half closed" as "a recognized chain string
 *    proving a different tier is refused", never as "the endpoint is proven to be
 *    on our chain".
 *
 *    A hole survives INSIDE the tier even for one coin: `test`, `testnet3` and
 *    `testnet4` all map to `testnet` below, yet Bitcoin testnet3 and testnet4 are
 *    DIFFERENT chains with different genesis blocks and different history. A
 *    testnet4 node under a testnet3-configured decoder agrees with this gate and
 *    still walks the whole failure path described above. The collapse is deliberate:
 *    `chain` carries no evidence that separates them.
 *
 * 2. CHAIN (chainGenesisMismatch). The block-0 hash is the only constant that
 *    separates same-tier chains, so it closes BOTH holes tier cannot reach: the
 *    cross-COIN one and the testnet3-vs-testnet4 one. The pinned value belongs in
 *    the coin registry (src/coins/{BTC,LTC,DOGE}.js, `chainGenesisHash` per
 *    network), which is vendored byte-identically from canonical
 *    xchain-hub/src/coins into ten repos and guarded by
 *    test/unit/coins-conformance.test.js; it is deliberately kept OUT of
 *    consensusSubset(), because it identifies the ENDPOINT rather than deciding
 *    how a block's bytes are read, so arming one moves no CONSENSUS_CONFIG_PIN
 *    and needs no flag-day.
 *
 *    The pin is null (unpinned) until an operator reads the authoritative hash
 *    off the fleet's own node (`getblockhash 0`). Unpinned means the check is
 *    SKIPPED, not that the endpoint passed: a guessed or stale constant would
 *    fail-close a healthy decoder, which is the one outcome worse than the hole
 *    it closes. XChainDecoder says the unchecked state out loud at boot.
 *
 * BOTH tip-refresh paths are gated, not just the loop's. getBlockchainInfo() is
 * called in two places: the block loop's throttled refresh, and verifyReorg's
 * best-effort re-read after a failed getBlockHash (XChainDecoder.js). The second
 * one assigns `nodeTip`, which the above-tip branch deletes
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

// Does the node's own block-0 hash contradict the one pinned for this
// coin/network (coins registry, chainGenesisHash)? Returns a human reason string
// on a DEFINITE mismatch, else null. This is the decision the tier gate above
// cannot make: it is the only evidence that separates BTC-mainnet from
// DOGE-mainnet, or Bitcoin testnet3 from testnet4.
//
// Fails OPEN in two cases, both deliberate, mirroring chainTierMismatch:
//
//   1. Nothing is pinned. Until an operator captures the real hash off the
//      fleet's own node the registry carries null, and an unpinned coin/network
//      must run exactly as it did before this gate existed rather than halt.
//   2. The node returned nothing usable (RPC error, trimmed proxy, empty
//      string). Inability to READ the hash is not evidence of a foreign chain,
//      and turning an RPC blip into a halt would be a self-inflicted outage.
//
// It fails CLOSED on the case it can actually prove: two hashes that are both
// present and differ. There the endpoint is demonstrably a different chain, and
// continuing decodes foreign blocks under our address rules while a foreign tip
// drives deleteBlockByIndex() over valid local state.
//
// Compared case-insensitively: the pin is operator-entered, and Core prints the
// hash lowercase, so a pasted uppercase pin must not read as a foreign chain.
function chainGenesisMismatch(pinnedHash, reportedHash){
    if (typeof pinnedHash !== 'string' || pinnedHash === '') return null;
    if (typeof reportedHash !== 'string' || reportedHash === '') return null;
    if (pinnedHash.toLowerCase() === reportedHash.toLowerCase()) return null;
    return 'node block-0 hash is ' + reportedHash + ', but this decoder is pinned to ' +
        pinnedHash + ', so the endpoint is serving a different chain';
}

// True when no block-0 hash is pinned for this coin/network, so the cross-coin
// and testnet3/testnet4 identity check cannot run at all. Lets the caller say the
// unchecked state out loud once instead of letting a skip read as a pass.
function chainGenesisUnpinned(pinnedHash){
    return typeof pinnedHash !== 'string' || pinnedHash === '';
}

module.exports = {
    CHAIN_TO_NETWORK,
    chainTierMismatch,
    chainFieldMissing,
    chainGenesisMismatch,
    chainGenesisUnpinned,
};
