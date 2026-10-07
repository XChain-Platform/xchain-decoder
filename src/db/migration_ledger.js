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
 **********************************************************************/

// Convert a legacy TIMESTAMP applied_at column on the migration ledger to DATETIME, in place.
async function ensureLedgerAppliedAtDatetime(conn){
    const rows = await conn.query(
        'SELECT DATA_TYPE AS dataType FROM information_schema.COLUMNS ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' " +
        "AND COLUMN_NAME = 'applied_at'"
    );
    if(String(rows[0]?.dataType || '').toLowerCase() !== 'timestamp') return;
    await conn.query(
        'ALTER TABLE schema_migrations MODIFY applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'
    );
}

module.exports = {
    ensureLedgerAppliedAtDatetime,
}
