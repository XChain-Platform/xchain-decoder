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

'use strict';

const assert = require('assert');
const Database = require('../../../../src/db');
const scan = Database.prototype.destructiveAutoStatement.bind(Database.prototype);

describe('decoder auto migration IGNORE and REPLACE SELECT guard @regression', function () {
    it('refuses statement-local strict-mode bypasses', function () {
        for(const sql of [
            'INSERT IGNORE INTO t (a) VALUES (1)',
            'INSERT DELAYED IGNORE t (a) VALUES (1)',
            'CREATE TABLE t2 IGNORE (SELECT a FROM s)',
            'CREATE TABLE t2 REPLACE AS SELECT a FROM s',
        ]) assert.strictEqual(scan([sql]), sql, sql);
    });

    it('keeps quoted uses and plain forms eligible', function () {
        for(const sql of [
            "INSERT INTO notes (body) VALUES ('IGNORE')",
            'CREATE TABLE t2 AS SELECT a FROM s',
            'CREATE TABLE t (`ignore` INT)',
            "CREATE TABLE t (a VARCHAR(10), b VARCHAR(10) AS (REPLACE(a, 'x', 'y')) VIRTUAL)",
        ]) assert.strictEqual(scan([sql]), null, sql);
    });
});
