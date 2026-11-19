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
 *********************************************************************/

'use strict'

const { readRolledBackAboveTip } = require('./reorg_halt.js')

async function validateClearedHaltResume(){
    const rolledBack = await readRolledBackAboveTip(this.db)
    if (rolledBack === undefined || rolledBack === 0) return true
    if (rolledBack === null){
        this.logError('REORG_HALT clear cannot be validated because the rolled-back range is unreadable; staying parked.')
        return false
    }
    const reason = 'A REORG_HALT clear raced a halted rollback; ' + rolledBack
        + ' rolled-back block(s) remain above the stored tip. Recover with a reset.'
    let persisted = false
    if (typeof this.db.markReorgHalted === 'function'){
        try { persisted = await this.db.markReorgHalted(reason) === true } catch (_) {}
    }
    this.reorgHalted = true
    this.reorgHaltReason = reason
    this.reorgHaltAt = new Date().toISOString()
    this.reorgHaltMarkerPersisted = persisted
    this.logError(reason + ' The decoder remains parked and wrote a fresh halt marker: ' + persisted + '.')
    return false
}

module.exports = { validateClearedHaltResume }
