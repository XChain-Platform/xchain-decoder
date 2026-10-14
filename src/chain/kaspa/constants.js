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
 * Kaspa family constants (xchain-decoder/src/chain/kaspa)
 *
 * Kaspa is NOT a bitcoinjs family. The three differences that matter
 * to this directory, each measured on kaspad v2.1.0 / rusty-kaspa
 * v2.1.0 and recorded in .scratch/kaspa/KASPA-ADAPTER-V2.md:
 *
 *   1. Transaction ids are blake3, and the wire encoding is borsh —
 *      bitcoin.Transaction.fromHex() cannot be pointed at these bytes.
 *   2. The carrier is the payload field of the transaction itself,
 *      not an OP_RETURN output. MAX_ACTION_DATA_LENGTH is the same
 *      8192 the protocol layer enforces (xchain-decoder/src/protocol/
 *      constants.js:40), so the envelope rules carry over unchanged.
 *   3. There is no `getblock <hash> 0` raw-hex RPC. kaspad answers
 *      over wRPC (Borsh 17110/17210, JSON 18110/18210) with structured
 *      blocks, so the node connector hands this family objects rather
 *      than hex (see kaspa_block_decoder.js, blockFromObject).
 ********************************************************************/
'use strict';

// Ports are the upstream defaults from kaspad/src/args.rs (help text):
//   "gRPC (default port: 16110, testnet: 16210)"
//   "wRPC Borsh (default port: 17110, testnet: 17210)"
//   "wRPC JSON (default port: 18110, testnet: 18210)"
//   "listen (default all interfaces port: 16111, testnet: 16211)"
// simnet is deliberately absent: its defaults were never verified, so it must be
// passed explicitly rather than guessed (crypto_nodes/kaspa/kaspa_node.js agrees).
const KASPA_PORTS = {
    mainnet: { grpc: 16110, p2p: 16111, wrpcBorsh: 17110, wrpcJson: 18110 },
    testnet: { grpc: 16210, p2p: 16211, wrpcBorsh: 17210, wrpcJson: 18210 },
};

// Address prefixes per network. kaspatest:<payload> etc. The payload is the same
// for a given key across networks, but the prefix is covered by the address
// checksum, so a prefix swap produces an invalid address (measured: kaspad
// answers "The address checksum is invalid").
const KASPA_ADDRESS_PREFIX = { mainnet: 'kaspa', testnet: 'kaspatest', simnet: 'kaspasim', regtest: 'kaspasim' };

// SCRIPT_VERSION_PUBKEY is what kaspad returns in verboseData.scriptPublicKeyAddress
// for a pay-to-public-key output; the decoder records it verbatim so the signer can
// round-trip the script (see the entry builder in the Kaspa encoder).
const KASPA_SCRIPT_VERSION_PUBKEY = 0;

// Protocol ceiling, mirrored from the platform so the same oversize rule applies:
// an action payload longer than this is blanked, and the row is still written.
const MAX_ACTION_DATA_LENGTH = 8192;

module.exports = {
    KASPA_PORTS,
    KASPA_ADDRESS_PREFIX,
    KASPA_SCRIPT_VERSION_PUBKEY,
    MAX_ACTION_DATA_LENGTH,
};
