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
 * Schema migration runner: CONVERT TO and MODIFY id rules of the auto-apply scan.
 *
 * CONVERT TO CHARACTER SET rewrites every text column of a table, and a MODIFY that
 * restates id without AUTO_INCREMENT strips the attribute, so neither may auto-run.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');

const scanOf  = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

describe('Database.destructiveAutoStatement() CONVERT TO and MODIFY id @regression', function () {
    it('flags ALTER TABLE ... CONVERT TO in every spelling', function () {
        for (const stmt of [
            'ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4',
            'ALTER TABLE t CONVERT TO CHARSET utf8mb4 COLLATE utf8mb4_bin',
            'alter online table `t` convert  to character set latin1',
            'ALTER TABLE t ADD COLUMN c INT, CONVERT TO CHARACTER SET utf8mb4',
        ]) {
            assert.strictEqual(scanOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('flags a MODIFY of id that drops AUTO_INCREMENT', function () {
        for (const stmt of [
            'ALTER TABLE t MODIFY id BIGINT',
            'ALTER TABLE t MODIFY COLUMN id BIGINT UNSIGNED',
            'ALTER TABLE t MODIFY `id` BIGINT NULL',
            'ALTER TABLE t MODIFY id BIGINT NOT NULL AUTO_INCREMENT, MODIFY `id` BIGINT',
            'ALTER TABLE t ADD COLUMN c INT, MODIFY id BIGINT',
            'ALTER TABLE t /* note */ MODIFY id BIGINT',
        ]) {
            assert.strictEqual(scanOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('keeps the AUTO_INCREMENT id repair and unrelated MODIFYs auto-eligible', function () {
        for (const stmt of [
            'ALTER TABLE t MODIFY id BIGINT NOT NULL AUTO_INCREMENT',
            'ALTER TABLE t MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT',
            'ALTER TABLE t MODIFY identifier VARCHAR(10) NULL',
            'ALTER TABLE t MODIFY memo MEDIUMTEXT NULL',
            'ALTER TABLE t ADD COLUMN c INT',
        ]) {
            assert.strictEqual(scanOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });

    it('refuses a mode=auto file that converts the charset, from raw file text', function () {
        const raw = '-- xchain:migration mode=auto\nALTER TABLE transactions CONVERT TO CHARACTER SET utf8mb3;\n';
        assert.match(String(scanOf(splitOf(raw))), /CONVERT TO CHARACTER SET utf8mb3/);
    });
});
