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
 * Comment markers inside quoted spans: the auto-apply scan and the live-schema guard strip
 * block comments with the splitter's quote model, so a '/*' literal and a later '*' + '/'
 * literal cannot hide the real clauses between them. Kept in step with the indexer suite.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');
const { modifyClauses, stripBlockComments } = require('../../../src/db/migration_live_schema_guard.js');

const destructiveOf = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const statementsOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

const HIDDEN = ['DROP COLUMN amount', 'RENAME TO balances_old', 'CHANGE amount amount2 BIGINT', 'ENGINE=MEMORY'];
const between = (open, close, clause) => 'ALTER TABLE balances ADD COLUMN IF NOT EXISTS a VARCHAR(4) DEFAULT ' + open +
    ', ' + clause + ', ADD COLUMN IF NOT EXISTS b VARCHAR(4) DEFAULT ' + close + ';';

describe('Database.destructiveAutoStatement() quoted comment markers @regression', function () {
    it('flags a destructive clause hidden between a /* literal and a later */ literal', function () {
        for (const clause of HIDDEN) {
            for (const [open, close] of [["'/*'", "'*/'"], ['"/*"', '"*/"']]) {
                const sql = between(open, close, clause);
                const offender = destructiveOf(statementsOf(sql));
                assert.ok(offender && offender.includes(clause), sql + ' must not be auto-eligible');
            }
        }
    });

    it('flags the same trick through backtick identifiers, one ending in a backslash', function () {
        for (const sql of [
            'ALTER TABLE balances ADD COLUMN `x/*` INT, DROP COLUMN amount, ADD COLUMN `y*/` INT;',
            'ALTER TABLE balances ADD COLUMN `a\\` INT, ADD COLUMN `x/*` INT, DROP COLUMN amount, ADD COLUMN `y*/` INT;',
        ]) {
            const offender = destructiveOf(statementsOf(sql));
            assert.ok(offender && /DROP COLUMN amount/.test(offender), sql + ' must not be auto-eligible');
        }
    });

    it('still reads a real comment as a comment and a quoted marker as data', function () {
        for (const sql of [
            "ALTER TABLE t ADD COLUMN c VARCHAR(4) DEFAULT '/*';",
            "ALTER TABLE t ADD COLUMN c VARCHAR(4) DEFAULT '*/' /* note: DROP TABLE x */;",
            '/* note */ ALTER TABLE t ADD COLUMN c INT;',
        ]) assert.strictEqual(destructiveOf(statementsOf(sql)), null, sql);
        assert.ok(destructiveOf(statementsOf('/* note */ DROP TABLE balances;')));
    });
});

describe('decoder live-schema guard quoted comment markers @regression', function () {
    it('finds a MODIFY between quoted markers or after a backslash-ended identifier', function () {
        for (const sql of [
            "ALTER TABLE t ADD COLUMN x VARCHAR(4) DEFAULT '/*', MODIFY amount INT, ADD COLUMN y VARCHAR(4) DEFAULT '*/';",
            'ALTER TABLE t ADD COLUMN `a\\` INT, MODIFY amount INT;',
        ]) assert.deepStrictEqual(modifyClauses(statementsOf(sql)).map(m => m.column), ['amount'], sql);
    });

    it('strips block comments with the splitter quote model', function () {
        assert.strictEqual(stripBlockComments('a /* x */ b'), 'a   b');
        assert.strictEqual(stripBlockComments("'/* x */' \"*/\" `/*`"), "'/* x */' \"*/\" `/*`");
        assert.strictEqual(stripBlockComments("'a''b' /* c */ d"), "'a''b'   d");
        assert.strictEqual(stripBlockComments("'a\\' /* x */' /* y */ z"), "'a\\' /* x */'   z");
        assert.strictEqual(stripBlockComments('`a\\` /* x */ b'), '`a\\`   b');
        assert.strictEqual(stripBlockComments('a /*!50000 b */ c /*M!100100 d */'), 'a /*!50000 b */ c /*M!100100 d */');
        assert.strictEqual(stripBlockComments('a /* b'), 'a /* b');
    });
});
