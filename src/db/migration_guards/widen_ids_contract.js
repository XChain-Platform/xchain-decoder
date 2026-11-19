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

function evaluateColumns(expected, rows){
    const presentTables = new Set();
    const live = new Map();
    for(const row of rows){
        if(!row || row.tableExists == null || row.tbl == null) continue;
        const table = String(row.tbl).toLowerCase();
        if(!Object.prototype.hasOwnProperty.call(expected, table)) continue;
        presentTables.add(table);
        if(row.col == null) continue;
        const column = String(row.col).toLowerCase();
        if(!expected[table].includes(column)) continue;
        live.set(table + '.' + column, {
            dataType: String(row.dataType || '').toLowerCase(),
            columnType: String(row.columnType || '').toLowerCase(),
            extra: String(row.extra || '').toLowerCase()
        });
    }

    const invalid = [];
    for(const [table, columns] of Object.entries(expected)){
        if(!presentTables.has(table)) continue;
        for(const column of columns){
            const type = live.get(table + '.' + column);
            if(!type || type.dataType !== 'bigint' || !/\bunsigned\b/.test(type.columnType)){
                invalid.push(table + '.' + column + '=' +
                    (type ? (type.columnType || type.dataType || 'unknown') : 'missing'));
            } else if(column === 'id' && !/\bauto_increment\b/.test(type.extra)){
                invalid.push(table + '.' + column + '=' +
                    (type.columnType || type.dataType || 'unknown') + ' (missing auto_increment)');
            }
        }
    }
    return { presentTables, invalid };
}

function hasPubkeysAddressForeignKey(rows){
    return rows.some(row => row &&
        String(row.tbl || '').toLowerCase() === 'pubkeys' &&
        String(row.col || '').toLowerCase() === 'address_id' &&
        String(row.referencedTable || '').toLowerCase() === 'index_addresses' &&
        String(row.referencedColumn || '').toLowerCase() === 'id');
}

module.exports = { evaluateColumns, hasPubkeysAddressForeignKey };
