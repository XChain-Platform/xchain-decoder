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
 ********************************************************************/

const assert = require('assert');

const Database = require('../../src/db');

describe('assertTransactionIdsAreBigint @regression @tier1', function () {

    const columns = [
        { col: 'tx_index', dataType: 'bigint' },
        { col: 'tx_hash_id', dataType: 'bigint' },
        { col: 'block_index', dataType: 'bigint' },
        { col: 'source_id', dataType: 'bigint' },
        { col: 'destination_id', dataType: 'bigint' }
    ];

    function ctxReturning(rows) {
        return {
            dbName: 'test_decoder',
            transactionConnection: null,
            getConnection: async () => ({
                query: async () => rows.map(row => ({ tableExists: 1, ...row })),
                release: async () => {}
            })
        };
    }

    it('names the exact migration file when a column is still INT', async function () {
        let message = null;
        try {
            await Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([
                { ...columns[0], dataType: 'int' },
                ...columns.slice(1)
            ]));
        } catch (err) {
            message = err.message;
        }
        assert.ok(message, 'an INT id column must fail the assertion');
        assert.ok(message.includes('--file 2026-06-02-widen-ids-to-bigint.sql'),
            'the halt message must name the migration; got: ' + message);
    });

    it('accepts the complete transactions id set at BIGINT', async function () {
        await Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning(columns));
    });

    it('rejects a missing id column', async function () {
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning(columns.slice(1))),
            /tx_index=missing/);
    });

    it('skips when the transactions table does not exist yet', async function () {
        await Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([]));
    });

    it('skips unrelated fixture rows that did not come from its schema query', async function () {
        const ctx = ctxReturning([]);
        ctx.getConnection = async () => ({
            query: async () => [{ dataType: 'bigint', columnType: 'bigint(20) unsigned' }],
            release: async () => {}
        });
        await Database.prototype.assertTransactionIdsAreBigint.call(ctx);
    });
});

describe('runMigrations BIGINT id startup contract @regression @tier1', function () {

    it('fails closed when the required assertion method is unavailable', async function () {
        const ctx = {
            assertStrictSqlMode: async () => {},
            runMigrationsInner: async () => ({ applied: [], pending: [] }),
            assertDispenserExpirationIsBigintUnsigned: async () => {},
            assertPubkeyColumnIsUncompressedWide: async () => {},
            assertActionDataIsUtf8mb4: async () => {}
        };

        await assert.rejects(
            Database.prototype.runMigrations.call(ctx),
            /assertTransactionIdsAreBigint/);
    });
});
