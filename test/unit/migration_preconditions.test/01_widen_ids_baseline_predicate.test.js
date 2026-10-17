'use strict';

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
 * Baseline predicate for the widen-ids deploy precondition: a database built
 * from the current src/sql records the file, and any narrower shape keeps it
 * pending for the operator run.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');

// The fresh src/sql shape for every column widen-ids MODIFYs, as information_schema
// reports it, with the FK count the correlated subquery returns (a BigInt from the driver).
const WIDEN_IDS_FRESH = [
    ['index_addresses', 'id'], ['index_transactions', 'id'], ['pubkeys', 'address_id'],
    ['blocks', 'block_index'], ['blocks', 'block_time'], ['blocks', 'block_hash_id'], ['blocks', 'previous_block_hash_id'],
    ['transactions', 'tx_index'], ['transactions', 'tx_hash_id'], ['transactions', 'block_index'],
    ['transactions', 'source_id'], ['transactions', 'destination_id'],
    ['dispensers', 'tx_index'], ['dispensers', 'address_id'],
    ['transaction_outputs', 'tx_index'], ['transaction_outputs', 'vout'], ['transaction_outputs', 'destination_id'],
];

function widenIdsRows(edit) {
    const rows = WIDEN_IDS_FRESH.map(([tbl, col]) => ({
        tbl, col, dataType: 'bigint', columnType: 'bigint(20) unsigned',
        extra: col === 'id' ? 'auto_increment' : '', fkCount: 1n
    }));
    return edit ? edit(rows) : rows;
}

describe('Database.MIGRATION_PRECONDITIONS: widen-ids-to-bigint predicate @regression', function () {

    const pre = Database.MIGRATION_PRECONDITIONS['2026-06-02-widen-ids-to-bigint.sql'];
    const narrow = (tbl, col, type) => (rows) => rows.map(r => (r.tbl === tbl && r.col === col)
        ? { ...r, dataType: type.split('(')[0], columnType: type } : r);

    it('baselines on the fresh src/sql shape', function () {
        assert.strictEqual(WIDEN_IDS_FRESH.length, 17);
        assert.match(pre.skipWhen(widenIdsRows()), /already BIGINT UNSIGNED/);
    });

    it('does NOT baseline while pubkeys.address_id or index_addresses.id is still INT', function () {
        assert.strictEqual(pre.skipWhen(widenIdsRows(narrow('pubkeys', 'address_id', 'int(10) unsigned'))), null);
        assert.strictEqual(pre.skipWhen(widenIdsRows(narrow('index_addresses', 'id', 'int(10) unsigned'))), null);
    });

    it('does NOT baseline on a signed BIGINT', function () {
        assert.strictEqual(pre.skipWhen(widenIdsRows(narrow('transaction_outputs', 'vout', 'bigint(20)'))), null);
    });

    it('does NOT baseline when any one column is absent', function () {
        for (let i = 0; i < WIDEN_IDS_FRESH.length; i++) {
            assert.strictEqual(pre.skipWhen(widenIdsRows(rows => rows.filter((_, j) => j !== i))), null,
                WIDEN_IDS_FRESH[i].join('.') + ' absent must not baseline');
        }
    });

    it('does NOT baseline when pubkeys_ibfk_1 is missing', function () {
        assert.strictEqual(pre.skipWhen(widenIdsRows(rows => rows.map(r => ({ ...r, fkCount: 0n })))), null);
    });

    it('does NOT baseline when a surrogate key lacks AUTO_INCREMENT', function () {
        assert.strictEqual(pre.skipWhen(widenIdsRows(rows => rows.map(r =>
            (r.tbl === 'index_transactions' ? { ...r, extra: '' } : r)))), null);
    });

    it('does NOT baseline on an unreadable type or an empty answer', function () {
        assert.strictEqual(pre.skipWhen(widenIdsRows(rows => rows.map(r =>
            (r.tbl === 'blocks' && r.col === 'block_time' ? { ...r, columnType: null } : r)))), null);
        assert.strictEqual(pre.skipWhen([]), null);
    });

    it('reads information_schema for this database through exactly one placeholder', function () {
        assert.match(pre.sql, /information_schema\.columns/i);
        assert.match(pre.sql, /table_schema\s*=\s*\?/i, 'must be parameterised on the database name');
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1, 'the runner binds only the database name');
        assert.match(pre.sql, /pubkeys_ibfk_1/);
    });
});
