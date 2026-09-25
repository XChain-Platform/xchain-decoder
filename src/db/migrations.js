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

const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const Database = require('../db.js')
const { logger } = require('./constants.js')

function validateMigrationTargets(files, only, dir){
    // Targeted rollout: a name that matches no committed migration is almost
    // always a typo. Fail loudly (silently applying nothing would look like a
    // successful no-op run) and list what IS available.
    if(!only) return;
    if(only.size === 0)
        throw new Error('runMigrations: opts.only was provided but empty; pass at least one migration filename.');
    const known   = new Set(files);
    const unknown = [...only].filter(n => !known.has(n));
    if(unknown.length)
        throw new Error('runMigrations: --file target(s) not found in ' + dir + ': ' + unknown.join(', ') +
            '. Available: ' + files.join(', '));
}

function assertDatedMigration(file){
    // Freeze the dated-prefix convention in code (mirrors the indexer's
    // runner): apply order is lexical (readdirSync().sort()), so every
    // migration filename must start with a YYYY-MM-DD- prefix to apply in
    // authorship order. The dashed and undashed date forms do NOT
    // interleave correctly ('-' 0x2D sorts before '0' 0x30, so a dashed
    // 2026-06-17- file applies BEFORE an undashed 20260612_ one), which
    // would silently run migrations out of authorship order.
    if(!/^\d{4}-\d{2}-\d{2}-/.test(file)){
        throw new Error('runMigrations: migration "' + file + '" is not dated. Every migration ' +
            'filename must start with a YYYY-MM-DD- prefix so it applies in authorship order ' +
            '(apply order is lexical). Rename it with the authored date.');
    }
}

async function reconcileAppliedMigration(context, file, checksum){
    const recorded = context.appliedByName.get(file);
    if(recorded === checksum) return true;
    // Deliberate one-off rebaselines: an applied file whose only change
    // was a reviewed non-executable edit (e.g. a mode retag) may be
    // rebaselined here so fleets that recorded the old checksum heal
    // in place instead of failing every operator migrate run forever.
    // Both hashes are pinned, so any OTHER edit still trips the guard.
    const rebase = Database.MIGRATION_CHECKSUM_REBASELINES[file];
    // `from` is a single hash or a list: the same reviewed edit can
    // supersede several historical file revisions, and each DB recorded
    // whichever revision it applied first.
    const fromList = rebase ? [].concat(rebase.from) : [];
    if(rebase && fromList.includes(recorded) && checksum === rebase.to){
        await context.conn.query('UPDATE schema_migrations SET checksum = ? WHERE name = ?', [checksum, file]);
        logger.info('runMigrations: rebaselined checksum for ' + file + ' (reviewed retag, executable SQL unchanged).');
        return true;
    }
    // Migrations are immutable once applied. A changed checksum means
    // someone edited an applied file, so the DB is now on a schema that
    // diverges from what the committed file describes.
    const msg = 'runMigrations: ' + file + ' was already applied but its content CHANGED (checksum mismatch: recorded ' +
        recorded + ', current ' + checksum + '). Migrations are immutable once applied.';
    // Operator path (`node src/db/migrate.js`, includeManual) and opt-in strict
    // mode fail closed so a diverged schema is caught in CI / by an operator
    // instead of silently continuing. Default auto-startup stays non-fatal
    // (console.error, not warn) to avoid a surprise fleet-wide boot failure.
    // Mirrors xchain-indexer/src/db/index.js.
    if(context.includeManual || config.MIGRATION_STRICT_CHECKSUM === '1'){
        // Tailor the remedy to which branch actually fired. The operator path
        // (includeManual, `node src/db/migrate.js`) ALWAYS fails closed by design, so
        // MIGRATION_STRICT_CHECKSUM has no effect there - telling the operator to
        // clear it just loops them back to the same error. Only the passive
        // startup path opted into strict mode via MIGRATION_STRICT_CHECKSUM=1 can
        // actually be downgraded by clearing it.
        const hint = context.includeManual
            ? ' This operator run always fails closed (MIGRATION_STRICT_CHECKSUM has no' +
              ' effect here). Either revert ' + file + ' to the content matching the' +
              ' recorded checksum, or - if the edit was reviewed and changed no' +
              ' executable SQL - add a pinned Database.MIGRATION_CHECKSUM_REBASELINES' +
              ' entry mapping the recorded hash to the current one.'
            : ' Review manually (set MIGRATION_STRICT_CHECKSUM=0 / omit to downgrade to a non-fatal log).';
        throw new Error(msg + hint);
    }
    logger.error(msg + ' Continuing on the diverged schema - review manually.');
    return true;
}

async function migrationModeOrSkip(database, context, file, raw, checksum){
    const mode = database.migrationMode(raw);
    // Precondition gate: a migration listed in MIGRATION_PRECONDITIONS is
    // applicable only to a schema in a particular shape, and running it on
    // any other shape destroys data rather than converting it. Evaluate the
    // predicate against the LIVE schema and, when it says the migration does
    // not apply, record it as applied WITHOUT executing a statement.
    //
    // Baselining rather than merely skipping is what makes it stick: a skip
    // leaves the file pending forever, so every later blanket run re-enters
    // this branch and one runner change or one direct-SQL apply puts the
    // hazard back. The ledger row states what is already true - the end
    // state this migration exists to produce holds on this database.
    //
    // It runs BEFORE the mode gate deliberately, so an unattended startup
    // baselines a pending manual migration and the hazard is gone before an
    // operator ever reaches for `npm run migrate`.
    const preconditionSkip = await database.migrationPreconditionSkip(file, context.conn);
    if(preconditionSkip){
        await context.conn.query(
            'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
            [file, checksum, mode]
        );
        context.result.baselined.push(file);
        logger.info('runMigrations: BASELINED ' + file + ' (recorded as applied, no statement run): ' + preconditionSkip);
        return null;
    }
    if(mode !== 'auto' && !context.includeManual){
        logger.info('runMigrations: PENDING (gated, mode=' + mode + '): ' + file + '; apply with `node src/db/migrate.js`.');
        context.result.pending.push(file);
        return null;
    }
    return mode;
}

function guardMigrationFrontier(context, file, mode){
    // Backdating guard: the dated-prefix check above freezes the NAMING
    // convention, but nothing stopped a new file from being dated before a
    // migration the fleet already applied. Lexical apply order then puts it
    // in its date slot on a fresh DB and after the frontier on an aged one,
    // diverging the two schemas. `frontier` is the ledger state at run start
    // (appliedByName is not written during the loop, and the precondition
    // baseline above deliberately does not advance it), so files applied or
    // baselined by THIS run never move it and a resumed partial run is fine.
    // Auto files only - see Database.backdatedFrontierViolation for why a
    // deferred mode=manual file cannot be told apart from a backdated one.
    // Mirrors xchain-indexer/src/db/index.js.
    if(mode !== 'auto') return;
    const frontier = Database.backdatedFrontierViolation(file, context.appliedByName.keys());
    if(!frontier) return;
    const msg = 'runMigrations: ' + file + ' is dated BEFORE already-applied migration ' + frontier +
        ', so it would run in a different position here than on a fresh database and diverge the schema. ' +
        'Rename it with a date after ' + frontier + '.';
    // Same dual-mode contract as the checksum guard above: the operator
    // path and opt-in strict mode fail closed, passive startup logs and
    // proceeds so a backdated commit cannot black-start the fleet.
    if(context.includeManual || config.MIGRATION_STRICT_CHECKSUM === '1') throw new Error(msg);
    logger.error(msg + ' Applying it anyway at this position - review manually.');
}

async function applyMigrationFile(database, context, file, raw, checksum, mode){
    const statements = database.splitSqlStatements(raw);
    // Destructive-DDL guard: the mode tag is a human declaration; this scan is
    // the machine check behind it. A file tagged `auto` that contains DDL able
    // to lose or rename data must NEVER run unattended at startup (nor slip
    // through migrate.js under the wrong tag) - block startup with an
    // actionable error instead of executing it against every validator's DB.
    // Mirrors xchain-indexer/src/db/index.js.
    if(mode === 'auto'){
        const offender = database.destructiveAutoStatement(statements);
        if(offender){
            throw new Error('runMigrations: ' + file + ' is tagged mode=auto but contains destructive DDL: "' +
                offender.slice(0, 160) + (offender.length > 160 ? '...' : '') + '". ' +
                'Re-tag the file `-- xchain:migration mode=manual` and apply it deliberately via `node src/db/migrate.js`.');
        }
    }
    logger.info('runMigrations: applying ' + file + ' (mode=' + mode + ', ' + statements.length + ' statement(s))...');
    try {
        for(const stmt of statements){ await context.conn.query(stmt); }
    } catch(err){
        logger.error('runMigrations: FAILED applying ' + file + ': ' + (err && err.message));
        throw err;   // schema is in an unknown state; block startup
    }
    await context.conn.query(
        'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
        [file, checksum, mode]
    );
    context.result.applied.push(file);
    logger.info('runMigrations: applied ' + file);
}

async function processMigration(database, context, file){
    // Scoped run (--file): touch ONLY the targeted file(s). Report an
    // untargeted-but-unapplied file as pending so the operator still sees
    // remaining work, then leave it entirely alone: no dated-prefix check,
    // no checksum guard, no apply. A per-file rollout must never be blocked
    // by an unrelated migration's state elsewhere in the tree.
    if(context.only && !context.only.has(file)){
        if(!context.appliedByName.has(file)) context.result.pending.push(file);
        return;
    }
    assertDatedMigration(file);
    const raw = fs.readFileSync(context.dir + '/' + file, 'utf8');
    const checksum = crypto.createHash('sha256').update(raw).digest('hex');
    if(context.appliedByName.has(file) && await reconcileAppliedMigration(context, file, checksum)) return;
    const mode = await migrationModeOrSkip(database, context, file, raw, checksum);
    if(mode === null) return;
    guardMigrationFrontier(context, file, mode);
    await applyMigrationFile(database, context, file, raw, checksum, mode);
}

function assertDispenserExpirationType(rows){
    if(!rows.length) return;  // dispensers table absent: nothing created yet
    // Each branch names the remedy that actually heals ITS state. The
    // 2026-06-13 migration converts DATETIME only: pointing a drifted-integer or
    // dropped-column node at it would run UNIX_TIMESTAMP() over raw epoch seconds
    // and destroy the values, so only the DATETIME branch may name it.
    const RETYPE = ' Retype it with the decoder stopped and a backup taken: ' +
        'ALTER TABLE dispensers MODIFY expiration BIGINT UNSIGNED NULL;';
    const dataType   = (rows[0].dataType   == null) ? null : String(rows[0].dataType).toLowerCase();
    const columnType = (rows[0].columnType == null) ? ''   : String(rows[0].columnType).toLowerCase();
    if(dataType === null){
        throw new Error(
            'dispensers exists but has no `expiration` column - a half-applied expiration ' +
            'migration (the old column was dropped before the holding column was renamed). ' +
            'Re-running the migration cannot heal this (its UPDATE reads the dropped column). ' +
            'Finish the rename by hand: ' +
            'ALTER TABLE dispensers CHANGE COLUMN expiration_unix expiration BIGINT UNSIGNED NULL;'
        );
    }
    if(dataType === 'datetime' || dataType === 'timestamp' || dataType === 'date'){
        throw new Error(
            'dispensers.expiration has type ' + columnType.toUpperCase() + ' but BIGINT UNSIGNED is required ' +
            '(FROM_UNIXTIME/DATETIME silently NULLs any expiration past 2038, which the decoder then never expires). ' +
            'Run the pending migration: node src/db/migrate.js --file ' +
            Database.startupAssertedMigrationFile('assertDispenserExpirationIsBigintUnsigned')
        );
    }
    if(dataType !== 'bigint'){
        const narrower = /^(tinyint|smallint|mediumint|int)$/.test(dataType);
        throw new Error(
            'dispensers.expiration has type ' + columnType.toUpperCase() + ' but BIGINT UNSIGNED is required' +
            (narrower
                ? ' (an expiration up to 4294967295 does not fit, so writes truncate or fail here while xchain-indexer accepts them).'
                : '.') + RETYPE
        );
    }
    if(!/\bunsigned\b/.test(columnType)){
        throw new Error(
            'dispensers.expiration is a SIGNED ' + columnType.toUpperCase() + ' but BIGINT UNSIGNED is required ' +
            '(it diverges from the xchain-indexer column and from the replica schema xchain-sync feeds).' + RETYPE
        );
    }
}

module.exports = {
    async runMigrationsInner(opts = {}){
        const includeManual = !!opts.includeManual;
        const only = (opts.only == null) ? null
            : new Set([].concat(opts.only).map(s => String(s).trim()).filter(Boolean));
        const dir = this.sqlPath + '/migrations';
        const result = { applied: [], pending: [], baselined: [], lockSkipped: false };
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
        catch(e){ return result; }   // no migrations dir → nothing to do
        if(!files.length) return result;
        validateMigrationTargets(files, only, dir);

        const lockName = 'xchain_migrate_' + this.dbName;
        let conn = await this.getConnection();
        try {
            const got = await conn.query('SELECT GET_LOCK(?, 30) AS l', [lockName]);
            if(!got || !got[0] || String(got[0].l) !== '1'){
                logger.warn('runMigrations: could not acquire lock ' + lockName + ' (another process is migrating). Skipping this run.');
                // Flag the skip so callers do NOT read the empty applied/pending shape as a
                // completed run. The operator CLI must not print "done" and exit 0 when nothing
                // was even examined; the schema may still be un-migrated.
                result.lockSkipped = true;
                return result;
            }
            try {
                await this.ensureMigrationsLedger(conn);
                const appliedRows = await conn.query('SELECT name, checksum FROM schema_migrations');
                const context = {
                    includeManual, only, dir, result, conn,
                    appliedByName: new Map(appliedRows.map(r => [r.name, r.checksum])),
                };
                for(const file of files) await processMigration(this, context, file);
            } finally {
                try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch(_){}
            }
        } finally {
            try { await conn.release(); } catch(_){}
        }
        if(result.applied.length) logger.info('runMigrations: ' + result.applied.length + ' migration(s) applied to ' + this.dbName + '.');
        if(result.pending.length) logger.info('runMigrations: ' + result.pending.length + ' manual migration(s) pending for ' + this.dbName + '; run `node src/db/migrate.js` to apply.');
        return result;
    },
    // Evaluate a migration's declared precondition against the live schema. Returns a
    // human reason string when the migration does NOT apply to this database (the caller
    // baselines it), or null when it should run. Files with no entry always run.
    // Runs on the caller's migration connection so it stays inside the migration lock.
    async migrationPreconditionSkip(file, conn){
        const pre = Database.MIGRATION_PRECONDITIONS[file];
        if(!pre) return null;
        const rows = await conn.query(pre.sql, [this.dbName]);
        return pre.skipWhen(rows || []);
    },

    // Assert that dispensers.expiration is exactly BIGINT UNSIGNED. The DISPENSER parser
    // accepts a raw unix expiration up to Number.MAX_SAFE_INTEGER and xchain-indexer holds
    // the same field as BIGINT UNSIGNED, so anything narrower or signed is fleet drift the
    // guard exists to catch: a signed BIGINT loses nothing today but rejects nothing either,
    // while INT / INT UNSIGNED either fail the write under a strict sql_mode or truncate
    // under a lax one, on a column xchain-sync replicates to validators. Checking only
    // DATA_TYPE let all three through while the error text claimed BIGINT UNSIGNED was
    // required, so COLUMN_TYPE (which carries the width and the unsigned attribute) is
    // what is read now.
    //
    // The LEFT JOIN from information_schema.tables separates the two skip-shaped cases the
    // old single-table query merged: no row at all means the dispensers table does not exist
    // yet (fresh install before verifyTables; skip), while a row with a NULL DATA_TYPE means
    // the table exists WITHOUT the column, which is real drift (a half-applied
    // 2026-06-13 expiration migration, dropped-but-not-renamed) and fails closed.
    async assertDispenserExpirationIsBigintUnsigned(){
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "SELECT c.DATA_TYPE AS dataType, c.COLUMN_TYPE AS columnType " +
                "FROM information_schema.tables t " +
                "LEFT JOIN information_schema.columns c " +
                "  ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'expiration' " +
                "WHERE t.table_schema = ? AND t.table_name = 'dispensers'",
                [this.dbName]
            );
            assertDispenserExpirationType(rows);
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },

    // Assert that pubkeys.pubkey is wide enough for an UNCOMPRESSED key (65 bytes ->
    // 130 hex chars). extractPubkeyFromInput emits both forms, so a DB still at the
    // older compressed-only VARCHAR(66) either fails the INSERT (errno 1406 under a
    // strict sql_mode) or truncates to 66 chars under a lax one, and the decoder->indexer
    // seam field source_pubkey ends up NULL or corrupted with the branch chosen by
    // the server's sql_mode rather than by chain data. The widen is mode=manual, so
    // the startup drift reconciler cannot heal it (alterTableForDrift only ADDS
    // columns and RELAXES nullability, never changes width) and a scoped --file
    // rollout can leave a fleet half-migrated with no operator signal. Fail closed
    // here, exactly as the dispensers.expiration contract does. Skips silently when
    // the column is absent (table not created yet).
    async assertPubkeyColumnIsUncompressedWide(){
        const UNCOMPRESSED_PUBKEY_HEX_LENGTH = 130;
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns WHERE table_schema = ? AND table_name = 'pubkeys' AND column_name = 'pubkey'",
                [this.dbName]
            );
            if(!rows.length) return;  // column absent: table may not exist yet
            const len = rows[0].len == null ? null : Number(rows[0].len);
            // A non-character type reports NULL here; that is a schema shape this
            // guard cannot reason about, so leave it to the column's own contract.
            if(len == null || Number.isNaN(len)) return;
            if(len < UNCOMPRESSED_PUBKEY_HEX_LENGTH){
                throw new Error(
                    'pubkeys.pubkey holds ' + len + ' chars but VARCHAR(' + UNCOMPRESSED_PUBKEY_HEX_LENGTH + ') is required ' +
                    'for uncompressed keys; narrower silently NULLs or truncates the source_pubkey seam field. ' +
                    'Run the pending migration: node src/db/migrate.js --file ' +
                    Database.startupAssertedMigrationFile('assertPubkeyColumnIsUncompressedWide')
                );
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },
}
