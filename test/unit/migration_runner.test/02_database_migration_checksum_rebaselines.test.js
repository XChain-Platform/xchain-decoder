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

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression', function () {

    const crypto  = require('crypto');
    const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');

    it('every rebaseline pins distinct 64-hex sha256 values (from may be a list)', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const fromList = [].concat(r.from);
            assert.ok(fromList.length >= 1, file + ': from must pin at least one hash');
            for (const from of fromList) {
                assert.match(from, /^[0-9a-f]{64}$/, file + ': from must be a sha256 hex digest');
                assert.notStrictEqual(from, r.to, file + ': from and to must differ');
            }
            assert.strictEqual(new Set(fromList).size, fromList.length,
                file + ': from list must not contain duplicates');
            assert.match(r.to, /^[0-9a-f]{64}$/, file + ': to must be a sha256 hex digest');
        }
    });

    it('the blessed files are pinned toward the committed content', function () {
        // These files' fleet-recorded checksums predate a series of comment-only
        // edits. If a rebaseline entry or one of its historical hashes is ever
        // dropped, un-healed fleet DBs go back to failing every operator migrate
        // run, so pin that each keeps at least its two original revisions. The
        // list only grows: a later comment edit appends another `from` hash.
        const blessed = [
            '2026-06-15-events-data-mediumtext.sql',
            '2026-06-17-pubkeys-add-monotonic-id.sql',
        ];
        for (const file of blessed) {
            const r = Database.MIGRATION_CHECKSUM_REBASELINES[file];
            assert.ok(r, file + ': expected a rebaseline entry');
            assert.ok([].concat(r.from).length >= 2,
                file + ': expected both historical revisions pinned');
        }
    });

    it('every rebaseline `to` hash matches the committed file content (heals TOWARD the repo, never away from it)', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const checksum = crypto.createHash('sha256').update(raw).digest('hex');
            assert.strictEqual(checksum, r.to,
                file + ': rebaseline target is stale - it must equal the current committed file sha256, ' +
                'otherwise the heal path would rewrite the ledger to a hash that still mismatches.');
        }
    });
});
