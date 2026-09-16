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

const Database = require('../db.js')

// Applicability preconditions the runner evaluates against the LIVE schema before it
// applies a migration (see migrationPreconditionSkip). Each entry is a parameterised
// information_schema query taking the database name, plus a predicate returning a reason
// string when the migration does not apply to this database and null when it does.
//
// The guard lives HERE rather than inside the .sql file on purpose: a migration file's
// sha256 is its identity in schema_migrations, so adding a guard clause to an already
// applied file would trip the immutability check on every node that ran it, and healing
// that needs a MIGRATION_CHECKSUM_REBASELINES entry whose documented contract is that the
// executable SQL is byte-identical across pinned revisions. A runner-side predicate keeps
// both properties intact and covers every invocation route (startup, blanket
// `node src/migrate.js`, and a targeted `--file` rollout), since all three funnel through
// this loop.
Database.MIGRATION_PRECONDITIONS = {
    // DATETIME -> BIGINT UNSIGNED converter. It is mode=manual, so it stays PENDING on a
    // database created from the current dispensers.sql (already BIGINT UNSIGNED) - and the
    // documented blanket `npm run migrate` applies every pending manual file. Run against a
    // BIGINT column, its UNIX_TIMESTAMP() reads raw epoch seconds as a date-form number and
    // yields NULL for ordinary 10-digit values, after which the file drops the good column
    // and renames the all-NULL holding column over it: irrecoverable loss, and the decoder
    // then never soft-expires while the BIGINT-backed indexer still does.
    //
    // Applicable only while the column is still a date/time type. A column that is absent
    // (a crash between the DROP and the rename) is deliberately NOT baselined: that state
    // needs an operator, and assertDispenserExpirationIsBigintUnsigned fails closed on it.
    '2026-06-13-dispensers-expiration-bigint.sql': {
        sql: "SELECT DATA_TYPE AS dataType FROM information_schema.columns " +
             "WHERE table_schema = ? AND table_name = 'dispensers' AND column_name = 'expiration'",
        skipWhen: (rows) => {
            // No column, or a type we could not read: never baseline on an absent answer,
            // let the file speak for itself and the contract guard fail closed after it.
            if(!rows.length || !rows[0].dataType) return null;
            const dataType = String(rows[0].dataType).toLowerCase();
            if(dataType === 'datetime' || dataType === 'timestamp' || dataType === 'date') return null;
            return 'dispensers.expiration is already ' + dataType.toUpperCase() +
                   ', so there is no DATETIME to convert and UNIX_TIMESTAMP() would NULL every row.';
        }
    },

    // Widens pubkeys.pubkey to hold an uncompressed key (130 hex chars). It is
    // mode=manual, so it stays PENDING on a database created from the current
    // src/sql/pubkeys.sql (already VARCHAR(130) or wider), and a fresh install has no
    // narrow column to widen. Baseline only while the live column is already 130
    // characters or more, the same threshold assertPubkeyColumnIsUncompressedWide
    // enforces at startup.
    //
    // Absent table/column, or an unreadable/NULL length, is deliberately NOT
    // baselined: that state needs an operator, and the startup assertion fails
    // closed on it.
    '2026-07-24-pubkeys-widen-uncompressed.sql': {
        sql: "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns " +
             "WHERE table_schema = ? AND table_name = 'pubkeys' AND column_name = 'pubkey'",
        skipWhen: (rows) => {
            // No column, or a length we could not read: never baseline on an absent
            // answer, let the file speak for itself and the assertion fail closed after it.
            if(!rows.length || rows[0].len == null) return null;
            const len = Number(rows[0].len);
            if(Number.isNaN(len)) return null;
            if(len >= 130) return 'pubkeys.pubkey is already ' + len + ' characters wide, so there is no narrow column to widen.';
            return null;
        }
    },

    // Widens transactions.data and mempool_transactions.data from utf8mb3 to utf8mb4.
    // It is mode=manual (a charset conversion rewrites every row), so it stays PENDING
    // on a database created from the current src/sql (already utf8mb4), and a fresh
    // install has no utf8mb3 column to convert. Baseline only while BOTH columns
    // already carry the utf8mb4 charset, the same query and per-column condition
    // assertActionDataIsUtf8mb4 enforces at startup.
    //
    // A half-converted pair (one column already utf8mb4, the other not) is
    // deliberately NOT baselined: the file still has real work to do on the lagging
    // column, so it must run. Either column absent, or an unreadable/NULL charset, is
    // also NOT baselined: that state needs an operator, and the startup assertion
    // fails closed on it.
    '2026-08-10-action-data-utf8mb4.sql': {
        sql: "SELECT table_name AS tbl, character_set_name AS cs FROM information_schema.columns " +
             "WHERE table_schema = ? AND column_name = 'data' AND table_name IN ('transactions', 'mempool_transactions')",
        skipWhen: (rows) => {
            // Fewer than both columns found: never baseline on an incomplete answer,
            // let the file run and the assertion fail closed on whichever column it
            // could not see.
            if(rows.length < 2) return null;
            for(const row of rows){
                const cs = row.cs == null ? null : String(row.cs).toLowerCase();
                if(cs !== 'utf8mb4') return null;
            }
            return 'transactions.data and mempool_transactions.data are already utf8mb4, so there is no utf8mb3 column left to convert.';
        }
    },

    // FK-id -> raw-string rebuild of mempool_transactions (tx_hash_id -> tx_hash, and
    // the two address ids likewise). It DROPs the table and recreates six columns at
    // `DEFAULT CHARSET=utf8`, which is a pure loss against the current
    // src/sql/mempool_transactions.sql: `data` goes back to utf8mb3 and the `raw_data`
    // and `first_seen` columns disappear.
    //
    // It is mode=manual, so it stays PENDING forever on a database built from the
    // current src/sql, while the later files that own those three properties
    // (2026-08-10-action-data-utf8mb4.sql, 2026-08-22-mempool-first-seen.sql) are
    // already recorded and are therefore skipped. The documented blanket
    // `npm run migrate` then runs this rebuild, assertActionDataIsUtf8mb4 blocks every
    // subsequent startup, and the remedy that assertion prints cannot help: the
    // conversion file is already in the ledger and the runner will not re-run it.
    //
    // Applicable only while the pre-migration shape is live, which is exactly
    // `tx_hash_id` still present. `tx_hash` present with no `tx_hash_id` is the
    // post-migration shape and has nothing left to convert. Neither column visible, an
    // unreadable name, or BOTH present (a crash mid-rebuild, or drift) is deliberately
    // NOT baselined: an absent or ambiguous answer needs an operator, and leaving the
    // file pending is the recoverable direction.
    '2026-06-15-mempool-raw-strings.sql': {
        sql: "SELECT column_name AS col FROM information_schema.columns " +
             "WHERE table_schema = ? AND table_name = 'mempool_transactions' AND column_name IN ('tx_hash', 'tx_hash_id')",
        skipWhen: (rows) => {
            if(!rows.length) return null;
            const cols = new Set();
            for(const row of rows){
                // An unreadable name makes the whole answer ambiguous; never baseline on it.
                if(row.col == null) return null;
                cols.add(String(row.col).toLowerCase());
            }
            if(cols.has('tx_hash_id')) return null;
            if(!cols.has('tx_hash')) return null;
            return 'mempool_transactions already holds raw string columns (tx_hash present, no tx_hash_id), so this rebuild ' +
                   'has nothing to convert and would drop the table, reverting data to utf8mb3 and destroying the raw_data ' +
                   'and first_seen columns that later, already-recorded migrations own.';
        }
    },
};

// Backdating guard for the auto-apply path, mirroring xchain-indexer/src/db/index.js. Apply
// order is lexical, so a migration added with a date EARLIER than one already applied
// runs in a different position on a fresh database (in its date slot) than on an aged
// one (after the frontier), and the two schemas diverge across the fleet. Given a
// pending filename and the names already in the ledger, return the offending applied
// name when the pending file sorts before the lexical maximum of them, else null. An
// empty ledger (fresh install) never trips. Pure string logic, no DB, unit-tested
// directly.
//
// Callers must pass this ONLY auto-mode files, and that restriction is the whole
// correctness argument rather than an optimization. A mode=manual file legitimately
// sits unapplied behind the frontier for as long as the operator defers it (seven of
// the nine files here are manual), so it is indistinguishable at runtime from a
// backdated one and guarding it would hard-fail `node src/migrate.js` on every aged
// fleet DB. An auto file has no such state: it applies unattended at the first startup
// that sees it, so an unapplied auto file behind the frontier is always newly backdated.
//
// Only DATED ledger names are eligible to be the frontier. No undated decoder migration
// ever shipped, so unlike the indexer this filter heals no known row; it is kept because
// an undated name sorts ABOVE every 2026-* name in ASCII ('a' 0x61 > '2' 0x32), so one
// stray row would make the frontier a garbage maximum that every ordinary new migration
// sorts below, hard-failing migrate on exactly the aged DBs this guard must not break.
Database.backdatedFrontierViolation = function(pendingName, appliedNames){
    let frontier = null;
    for(const name of (appliedNames || [])){
        const n = String(name);
        if(!/^\d{4}-\d{2}-\d{2}-/.test(n)) continue;
        if(frontier === null || n > frontier) frontier = n;
    }
    if(frontier === null) return null;
    return (String(pendingName) < frontier) ? frontier : null;
};

// The header token that marks a migration as a DEPLOY PRECONDITION: code in this
// tree asserts it at startup, so a build carrying that assertion must not be
// deployed against a database that has not applied it. It rides on the existing
// `-- xchain:migration` directive line, next to `mode=`:
//
//   -- xchain:migration mode=manual deploy-precondition=required
//
// Only a mode=manual file needs it. An `auto` file applies itself at the first
// startup that sees it, so it can never be the missing precondition.
Database.DEPLOY_PRECONDITION_TAG = 'deploy-precondition=required';

// Migrations this tree ASSERTS at startup: the service refuses to run when the
// target database has not applied them.
//
// WHY THIS LIST EXISTS
// --------------------
// A v0.10.0 fleet deploy put five of nine decoders into Restarting(1) crash-loops.
// The three startup assertions above (assertDispenserExpirationIsBigintUnsigned,
// assertPubkeyColumnIsUncompressedWide, assertActionDataIsUtf8mb4) each require a
// mode=manual migration, and none of the three migration files carried a header the
// deploy tool could read, so nothing checked the precondition at deploy time and the
// crash-loop itself was the only thing that surfaced the requirement.
//
// The registry is the in-code half of the fix. The machine-readable half is the
// DEPLOY_PRECONDITION_TAG in each listed migration's own header, which the deploy
// tool reads out of the source tree it is about to deploy and checks against the
// target DB's schema_migrations BEFORE the container is recreated.
// test/unit/migration-preconditions.test.js keeps the halves in step: every entry
// here must exist, be mode=manual, and carry the tag.
//
// ADDING A STARTUP ASSERTION: register it here and tag its migration file, or the
// next fleet deploy discovers the requirement as a crash-loop again.
Database.STARTUP_ASSERTED_MIGRATIONS = [
    {
        file:      '2026-06-13-dispensers-expiration-bigint.sql',
        assertion: 'assertDispenserExpirationIsBigintUnsigned',
        symptom:   'Fatal decoder error: dispensers.expiration has type DATETIME but BIGINT UNSIGNED is required'
    },
    {
        file:      '2026-07-24-pubkeys-widen-uncompressed.sql',
        assertion: 'assertPubkeyColumnIsUncompressedWide',
        symptom:   'Fatal decoder error: pubkeys.pubkey holds 66 chars but VARCHAR(130) is required'
    },
    {
        file:      '2026-08-10-action-data-utf8mb4.sql',
        assertion: 'assertActionDataIsUtf8mb4',
        symptom:   'Fatal decoder error: transactions.data uses charset utf8mb3 but utf8mb4 is required'
    },
];

// Registry lookup by assertion method name. Throws rather than returning undefined:
// an assertion that names a migration nobody registered would otherwise render as
// "--file undefined" in the very error an operator reads mid-outage.
Database.startupAssertedMigrationFile = function(assertion){
    const entry = Database.STARTUP_ASSERTED_MIGRATIONS.find(m => m.assertion === assertion);
    if(!entry) throw new Error('startupAssertedMigrationFile: ' + assertion +
        ' is not registered in Database.STARTUP_ASSERTED_MIGRATIONS');
    return entry.file;
};

// Does this migration file's header declare itself a deploy precondition?
// Prologue-anchored exactly like migrationMode (the scan stops at the first
// non-blank, non-comment line), so a token buried in body prose or a data literal
// cannot arm it. Pure string logic, unit-tested directly.
//
// Twin: the deploy tool carries the same parser, because it reads these files from a
// source tree it has only cloned and cannot require this module. Keep the two in step.
Database.migrationDeclaresDeployPrecondition = function(raw){
    const prologue = [];
    for(const line of String(raw).split('\n')){
        const trimmed = line.trim();
        if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
        break;
    }
    return /^\s*--\s*xchain:migration\b[^\n]*\bdeploy-precondition\s*=\s*required\b/im.test(prologue.join('\n'));
};
