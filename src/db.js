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
 *
 * XChain Decoder - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

const mariadb = require('mariadb');
const fs      = require('fs');
const util    = require('./util')

const SATOSHIS_DECIMALS = 8
const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/

// MariaDB errnos for a write rejection that is a pure function of the row bytes + schema,
// i.e. deterministic: it fails identically on every instance and will never succeed on a
// retry. Distinguished from transient errors (deadlock 1213, lock-wait 1205, lost
// connection 2006/2013, query timeout) so the block loop can quarantine a poison row
// instead of retrying it forever. 1366=incorrect string value (e.g. a 4-byte UTF-8 char
// on a utf8mb3 column), 1406=data too long, 1264=out of range, 1265=data truncated,
// 1292=truncated wrong value.
const DETERMINISTIC_WRITE_ERRNOS = new Set([1366, 1406, 1264, 1265, 1292])

const DEFAULT_QUERY_TIMEOUT_MS = 30000

// Resolve DB_QUERY_TIMEOUT into the pool's queryTimeout option. An explicit 0
// disables the timeout entirely (mariadb treats 0 as "no timeout"), which the
// old `parseInt(...) || 30000` pattern silently turned back into the 30s cap.
// Unset, non-numeric, or negative values fall back to the default.
function resolveQueryTimeout(raw, defaultMs = DEFAULT_QUERY_TIMEOUT_MS) {
    const parsed = parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 0) return defaultMs
    return parsed
}

class Database {
    constructor(host, port, dbName, user, pass){
        if (!DB_NAME_REGEX.test(dbName)) {
            throw new Error('Invalid database name: must contain only alphanumeric characters and underscores')
        }
        this.sqlPath  = __dirname+'/sql';
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        this.DUPLICATED_TRANSACTION = 1
        // Distinct from `false` (transient write failure -> retry the block): a row that
        // deterministically cannot be inserted as-is (content/constraint rejection). The
        // block loop quarantines the tx after a few retries instead of retrying forever.
        this.POISON_ROW = 2
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            connectionLimit:  10,
            insertIdAsNumber: true,
            queryTimeout:     resolveQueryTimeout(process.env.DB_QUERY_TIMEOUT)
        };
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
        this._transactionLock = false;
        this._transactionLockQueue = [];
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    

    // Seam over the driver: mariadb's createConnection export is
    // non-configurable, so tests stub this method instead of the module.
    _createConnection(connectionParams){
        return mariadb.createConnection(connectionParams);
    }

    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        // Bounded retry (~75s of patience) so a wrong DECODER_DB_USER/DECODER_DB_PASS or an
        // otherwise-unreachable MariaDB fails loud at startup instead of wedging the process
        // in an unbounded loop the container restart policy can never recycle. Matches the
        // getConnection() retry shape; a slow-starting MariaDB sidecar still boots normally.
        let attempts = 0;
        const maxAttempts = 15;
        while(true){
            try {
                let db     = await this._createConnection(connectionParams);
                let result = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(result.length > 0)
                    return true;
                return false;
            } catch (e){
                attempts++;
                if(attempts >= maxAttempts)
                    throw new Error('Failed to verify database ' + this.dbName + ' after ' + maxAttempts + ' attempts: ' + (e.code || e.message));
                console.error('Error checking if database ' + this.dbName + ' exists (attempt ' + attempts + '/' + maxAttempts + '):', e)
                await util.sleep(5000);
            }
        }
    }

    async createDatabase(){
        // First time connecting, do not specify database name or we throw error
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        let databaseCreated = false;
        console.log("Creating " + this.dbName + " database!");
        // Bounded retry (~75s of patience): see verifyDatabase above. A persistent auth or
        // config failure throws so the process exits and the container can be restarted,
        // rather than looping and re-logging the same error forever.
        let attempts = 0;
        const maxAttempts = 15;
        while(!databaseCreated){
            try {
                let db     = await this._createConnection(connectionParams);
                let result = await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                databaseCreated = true;
            } catch(e){
                attempts++;
                if(attempts >= maxAttempts)
                    throw new Error('Failed to create database ' + this.dbName + ' after ' + maxAttempts + ' attempts: ' + (e.code || e.message));
                console.error('Error creating database ' + this.dbName + ' (attempt ' + attempts + '/' + maxAttempts + '):', e)
                await util.sleep(5000);
            }
        }
        return true;
    }
    
    async verifyTables(){
        let path  = this.sqlPath;
        let files = fs.readdirSync(path);
        let file  = null;
        let db    = await this.getConnection();
        // Snapshot the set of tables currently in this database. SHOW TABLES is a
        // direct query (no parameter binding quirks) and gives a clean per-DB list,
        // so the existence check below is reliable on a fresh DB.
        let existing = new Set();
        try {
            let rows = await db.query("SHOW TABLES FROM `" + this.dbName + "`");
            for (let row of rows){
                // SHOW TABLES returns one column named "Tables_in_<dbname>".
                for (let key in row){
                    existing.add(String(row[key]));
                    break;
                }
            }
        } catch(e){
            console.log('Error listing tables in ' + this.dbName + ': ' + (e && e.sqlMessage ? e.sqlMessage : e));
            util.throwError('Error while listing tables in ' + this.dbName);
            try { await db.release(); } catch(_){}
            return false;
        }
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        console.log('Verifying database and tables...');
        let checked = 0;
        let created = 0;
        try {
            for (file of files){
                // indexOf returns -1 when '.sql' is absent (e.g. the migrations/ subdirectory).
                // -1 is truthy, so the old `if(isSql)` processed non-.sql entries and tried to
                // read a directory as a table (EISDIR). Only process actual .sql files.
                var isSql = file.indexOf('.sql');
                if(isSql !== -1){
                    let table   = file.substring(0, file.indexOf('.sql'));
                    checked++;
                    try {
                        if(existing.has(table)){
                            // Existing table: reconcile column drift against the SQL
                            // source so columns added upstream (e.g. transactions.raw_data)
                            // are auto-applied on stacks created from an older release,
                            // instead of surfacing later as a hard "Unknown column" error.
                            await this.alterTableForDrift(file, db);
                            // Also reconcile declared indexes. A UNIQUE index added to
                            // the SQL source AFTER a table was first created is otherwise
                            // never applied to existing databases, which silently degrades
                            // any INSERT ... ON DUPLICATE KEY UPDATE relying on it to a
                            // plain INSERT and accumulates duplicate rows.
                            await this.reconcileTableIndexes(file, db);
                        } else {
                            await this.createTable(file, db);
                            existing.add(table);
                            created++;
                        }
                    } catch(e){
                        console.log('Error verifying table ' + table + ': ' + e.code);
                        util.throwError('Error while trying to verify ' + table + ' table exists!');
                        return false;
                    }
                }
            }
        } finally {
            // This is a direct pool lease (transactionConnection is null at startup),
            // so releaseConnection() (which only releases transactionConnection)
            // would be a no-op. Release the lease itself, or a fresh-DB boot leaks
            // one connection per created table plus this one and exhausts the pool.
            try { await db.release(); } catch(_){}
        }
        console.log('Database and tables verified (' + checked + ' tables, ' + created + ' created).');
        return true;
    }

    // Apply tracked, ordered schema migrations from src/sql/migrations/: the changes the
    // startup drift reconciler deliberately will not make on its own (data backfills,
    // destructive index/column changes, dedup-then-unique, type changes). Each file is
    // applied at most once and recorded in the `schema_migrations` ledger, so this is safe
    // to call on every startup.
    //
    // A migration opts into unattended application with a header tag in its comment prologue:
    //   -- xchain:migration mode=auto     applied automatically at startup
    //   -- xchain:migration mode=manual   applied only by an explicit operator run
    // An untagged file is treated as `manual` (unknown DDL never auto-runs). `auto` files
    // must be additive and idempotent (guard with IF [NOT] EXISTS); anything that can fail
    // on existing data must be `manual`.
    //
    // opts.includeManual=true also applies pending `manual` migrations (the operator path,
    // node src/migrate.js). The run holds a DB-scoped advisory lock so concurrent processes
    // cannot apply the same file twice. Returns { applied, pending }.
    //
    // opts.only (string | string[]) scopes the run to specific filenames: the per-file fleet
    // rollout path (migrate.js --file), where one pending manual migration is deployed
    // without a blanket run also applying every other pending file. A scoped run is
    // deliberately NOT gated on unrelated files' dated-prefix / checksum state, so an
    // unrelated tree quirk can never block the targeted rollout; an unknown target fails
    // loudly rather than applying nothing.
    //
    // The wrapper always runs the schema-contract assertions after the body, so the
    // fail-closed guards a mode=manual migration owns fire even when the body early-returns
    // (no migrations dir, empty dir, lock contention). A throwing body is already failing
    // loudly, so the assertions are skipped there.
    async runMigrations(opts = {}){
        const result = await this._runMigrationsInner(opts);
        await this._assertDispenserExpirationIsBigintUnsigned();
        await this._assertPubkeyColumnIsUncompressedWide();
        await this._assertActionDataIsUtf8mb4();
        return result;
    }

    async _runMigrationsInner(opts = {}){
        const crypto        = require('crypto');
        const includeManual = !!opts.includeManual;
        const only          = (opts.only == null) ? null
            : new Set([].concat(opts.only).map(s => String(s).trim()).filter(Boolean));
        const dir           = this.sqlPath + '/migrations';
        const result        = { applied: [], pending: [], baselined: [], lockSkipped: false };

        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
        catch(e){ return result; }   // no migrations dir → nothing to do
        if(!files.length) return result;

        // Targeted rollout: a name that matches no committed migration is almost
        // always a typo. Fail loudly (silently applying nothing would look like a
        // successful no-op run) and list what IS available.
        if(only){
            if(only.size === 0)
                throw new Error('runMigrations: opts.only was provided but empty; pass at least one migration filename.');
            const known   = new Set(files);
            const unknown = [...only].filter(n => !known.has(n));
            if(unknown.length)
                throw new Error('runMigrations: --file target(s) not found in ' + dir + ': ' + unknown.join(', ') +
                    '. Available: ' + files.join(', '));
        }

        const lockName = 'xchain_migrate_' + this.dbName;
        let conn = await this.getConnection();
        try {
            const got = await conn.query('SELECT GET_LOCK(?, 30) AS l', [lockName]);
            if(!got || !got[0] || String(got[0].l) !== '1'){
                console.warn('runMigrations: could not acquire lock ' + lockName + ' (another process is migrating). Skipping this run.');
                // Flag the skip so callers do NOT read the empty applied/pending shape as a
                // completed run. The operator CLI must not print "done" and exit 0 when nothing
                // was even examined; the schema may still be un-migrated.
                result.lockSkipped = true;
                return result;
            }
            try {
                await this._ensureMigrationsLedger(conn);
                const appliedRows   = await conn.query('SELECT name, checksum FROM schema_migrations');
                const appliedByName = new Map(appliedRows.map(r => [r.name, r.checksum]));

                for(const file of files){
                    // Scoped run (--file): touch ONLY the targeted file(s). Report an
                    // untargeted-but-unapplied file as pending so the operator still sees
                    // remaining work, then leave it entirely alone: no dated-prefix check,
                    // no checksum guard, no apply. A per-file rollout must never be blocked
                    // by an unrelated migration's state elsewhere in the tree.
                    if(only && !only.has(file)){
                        if(!appliedByName.has(file)) result.pending.push(file);
                        continue;
                    }
                    // Freeze the dated-prefix convention in code (mirrors the indexer's
                    // runner): apply order is lexical (readdirSync().sort()), so every
                    // migration filename must start with a YYYY-MM-DD- prefix to apply in
                    // authorship order. The two forms the README used to sanction do NOT
                    // interleave correctly ('-' 0x2D sorts before '0' 0x30, so a dashed
                    // 2026-06-17- file applies BEFORE an undashed 20260612_ one), which
                    // would silently run migrations out of authorship order.
                    if(!/^\d{4}-\d{2}-\d{2}-/.test(file)){
                        throw new Error('runMigrations: migration "' + file + '" is not dated. Every migration ' +
                            'filename must start with a YYYY-MM-DD- prefix so it applies in authorship order ' +
                            '(apply order is lexical). Rename it with the authored date.');
                    }
                    const raw      = fs.readFileSync(dir + '/' + file, 'utf8');
                    const checksum = crypto.createHash('sha256').update(raw).digest('hex');

                    if(appliedByName.has(file)){
                        if(appliedByName.get(file) !== checksum){
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
                            if(rebase && fromList.includes(appliedByName.get(file)) && checksum === rebase.to){
                                await conn.query('UPDATE schema_migrations SET checksum = ? WHERE name = ?', [checksum, file]);
                                console.log('runMigrations: rebaselined checksum for ' + file + ' (reviewed retag, executable SQL unchanged).');
                                continue;
                            }
                            // Migrations are immutable once applied. A changed checksum means
                            // someone edited an applied file, so the DB is now on a schema that
                            // diverges from what the committed file describes.
                            const msg = 'runMigrations: ' + file + ' was already applied but its content CHANGED (checksum mismatch: recorded ' +
                                appliedByName.get(file) + ', current ' + checksum + '). Migrations are immutable once applied.';
                            // Operator path (`node src/migrate.js`, includeManual) and opt-in strict
                            // mode fail closed so a diverged schema is caught in CI / by an operator
                            // instead of silently continuing. Default auto-startup stays non-fatal
                            // (console.error, not warn) to avoid a surprise fleet-wide boot failure.
                            // Mirrors xchain-indexer/src/db.js.
                            if(includeManual || process.env.MIGRATION_STRICT_CHECKSUM === '1'){
                                // Tailor the remedy to which branch actually fired. The operator path
                                // (includeManual, `node src/migrate.js`) ALWAYS fails closed by design, so
                                // MIGRATION_STRICT_CHECKSUM has no effect there - telling the operator to
                                // clear it just loops them back to the same error. Only the passive
                                // startup path opted into strict mode via MIGRATION_STRICT_CHECKSUM=1 can
                                // actually be downgraded by clearing it.
                                const hint = includeManual
                                    ? ' This operator run always fails closed (MIGRATION_STRICT_CHECKSUM has no' +
                                      ' effect here). Either revert ' + file + ' to the content matching the' +
                                      ' recorded checksum, or - if the edit was reviewed and changed no' +
                                      ' executable SQL - add a pinned Database.MIGRATION_CHECKSUM_REBASELINES' +
                                      ' entry mapping the recorded hash to the current one.'
                                    : ' Review manually (set MIGRATION_STRICT_CHECKSUM=0 / omit to downgrade to a non-fatal log).';
                                throw new Error(msg + hint);
                            }
                            console.error(msg + ' Continuing on the diverged schema - review manually.');
                        }
                        continue;
                    }

                    const mode = this._migrationMode(raw);

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
                    const preconditionSkip = await this._migrationPreconditionSkip(file, conn);
                    if(preconditionSkip){
                        await conn.query(
                            'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
                            [file, checksum, mode]
                        );
                        result.baselined.push(file);
                        console.log('runMigrations: BASELINED ' + file + ' (recorded as applied, no statement run): ' + preconditionSkip);
                        continue;
                    }

                    if(mode !== 'auto' && !includeManual){
                        console.log('runMigrations: PENDING (gated, mode=' + mode + '): ' + file + '; apply with `node src/migrate.js`.');
                        result.pending.push(file);
                        continue;
                    }

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
                    // Mirrors xchain-indexer/src/db.js.
                    if(mode === 'auto'){
                        const frontier = Database.backdatedFrontierViolation(file, appliedByName.keys());
                        if(frontier){
                            const msg = 'runMigrations: ' + file + ' is dated BEFORE already-applied migration ' + frontier +
                                ', so it would run in a different position here than on a fresh database and diverge the schema. ' +
                                'Rename it with a date after ' + frontier + '.';
                            // Same dual-mode contract as the checksum guard above: the operator
                            // path and opt-in strict mode fail closed, passive startup logs and
                            // proceeds so a backdated commit cannot black-start the fleet.
                            if(includeManual || process.env.MIGRATION_STRICT_CHECKSUM === '1') throw new Error(msg);
                            console.error(msg + ' Applying it anyway at this position - review manually.');
                        }
                    }

                    const statements = this.splitSqlStatements(raw);
                    // Destructive-DDL guard: the mode tag is a human declaration; this scan is
                    // the machine check behind it. A file tagged `auto` that contains DDL able
                    // to lose or rename data must NEVER run unattended at startup (nor slip
                    // through migrate.js under the wrong tag) - block startup with an
                    // actionable error instead of executing it against every validator's DB.
                    // Mirrors xchain-indexer/src/db.js.
                    if(mode === 'auto'){
                        const offender = this._destructiveAutoStatement(statements);
                        if(offender){
                            throw new Error('runMigrations: ' + file + ' is tagged mode=auto but contains destructive DDL: "' +
                                offender.slice(0, 160) + (offender.length > 160 ? '...' : '') + '". ' +
                                'Re-tag the file `-- xchain:migration mode=manual` and apply it deliberately via `node src/migrate.js`.');
                        }
                    }
                    console.log('runMigrations: applying ' + file + ' (mode=' + mode + ', ' + statements.length + ' statement(s))...');
                    try {
                        for(const stmt of statements){ await conn.query(stmt); }
                    } catch(err){
                        console.error('runMigrations: FAILED applying ' + file + ': ' + (err && err.message));
                        throw err;   // schema is in an unknown state; block startup
                    }
                    await conn.query(
                        'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
                        [file, checksum, mode]
                    );
                    result.applied.push(file);
                    console.log('runMigrations: applied ' + file);
                }
            } finally {
                try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch(_){}
            }
        } finally {
            try { await conn.release(); } catch(_){}
        }

        if(result.applied.length) console.log('runMigrations: ' + result.applied.length + ' migration(s) applied to ' + this.dbName + '.');
        if(result.pending.length) console.log('runMigrations: ' + result.pending.length + ' manual migration(s) pending for ' + this.dbName + '; run `node src/migrate.js` to apply.');

        return result;
    }

    // Evaluate a migration's declared precondition against the live schema. Returns a
    // human reason string when the migration does NOT apply to this database (the caller
    // baselines it), or null when it should run. Files with no entry always run.
    // Runs on the caller's migration connection so it stays inside the migration lock.
    async _migrationPreconditionSkip(file, conn){
        const pre = Database.MIGRATION_PRECONDITIONS[file];
        if(!pre) return null;
        const rows = await conn.query(pre.sql, [this.dbName]);
        return pre.skipWhen(rows || []);
    }

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
    async _assertDispenserExpirationIsBigintUnsigned(){
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
                    'Run the pending migration: node src/migrate.js --file 2026-06-13-dispensers-expiration-bigint.sql'
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
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    }

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
    async _assertPubkeyColumnIsUncompressedWide(){
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
                    'Run the pending migration: node src/migrate.js'
                );
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    }

    // Assert that the decoded-ACTION text columns hold the full UTF-8 range. The encoder
    // validates and emits any valid UTF-8 (a four-byte emoji in a MEMO), and a utf8mb3
    // column rejects that with errno 1366, which DETERMINISTIC_WRITE_ERRNOS classifies as
    // POISON_ROW, so the fee-paid tx is quarantined with no ACTION row. `transactions` is
    // part of the xchain-sync replicated set, so an un-migrated node quarantines what a
    // migrated node stores and the fleet diverges on chain state rather than merely
    // lagging. The widen is mode=manual (a charset conversion rewrites every row), and
    // alterTableForDrift never changes an existing column's type, so nothing heals this
    // automatically. Fail closed here, exactly as the pubkeys.pubkey contract does. Skips
    // silently when a column is absent (table not created yet).
    async _assertActionDataIsUtf8mb4(){
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "SELECT table_name AS tbl, character_set_name AS cs FROM information_schema.columns " +
                "WHERE table_schema = ? AND column_name = 'data' AND table_name IN ('transactions', 'mempool_transactions')",
                [this.dbName]
            );
            for(const row of rows){
                // A non-character type reports NULL here; that is a shape this guard
                // cannot reason about, so leave it to the column's own contract.
                const cs = row.cs == null ? null : String(row.cs).toLowerCase();
                if(cs == null) continue;
                if(cs !== 'utf8mb4'){
                    throw new Error(
                        String(row.tbl) + '.data uses charset ' + cs + ' but utf8mb4 is required; a non-BMP ' +
                        'ACTION (e.g. an emoji MEMO) is rejected with errno 1366 and the fee-paid transaction ' +
                        'is quarantined with no ACTION row, diverging this node from a migrated one. ' +
                        'Run the pending migration: node src/migrate.js'
                    );
                }
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    }

    // Read a migration file's `-- xchain:migration mode=auto|manual` header tag.
    // Defaults to 'manual' when absent (conservative: unknown DDL never auto-runs).
    _migrationMode(raw){
        // The mode tag is a leading-prologue directive: it may only sit in the run of
        // blank and `--`-comment lines BEFORE the first SQL statement. Scanning the whole
        // file would let a `mode=auto` token buried in body prose or a data literal arm
        // auto-apply for a destructive migration; a fixed first-N-lines window is too
        // tight, because the multi-line license banner pushes the tag past it and the
        // migration then silently reads as the `manual` default. Anchoring to the
        // prologue keeps both properties at any banner length.
        const lines    = String(raw).split('\n');
        const prologue = [];
        for(const line of lines){
            const trimmed = line.trim();
            if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
            break;   // first non-blank, non-comment line ends the prologue
        }
        const m = prologue.join('\n').match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
        return m ? m[1].toLowerCase() : 'manual';
    }

    // Destructive-DDL scan for the auto-apply path. Given a migration file's
    // statement list (already line-comment-stripped and ';'-split), returns the
    // first statement that can lose, truncate, or rename data - or null when the
    // file is safe to auto-run. Pure string logic (no DB), unit-tested directly.
    // Byte-for-byte the same classifier as xchain-indexer/src/db.js so the two
    // migration runners stay legible as a pair.
    //
    // Flagged as destructive: DROP TABLE/DATABASE/SCHEMA, TRUNCATE, RENAME TABLE,
    // DELETE (any form), REPLACE INTO (atomic DELETE+INSERT), INSERT ... ON DUPLICATE
    // KEY UPDATE (rewrites every colliding row), LOAD DATA (rows from a file the
    // scanner cannot read), UPDATE (except the
    // committed AUTO_INCREMENT id=0 repair),
    // ALTER TABLE ... DROP <column|partition|bare identifier>,
    // ALTER TABLE ... RENAME (except RENAME INDEX/KEY), ALTER TABLE ... CHANGE
    // (rename+retype), MODIFY ... NOT NULL (the statically detectable
    // narrowing; a width reduction cannot be seen without the live schema and
    // stays covered by the manual-tag convention), and any ALTER TABLE PARTITION or
    // TABLESPACE clause.
    //
    // Deliberately NOT flagged (legitimate existing auto patterns): DROP INDEX/KEY,
    // DROP FOREIGN KEY/CONSTRAINT/CHECK/DEFAULT/PRIMARY KEY (structural, no row
    // data lost), ADD ..., plain CREATE TABLE / CREATE TABLE IF NOT EXISTS (additive;
    // but CREATE OR REPLACE TABLE IS flagged - it is an atomic DROP+CREATE), and
    // MODIFY that widens/nullables a column.
    _destructiveAutoStatement(statements){
        // Drops that remove metadata only; anything else after DROP inside an
        // ALTER (COLUMN, PARTITION, or a bare column identifier) loses data.
        const SAFE_ALTER_DROP = new Set(['INDEX', 'KEY', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'DEFAULT', 'PRIMARY']);
        // True when a `#` sits outside every quoted span - a line comment
        // stripSqlLineComments should already have removed. Quote-aware so a `#`
        // inside a string literal or a backtick identifier is not mistaken for one.
        // Local rather than a method: runMigrations' callers build partial `this`
        // objects, and a second prototype hop would break the guard on those.
        const hasUnquotedHash = (s) => {
            let q = null;
            for(let i = 0; i < s.length; i++){
                const c = s[i];
                if(q){
                    if(c === q){
                        if(s[i + 1] === q){ i++; }
                        else { q = null; }
                    }
                    continue;
                }
                if(c === "'" || c === '"' || c === '`'){ q = c; continue; }
                if(c === '#') return true;
            }
            return false;
        };
        for(const raw of (statements || [])){
            // Executable (versioned) comments are the one /* */ form the server RUNS:
            // MariaDB/MySQL execute `/*!50000 DROP TABLE balances */` and `/*M! ... */`
            // verbatim, and splitSqlStatements strips only `--` lines, so the payload
            // reaches conn.query intact. The block-comment strip below would delete it
            // before any keyword check, scoring the file safe and auto-running the DROP.
            // Same class as the PREPARE/EXECUTE/CALL forms below - the server does
            // something a prefix classifier cannot see - and no committed auto migration
            // uses one, so treat any statement carrying one as non-auto-eligible.
            if(/\/\*(?:!|M!)/i.test(String(raw)))                return raw;
            // Belt-and-braces: strip /* */ block comments (line comments are already
            // gone) so a keyword inside comment prose never triggers or hides a hit.
            const stmt = String(raw).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
            if(!stmt) continue;
            // Second layer behind stripSqlLineComments: MariaDB/MySQL honour `#` to
            // end-of-line as a comment, so `# note\nDROP TABLE balances` is a DROP every
            // ^-anchored check below is blind to. The strip removes it upstream; if one
            // ever reaches here the strip has regressed, and the only safe reading of a
            // comment introducer the classifier can still see is non-auto-eligible.
            if(hasUnquotedHash(stmt))                            return raw;
            // Server-side indirection escapes a statement-prefix classifier: a mode=auto
            // file can smuggle destructive SQL past every keyword check below via dynamic
            // SQL (`SET @s = 'DROP TABLE balances'; PREPARE stmt FROM @s; EXECUTE stmt;`)
            // or a `CALL proc()` whose body the scanner cannot see. None of these are used
            // by any committed auto migration, so treat them as non-auto-eligible. SET of a
            // user variable (`SET @s = ...`) exists to stage dynamic SQL for PREPARE, so
            // flag it too - but NOT system-variable SETs (`SET NAMES ...`, `SET sql_mode
            // = ...`, `SET @@session...`), which are benign and stay auto-eligible.
            if(/^PREPARE\b/i.test(stmt))                         return raw;
            if(/^EXECUTE\b/i.test(stmt))                         return raw;
            if(/^CALL\b/i.test(stmt))                            return raw;
            if(/^SET\s+@(?!@)/i.test(stmt))                      return raw;
            if(/^DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(stmt))  return raw;
            // CREATE OR REPLACE TABLE is an atomic DROP TABLE IF EXISTS + CREATE: it destroys
            // every existing row. Plain CREATE TABLE / CREATE TABLE IF NOT EXISTS are additive
            // and stay unflagged (see the CREATE note below); only the OR REPLACE form loses
            // data. DROP TABLE is already flagged, so an author must not be able to slip the
            // data-losing idempotent-create variant past the auto guard.
            if(/^CREATE\s+OR\s+REPLACE\s+(TEMPORARY\s+)?TABLE\b/i.test(stmt)) return raw;
            if(/^TRUNCATE\b/i.test(stmt))                        return raw;
            if(/^RENAME\s+TABLE\b/i.test(stmt))                  return raw;
            // Any DELETE removes row data - there is no non-destructive form - so match the
            // bare keyword, not `DELETE FROM`. The narrower form let valid-but-non-canonical
            // syntax slip the auto guard: `DELETE LOW_PRIORITY FROM`, `DELETE IGNORE FROM`,
            // and multi-table `DELETE t1 FROM t1 JOIN t2 ...` all delete rows yet omit an
            // immediate FROM. No false positive: a statement starting with DELETE is always DML.
            if(/^DELETE\b/i.test(stmt))                          return raw;
            // REPLACE INTO is an atomic DELETE+INSERT on every existing-key row it
            // touches - the same data-loss profile as DELETE, with no non-destructive
            // form - so match the bare keyword like DELETE above.
            if(/^REPLACE\b/i.test(stmt))                         return raw;
            // INSERT ... ON DUPLICATE KEY UPDATE overwrites columns of every existing
            // duplicate-key row it touches - the same data-rewrite profile the UPDATE arm
            // below hard-blocks, reached from a keyword that arm never sees. Plain INSERT
            // stays auto-eligible: with no ON DUPLICATE clause it only adds rows.
            if(/^INSERT\b[\s\S]*\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stmt)) return raw;
            // LOAD DATA ... REPLACE INTO TABLE is a DELETE+INSERT on every key collision,
            // and the rows come from a file the classifier cannot read, so no form of it
            // can be judged safe from the statement text. No committed auto migration
            // loads a file; treat the whole form as non-auto-eligible.
            if(/^LOAD\s+DATA\b/i.test(stmt))                     return raw;
            // A bare UPDATE can rewrite arbitrary row data. The one committed auto
            // pattern is the AUTO_INCREMENT id repair (`UPDATE <table> SET id = (...)
            // WHERE id = 0;` in 2026-06-10-mirror-id-autoincrement-repair.sql), which
            // touches only the sentinel id=0 row; carve exactly that shape out and
            // flag every other UPDATE.
            if(/^UPDATE\b/i.test(stmt) && !this._isIdRepairUpdate(stmt)) return raw;
            if(/^ALTER\s+TABLE\b/i.test(stmt)){
                // Partition and tablespace clauses move or discard row data while carrying
                // none of the keywords the checks below look for: TRUNCATE PARTITION empties
                // a partition, EXCHANGE PARTITION swaps its rows out to another table,
                // DISCARD TABLESPACE deletes the table's data file. The additive members of
                // the class (ADD PARTITION, IMPORT TABLESPACE) are not separable from the
                // destructive ones by prefix, and no committed migration partitions anything,
                // so the whole class is non-auto-eligible - re-tag mode=manual to run one.
                if(/\bPARTITION(?:ING)?\b/i.test(stmt))          return raw;
                if(/\bTABLESPACE\b/i.test(stmt))                 return raw;
                // Every DROP inside the ALTER must target a safe (metadata-only) object.
                let m;
                const dropRe = /\bDROP\s+([A-Za-z_]+|`[^`]+`)/gi;
                while((m = dropRe.exec(stmt)) !== null){
                    const target = m[1].replace(/`/g, '').toUpperCase();
                    if(!SAFE_ALTER_DROP.has(target)) return raw;
                }
                // RENAME TO / RENAME COLUMN / bare RENAME lose the old name; only
                // RENAME INDEX/KEY is a metadata-only rename.
                if(/\bRENAME\b(?!\s+(INDEX|KEY)\b)/i.test(stmt)) return raw;
                // CHANGE [COLUMN] renames and retypes in one clause - manual only.
                if(/\bCHANGE\b/i.test(stmt))                     return raw;
                // MODIFY that adds NOT NULL narrows the column domain - except an
                // AUTO_INCREMENT attribute repair: an AUTO_INCREMENT column is
                // definitionally NOT NULL, so no domain is narrowed (see the
                // committed 2026-06-10-mirror-id-autoincrement-repair.sql pattern).
                // Check per top-level clause: a statement-wide AUTO_INCREMENT test
                // would let one AUTO_INCREMENT clause exempt a sibling NOT NULL clause
                // in the same multi-clause ALTER (e.g. `MODIFY id ... AUTO_INCREMENT,
                // MODIFY source VARCHAR(255) NOT NULL`).
                let mDepth = 0, mStart = 0;
                const mClauses = [];
                for(let i=0;i<stmt.length;i++){
                    const ch = stmt[i];
                    if(ch === '(') mDepth++;
                    else if(ch === ')') mDepth--;
                    else if(ch === ',' && mDepth === 0){ mClauses.push(stmt.slice(mStart, i)); mStart = i + 1; }
                }
                mClauses.push(stmt.slice(mStart));
                for(const clause of mClauses){
                    if(/\bMODIFY\b[\s\S]*\bNOT\s+NULL\b/i.test(clause) &&
                       !/\bAUTO_INCREMENT\b/i.test(clause))      return raw;
                }
            }
        }
        return null;
    }

    // True only for the one committed auto UPDATE shape: the AUTO_INCREMENT id repair
    // `UPDATE <table> SET id = (<subquery>) WHERE id = 0`. The shape is matched
    // structurally, not by a wildcard regex: (1) a single table then `SET id = (`;
    // (2) a balanced-paren, quote-aware walk finds the value's true matching `)`, so no
    // extra assignment or trailing clause can ride inside it; (3) the remainder must be
    // exactly `WHERE id = 0`, end-anchored. An earlier unanchored regex let both
    // `... WHERE id = 0 OR 1=1` and a smuggled `SET id = (...), amount = (...)` through,
    // rewriting every row. The committed repair migration nests a subquery containing
    // commas, so a "no inner parens / no commas" rule would wrongly reject it and
    // hard-fail startup; the balanced scan is required.
    // Kept byte-for-byte in sync with the xchain-indexer classifier.
    _isIdRepairUpdate(stmt){
        const head = /^UPDATE\s+(?:`[^`]+`|[A-Za-z0-9_$.]+)\s+SET\s+id\s*=\s*\(/i.exec(stmt);
        if(!head) return false;
        let i = head[0].length - 1;              // index of the opening '('
        let depth = 0;
        let quote = null;
        for(; i < stmt.length; i++){
            const ch = stmt[i];
            if(quote){
                if(ch === quote){
                    if(stmt[i + 1] === quote){ i++; }    // doubled-quote escape
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
            if(ch === '('){ depth++; }
            else if(ch === ')'){ depth--; if(depth === 0){ i++; break; } }
        }
        if(depth !== 0) return false;            // unbalanced parens: not the repair shape
        return /^\s*WHERE\s+id\s*=\s*0\s*;?\s*$/i.test(stmt.slice(i));
    }

    // Create the migration ledger if absent. Infrastructure, not a domain table, so
    // verifyTables() doesn't manage it.
    async _ensureMigrationsLedger(conn){
        await conn.query(
            'CREATE TABLE IF NOT EXISTS schema_migrations (' +
            "name VARCHAR(255) NOT NULL PRIMARY KEY, " +
            "checksum VARCHAR(64) NOT NULL, " +
            "mode VARCHAR(10) NOT NULL DEFAULT 'manual', " +
            'applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
            ') ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci'
        );
    }

    // Remove SQL line comments while respecting quoted strings, so a ';'
    // or ',' appearing inside comment prose is never mistaken for SQL structure.
    // Single/double-quote and backtick spans are preserved verbatim (doubled
    // quotes treated as escapes); a `--` or `#` outside any quote or block comment
    // skips to the end of its line. Newlines are kept so the column-split below
    // stays well-formed.
    //
    // `#` counts because MariaDB/MySQL honour it to end-of-line exactly like
    // `--`. Missing it made a `# note` line ahead of a destructive statement
    // invisible to the ^-anchored checks in _destructiveAutoStatement: the
    // chunk began with `#`, matched no keyword, scored the file auto-eligible,
    // and the server ran the DROP unattended at startup. A `;` inside a `#`
    // comment also tore the statement in two for both the classifier and the
    // apply loop.
    //
    // `/* ... */` spans are copied through verbatim rather than scanned: a `--`
    // or `#` inside one would otherwise swallow the closing `*/` and the rest of
    // that line (the server does not treat either as a comment start there), and
    // an apostrophe in block-comment prose would open a bogus quote span. The
    // verbatim copy also keeps `/*!...*/` executable-comment payloads intact for
    // _destructiveAutoStatement to flag.
    stripSqlLineComments(sql){
        let out = '';
        let quote = null;
        for(let i = 0; i < sql.length; i++){
            const ch = sql[i];
            if(quote){
                out += ch;
                if(ch === quote){
                    if(sql[i + 1] === quote){ out += sql[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
            if(ch === '/' && sql[i + 1] === '*'){
                const end = sql.indexOf('*/', i + 2);
                if(end === -1){ out += sql.slice(i); break; }   // unterminated: copy the rest as-is
                out += sql.slice(i, end + 2);
                i = end + 1;
                continue;
            }
            if((ch === '-' && sql[i + 1] === '-') || ch === '#'){
                while(i < sql.length && sql[i] !== '\n'){ i++; }
                if(i < sql.length){ out += '\n'; }
                continue;
            }
            out += ch;
        }
        return out;
    }

    // Split a SQL string into individual statements on `;`, but only when the `;`
    // sits outside a quoted string. A naive `.split(';')` tears a statement whose
    // string literal contains a semicolon (e.g. `SET data = 'a;b'`) into invalid
    // fragments, so no migration or seed carrying a semicolon in quoted data can
    // ship, and _destructiveAutoStatement ends up classifying fragments rather than
    // real statements. `--` and `#` line comments are stripped first (same rule as
    // the callers used); the quote model matches stripSqlLineComments exactly
    // (single/double-quote and backtick spans, doubled quotes treated as escapes).
    // Returns trimmed, non-empty statements. Mirrors xchain-indexer/src/db.js.
    splitSqlStatements(sql){
        const stripped = this.stripSqlLineComments(sql);
        const statements = [];
        let current = '';
        let quote = null;
        for(let i = 0; i < stripped.length; i++){
            const ch = stripped[i];
            if(quote){
                current += ch;
                if(ch === quote){
                    if(stripped[i + 1] === quote){ current += stripped[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; current += ch; continue; }
            // Block comments survive the strip (the classifier needs `/*!...*/` payloads
            // intact), so carry them across whole: an apostrophe in comment prose must not
            // open a quote span, and a ';' inside one must not terminate the statement.
            if(ch === '/' && stripped[i + 1] === '*'){
                const end = stripped.indexOf('*/', i + 2);
                if(end === -1){ current += stripped.slice(i); break; }
                current += stripped.slice(i, end + 2);
                i = end + 1;
                continue;
            }
            if(ch === ';'){ statements.push(current); current = ''; continue; }
            current += ch;
        }
        statements.push(current);
        return statements.map(s => s.trim()).filter(Boolean);
    }

    // Parse a CREATE TABLE statement to extract expected columns. Conservative:
    // only used for drift detection, not full schema management. Returns array of
    // {name, nullable, definition, notNull, hasDefault} or null when the file has
    // no recognizable CREATE TABLE block.
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing; inline comments
        // routinely carry commas/parens that would otherwise fool the comma split.
        sqlData = this.stripSqlLineComments(sqlData);
        // Match the column block up to the table's closing paren, tolerating the
        // optional `IF NOT EXISTS` clause and both the `) ENGINE=...;` form and a
        // bare `);` terminator (the decoder schema mixes all three).
        const m = sqlData.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(([\s\S]+?)\)\s*(?:ENGINE\b|;|$)/i);
        if(!m) return null;
        // Split on top-level commas (commas not inside type parens like VARCHAR(20))
        const parts = m[1].split(/,(?![^()]*\))/g);
        const cols = [];
        for(let raw of parts){
            let line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            // Skip constraint/index/key lines (column) definitions only
            if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
            const tokens = line.split(/\s+/);
            if(tokens.length < 2) continue;
            const name       = tokens[0].replace(/`/g, '');
            // A column is nullable unless it says NOT NULL, is an inline PRIMARY
            // KEY, or is AUTO_INCREMENT. SQL forces PK and AUTO_INCREMENT columns
            // NOT NULL, so a MODIFY ... NULL on one is a silent no-op (PK) or, worse,
            // silently STRIPS the AUTO_INCREMENT attribute - the mirror-cursor
            // corruption the indexer hit live on 2026-06-10. Mirrors
            // xchain-indexer/src/db.js so both reconcilers infer NOT NULL identically.
            const nullable   = !/\bNOT\s+NULL\b/i.test(line) && !/\bPRIMARY\s+KEY\b/i.test(line) && !/\bAUTO_INCREMENT\b/i.test(line);
            const notNull    = !nullable;
            const hasDefault = /\bDEFAULT\b/i.test(line);
            // Keep the full (comment-stripped) definition so a missing column can
            // be re-added verbatim, preserving its DEFAULT clause, which is what
            // backfills existing rows when the column is NOT NULL.
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    }

    // Detect schema drift between the live table and its SQL source, and fix it
    // by ALTER. Two kinds of drift are handled:
    //   1. Missing columns: a column declared in the SQL source but absent from
    //      the live table is added with ADD COLUMN, reusing the source definition
    //      verbatim so its DEFAULT clause backfills existing rows. (A NOT NULL
    //      column with no DEFAULT can't be backfilled safely, so it's skipped
    //      with a loud warning rather than aborting startup.)
    //   2. Nullability: only relaxes NOT NULL -> NULL (the safe direction; never
    //      strengthens to NOT NULL since live rows might hold NULLs that would
    //      block the ALTER).
    // Doesn't touch types, defaults of existing columns, or indexes. Each applied
    // ALTER is loudly logged. Reuses the caller's connection (`db`).
    async alterTableForDrift(file, db){
        const data     = fs.readFileSync(this.sqlPath + '/' + file, "utf8");
        const table    = file.substring(0, file.indexOf('.sql'));
        const expected = this.parseExpectedColumns(data);
        if(!expected){
            // parseExpectedColumns returns null when the file has no recognizable
            // `CREATE TABLE ... ) ENGINE ...` block (e.g. a missing ENGINE clause).
            // That silently disables ALL column-drift reconciliation for this table.
            // Make it loud so a malformed source file can't hide. (Non-fatal: the
            // parse-coverage unit test is the hard guardrail.)
            console.warn('Schema drift check SKIPPED for `' + table + '`: could not parse columns from ' + file + ': expected a `CREATE TABLE ... ) ENGINE ...` definition. Additive column/nullability drift will NOT auto-reconcile for this table until the SQL source is fixed.');
            return;
        }
        const live = await db.query(
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE, COLUMN_KEY, EXTRA FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        const liveByName = new Map(live.map(c => [c.COLUMN_NAME.toLowerCase(), c]));
        for(const exp of expected){
            const cur = liveByName.get(exp.name.toLowerCase());
            if(!cur){
                if(exp.notNull && !exp.hasDefault){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT; cannot backfill existing rows safely. Skipping; add manually.');
                    continue;
                }
                console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source.');
                await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition);
                continue;
            }
            const liveIsNullable = cur.IS_NULLABLE === 'YES';
            if(!liveIsNullable && exp.nullable){
                // NEVER relax a primary-key or auto-increment column: a PK can't be
                // NULL anyway, and a bare `MODIFY <type> NULL` silently strips the
                // AUTO_INCREMENT attribute (mirror-cursor corruption). parseExpectedColumns
                // already treats such sources as NOT NULL; this guards against any parse gap.
                const isPk      = String(cur.COLUMN_KEY || '').toUpperCase() === 'PRI';
                const isAutoInc = /auto_increment/i.test(String(cur.EXTRA || ''));
                if(isPk || isAutoInc){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL - SKIPPING relax (' + (isPk ? 'PRIMARY KEY' : 'AUTO_INCREMENT') + ' column; a bare MODIFY would strip attributes).');
                    continue;
                }
                console.log('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL. Relaxing constraint.');
                await db.query('ALTER TABLE `' + table + '` MODIFY `' + exp.name + '` ' + cur.COLUMN_TYPE + ' NULL');
            }
        }
    }

    // Parse standalone `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>)` statements
    // from a table's SQL source. Returns [{name, unique, columns:[...]}]. Inline
    // PRIMARY KEY / UNIQUE clauses inside CREATE TABLE are created with the table and
    // are not reconciled here. Index/column names come from the trusted SQL files.
    parseExpectedIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(\s*([\s\S]+?)\s*\)\s*;/gi;
        const out = [];
        let m;
        while((m = re.exec(sqlData)) !== null){
            if(m[3].toLowerCase() !== table.toLowerCase()) continue;
            // Split the column list on commas; strip backticks, ASC/DESC, and any (len) prefix.
            const columns = m[4].split(',')
                .map(c => c.trim().replace(/`/g, '').split(/\s+/)[0].replace(/\(\d+\)$/, ''))
                .filter(Boolean);
            if(columns.length) out.push({ name: m[2], unique: !!m[1], columns });
        }
        return out;
    }

    // Reconcile declared indexes against the live table. Adds any index named in the
    // SQL source that is absent live (matched by column set, so a renamed-but-equivalent
    // index is treated as present). For a UNIQUE index blocked by pre-existing duplicate
    // rows, dedupes first (see dedupeForUniqueIndex) then retries. Never throws (a
    // failure is logged and startup continues). On a table that already has every declared
    // index (the normal case) this is a single information_schema read and a no-op.
    async reconcileTableIndexes(file, db){
        try {
            const data     = fs.readFileSync(this.sqlPath + '/' + file, "utf8");
            const table    = file.substring(0, file.indexOf('.sql'));
            const expected = this.parseExpectedIndexes(data, table);
            if(!expected.length) return;

            // Live indexes -> map keyed by ordered column-set: "c1,c2" => {unique}
            const rows = await db.query(
                "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                [this.dbName, table]);
            const byName = new Map();
            const liveNames = new Set();
            for(const r of rows){
                liveNames.add(r.INDEX_NAME.toLowerCase());
                if(!byName.has(r.INDEX_NAME)) byName.set(r.INDEX_NAME, { unique: Number(r.NON_UNIQUE) === 0, cols: [] });
                byName.get(r.INDEX_NAME).cols.push(r.COLUMN_NAME.toLowerCase());
            }
            const liveByCols = new Map();
            for(const info of byName.values()) liveByCols.set(info.cols.join(','), info);

            for(const idx of expected){
                const key  = idx.columns.map(c => c.toLowerCase()).join(',');
                const live = liveByCols.get(key);
                if(live && (!idx.unique || live.unique)) continue;          // already satisfied
                if(liveNames.has(idx.name.toLowerCase())) continue;          // name taken by a different index; leave alone
                const colList = idx.columns.map(c => '`' + c + '`').join(', ');

                if(!idx.unique){
                    console.log('Schema drift on ' + table + ': missing index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD INDEX `' + idx.name + '` (' + colList + ')');
                    continue;
                }
                try {
                    console.log('Schema drift on ' + table + ': missing UNIQUE index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                } catch(e){
                    const dup = e && (Number(e.errno) === 1062 || /duplicate entry/i.test(e.message || ''));
                    if(!dup){ console.log('  could not add UNIQUE index ' + idx.name + ' on ' + table + ': ' + (e && e.message)); continue; }
                    console.log('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index; deduping (keep newest id per ' + key + ') then retrying.');
                    if(!(await this.dedupeForUniqueIndex(db, table, idx.columns))) continue;
                    try {
                        await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                        console.log('  added ' + idx.name + ' after dedupe.');
                    } catch(e2){
                        console.log('  ' + table + '.' + idx.name + ' still failing after dedupe; leaving as-is: ' + (e2 && e2.message));
                    }
                }
            }
        } catch(e){
            // Never abort startup over index reconciliation.
            console.warn('reconcileTableIndexes(' + file + ') failed (non-fatal): ' + (e && e.message));
        }
    }

    // Collapse duplicate rows on `columns` so a UNIQUE index can be added, keeping the
    // row with the highest `id` in each group. For the failure this repairs: an
    // INSERT ... ON DUPLICATE KEY UPDATE upsert that degraded to plain INSERT because the
    // unique index was missing. Each change appended a fresh row with the current
    // value, so the highest id is the live (correct) value and the older rows are stale.
    // Uses `=` (not `<=>`) so NULL tuples are left intact, matching UNIQUE semantics (a
    // UNIQUE index permits multiple NULLs). Requires a single `id` column to pick a
    // survivor; skips with a warning if absent. Returns true if the table is now safe to index.
    async dedupeForUniqueIndex(db, table, columns){
        const hasId = (await db.query(
            "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = 'id'",
            [this.dbName, table])).length > 0;
        if(!hasId){
            console.log('  cannot dedupe ' + table + ' (no `id` column to pick a surviving row); skipping unique-index add.');
            return false;
        }
        const on  = columns.map(c => 't1.`' + c + '` = t2.`' + c + '`').join(' AND ');
        const res = await db.query('DELETE t1 FROM `' + table + '` t1 JOIN `' + table + '` t2 ON ' + on + ' AND t1.id < t2.id');
        console.log('  deduped ' + table + ': removed ' + (res && res.affectedRows != null ? res.affectedRows : '?') + ' stale duplicate row(s).');
        return true;
    }

    // Handle creating database tables. Runs on the caller's connection (same
    // pattern as alterTableForDrift): leasing a fresh connection per table here
    // leaked the entire pool on a fresh-DB boot, because nothing ever released
    // those leases (releaseConnection() only releases transactionConnection).
    async createTable(file, db){
        let path    = this.sqlPath;
        let data    = fs.readFileSync(path + '/' + file, "utf8");
        let table   = file.substring(0, file.indexOf('.sql'));
        let ownLease = false;
        if(!db){
            db = await this.getConnection();
            ownLease = true;
        }
        // Quote-aware split (same as runMigrations): a ';' inside a `--` comment or
        // inside a string literal must not terminate a statement, or the CREATE TABLE
        // is torn mid-statement and a fresh install breaks. Existing DBs never hit this
        // (verifyTables skips createTable when the table already exists), so it was a
        // latent fresh-install-only bug.
        let queries = this.splitSqlStatements(data);
        let query   = null;
        try {
            for(query of queries){
                query = query.trim();
                if(query=='')
                    continue;
                try {
                    let result = await db.query(query);
                    if(result.length > 0)
                        continue;
                } catch(e){
                    util.throwError('Error while trying to create ' + table + ' table!');
                }
            }
        } finally {
            if(ownLease){
                try { await db.release(); } catch(_){}
            }
        }
    }

    // Handle getting a database Connection (with exponential backoff + jitter).
    // Matches the indexer's retry shape so a transient MariaDB blip during
    // heavy concurrent load (e.g. e2etest container build + initial seeding)
    // doesn't crash the decoder process. ~5min worst-case patience before
    // surfacing a real outage.
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        var connection  = null;
        var attempts    = 0;
        var maxAttempts = 30;
        var baseDelay   = 500;   // 500ms initial delay
        var maxDelay    = 15000; // 15s max delay
        while(connection == null){
            try {
                connection = await this.pool.getConnection();
            } catch (e){
                attempts++;
                if(attempts >= maxAttempts)
                    throw new Error('Failed to get database connection after ' + maxAttempts + ' attempts: ' + e.code)
                let delay      = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
                let jitter     = Math.floor(Math.random() * delay * 0.3);
                let totalDelay = delay + jitter;
                console.error('MariaDB connection attempt ' + attempts + '/' + maxAttempts + ' failed. Retrying in ' + totalDelay + 'ms...', e)
                connection = null;
                await util.sleep(totalDelay);
            }
        }
        return connection;
    }

    async releaseConnection(){
        if(this.transactionConnection != null){
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }
    }

    // DB liveness probe for the API health/status endpoints. Draws a connection
    // DIRECTLY from the pool, never via getConnection(): while a block is being
    // processed, getConnection() returns the shared transactionConnection, and a
    // probe that then .release()s it hands the block's live transaction
    // connection back to the pool while the block loop keeps writing on it.
    // Any monitor polling /status mid-block would break per-block atomicity.
    // No retry/backoff either: a health check wants the current truth.
    async ping(){
        let conn = await this.pool.getConnection();
        try {
            await conn.query('SELECT 1');
            return true;
        } finally {
            try { await conn.release(); } catch(_){}
        }
    }

    async _acquireTransactionLock(){
        if (!this._transactionLock) {
            this._transactionLock = true
            return
        }
        await new Promise(resolve => this._transactionLockQueue.push(resolve))
    }

    _releaseTransactionLock(){
        if (this._transactionLockQueue.length > 0) {
            let next = this._transactionLockQueue.shift()
            next()
        } else {
            this._transactionLock = false
        }
    }

    async beginTransaction(){
        await this._acquireTransactionLock()

        if (this.transactionConnection != null){
            await this.endTransaction()
        }

        this.transactionConnection = await this.getConnection()
        try {
            await this.transactionConnection.beginTransaction()
        } catch(err){
            await this.transactionConnection.release()
            this.transactionConnection = null
            this._releaseTransactionLock()
            throw err
        }
    }

    async endTransaction(){
        if (this.transactionConnection != null){
            console.log("rolling back")
            await this.transactionConnection.rollback()
            await this.transactionConnection.release()
            this.transactionConnection = null
        }
        this._releaseTransactionLock()
    }

    async commitTransaction(){
        if (this.transactionConnection != null){
            try {
                await this.transactionConnection.commit()
                await this.transactionConnection.release()
                this.transactionConnection = null
                this._releaseTransactionLock()
                return true
            } catch (e){
                console.error("There was an error trying to commit a transaction: " + e.code)
                await this.endTransaction()
            }
        }

        return false
    }
    
    bigIntSatoshiToDecimalsString(bigIntValue) {
        let negative = false
        if (bigIntValue < 0) {
            negative = true
            bigIntValue = typeof bigIntValue === 'bigint' ? -bigIntValue : -bigIntValue
        }

        const strBigInt = bigIntValue.toString();
        const bigIntLength = strBigInt.length;
        let result

        if (bigIntLength <= SATOSHIS_DECIMALS) {
            let missingZeros = SATOSHIS_DECIMALS - bigIntLength;
            let decimalPart = '0'.repeat(missingZeros) + strBigInt;
            result = `0.${decimalPart}`;
        } else {
            const decimalSeparatorIndex = bigIntLength - SATOSHIS_DECIMALS;
            const integerPart = strBigInt.slice(0, decimalSeparatorIndex);
            const decimalPart = strBigInt.slice(decimalSeparatorIndex);
            result = `${integerPart}.${decimalPart}`;
        }

        return negative ? `-${result}` : result;
    }
    
    async deleteBlockByIndex(blockIndex, reorgBlockHash){
        await this.beginTransaction()
        let connection = await this.getConnection()

        try {
            // Resurrect any dispenser that THIS (now-orphaned) block soft-expired:
            // clear the expiry mark so it is open again. Must run before the
            // dispenser row-delete below (a dispenser both OPENED and expired in
            // this same orphaned block is hard-deleted by tx_index there, while one
            // opened in an EARLIER block but expired by this block is restored here.
            let query = `
                UPDATE dispensers SET expired_block_index = NULL WHERE expired_block_index = ?;
            `;
            await connection.query(query, [blockIndex])
            // Delete child rows first: transaction_outputs and dispensers are
            // keyed by tx_index, so they must be removed before the parent
            // transactions rows they reference are deleted. Otherwise the decoder
            // re-inserts the same block and hits duplicate-key errors, leaving
            // stale pre-reorg rows that the indexer reads as valid.
            query = `
                DELETE FROM transaction_outputs WHERE tx_index IN (SELECT tx_index FROM transactions WHERE block_index = ?);
            `;
            await connection.query(query, [blockIndex])
            query = `
                DELETE FROM dispensers WHERE tx_index IN (SELECT tx_index FROM transactions WHERE block_index = ?);
            `;
            await connection.query(query, [blockIndex])
            query = `
                DELETE FROM transactions WHERE block_index = ?;
            `;
            await connection.query(query, [blockIndex])
            query = `
                DELETE FROM blocks WHERE block_index = ?;
            `;
            await connection.query(query, [blockIndex])
            // index_addresses is intentionally NOT deleted on reorg: it is an append-only,
            // first-reference (INSERT IGNORE) lookup whose AUTO_INCREMENT id is a purely local
            // artifact. Downstream consumers resolve it to the canonical address string and never
            // treat the id as consensus-visible, so an orphan row left by a reorg is harmless. Do
            // not start feeding a raw lookup id into any consensus/hashed value.

            // events is likewise intentionally NOT deleted on reorg: it is an append-only audit
            // log with no block_index column (rows like PARSE_ERROR only carry a height inside
            // their JSON payload). Orphaned audit rows for rolled-back blocks are accepted as
            // stale-but-harmless history, and the REORG marker inserted below records the
            // deletion itself in that same log. The indexer's reorg detection consumes events
            // by ascending id and would misbehave if rows were retroactively removed.

            // Crash durability: the REORG audit marker is written in the SAME transaction that
            // deletes the block, so the delete and its marker are atomic. A single marker written
            // once at the end of verifyReorg leaves a crash window where the blocks are gone but no
            // marker exists, and the indexer (which detects decoder reorgs solely by reading these
            // events rows and rolling back to the lowest block_index across them) never retracts the
            // orphaned old-chain rows it already indexed: a silent, permanent divergence. The
            // indexer rolls back to the deepest block_index across all unprocessed markers, so N
            // single-block markers land it exactly where one combined event would have, and a marker
            // for block B becomes visible only once B is actually deleted, so it can never roll back
            // onto a block still present in a half-deleted decoder. Payload shape matches the
            // indexer's parser (array of {block_index, block_hash}); reorgBlockHash is omitted by
            // non-reorg callers, leaving deleteBlockByIndex a plain delete.
            if (reorgBlockHash != null){
                const eventQuery = `INSERT INTO events (time, code, data) VALUES (?, ?, ?);`
                const nowString  = new Date().toISOString().slice(0, 19).replace('T', ' ')
                const eventData  = JSON.stringify([{ block_index: blockIndex, block_hash: reorgBlockHash }])
                await connection.query(eventQuery, [nowString, 'REORG', eventData])
            }

            const committed = await this.commitTransaction()
            if (!committed) throw new Error('deleteBlockByIndex: commit failed for block ' + blockIndex)

            return true
        } catch (err) {
            // A query failure here would otherwise escape with the transaction
            // lock still held and the connection still open, deadlocking every
            // later caller that waits on the lock. Roll back and release the
            // lock before propagating so the reorg retry path can recover.
            console.error('Error deleting block by index:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            throw err
        }
    }
    
    async getLastBlockIndex(){
        const query = `
            SELECT MAX(block_index) AS max_height FROM blocks ;
        `;
        // Retry a transient DB error a few times, then THROW. Never return a
        // non-numeric sentinel: the old `return false` was silently coerced to a
        // height (`false + 1 === 1`), which collided block 1 and wedged the parse
        // loop in an insert/rollback spin, and in verifyReorg turned
        // getBlockByIndex(false) into a null row that ended the walk early and
        // emitted a REORG event for a partial deletion. start() has no retry
        // wrapper, so a throw here surfaces loud (process visible to health checks)
        // instead of corrupting height math silently.
        const MAX_ATTEMPTS = 5
        let lastErr = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query)
                if (rows.length > 0 && rows[0]["max_height"] != null){
                    // block_index is BIGINT UNSIGNED, so the driver returns a JS BigInt.
                    // Coerce to Number: heights are well within Number.MAX_SAFE_INTEGER, and a
                    // BigInt breaks both arithmetic (`+1` in the parse loop) and JSON serialization
                    // Note: getBlockHash's axios body and insertEvent's JSON.stringify both throw
                    // "Do not know how to serialize a BigInt", which silently wedges verifyReorg.
                    return Number(rows[0]["max_height"])
                }
                return -1
            } catch (err) {
                lastErr = err
                console.error(`Error selecting max block height (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
            } finally {
                if (this.transactionConnection == null){
                    await connection.release()
                }
            }
            if (attempt < MAX_ATTEMPTS) await this.sleep(1000)
        }
        throw new Error('getLastBlockIndex failed after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr && lastErr.message))
    }
    
    async getLastTxIndex(){
        const query = `
            SELECT MAX(tx_index) AS max_tx_index FROM transactions;
        `;
        // Retry-then-throw, same rationale as getLastBlockIndex: a `return false`
        // reset the tx counter to 1 on any DB error, colliding tx_index 1.
        const MAX_ATTEMPTS = 5
        let lastErr = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query)
                if (rows.length > 0 && rows[0]["max_tx_index"] != null){
                    // tx_index is BIGINT UNSIGNED: coerce the BigInt to Number for the same
                    // reasons as getLastBlockIndex (arithmetic + JSON-RPC/event serialization).
                    return Number(rows[0]["max_tx_index"])
                }
                return -1
            } catch (err) {
                lastErr = err
                console.error(`Error selecting max tx index (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
            } finally {
                if (this.transactionConnection == null){
                    await connection.release()
                }
            }
            if (attempt < MAX_ATTEMPTS) await this.sleep(1000)
        }
        throw new Error('getLastTxIndex failed after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr && lastErr.message))
    }
    
    async getBlockByIndex(blockIndex){
        const query = `
            SELECT b.*, it.hash AS block_hash, previous_it.hash AS previous_block_hash FROM blocks b
            LEFT JOIN index_transactions it ON it.id = b.block_hash_id
            LEFT JOIN index_transactions previous_it ON previous_it.id = b.previous_block_hash_id
            WHERE block_index = ?;
        `;
        
        // Retry-then-throw, same rationale as getLastBlockIndex/getLastTxIndex above.
        // A `catch { return null }` makes a failed query indistinguishable from "no such
        // row", and verifyReorg's backward walk treats a null row as "table exhausted":
        // ONE failed read then ended the rollback walk and reported the reorg reconciled
        // while orphan blocks were still stored above the fork point. Here null means
        // exactly "no such row"; a read that never succeeds throws, so each caller decides
        // what to do with a failure.
        const MAX_ATTEMPTS = 5
        let lastErr = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query, [blockIndex])
                if (rows.length > 0){
                    return rows[0]
                } else {
                    return null
                }
            } catch (err) {
                lastErr = err
                console.error(`Error selecting block by index ${blockIndex} (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
            } finally {
                if (this.transactionConnection == null){
                    await connection.release()
                }
            }
            if (attempt < MAX_ATTEMPTS) await this.sleep(1000)
        }
        throw new Error('getBlockByIndex(' + blockIndex + ') failed after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr && lastErr.message))
    }
    
    async insertBlock(block) {
        const query = `
        INSERT INTO blocks (
        block_index,
        block_hash_id,
        block_time,
        previous_block_hash_id
        ) VALUES (?, ?, ?, ?);
        `;
        
        let blockHashId = await this.createTransaction(block.block_hash)
        let previousBlockHashId = await this.createTransaction(block.previous_block_hash)
        
        let connection = await this.getConnection()
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the catch
        // path's endTransaction() releases it and nulls the field, so the finally must key
        // off this entry-time snapshot, not the mutated field, or it would release the same
        // pooled socket a second time.
        const ownLease = (this.transactionConnection == null)
        
        try {
            await connection.query(query, [
                block.block_index,
                blockHashId,
                block.block_time,
                previousBlockHashId
            ])
            
            return true
        } catch (err) {
            console.error('Error inserting block:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }
    
    async getTransaction(txid){
        const query = `
            SELECT 
                t.*, 
                ia_source.address AS source, 
                ia_destination.address AS destination, 
                it.hash AS hash 
                FROM transactions t 
                LEFT JOIN index_transactions it ON it.id = t.tx_hash_id 
                LEFT JOIN index_addresses ia_source ON ia_source.id = t.source_id 
                LEFT JOIN index_addresses ia_destination ON ia_destination.id = t.destination_id 
                WHERE it.hash = ?;
        `;
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query,[txid])
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error selecting a transaction from the db:', err);
            return false;
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }
    
    async insertTransaction(tx) {
        const query = `
            INSERT INTO transactions (
            tx_index,
            tx_hash_id,
            block_index,
            source_id,
            destination_id,
            amount,
            fee,
            data,
            raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            let txHashId = await this.createTransaction(tx.hash)
            let sourceId = await this.createAddress(tx.source)
            let destinationId = await this.createAddress(tx.destination)

            await connection.query(query, [
                tx.index,
                txHashId,
                tx.block_index,
                sourceId,
                destinationId,
                tx.amount,
                tx.fee,
                tx.data,
                tx.raw_data || null
            ])

            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting transaction:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                // A deterministic content/constraint rejection can never insert as-is;
                // signal POISON_ROW so the block loop quarantines the tx after a few
                // retries rather than retrying the block forever (a permanent wedge).
                // A transient error stays `false`: the loop retries indefinitely, since
                // skipping a tx a healthy instance accepts would break cross-instance parity.
                return DETERMINISTIC_WRITE_ERRNOS.has(err.errno) ? this.POISON_ROW : false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    async insertMempoolTransaction(tx) {
        const query = `
            INSERT INTO mempool_transactions (
            tx_hash,
            source,
            destination,
            amount,
            fee,
            data,
            raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            // Store raw strings here; never allocate index_addresses/index_transactions
            // ids. Mempool arrival order is node-local and non-deterministic, but those
            // lookup tables are replicated, so pre-allocating ids during mempool
            // observation would let two nodes assign different ids to the same
            // address/hash and silently diverge. Lookup ids are allocated only during
            // deterministic block-confirmation processing (see insertTransaction).
            await connection.query(query, [
                tx.hash,
                tx.source,
                tx.destination,
                tx.amount,
                tx.fee,
                tx.data,
                // Mirror insertTransaction: the encoder's second push (FILE bytes, gated
                // ciphertext) belongs on the pending row too, or the payload only appears
                // at confirmation and a pending row cannot be correlated with its twin.
                tx.raw_data || null
            ])

            return true
        } catch (err) {
            if (err.errno == 1062) {
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting mempool transaction:', err);
                if (this.transactionConnection) {
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease) {
                await connection.release()
            }
        }
    }

    // Bounded read of the current mempool snapshot for the API's getmempool
    // method. Same raw-string columns the explorer's colocated-DB path reads
    // (tx_hash/source/data), plus first_seen (2026-08-22-mempool-first-seen.sql).
    // ORDER BY the unique-indexed tx_hash: the table has no primary key and is
    // rewritten row-by-row every poll cycle, so a bare LIMIT would return a
    // scan-order subset that churns between polls; callers diff/page this
    // window as a stable snapshot. Capped at 500 like the explorer's own
    // getDecoderMempoolRows window.
    async getMempoolTransactions(limit) {
        const max = Math.max(1, Math.min(Number(limit) || 200, 500))
        const query = `
            SELECT tx_hash, source, data, first_seen
            FROM mempool_transactions
            ORDER BY tx_hash
            LIMIT ${max};
        `;
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            return rows || []
        } finally {
            if (ownLease) {
                await connection.release()
            }
        }
    }

    // Total mempool_transactions row count (the XChain-carrying subset of the
    // node mempool), companion to the bounded window above so getmempool can
    // report a true total when the table runs past the 500-row cap.
    async getMempoolTransactionCount() {
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query('SELECT COUNT(*) AS count FROM mempool_transactions;')
            return (rows && rows.length) ? Number(rows[0].count) : 0
        } finally {
            if (ownLease) {
                await connection.release()
            }
        }
    }

    //This is only used in tests
    async dropDatabase(){
        console.log("Droping database")
        
        const dropBlockTable = "DROP TABLE IF EXISTS blocks"
        const dropTransactionTable = "DROP TABLE IF EXISTS transactions"
        const dropIndexAddressesTable = "DROP TABLE IF EXISTS index_addresses"
        const dropIndexTransactionsTable = "DROP TABLE IF EXISTS index_transactions"
        const dropEventsTable = "DROP TABLE IF EXISTS events"
        const dropTransactionOutputsTable = "DROP TABLE IF EXISTS transaction_outputs"
        const dropDispensersTable = "DROP TABLE IF EXISTS dispensers"
        const dropMempoolTransactionsTable = "DROP TABLE IF EXISTS mempool_transactions"
        const dropPubkeysTable = "DROP TABLE IF EXISTS pubkeys"

        let connection = await this.getConnection()

        // Drop child / referencing tables before their parents. pubkeys carries a
        // foreign key onto index_addresses, so it must go before index_addresses
        // below or the DROP would fail with a constraint error.
        await connection.query(dropTransactionOutputsTable)
        await connection.query(dropDispensersTable)
        await connection.query(dropMempoolTransactionsTable)
        await connection.query(dropPubkeysTable)
        await connection.query(dropTransactionTable)
        await connection.query(dropBlockTable)
        await connection.query(dropIndexAddressesTable)
        await connection.query(dropIndexTransactionsTable)
        await connection.query(dropEventsTable)
        await connection.release()
    }

    async getTransactionId(hash){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        try {
            let rows = await db.query(query, [hash]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up hash record id in index_transactions table:', err);
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        
        return id;
    }

    async createTransaction(hash){
        // An empty hash resolves to the reserved sentinel row id 1 rather than
        // interning a blank value.
        if(hash==null||hash=='')
            return 1;
        var id = await this.getTransactionId(hash);
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: if a
            // concurrent caller inserted the same hash between our lookup and here,
            // the IGNORE skips the duplicate and the refetch below resolves to the
            // canonical row id, so two callers can never create duplicate rows.
            let query = "INSERT IGNORE INTO index_transactions (`hash`) values (?)"
            try {
                await db.query(query, [hash]);
            } catch (err) {
                console.error('Error trying to create hash record in index_transactions table:', err);
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
            id = await this.getTransactionId(hash);
        }
        return id;
    }

    async getAddressId(address){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1"
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up address record id in index_addresses table:', err);
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return id;
    }

    async createAddress(address){
        // An empty address resolves to the reserved sentinel row id 1 rather than
        // interning a blank value.
        if(address==null||address=='')
            return 1;
        var id = await this.getAddressId(address);
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index, as in
            // createTransaction above.
            let query = "INSERT IGNORE INTO index_addresses (`address`) values (?)"
            try {
                await db.query(query, [address]);
            } catch (err) {
                console.error('Error trying to create address record in index_addresses table:', err);
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
            id = await this.getAddressId(address);
        }
        return id;
    }
    
    async hasPubkey(addressId){
        let db = await this.getConnection()
        try {
            let rows = await db.query("SELECT 1 FROM pubkeys WHERE address_id=? LIMIT 1", [addressId])
            return rows.length > 0
        } catch (err) {
            console.error('Error checking pubkey existence:', err)
            return false
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
    }

    async insertPubkey(addressId, pubkey){
        let db = await this.getConnection()
        try {
            await db.query("INSERT IGNORE INTO pubkeys (address_id, pubkey) VALUES (?, ?)", [addressId, pubkey])
            return true
        } catch (err) {
            console.error('Error inserting pubkey:', err)
            return false
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
    }

    // blockTime is a unix timestamp (seconds) from the block header. When provided,
    // PARSE_ERROR rows use the block timestamp so replicas that process the same
    // deterministic error at different wall-clock times produce byte-identical rows.
    // REORG events are operator-local by nature (each node's reorg exposure differs)
    // and may omit blockTime; they fall back to the current wall clock.
    async insertEvent(code, data, blockTime){
        const query = `
            INSERT INTO events (
            time,
            code,
            data
        ) VALUES (?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            let timeString = blockTime != null
                ? new Date(blockTime * 1000).toISOString().slice(0, 19).replace('T', ' ')
                : new Date().toISOString().slice(0, 19).replace('T', ' ');
            let dataString = JSON.stringify(data)
        
            await connection.query(query, [
                timeString,
                code,
                dataString
            ])
            
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting event:', err);
                if (this.transactionConnection){
                    // Roll back + free the transaction lock, matching every sibling
                    // insert. releaseConnection() alone leaves the transaction open on
                    // the pooled connection AND never calls _releaseTransactionLock(),
                    // so the next beginTransaction() would wait on the lock forever.
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // Set-based diff of the stored mempool against the node's current mempool. The node's
    // mempool is seeded into a session-scoped temp table and the whole diff runs in SQL
    // against the unique `tx_hash` index, so only the intersection ever crosses the wire.
    // Streaming every stored row into Node and searching it in JS instead made the poll
    // cycle grow with mempool depth, which a fee-spike mempool turns into a real cost.
    //
    // Two effects:
    //   1. stored rows whose tx_hash is no longer in the node mempool are DELETEd (they
    //      confirmed or were evicted);
    //   2. txids already stored are removed from `txidList` IN PLACE, so the caller is
    //      left holding only the new arrivals to fetch and insert.
    async deleteAndCompareTxsNotInList(txidList) {
        // Snapshot the lease ownership: inside a block transaction getConnection() hands
        // back the shared transaction connection, which we must not release. Mempool
        // maintenance runs on its own Database handle, so ownLease is true here in
        // practice, but keep the guard for correctness.
        const ownLease = (this.transactionConnection == null)
        let connection = await this.getConnection();

        // Bounded multi-row INSERT size: 5000 single-column rows keeps each
        // statement well under the placeholder/packet limits even on a flood.
        const INSERT_CHUNK = 5000
        // A session temp table is scoped to this ONE connection. Pooled
        // connections are reused, so it is always dropped in finally; the name is
        // unlikely to collide with anything else on the connection.
        const TMP = '_mempool_node_snapshot'

        try {
            // Default temp storage engine (InnoDB) spills to disk, so a huge
            // mempool snapshot cannot blow max_heap_table_size the way a MEMORY
            // engine table would. Collation matches mempool_transactions.tx_hash so
            // the JOIN uses the unique index and compares identically.
            await connection.query(
                'CREATE TEMPORARY TABLE IF NOT EXISTS ' + TMP + ' (' +
                'tx_hash VARCHAR(250) CHARACTER SET utf8 COLLATE utf8_unicode_ci NOT NULL, ' +
                'INDEX (tx_hash)' +
                ')'
            )
            // A reused pooled connection may still hold a prior cycle's snapshot;
            // clear it before seeding this cycle's node mempool.
            await connection.query('DELETE FROM ' + TMP)

            if (txidList.length > 0) {
                for (let i = 0; i < txidList.length; i += INSERT_CHUNK) {
                    const chunk = txidList.slice(i, i + INSERT_CHUNK)
                    const placeholders = chunk.map(() => '(?)').join(',')
                    await connection.query(
                        'INSERT IGNORE INTO ' + TMP + ' (tx_hash) VALUES ' + placeholders,
                        chunk
                    )
                }
            }

            // (1) Delete stored rows absent from the node snapshot (anti-join).
            // With an empty snapshot (node mempool empty) this deletes every row.
            const deleteResult = await connection.query(
                'DELETE m FROM mempool_transactions m ' +
                'LEFT JOIN ' + TMP + ' s ON s.tx_hash = m.tx_hash ' +
                'WHERE s.tx_hash IS NULL'
            )
            const transactionsDeleted = Number((deleteResult && deleteResult.affectedRows) || 0)

            // (2) Which snapshot txids are already stored? Only the intersection is
            // returned, never the whole table. Skip the query entirely when there
            // is nothing to compare.
            let presentRows = []
            if (txidList.length > 0) {
                presentRows = await connection.query(
                    'SELECT s.tx_hash AS hash FROM ' + TMP + ' s ' +
                    'JOIN mempool_transactions m ON m.tx_hash = s.tx_hash'
                )
            }

            if (presentRows.length > 0) {
                const present = new Set(presentRows.map((r) => r.hash))
                // Filter preserves the caller's descending order; mutate the array
                // in place because the caller keeps using the same reference.
                const remaining = txidList.filter((h) => !present.has(h))
                txidList.length = 0
                for (const h of remaining) txidList.push(h)
            }

            return { transactionsDeleted }
        } catch (err) {
            console.error('Error diffing mempool_transactions:', err);
            return { transactionsDeleted: 0 }
        } finally {
            // Drop the temp table so a pooled connection never leaks it into an
            // unrelated later query, then release the lease we acquired.
            try { await connection.query('DROP TEMPORARY TABLE IF EXISTS ' + TMP) } catch (_) {}
            if (ownLease) {
                await connection.release()
            }
        }
    }
    
    async insertDispenser(openDispenser) {
        const query = `
            INSERT INTO dispensers (
            tx_index,
            address_id,
            expiration,
            oracle_address_id,
            source_address_id
        ) VALUES (?, ?, ?, ?, ?);
        `;
        // expiration is a raw unix timestamp (seconds) stored as-is into a BIGINT UNSIGNED
        // column. It is deliberately NOT wrapped in FROM_UNIXTIME(): FROM_UNIXTIME() caps at
        // 2147483647 (Y2038) and returns NULL above it, which would silently drop every
        // expiration past 2038 even though the decoder accepts any safe-integer value
        // (XChainDecoder.js DISPENSER parse). Matches xchain-indexer dispensers.expiration.
        
        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)
        
        try {
            let txIndex = openDispenser.txIndex
            let addressId = await this.createAddress(openDispenser.address)
            let expiration = openDispenser.expiration
            // Mode B only: interned so a later v2 refill (whose payload names no address)
            // can still resolve which oracle-fee output to capture.
            let oracleAddressId = openDispenser.oracleAddress
                ? await this.createAddress(openDispenser.oracleAddress)
                : null
            // The create's SOURCE, recorded ONLY when the dispenser operates on a
            // delegated GET_ADDRESS (address != source). The indexer authorises a later
            // cancel/edit from EITHER the dispenser SOURCE or its GET_ADDRESS
            // (xchain-indexer/src/actions/dispenser.js "SOURCE (not owner)"), and
            // address_id records only the operating address, so without this id a
            // creator-issued cancel of a delegated dispenser matches no decoder row and the
            // row stays open past the indexer's close. A non-delegated dispenser leaves
            // this NULL.
            let sourceAddressId = (openDispenser.sourceAddress &&
                                   openDispenser.sourceAddress !== openDispenser.address)
                ? await this.createAddress(openDispenser.sourceAddress)
                : null

            await connection.query(query, [
                txIndex,
                addressId,
                expiration,
                oracleAddressId,
                sourceAddressId
            ])
            
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting transaction:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // The decoder's open-dispenser view is ADVISORY.
    //
    // It exists for ONE purpose: decide which transaction outputs are captured as
    // potential dispense payments. The indexer is the sole arbiter of whether a dispenser
    // is open, which one a cancel/edit targets, and whether a captured payment dispenses
    // anything. The two views are allowed to disagree, and the disagreement is only ever
    // safe in one direction:
    //
    //   decoder open LONGER than the indexer    -> extra captured outputs the indexer drops
    //   decoder closed EARLIER than the indexer -> payments to a LIVE dispenser are never
    //                                              captured, so real dispenses are lost
    //
    // The second is money-bearing, so the decoder must never close a row on anything less
    // than certainty, and it has no certainty available: the indexer targets a cancel/edit
    // by an explicit DISPENSER_ACTION_INDEX wire field, while the decoder runs UPSTREAM of
    // the indexer, holds no such id, and can only resolve a target by SOURCE address. When
    // one source holds more than one open dispenser that resolution is a GUESS, and a wrong
    // guess closes the wrong row. No tie-break rule can fix that, because the two sides are
    // not addressing the same thing at all, so the guess was removed rather than refined:
    //   * The format-1 cancel mirror is RETIRED. It only ever moved an expiration EARLIER
    //     (cancel_block_time + close delay), which is the one thing this view must not do
    //     on a guess. Without it a cancelled dispenser stays in the decoder's open set
    //     until its own original expiration, and the indexer drops the extra triggers.
    //   * The format-2 edit mirror survives as extendOpenDispenserExpirationBySource
    //     below, but only in the extend direction and without picking a row.
    // Do NOT re-add a closing mirror here, in either form, and do not reintroduce
    // ORDER BY ... LIMIT 1 targeting: both are the defect, not the fix.
    //
    // The advisory contract stops at the open-view. Output CAPTURE resolution has TWO
    // implementations, picked by the ORACLE_FEE_SET_CAPTURE_ACTIVATION flag-day:
    // getOpenDispenserOracleAddressesBySource returns the WHOLE set of a source's open
    // oracle addresses (no ranking, tested by membership) and is what runs above the gate;
    // getOpenDispenserOracleAddressBySource keeps the legacy ORDER BY ... LIMIT 1 pick and
    // runs only below it, where changing the captured output set would break from-genesis
    // byte-identity. Both headers state their own contract.

    // Mirror a DISPENSER format-2 edit that re-dates EXPIRATION, so the block-time
    // soft-expire (deleteOpenDispensers) does not close a decoder row while the indexer
    // still considers the dispenser live. Two deliberate departures from a faithful
    // mirror, both of which make a wrong resolution benign instead of money-bearing:
    //
    //   1. EXTEND ONLY. GREATEST(expiration, ?) never brings an expiration forward, so
    //      an edit that SHORTENS the expiry is not mirrored at all: the indexer closes at
    //      the edited time and the decoder keeps capturing a little longer. Mirroring the
    //      shortening faithfully would mean closing early on a guessed row.
    //   2. NO TARGET SELECTION. Every open row of that source is extended, not one
    //      chosen by an ORDER BY. The correct row is therefore ALWAYS extended (which a
    //      LIMIT 1 guess could miss - itself an early close), and any other row of the
    //      same source is merely held open longer, which the indexer absorbs.
    //
    // Matching address_id OR source_address_id keeps the delegated case working:
    // address_id is the operating address (GET_ADDRESS when delegated), source_address_id
    // the create SOURCE, stored only when the two differ, so an edit issued by the
    // creator of a delegated dispenser still reaches its row.
    //
    // THIS-BLOCK RESTORE. BELOW DISPENSER_EXPIRY_REALIGN_ACTIVATION deleteOpenDispensers
    // runs at block START, before the
    // transaction loop, while the indexer expires at block END, after it. So on the block
    // whose header time first passes an expiration, this mirror is handed a row that the
    // block-start soft-expire has ALREADY stamped, and an `expired_block_index IS NULL`
    // filter cannot reach it: the extend silently does nothing, the row stays closed
    // forever, and the decoder stops capturing payments to a dispenser the indexer applies
    // the same edit to and keeps OPEN. That is the money-bearing direction, and it is the
    // exact failure the paragraph above says this mirror exists to prevent, so the filter
    // now admits a row expired by THIS block and clears the mark on it.
    //
    // Scoped to `expired_block_index = blockIndex` only. A row expired in an EARLIER block
    // stays closed: reopening one would be exactly the mirror-on-a-guessed-row the advisory
    // note above rules out, and the indexer has long since settled that dispenser's
    // lifecycle.
    // Same shape as deleteBlockByIndex's reorg clear, which also keys the reset on the
    // stamping height, so a re-processed block remains idempotent.
    //
    // AT/ABOVE that gate the soft-expire moves to the end of the block loop, so no row
    // carries a stamp from THIS block while the loop is running and the widened filter is
    // simply never exercised on a fresh pass. It still matters on a RE-PROCESSED block
    // (the stamp from the earlier pass survives), and it is what keeps the two eras' write
    // behavior identical on every input the legacy era could produce, so this clause stays.
    //
    // The caller has already validated newExpiration is present, in range and future.
    // A stale/unknown SOURCE matches zero rows and is a no-op. Same false/true contract
    // as insertDispenser: false means the query failed and the block transaction was
    // rolled back, so the caller retries the block.
    async extendOpenDispenserExpirationBySource(sourceAddress, newExpiration, blockIndex) {
        const query = `
            UPDATE dispensers
            SET expiration = GREATEST(expiration, ?),
                expired_block_index = CASE WHEN expired_block_index = ? THEN NULL ELSE expired_block_index END
            WHERE (address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1)
                OR source_address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1))
              AND (expired_block_index IS NULL OR expired_block_index = ?);
        `;
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            await connection.query(query, [newExpiration, blockIndex, sourceAddress, sourceAddress, blockIndex])
            return true
        } catch (err) {
            console.error('Error extending dispenser expiration:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // The ORACLE_ADDRESS of the open dispenser a DISPENSER v2 edit/refill targets, so the
    // block loop can capture that transaction's PRICE v1 oracle-usage-fee output. The v2
    // payload names its target by DISPENSER_ACTION_INDEX, an id in the INDEXER's action
    // space the decoder does not maintain, so the target is resolved by SOURCE address:
    // the same two-key match (operating address OR stored create SOURCE) that
    // extendOpenDispenserExpirationBySource uses, which lets a refill of a DELEGATED
    // dispenser (paid by its original creator, whose SOURCE is not the operating address)
    // still find its dispenser and capture the oracle-fee output the indexer will look for.
    //
    // LEGACY PATH, BELOW THE FLAG-DAY ONLY. The ORDER BY ... LIMIT 1 ranking removed from
    // the extend path survives here, and it is preserved rather than endorsed: it is the
    // exact behavior the fleet ran before ORACLE_FEE_SET_CAPTURE_ACTIVATION, so a re-decode
    // of pre-flag-day history must keep reproducing it byte-for-byte. Its defect is real.
    // Capture is a single-address EQUALITY test (the block loop's payment-output scan), so
    // a wrong pick captures NOTHING: the under-capture direction the advisory note above
    // calls money-bearing, not the over-capture direction it calls safe. When one source
    // holds several open Mode B dispensers with DIFFERENT oracle addresses, a refill of any
    // row but the top-ranked one resolves the wrong oracle, no output is captured, and the
    // indexer (which resolves the exact DISPENSER_ACTION_INDEX target) rejects a valid
    // refill for a missing oracle fee after the native payment is already spent.
    //
    // Do not restore the claim that a wrong pick is harmless because it captures an extra
    // output the indexer ignores: a single-equality filter cannot over-capture.
    //
    // ABOVE the flag-day that defect is gone: the block loop calls
    // getOpenDispenserOracleAddressesBySource below and tests membership over the whole set.
    // Do not "fix" the ranking here, and do not widen this query: it exists to reproduce the
    // pre-flag-day output set, and widening it breaks from-genesis byte-identity.
    //
    // Returns the address string, null when there is no match or the dispenser named no
    // oracle, and false on a query fault (the caller retries the block rather than
    // capturing a different output set than a healthy node).
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const query = `
            SELECT a2.address AS oracle_address
            FROM dispensers d
            INNER JOIN index_addresses a2 ON (a2.id = d.oracle_address_id)
            WHERE (d.address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1)
                OR d.source_address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1))
              AND d.expired_block_index IS NULL
            ORDER BY (d.address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1)) DESC, d.tx_index DESC
            LIMIT 1;
        `;
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            let rows = await connection.query(query, [sourceAddress, sourceAddress, sourceAddress])
            if (rows && rows.length > 0 && rows[0].oracle_address)
                return rows[0].oracle_address
            return null
        } catch (err) {
            console.error('Error reading dispenser oracle address:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // EVERY ORACLE_ADDRESS named by an open dispenser of this SOURCE, as a set the block
    // loop tests output addresses against. Live at/above ORACLE_FEE_SET_CAPTURE_ACTIVATION;
    // below it the single-pick above stands, unchanged.
    //
    // Same two-key match as the single-pick and as extendOpenDispenserExpirationBySource
    // (operating address OR stored create SOURCE), so a refill of a DELEGATED dispenser
    // paid by its original creator still resolves. What changes is that the ranking is
    // GONE: a v2 payload names its target by DISPENSER_ACTION_INDEX, an id in the INDEXER's
    // action space the decoder does not maintain, so no ORDER BY can identify the targeted
    // row, and picking one made a refill of any other open row capture nothing at all.
    // Returning the whole set makes capture right for every row of the source. When the
    // source holds several oracles the refill may also capture an output paying an oracle
    // it did not target; that is the over-capture direction the decoder's advisory contract
    // calls safe, because the indexer validates the fee against the target it resolved and
    // ignores the rest.
    //
    // DISTINCT because the set is membership-tested: two open dispensers naming the same
    // oracle must not make the same address appear twice, and ORDER BY keeps the set
    // deterministic for logs (the persisted rows keep the block's own vout order either
    // way, since the caller walks the transaction's outputs, not this list).
    //
    // Rows whose dispenser named no oracle are dropped by the INNER JOIN, so a source with
    // only Mode A dispensers yields []. Returns an array (possibly empty), or false on a
    // query fault, matching the single-pick's contract: the caller retries the block rather
    // than committing a different output set than a healthy node.
    async getOpenDispenserOracleAddressesBySource(sourceAddress) {
        const query = `
            SELECT DISTINCT a2.address AS oracle_address
            FROM dispensers d
            INNER JOIN index_addresses a2 ON (a2.id = d.oracle_address_id)
            WHERE (d.address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1)
                OR d.source_address_id = (SELECT id FROM index_addresses WHERE address = ? LIMIT 1))
              AND d.expired_block_index IS NULL
            ORDER BY a2.address ASC;
        `;
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            let rows = await connection.query(query, [sourceAddress, sourceAddress])
            if (!rows || rows.length === 0) return []
            let addresses = []
            for (let nextRow of rows){
                if (nextRow && nextRow.oracle_address)
                    addresses.push(nextRow.oracle_address)
            }
            return addresses
        } catch (err) {
            console.error('Error reading dispenser oracle addresses:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    async insertTransactionOutput(dispenseOutput) {
        const query = `
            INSERT INTO transaction_outputs (
            tx_index,
            vout,
            destination_id,
            amount
        ) VALUES (?, ?, ?, ?);
        `
        
        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)
        
        try {
            let txIndex = dispenseOutput.txIndex
            let vout = dispenseOutput.vout
            let destinationId = await this.createAddress(dispenseOutput.destinationAddress)
            let amount = this.bigIntSatoshiToDecimalsString(dispenseOutput.amount)
            
            await connection.query(query, [
                txIndex,
                vout,
                destinationId,
                amount
            ])
            
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting dispense output:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }   
    }
    
    async isThereADispenserForAddress(address){
        let db    = await this.getConnection();
        let query = 
            `SELECT COUNT(*) AS dispensers_count
            FROM dispensers op
            LEFT JOIN index_addresses ia ON ia.id = op.address_id
            WHERE ia.address = ?
              AND op.expired_block_index IS NULL`
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                return rows[0]["dispensers_count"] > 0
        } catch (err) {
            console.error('Error looking up address record id in index_addresses table:', err);
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return false;
    }

    // Return the address strings of every currently-open dispenser in a single
    // query. Callers load this once per block into a Set and test membership in
    // JS, instead of issuing one isThereADispenserForAddress() round-trip per
    // transaction output (thousands per mainnet block). Reads through the active
    // transaction connection when one is open, so it reflects in-transaction
    // state (e.g. dispensers just soft-expired by deleteOpenDispensers, which sets
    // expired_block_index; filtered out here so an expired dispenser stops
    // capturing payment outputs exactly as the old hard-delete did).
    // Returns null when the query fails: an empty set and a FAILED read must stay
    // distinguishable, because decoding a block against a silently-empty set would
    // drop every dispense output on this instance only (instance-dependent block
    // contents). The block loop retries the block on null.
    async getAllOpenDispenserAddresses(){
        let db    = await this.getConnection();
        let query =
            `SELECT ia.address AS address
            FROM dispensers op
            LEFT JOIN index_addresses ia ON ia.id = op.address_id
            WHERE op.expired_block_index IS NULL`
        let addresses = new Set()
        try {
            let rows = await db.query(query);
            for (let row of rows){
                if (row["address"] != null)
                    addresses.add(row["address"])
            }
        } catch (err) {
            console.error('Error loading open dispenser addresses:', err);
            return null;
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return addresses;
    }

    async deleteOpenDispensers(blockIndex, minExpiration) {
        // SOFT-EXPIRE, don't hard-delete. minExpiration is a raw unix timestamp
        // (the block header time); expiration is a raw unix BIGINT, so compare
        // integers directly. We stamp the expiring block height into
        // expired_block_index instead of deleting the row, so that a reorg's
        // deleteBlockByIndex can clear the mark (resurrecting a dispenser that an
        // orphaned block's non-monotonic timestamp expired). The `IS NULL` guard
        // makes a re-processed block idempotent, and the mark is a pure function of
        // canonical block height, so two honest nodes write byte-identical rows.
        const query = `
            UPDATE dispensers
            SET expired_block_index = ?
            WHERE expiration < ?
              AND expired_block_index IS NULL;
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            await connection.query(query, [
                blockIndex,
                minExpiration
            ])

            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error soft-expiring dispensers:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // Hard-delete dispensers that were soft-expired at or before a reorg-safe
    // depth. Run OUTSIDE the per-block transaction (a transient failure here must
    // never roll back committed block data. At worst soft-expired rows linger a
    // little longer). Deterministic across nodes: keyed off canonical block height,
    // never wall clock. Bounds dispensers table growth (the reason streamed
    // dispenser replication was disabled, see xchain-sync replicatedTables.js).
    async purgeExpiredDispensers(safeHeight) {
        if (safeHeight == null || safeHeight < 0) return true   // nothing reorg-safe yet (initial sync)
        const query = `
            DELETE FROM dispensers
            WHERE expired_block_index IS NOT NULL
              AND expired_block_index <= ?;
        `;
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            await connection.query(query, [safeHeight])
            return true
        } catch (err) {
            console.error('Error purging expired dispensers:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // Durable reorg-halt flag. verifyReorg's fail-closed safe-depth
    // ceiling is a per-invocation counter: on a reorg deeper than
    // DISPENSER_EXPIRE_SAFE_DEPTH it aborts mid-rollback, but nothing persisted
    // the abort, so a plain process restart re-entered verifyReorg with a zeroed
    // counter and silently completed the over-deep rollback past the dispenser
    // purge window (permanent money-bearing dispenser-state divergence). The halt
    // is persisted as a REORG_HALT row in the events table (an existing durable
    // store); a full resync from a known-good snapshot rebuilds the schema and so
    // clears it, matching the recovery the abort message already demands.
    async isReorgHalted(){
        const query = `SELECT 1 FROM events WHERE code = 'REORG_HALT' LIMIT 1;`
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            return Array.isArray(rows) ? rows.length > 0 : false
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // Read the durable halt marker WITH its detail. isReorgHalted() above
    // answers the one question verifyReorg asks (may I roll back?) and deliberately
    // stays a bare existence probe on the hot reorg path. Operator-facing surfaces
    // (health, GET /status, the bootstrap publisher's source gate) need to say WHEN
    // the decoder halted and WHY, because a latent marker is otherwise invisible
    // until a reorg trips it days later. Returns { halted, at, reason }; `at`/`reason`
    // are null when the row exists but its payload is unreadable (an older marker, or
    // JSON written by a different revision), which must never turn a real halt into a
    // reported non-halt.
    async getReorgHaltMarker(){
        const query = `SELECT time, data FROM events WHERE code = 'REORG_HALT' ORDER BY id DESC LIMIT 1;`
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            if (!Array.isArray(rows) || rows.length === 0) return { halted: false, at: null, reason: null }
            const row = rows[0]
            let payload = null
            try {
                payload = (typeof row.data === 'string') ? JSON.parse(row.data) : row.data
            } catch (_) {
                payload = null
            }
            return {
                halted: true,
                at:     (payload && payload.at) ? payload.at : (row.time != null ? String(row.time) : null),
                reason: (payload && payload.reason) ? payload.reason : null
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    }

    // Persist the durable reorg-halt marker (idempotent: no-op if already halted).
    // Called on every verifyReorg abort path BEFORE the throw, so a restart cannot
    // resume the over-deep rollback. Best-effort by design; the caller swallows any
    // error so a marker-write failure never masks the original loud abort.
    async markReorgHalted(reason){
        if (await this.isReorgHalted()) return true
        return this.insertEvent('REORG_HALT', { reason: reason, at: new Date().toISOString() })
    }
}

// Applied-migration files whose checksum may be healed in place. Entries are
// (old sha256 -> new sha256) pairs pinned to reviewed edits; anything else
// still fails the immutability guard in runMigrations(). `from` may be a list
// when the same reviewed edit supersedes several historical revisions (fleet
// DBs recorded whichever revision they applied first). Executable SQL is
// byte-identical across every pinned revision (verified: strip `--` comment
// lines and blank lines; the residue hashes identically from first commit to
// HEAD) for every entry EXCEPT the byte-order one at the bottom, which is
// justified by a measured data equivalence instead and carries that argument in
// full at its own entry rather than relying on this blanket sentence.
// Applied fleet-wide through code deploy: both the startup auto-run and
// `node src/migrate.js` pass through this heal before the mismatch guard, so no
// direct schema_migrations SQL is ever needed. Mirrors xchain-indexer/src/db.js.
Database.MIGRATION_CHECKSUM_REBASELINES = {
    // Comment-only edits: 3a1c435 rewrote the validator note into the follower
    // ordering note (and dropped an em-dash), ec36bd4 added the license header.
    // The single ALTER statement is unchanged since authorship (9f3b898).
    '2026-06-15-events-data-mediumtext.sql': {
        from: [
            'c34872de8f381587269d0a408138b9caadb5cbec01660eef034a95a7a039ca42',  // 9f3b898..6869813
            '08cd99f76467f8aa82ffb06df5ff46b67095c5d1fd89dd427b6a085d52a30006',  // 3a1c435
        ],
        to:   '3790d814dec1ecbf7be78065be82a9f7e4f983c4529620f3c1a7d01f129881e8',  // ec36bd4 (HEAD)
    },
    // Comment-only edits: 6869813 corrected the stale header comment (table
    // rebuild warning), ec36bd4 added the license header. The executable
    // statements are unchanged since authorship (710a954).
    '2026-06-17-pubkeys-add-monotonic-id.sql': {
        from: [
            '84b1c8093344d8a829d724c6e99468bb12c24cb85fe9a248a04e57b6d5769697',  // 710a954
            '1aabdd6da22872473ce26757c357dbbb68240fb5681956adce959778203b9caa',  // 6869813..3a1c435
        ],
        to:   '1d8406192690e5a754ec9430fcd9115e907f34944f340a70b776166a62f83868',  // ec36bd4 (HEAD)
    },
    // Comment-only edit: the header claimed mode=manual left the file
    // "pending and harmless on fresh DBs" and that IF [NOT] EXISTS made a partial
    // run resumable. Both were false and both invited the corrupting blanket run,
    // so the header now names MIGRATION_PRECONDITIONS below as the actual guard.
    // The four statements are unchanged since authorship (63fc384): stripping
    // `--` comment lines and blank lines leaves the identical residue
    // 820a0b2ae5b662a4e963dd2301f6ac86d2f67feaa6b59527c23fabec3c1a678c at every
    // revision pinned here.
    '2026-06-13-dispensers-expiration-bigint.sql': {
        from: [
            '8b163db63932ec7940fc0c4ff83abb6a52d27ab4a192c377ce5195c3ca4b969f',  // 63fc384
            'c4d622adc34b3190a7cc43954b4c815a3c79bb6c6b7374be39c16d66454d1549',  // ec36bd4 (license header)
            '44901ce7272347e6665ffe29655dbd7b8f3e45ba58b26671e50d07c0c629caef',  // header correction
        ],
        to:   '2e20aceb9a446f03ff8ef7a9fd2cc6dede722c30610de57c0d1ef25a455b4dca',  // comment tidy (HEAD)
    },
    // Comment-only edit: the header prose was tidied and a stale operator note
    // dropped. The executable statements are unchanged since a0f826b, which is
    // the earliest revision that can be blessed here: 6869813 and older carry a
    // different statement residue and must still fail the immutability check.
    '2026-06-02-widen-ids-to-bigint.sql': {
        from: [
            'e508ea3bcc4ea4f8f6fd241d93c678245a0ddcb9e582094fe4ddbb636b66d6d7',  // a0f826b
            '82865499dd2ccc48c0a0a016535409a9201b415395f49c70b41c73a3aeda8847',  // ec36bd4 (license header)
        ],
        to:   'b03b41b6fcabef9c959851ede9b75cc9089cef7c015bdd69cfcea74ad5acea7a',  // comment tidy (HEAD)
    },
    // Comment-only edit: the fleet recorded 50a5e83, which is the revision that ADDED the
    // `@mempool_has_ids` guard, so the guarded UPDATEs are what actually ran. 7817e6c then
    // added the license header. Stripped residue verified IDENTICAL between 50a5e83 and
    // HEAD, so this entry meets the ordinary contract above.
    '2026-05-28-unique-index-tables.sql': {
        from: '8845b9addc0990b0433f8862969b57cb472535474b4b4d5576c408db777b57ce',  // 50a5e83..7817e6c^
        to:   '4f7f53ea5423d5ad50e0a2136243dab9e215033e6a110c7b47e66ba5361d44c2',  // 7817e6c (HEAD)
    },
    // THE ONE ENTRY THAT DOES NOT MEET THE BYTE-IDENTICAL-SQL CONTRACT ABOVE, said plainly
    // rather than filed quietly alongside the comment-only ones. The fleet recorded 0a6afe3,
    // which PREDATES c808bd1, so the SQL that ran there really was the earlier form:
    //
    //     recorded (0a6afe3):  JOIN blocks prev ON prev.block_index = b.block_index - 1
    //     HEAD     (c808bd1):  JOIN blocks prev ON prev.block_index + 1 = b.block_index
    //
    // The two are algebraically identical for every block_index >= 1 and differ ONLY at
    // block_index 0, where `b.block_index - 1` underflows BIGINT UNSIGNED - which is the
    // defect c808bd1 fixed. So this is justified by a DATA equivalence rather than by a text
    // equivalence, and the data was measured on 2026-08-14 rather than assumed: the lowest
    // block any decoder holds is its XChain genesis pin, BTC 950000, LTC 3120000, DOGE
    // 6240000. No decoder database contains block_index 0, or anything near it, so the
    // divergent branch was UNREACHABLE on every database this heals and both forms produced
    // identical rows.
    //
    // The check to re-run before extending this entry to a new database: if it can ever hold
    // block_index 0, this reasoning does NOT carry and the schema must be reconciled instead.
    '2026-06-02-fix-previous-block-hash-byte-order.sql': {
        from: '263aba4e1f16aca19342cb1d58eb072735e822ddffc3823e8850cf52404c37dd',  // 0a6afe3..c808bd1^
        to:   'db1e2cac25b7ed132dddaf33a483f35151208901c40a5b4c637d5b5f23492663',  // 7817e6c (HEAD)
    },
};

// Applicability preconditions the runner evaluates against the LIVE schema before it
// applies a migration (see _migrationPreconditionSkip). Each entry is a parameterised
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
    // needs an operator, and _assertDispenserExpirationIsBigintUnsigned fails closed on it.
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
};

// Backdating guard for the auto-apply path, mirroring xchain-indexer/src/db.js. Apply
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

module.exports = Database