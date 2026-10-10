/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

// Block-time gate for mapping an indexer-valid unsigned 64-bit DISPENSER
// EXPIRATION onto the decoder's exact Number range. Mainnet and testnet keep
// the historical rejection until a fleet flag day is selected. Regtest is
// genesis-active so the widened recognition path is continuously exercised.
const DISPENSER_WIDE_EXPIRATION_GATES = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

module.exports = { DISPENSER_WIDE_EXPIRATION_GATES };
