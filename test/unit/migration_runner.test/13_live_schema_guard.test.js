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
 * Live-schema MODIFY guard: an auto migration whose MODIFY would strip or narrow a live
 * column is refused before it runs.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const Database = require('../../../src/db');
const { assertNoLiveColumnLoss, modifyClauses } = require('../../../src/db/migration_live_schema_guard.js');

const statementsOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

const liveRow = (over) => Object.assign({
    COLUMN_TYPE: 'bigint(20) unsigned', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '',
    GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: null,
}, over);

async function verdict(live, sql) {
    const conn = { query: async () => (live ? [live] : []) };
    try { await assertNoLiveColumnLoss(conn, 'f.sql', statementsOf(sql)); return null; }
    catch (e) { return e.message; }
}

describe('decoder migration live-schema MODIFY guard @regression', function () {
    it('finds each MODIFY clause, ignoring FIRST/AFTER and other clauses', function () {
        const got = modifyClauses(statementsOf(
            'ALTER TABLE `t` MODIFY COLUMN a INT NOT NULL AFTER b, ADD COLUMN c INT, MODIFY d VARCHAR(10) DEFAULT \'x,y\';'));
        assert.deepStrictEqual(got.map(g => [g.table, g.column]), [['t', 'a'], ['t', 'd']]);
        assert.strictEqual(got[0].definition, 'INT NOT NULL');
    });

    it('refuses a MODIFY that strips AUTO_INCREMENT, a DEFAULT, ON UPDATE, COMMENT or a generation expression', async function () {
        assert.match(await verdict(liveRow({ EXTRA: 'auto_increment' }), 'ALTER TABLE t MODIFY id BIGINT UNSIGNED NOT NULL;'), /strips AUTO_INCREMENT/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'int(11)', COLUMN_DEFAULT: '0' }), 'ALTER TABLE t MODIFY n INT NOT NULL;'), /strips DEFAULT 0/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'timestamp', EXTRA: 'on update current_timestamp()' }),
            'ALTER TABLE t MODIFY u TIMESTAMP;'), /strips ON UPDATE/);
        assert.match(await verdict(liveRow({ COLUMN_COMMENT: 'why' }), 'ALTER TABLE t MODIFY n BIGINT UNSIGNED;'), /strips COMMENT/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'int(11)', EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: '`a` + 1' }),
            'ALTER TABLE t MODIFY g INT;'), /generation expression/);
    });

    it('refuses narrowing of type, length and charset', async function () {
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'bigint(20)' }), 'ALTER TABLE t MODIFY n INT;'), /narrows the type/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'varchar(64)', COLUMN_DEFAULT: "'x'" }), "ALTER TABLE t MODIFY s VARCHAR(32) DEFAULT 'x';"), /varchar\(64\) -> varchar\(32\)/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'mediumtext', CHARACTER_SET_NAME: 'utf8mb4' }),
            'ALTER TABLE t MODIFY data MEDIUMTEXT CHARACTER SET utf8mb3;'), /charset/);
    });

    it('passes a MODIFY that restates every attribute or only widens, and an absent column', async function () {
        assert.strictEqual(await verdict(liveRow({ EXTRA: 'auto_increment' }),
            'ALTER TABLE t MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;'), null);
        assert.strictEqual(await verdict(liveRow({ COLUMN_TYPE: 'text' }), 'ALTER TABLE events MODIFY COLUMN data MEDIUMTEXT;'), null);
        assert.strictEqual(await verdict(null, 'ALTER TABLE t MODIFY n INT;'), null);
        assert.strictEqual(await verdict({ dataType: 'bigint' }, 'ALTER TABLE t MODIFY n INT;'), null);
    });

    it('sees a MODIFY behind a block comment and ignores a keyword inside one', async function () {
        const live = liveRow({ COLUMN_TYPE: 'int(11)', COLUMN_DEFAULT: '0' });
        assert.match(await verdict(live, '/* widen */ ALTER TABLE t MODIFY n INT;'), /strips DEFAULT 0/);
        assert.match(await verdict(live, 'ALTER TABLE t /* note */ MODIFY n INT;'), /strips DEFAULT 0/);
        assert.match(await verdict(live, 'ALTER TABLE t MODIFY n INT /* DEFAULT dropped */;'), /strips DEFAULT 0/);
    });
});

describe('decoder migration runner applies the live-schema guard to auto files @regression', function () {
    function makeDb(live) {
        const executed = [];
        const conn = {
            async query(sql) {
                if (/GET_LOCK|RELEASE_LOCK|^SET SESSION|CREATE TABLE|schema_migrations/.test(sql)) return /GET_LOCK/.test(sql) ? [{ l: '1' }] : [];
                if (/@@SESSION\.sql_mode/.test(sql)) return [{ mode: 'STRICT_TRANS_TABLES' }];
                if (/COLUMN_DEFAULT/.test(sql)) return [live];
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-live-guard-'));
        fs.mkdirSync(path.join(root, 'migrations'));
        fs.writeFileSync(path.join(root, 'migrations', '2099-01-01-t.sql'), '-- xchain:migration mode=auto\nALTER TABLE t MODIFY s VARCHAR(64);\n');
        Object.assign(db, { sqlPath: root, dbName: 'fake_db', getConnection: async () => conn, ensureMigrationsLedger: async () => {} });
        return { db, executed };
    }

    it('refuses an auto MODIFY that would strip a live DEFAULT before running any statement', async function () {
        const { db, executed } = makeDb(liveRow({ COLUMN_TYPE: 'varchar(64)', COLUMN_DEFAULT: "'x'" }));
        await assert.rejects(() => db.runMigrations({}), /would damage the live column: strips DEFAULT/);
        assert.ok(!executed.some((s) => /^ALTER/i.test(s)), 'the MODIFY never ran');
    });
});
