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

'use strict'

async function dispenserAddressKey(address, addressIdOf){
    const addressId = await addressIdOf(address)
    return addressId === null || addressId === undefined
        ? 'address:' + address
        : 'address-id:' + String(addressId)
}

module.exports = { dispenserAddressKey }
