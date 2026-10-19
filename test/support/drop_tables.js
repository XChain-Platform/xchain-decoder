// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Test-only helper that resets a decoder database between suites. It lives in
// test support so no production code path can drop the schema.

'use strict';

// Child / referencing tables first. pubkeys carries a foreign key onto
// index_addresses, so it must go before index_addresses or the DROP would fail
// with a constraint error.
const DROP_ORDER = [
    'transaction_outputs',
    'dispensers',
    'mempool_transactions',
    'pubkeys',
    'transactions',
    'blocks',
    'index_addresses',
    'index_transactions',
    'events',
];

// Drops every decoder table on one connection taken from `db`.
async function dropAllTables(db) {
    const connection = await db.getConnection();
    try {
        for (const table of DROP_ORDER) {
            await connection.query(`DROP TABLE IF EXISTS ${table}`);
        }
    } finally {
        await connection.release();
    }
}

module.exports = { DROP_ORDER, dropAllTables };
