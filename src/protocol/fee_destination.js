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
 * validation failed closed downstream). The bare FEE_DESTINATION env is ignored
 * with a warning on every recognized coin/network: the only override is the
 * registry's regtest-only XCHAIN_FEE_DESTINATION_<COIN>_REGTEST, the same
 * variable the indexer reads, so the capture side and the validation side of
 * the native-fee seam always resolve one address. Fee-output capture feeds
 * consensus-relevant fee acceptance and must not depend on operator env on
 * mainnet or testnet either. Testnet is an armed multi-operator federation
 * whose consensus_pin hashes only the static bundle, so an env-resolved override
 * there escapes the freeze and would let two honest nodes capture different fee
 * outputs and diverge the block-hashed ledger, the identical fork mainnet is
 * protected from - so testnet must be gated too, not just mainnet.
 *
 ********************************************************************/

const { getCoinConfigByFullName } = require('../coins')
const { getLogger } = require('../observability');
const logger = getLogger();

function resolveFeeDestination(networkName, envOverride) {
    const m = /^([a-z]+)-(mainnet|testnet|regtest)$/.exec(networkName || '')
    let pinned = null
    let tick = null
    if (m) {
        try {
            const coin = getCoinConfigByFullName(m[1], m[2])
            pinned = coin.addresses.FEE_DESTINATION || null
            tick = coin.tick || null
        } catch (e) {
            // Unknown coin/network (e.g. test doubles): no registry default, env-only below.
        }
    }
    if (envOverride) {
        // On a recognized coin/network the registry value always wins, on regtest too. It already
        // carries the regtest-only XCHAIN_FEE_DESTINATION_<COIN>_REGTEST override, the one variable
        // the indexer reads, so capture and fee validation cannot resolve two different addresses.
        // On mainnet AND testnet that value is the consensus pin: an env override there escapes the
        // consensus_pin freeze, so two honest nodes with different env would capture different fee
        // outputs and fork the block-hashed ledger. With no registry value (unknown coin / test
        // double, pinned === null) the bare override still resolves so those paths keep working.
        if (m && pinned) {
            if (envOverride !== pinned) {
                const redirect = m[2] === 'regtest'
                    ? 'set XCHAIN_FEE_DESTINATION_' + (tick || '<COIN>') + '_REGTEST to redirect fees, so the indexer validates the same address.'
                    : 'using the consensus-pinned registry address.'
                logger.info('WARNING: FEE_DESTINATION env is set but IGNORED on ' + m[2] + ' (registry resolves ' + pinned + '); ' + redirect)
            }
            return pinned
        }
        return envOverride
    }
    return pinned
}

module.exports = { resolveFeeDestination }
