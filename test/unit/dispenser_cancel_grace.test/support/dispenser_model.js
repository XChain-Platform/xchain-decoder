'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Model the decoder dispenser queries used by the cancellation grace tests.
class DispenserModel {
    constructor(){
        this.rows = []
        this.captureLoads = []
        this.purgeCalls = []
    }
    async insertDispenser(){ return true }
    async extendOpenDispenserExpirationBySource(){ return true }
    async getOpenDispenserOracleAddressBySource(){ return null }
    async getOpenDispenserOracleAddressesBySource(){ return [] }
    async purgeExpiredDispensers(safeHeight, graceFloor){
        this.purgeCalls.push({ safeHeight, graceFloor })
        return true
    }
    async deleteOpenDispensers(blockIndex, minExpiration){
        for (const row of this.rows)
            if (row.expiredBlockIndex === null && row.expiration < Number(minExpiration)){
                row.expiredBlockIndex = blockIndex
                row.expiredBlockTime  = Number(minExpiration)
            }
        return true
    }
    async getAllOpenDispenserAddresses(graceFloor){
        const floor = graceFloor
        const graceActive = (typeof floor === 'number') && Number.isFinite(floor)
        const set = new Set(this.rows
            .filter(row => row.expiredBlockIndex === null
                || (graceActive && Number.isFinite(row.expiredBlockTime) && row.expiredBlockTime >= floor)
                || (graceActive && row.expiration >= floor))
            .map(row => row.address))
        this.captureLoads.push({ floor: graceActive ? floor : null, set })
        return set
    }
}

module.exports = DispenserModel
