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
 **********************************************************************
 *
 * Collapse dispenser registrations by an optional caller-provided key.
 *
 ********************************************************************/

'use strict';

function collapseRegistrationsByKey(candidates, keyOf){
    if (!Array.isArray(candidates)) return []
    const collapsed = new Map()
    for (const candidate of candidates){
        if (!candidate || !candidate.address) continue
        const selectedKey = typeof keyOf === 'function' ? keyOf(candidate.address) : null
        const key = typeof selectedKey === 'string' && selectedKey ? selectedKey : candidate.address
        const existing = collapsed.get(key)
        if (existing === undefined){
            collapsed.set(key, {
                address:       candidate.address,
                sourceAddress: candidate.sourceAddress,
                oracleAddress: candidate.oracleAddress || null,
                expiration:    candidate.expiration,
            })
            continue
        }
        if (candidate.expiration > existing.expiration)
            existing.expiration = candidate.expiration
        if (!existing.oracleAddress && candidate.oracleAddress)
            existing.oracleAddress = candidate.oracleAddress
    }
    return [...collapsed.values()]
}

module.exports = { collapseRegistrationsByKey }
