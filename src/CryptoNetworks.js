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
 * XChain Decoder - Crypto Networks Class
 *
 * Thin adapter over the canonical coin registry (src/coins). The bitcoinjs
 * network object and the indexing start height come from that single source of
 * truth rather than an in-file switch, so a coin's parameters cannot differ
 * between the services that vendor the registry.
 *
 ********************************************************************/

const coins = require('./coins');

const SUPPORTED = 'bitcoin-mainnet, bitcoin-testnet, bitcoin-regtest, dogecoin-mainnet, ' +
    'dogecoin-testnet, dogecoin-regtest, litecoin-mainnet, litecoin-testnet, litecoin-regtest';

// Split a "<fullname>-<network>" key (e.g. "bitcoin-mainnet") into a canonical
// {tick, net} pair, or null when it names no known coin/network.
function parseNetworkName(networkName){
    const s = String(networkName);
    const i = s.lastIndexOf('-');
    if(i < 0) return null;
    const tick = coins.FULL_NAME_TO_TICK[s.slice(0, i)];
    const net  = s.slice(i + 1);
    if(!tick || !coins.NETWORKS.includes(net)) return null;
    return { tick, net };
}

class CryptoNetworks {
    // bitcoinjs-lib network object (+ XChain relay overlays) for a network key.
    static getBitcoinJsNetwork(networkName){
        const p = parseNetworkName(networkName);
        if(!p) throw new TypeError(`Unknown network: "${networkName}". Supported: ${SUPPORTED}`);
        return coins.getCoinConfig(p.tick, p.net).net;
    }

    // Uppercase native-coin ticker ('BTC'|'DOGE'|'LTC') for a network key. This is
    // the same value carried in a v0 DISPENSER's GIVE_COIN/GET_COIN fields and the
    // indexer's config['COIN'], so the decoder can gate dispenser opens on the same
    // coin identity the indexer validates against.
    static getCoinTick(networkName){
        const p = parseNetworkName(networkName);
        if(!p) throw new TypeError(`Unknown network: "${networkName}". Supported: ${SUPPORTED}`);
        return p.tick;
    }

    // Pinned block-0 hash of the CHAIN this network key names, or null when the
    // registry leaves it unpinned (every regtest, and any mainnet/testnet whose real
    // hash an operator has not yet captured off the fleet's own node). The decoder
    // asserts it against `getblockhash 0` to refuse a same-tier foreign endpoint,
    // which `chain` alone cannot detect (chainIdentity.js). Not part of any consensus
    // hash: it identifies the endpoint, not how bytes are read.
    static getChainGenesisHash(networkName){
        const p = parseNetworkName(networkName);
        if(!p) throw new TypeError(`Unknown network: "${networkName}". Supported: ${SUPPORTED}`);
        return coins.getCoinConfig(p.tick, p.net).chainGenesisHash || null;
    }

    // Indexing start height, and a CONSENSUS input: coins/index.js folds firstBlock into
    // consensusSubset() (REGENERATED 2026-08-06, see coins/consensus_pin.js), because the
    // decoder reads it as the chain's start height, so it decides which block the action
    // history begins at. A node bundling a higher value skips the actions below it and
    // replays a different history while its pin verifies clean, so this is never a
    // locally-tunable operational value. Unknown/regtest -> 0.
    static getFirstBlock(networkName){
        const p = parseNetworkName(networkName);
        return p ? coins.getCoinConfig(p.tick, p.net).firstBlock : 0;
    }

    // Default dispenser/order EXPIRATION window in days (consensus param). Must
    // match the indexer's config['EXPIRATION_FEE_DEFAULT_DAYS'] that
    // util.getDefaultExpiration substitutes for an omitted EXPIRATION field.
    static getExpirationFeeDefaultDays(networkName){
        const p = parseNetworkName(networkName);
        if(!p) throw new TypeError(`Unknown network: "${networkName}". Supported: ${SUPPORTED}`);
        return coins.getCoinConfig(p.tick, p.net).legacyFees.EXPIRATION_FEE_DEFAULT_DAYS;
    }
}

module.exports = CryptoNetworks;
