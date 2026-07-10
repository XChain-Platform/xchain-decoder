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
 * XChain Decoder - Native-coin fee destination resolution
 *
 * Resolves the FEE_DESTINATION the decoder captures fee outputs for (persisted
 * to transaction_outputs so the indexer can validate native-coin fee payments).
 * The vendored coin registry (src/coins) supplies the consensus-pinned default,
 * so a stock deployment captures fee outputs with no operator env (previously
 * env-only: default installs captured nothing and LTC/DOGE native-fee
 * validation failed closed downstream). A FEE_DESTINATION env override is
 * honored on regtest ONLY; on mainnet AND testnet it is ignored with a warning,
 * because fee-output capture feeds consensus-relevant fee acceptance and must
 * not depend on operator env (same rule as the registry's per-coin override,
 * which is likewise regtest-only). Testnet is an armed multi-operator federation
 * whose consensus_pin hashes only the static bundle, so an env-resolved override
 * there escapes the freeze and would let two honest nodes capture different fee
 * outputs and diverge the block-hashed ledger, the identical fork mainnet is
 * protected from - so testnet must be gated too, not just mainnet.
 *
 ********************************************************************/

const { getCoinConfigByFullName } = require('./coins')

function resolveFeeDestination(networkName, envOverride) {
    const m = /^([a-z]+)-(mainnet|testnet|regtest)$/.exec(networkName || '')
    let pinned = null
    if (m) {
        try {
            pinned = getCoinConfigByFullName(m[1], m[2]).addresses.FEE_DESTINATION || null
        } catch (e) {
            // Unknown coin/network (e.g. test doubles): no registry default, env-only below.
        }
    }
    if (envOverride) {
        // Honored on regtest ONLY. On mainnet AND testnet the consensus-pinned registry
        // default wins (matches src/coins/index.js resolveFeeDestination and the indexer's
        // config, both regtest-only): the override escapes the consensus_pin freeze, so two
        // honest nodes with different env would capture different fee outputs and fork the
        // block-hashed ledger. When there is no pinned default (unknown coin / test double,
        // pinned === null) the override still resolves so those paths keep working.
        if (m && m[2] !== 'regtest' && pinned) {
            if (envOverride !== pinned)
                console.log('WARNING: FEE_DESTINATION env is set but IGNORED on ' + m[2] + '; using the consensus-pinned registry address.')
            return pinned
        }
        return envOverride
    }
    return pinned
}

module.exports = { resolveFeeDestination }
