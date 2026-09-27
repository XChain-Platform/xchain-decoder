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
 **********************************************************************/

const assert = require('assert');
const Database = require('../../src/db');

const DATA_TYPE_SQL =
    'SELECT DATA_TYPE AS dataType FROM information_schema.COLUMNS ' +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' " +
    "AND COLUMN_NAME = 'applied_at'";
const ALTER_SQL =
    'ALTER TABLE schema_migrations MODIFY applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';

async function ledgerQueries(dataTypeRows){
    const queries = [];
    const conn = {
        query: async sql => {
            queries.push(sql);
            if(sql === DATA_TYPE_SQL) return dataTypeRows;
            return [];
        }
    };
    await Database.prototype.ensureMigrationsLedger(conn);
    return queries;
}

describe('Database#ensureMigrationsLedger() applied_at type', () => {
    it('creates the ledger with a DATETIME applied_at column', async () => {
        const queries = await ledgerQueries([]);
        const create = queries[0];
        assert.match(create, /applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP/i);
        assert.doesNotMatch(create, /\bTIMESTAMP\b/i);
    });

    it('retypes an existing TIMESTAMP applied_at column', async () => {
        const queries = await ledgerQueries([{ dataType: 'timestamp' }]);
        assert.deepStrictEqual(queries.filter(sql => /^ALTER TABLE/i.test(sql)), [ALTER_SQL]);
    });

    it('does not alter an existing DATETIME applied_at column', async () => {
        const queries = await ledgerQueries([{ dataType: 'datetime' }]);
        assert.deepStrictEqual(queries.filter(sql => /^ALTER TABLE/i.test(sql)), []);
    });

    it('does not alter when the applied_at column metadata is absent', async () => {
        const queries = await ledgerQueries([]);
        assert.deepStrictEqual(queries.filter(sql => /^ALTER TABLE/i.test(sql)), []);
    });
});
