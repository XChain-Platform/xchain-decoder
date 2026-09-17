// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

module.exports = function registerDbCleanupRecord(context) {
    const { assert, Database, poolWhoseDropFails, linesFor } = context

    it('records the drop failure with the table and the cause', async function () {
        const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p')
        db.pool = poolWhoseDropFails()

        // Control: the drop is cleanup, so the call still returns its result.
        const r = await db.deleteAndCompareTxsNotInList([])
        assert.strictEqual(r.transactionsDeleted, 0)

        const warned = linesFor('DB_TEMP_TABLE_DROP_FAILED')
        assert.strictEqual(warned.length, 1)
        assert.ok(warned[0].includes('table=_mempool_node_snapshot'), warned[0])
        assert.ok(warned[0].includes('lost connection to server'), warned[0])
    })
}
