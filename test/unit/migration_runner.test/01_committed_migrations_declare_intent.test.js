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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers migrationMode() header parsing and the invariant that every committed
 * migration declares its intent explicitly, so a destructive file can never
 * default-silently into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');

const modeOf = Database.prototype.migrationMode.bind({});
const scanOf = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

describe('committed migrations declare intent @regression', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    it('migrations directory is present', function () {
        assert.ok(fs.existsSync(MIG_DIR), 'expected ' + MIG_DIR);
    });

    files.forEach(function (file) {
        it(file + ': carries a runner-visible `-- xchain:migration mode=auto|manual` tag', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const anywhere = raw.match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
            assert.ok(anywhere,
                file + ' has no explicit mode tag. Every migration must declare intent so a ' +
                'destructive change can never silently auto-run at startup. Add a first line: ' +
                '`-- xchain:migration mode=auto` (additive + idempotent) or `mode=manual` (gated).');
            // The runner must actually SEE that tag. A whole-file regex passes even when
            // the tag sits below the runner's prologue window (e.g. pushed past a fixed
            // line count by the license banner), which silently gates a declared
            // mode=auto migration to the manual default. Assert the real code path agrees
            // with the declared intent so a runner-invisible tag fails CI.
            assert.strictEqual(modeOf(raw), anywhere[1].toLowerCase(),
                file + ' declares mode=' + anywhere[1].toLowerCase() + ' but the runner reads mode=' +
                modeOf(raw) + '; the tag is outside the runner-visible comment prologue. Move it into ' +
                'the leading comment block, before the first SQL statement.');
        });
    });

    files.forEach(function (file) {
        it(file + ': if tagged mode=auto, contains no destructive DDL', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const mode = modeOf(raw);
            if (mode !== 'auto') { this.skip(); return; }
            const statements = splitOf(raw);
            const offender = scanOf(statements);
            assert.strictEqual(offender, null,
                file + ' is tagged mode=auto but contains destructive DDL: ' + offender);
        });
    });

    // Apply order is lexical (readdirSync().sort() in runMigrations), so the dated
    // prefix is what makes it chronological. Freeze the single YYYY-MM-DD- form: an
    // undashed 20260612_ sequence name would sort BEFORE every dashed file ('-' 0x2D
    // < '0' 0x30) and apply out of authorship order with no runtime error. The runner
    // now throws on an undated name; this pins the committed tree to the convention.
    const DATED_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
    files.forEach(function (file) {
        it(file + ': is named with the YYYY-MM-DD- dated prefix', function () {
            assert.ok(DATED_PREFIX.test(file),
                file + ' is not dated. Apply order is lexical, so every migration filename must ' +
                'start with a YYYY-MM-DD- prefix to apply in authorship order.');
        });
    });
});
