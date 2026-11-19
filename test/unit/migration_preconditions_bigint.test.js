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

const columns = [
    { tbl: 'transactions', col: 'tx_index', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
    { tbl: 'transactions', col: 'tx_hash_id', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
    { tbl: 'transactions', col: 'block_index', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
    { tbl: 'transactions', col: 'source_id', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
    { tbl: 'transactions', col: 'destination_id', dataType: 'bigint', columnType: 'bigint(20) unsigned' }
];

function completeColumns() {
    return Object.entries(Database.BIGINT_ID_COLUMNS).flatMap(([tbl, names]) => names.map(col => ({
        tbl,
        col,
        dataType: 'bigint',
        columnType: 'bigint(20) unsigned',
        extra: col === 'id' ? 'auto_increment' : ''
    })));
}

const linkedPubkeysForeignKey = [{
    tbl: 'pubkeys',
    col: 'address_id',
    referencedTable: 'index_addresses',
    referencedColumn: 'id',
    constraintName: '1'
}];

function ctxReturning(rows, fkRows = []) {
    return {
        dbName: 'test_decoder',
        transactionConnection: null,
        getConnection: async () => ({
            query: async (sql) => {
                if(/information_schema\.key_column_usage/i.test(sql)) return fkRows;
                const selected = /t\.table_name\s*=\s*'transactions'/i.test(sql)
                    ? rows.filter(row => row.tbl === 'transactions')
                    : rows;
                return selected.map(row => ({ tableExists: 1, ...row }));
            },
            release: async () => {}
        })
    };
}

function registerTransactionIdTypeTests() {
    it('names the exact migration file when a column is still INT', async function () {
        let message = null;
        try {
            await Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([
                { ...columns[0], dataType: 'int', columnType: 'int(10) unsigned' },
                ...columns.slice(1)
            ]));
        } catch (err) {
            message = err.message;
        }
        assert.ok(message, 'an INT id column must fail the assertion');
        assert.ok(message.includes('--file 2026-06-02-widen-ids-to-bigint.sql'),
            'the halt message must name the migration; got: ' + message);
    });

    it('rejects a signed BIGINT id column', async function () {
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([
                { ...columns[0], columnType: 'bigint(20)' },
                ...columns.slice(1)
            ])),
            /BIGINT UNSIGNED.*tx_index=bigint\(20\)/s);
    });

    it('accepts the complete transactions id set at BIGINT UNSIGNED', async function () {
        await Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning(columns));
    });
}

function registerSharedContractTests() {
    it('rejects a narrow transaction output after transactions is fully widened', async function () {
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([
                ...columns,
                {
                    tbl: 'transaction_outputs', col: 'destination_id',
                    dataType: 'int', columnType: 'int(10) unsigned'
                }
            ])),
            /transaction_outputs\.destination_id=int\(10\) unsigned/);
    });

    it('rejects a narrow dispenser address id', async function () {
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([
                { tbl: 'dispensers', col: 'tx_index', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
                { tbl: 'dispensers', col: 'address_id', dataType: 'int', columnType: 'int(10) unsigned' }
            ])),
            /dispensers\.address_id=int\(10\) unsigned/);
    });

    it('names every narrow column in one failure', async function () {
        const rows = completeColumns().map(row => {
            if((row.tbl === 'dispensers' && row.col === 'address_id') ||
                (row.tbl === 'transaction_outputs' && row.col === 'destination_id')){
                return { ...row, dataType: 'int', columnType: 'int(10) unsigned' };
            }
            return row;
        });
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(
                ctxReturning(rows, linkedPubkeysForeignKey)),
            /dispensers\.address_id=int\(10\) unsigned.*transaction_outputs\.destination_id=int\(10\) unsigned/s);
    });

    it('accepts the complete shared contract with a differently named foreign key', async function () {
        assert.strictEqual(completeColumns().length, 17);
        await Database.prototype.assertTransactionIdsAreBigint.call(
            ctxReturning(completeColumns(), linkedPubkeysForeignKey));
    });
}

describe('assertTransactionIdsAreBigint types @regression @tier1', function () {
    registerTransactionIdTypeTests();
    registerSharedContractTests();
});

describe('assertTransactionIdsAreBigint metadata @regression @tier1', function () {
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

    it('rejects complete columns when the pubkeys foreign key is absent', async function () {
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning(completeColumns())),
            /pubkeys\.address_id->index_addresses\.id=missing/);
    });

    it('rejects a surrogate id without AUTO_INCREMENT', async function () {
        const rows = completeColumns().map(row =>
            row.tbl === 'index_addresses' && row.col === 'id' ? { ...row, extra: '' } : row);
        await assert.rejects(
            Database.prototype.assertTransactionIdsAreBigint.call(
                ctxReturning(rows, linkedPubkeysForeignKey)),
            /index_addresses\.id=bigint\(20\) unsigned \(missing auto_increment\)/);
    });

    it('checks only the migration tables that exist', async function () {
        await Database.prototype.assertTransactionIdsAreBigint.call(ctxReturning([
            { tbl: 'transaction_outputs', col: 'tx_index', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
            { tbl: 'transaction_outputs', col: 'vout', dataType: 'bigint', columnType: 'bigint(20) unsigned' },
            { tbl: 'transaction_outputs', col: 'destination_id', dataType: 'bigint', columnType: 'bigint(20) unsigned' }
        ]));
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
