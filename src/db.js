/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Decoder - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const fs      = require('fs');
const util    = require('./util')
const bs = require("binary-search")

const SATOSHIS_DECIMALS = 8
const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/

class Database {
    constructor(host, port, dbName, user, pass){
        if (!DB_NAME_REGEX.test(dbName)) {
            throw new Error('Invalid database name: must contain only alphanumeric characters and underscores')
        }
        this.sqlPath  = __dirname+'/sql';
        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        this.DUPLICATED_TRANSACTION = 1
        // Database connection parameters
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        // Database pool connection parameters
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            // Connection options
            connectionLimit:  10,
            //connectTimeout: 0,
            insertIdAsNumber: true,
            queryTimeout:     parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
        };
        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
        this._transactionLock = false;
        this._transactionLockQueue = [];
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    

    // Verify a database exists and return true or false
    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        while(true){
            try {
                let db     = await mariadb.createConnection(connectionParams);
                let result = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(result.length > 0)
                    return true;
                return false;
            } catch (e){
                console.error('Error checking if database ' + this.dbName + ' exists:', e)
                await util.sleep(5000); // Wait 5 seconds
            }
        }
    }

    // Handle creating a database
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
        while(!databaseCreated){
            try {
                let db     = await mariadb.createConnection(connectionParams);
                let result = await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                databaseCreated = true;
            } catch(e){
                console.error('Error creating database ' + this.dbName + ':', e)
                await util.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    }
    
    // Handle verifying all database tables exist
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
        // Loop through SQL files
        try {
            for (file of files){
                // indexOf returns -1 when '.sql' is absent (e.g. the migrations/ subdirectory).
                // -1 is truthy, so the old `if(isSql)` processed non-.sql entries and tried to
                // read a directory as a table (EISDIR). Only process actual .sql files.
                var isSql = file.indexOf('.sql');
                if(isSql !== -1){
                    let table   = file.substring(0, file.indexOf('.sql'));
                    console.log('Verifying ' + table + ' table exists...');
                    try {
                        if(existing.has(table)){
                            // Existing table — reconcile column drift against the SQL
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
            // so releaseConnection() — which only releases transactionConnection —
            // would be a no-op. Release the lease itself, or a fresh-DB boot leaks
            // one connection per created table plus this one and exhausts the pool.
            try { await db.release(); } catch(_){}
        }
        return true;
    }

    // Apply tracked, ordered schema migrations from src/sql/migrations/ — the changes
    // the startup drift reconciler deliberately can't/won't make on its own: data
    // backfills, destructive index/column changes, dedup-then-unique, type changes.
    // (Additive column/index drift is already auto-reconciled by verifyTables; this is
    // only for the rest.) Each file is applied at most once and recorded in the
    // `schema_migrations` ledger, so it is safe to call on every startup.
    //
    // A migration opts into unattended application with a header tag on any of its
    // first lines:
    //   -- xchain:migration mode=auto     → applied automatically at startup
    //   -- xchain:migration mode=manual   → applied only by an explicit operator run
    // A file with NO tag is treated as `manual` — unknown DDL never auto-runs. `auto`
    // migrations must be additive + idempotent (guard with IF [NOT] EXISTS); anything
    // that can fail on existing data must be `manual`.
    //
    // opts.includeManual=true also applies pending `manual` migrations — the operator
    // path (`node src/migrate.js`). The whole run holds a DB-scoped advisory lock so
    // concurrent processes can't apply the same file twice. Returns { applied, pending }.
    async runMigrations(opts = {}){
        const crypto        = require('crypto');
        const includeManual = !!opts.includeManual;
        const dir           = this.sqlPath + '/migrations';
        const result        = { applied: [], pending: [] };

        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
        catch(e){ return result; }   // no migrations dir → nothing to do
        if(!files.length) return result;

        const lockName = 'xchain_migrate_' + this.dbName;
        let conn = await this.getConnection();
        try {
            const got = await conn.query('SELECT GET_LOCK(?, 30) AS l', [lockName]);
            if(!got || !got[0] || String(got[0].l) !== '1'){
                console.warn('runMigrations: could not acquire lock ' + lockName + ' (another process is migrating). Skipping this run.');
                return result;
            }
            try {
                await this._ensureMigrationsLedger(conn);
                const appliedRows   = await conn.query('SELECT name, checksum FROM schema_migrations');
                const appliedByName = new Map(appliedRows.map(r => [r.name, r.checksum]));

                for(const file of files){
                    const raw      = fs.readFileSync(dir + '/' + file, 'utf8');
                    const checksum = crypto.createHash('sha256').update(raw).digest('hex');

                    if(appliedByName.has(file)){
                        if(appliedByName.get(file) !== checksum){
                            console.warn('runMigrations: ' + file + ' was already applied but its content CHANGED (checksum mismatch). Migrations are immutable once applied — review manually.');
                        }
                        continue;
                    }

                    const mode = this._migrationMode(raw);
                    if(mode !== 'auto' && !includeManual){
                        console.log('runMigrations: PENDING (gated, mode=' + mode + '): ' + file + ' — apply with `node src/migrate.js`.');
                        result.pending.push(file);
                        continue;
                    }

                    const statements = this.stripSqlLineComments(raw).split(';').map(s => s.trim()).filter(Boolean);
                    console.log('runMigrations: applying ' + file + ' (mode=' + mode + ', ' + statements.length + ' statement(s))...');
                    try {
                        for(const stmt of statements){ await conn.query(stmt); }
                    } catch(err){
                        console.error('runMigrations: FAILED applying ' + file + ': ' + (err && err.message));
                        throw err;   // schema is in an unknown state — block startup
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
        if(result.pending.length) console.log('runMigrations: ' + result.pending.length + ' manual migration(s) pending for ' + this.dbName + ' — run `node src/migrate.js` to apply.');
        return result;
    }

    // Read a migration file's `-- xchain:migration mode=auto|manual` header tag.
    // Defaults to 'manual' when absent (conservative — unknown DDL never auto-runs).
    _migrationMode(raw){
        const m = String(raw).match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
        return m ? m[1].toLowerCase() : 'manual';
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

    // Remove SQL `--` line comments while respecting quoted strings, so a ';'
    // or ',' appearing inside comment prose is never mistaken for SQL structure.
    // Single/double-quote and backtick spans are preserved verbatim (doubled
    // quotes treated as escapes); a `--` outside any quote skips to the end of
    // its line. Newlines are kept so the column-split below stays well-formed.
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
            if(ch === '-' && sql[i + 1] === '-'){
                while(i < sql.length && sql[i] !== '\n'){ i++; }
                if(i < sql.length){ out += '\n'; }
                continue;
            }
            out += ch;
        }
        return out;
    }

    // Parse a CREATE TABLE statement to extract expected columns. Conservative —
    // only used for drift detection, not full schema management. Returns array of
    // {name, nullable, definition, notNull, hasDefault} or null when the file has
    // no recognizable CREATE TABLE block.
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing — inline comments
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
            // Skip constraint/index/key lines — column definitions only
            if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
            const tokens = line.split(/\s+/);
            if(tokens.length < 2) continue;
            const name       = tokens[0].replace(/`/g, '');
            // A column is nullable unless it says NOT NULL or is an inline PRIMARY
            // KEY (SQL forces PK columns NOT NULL, so a MODIFY ... NULL on one is a
            // silent no-op that would otherwise re-fire on every startup).
            const nullable   = !/\bNOT\s+NULL\b/i.test(line) && !/\bPRIMARY\s+KEY\b/i.test(line);
            const notNull    = !nullable;
            const hasDefault = /\bDEFAULT\b/i.test(line);
            // Keep the full (comment-stripped) definition so a missing column can
            // be re-added verbatim — preserving its DEFAULT clause, which is what
            // backfills existing rows when the column is NOT NULL.
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    }

    // Detect schema drift between the live table and its SQL source, and fix it
    // by ALTER. Two kinds of drift are handled:
    //   1. Missing columns — a column declared in the SQL source but absent from
    //      the live table is added with ADD COLUMN, reusing the source definition
    //      verbatim so its DEFAULT clause backfills existing rows. (A NOT NULL
    //      column with no DEFAULT can't be backfilled safely, so it's skipped
    //      with a loud warning rather than aborting startup.)
    //   2. Nullability — only relaxes NOT NULL -> NULL (the safe direction; never
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
            console.warn('Schema drift check SKIPPED for `' + table + '`: could not parse columns from ' + file + ' — expected a `CREATE TABLE ... ) ENGINE ...` definition. Additive column/nullability drift will NOT auto-reconcile for this table until the SQL source is fixed.');
            return;
        }
        const live = await db.query(
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        const liveByName = new Map(live.map(c => [c.COLUMN_NAME.toLowerCase(), c]));
        for(const exp of expected){
            const cur = liveByName.get(exp.name.toLowerCase());
            if(!cur){
                if(exp.notNull && !exp.hasDefault){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT — cannot backfill existing rows safely. Skipping; add manually.');
                    continue;
                }
                console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source.');
                await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition);
                continue;
            }
            const liveIsNullable = cur.IS_NULLABLE === 'YES';
            if(!liveIsNullable && exp.nullable){
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
    // rows, dedupes first (see dedupeForUniqueIndex) then retries. Never throws — a
    // failure is logged and startup continues. On a table that already has every declared
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
                if(liveNames.has(idx.name.toLowerCase())) continue;          // name taken by a different index — leave alone
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
                    console.log('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index — deduping (keep newest id per ' + key + ') then retrying.');
                    if(!(await this.dedupeForUniqueIndex(db, table, idx.columns))) continue;
                    try {
                        await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                        console.log('  added ' + idx.name + ' after dedupe.');
                    } catch(e2){
                        console.log('  ' + table + '.' + idx.name + ' still failing after dedupe — leaving as-is: ' + (e2 && e2.message));
                    }
                }
            }
        } catch(e){
            // Never abort startup over index reconciliation.
            console.warn('reconcileTableIndexes(' + file + ') failed (non-fatal): ' + (e && e.message));
        }
    }

    // Collapse duplicate rows on `columns` so a UNIQUE index can be added, keeping the
    // row with the highest `id` in each group. For the failure this repairs — an
    // INSERT ... ON DUPLICATE KEY UPDATE upsert that degraded to plain INSERT because the
    // unique index was missing — each change appended a fresh row with the current
    // value, so the highest id is the live (correct) value and the older rows are stale.
    // Uses `=` (not `<=>`) so NULL tuples are left intact, matching UNIQUE semantics (a
    // UNIQUE index permits multiple NULLs). Requires a single `id` column to pick a
    // survivor; skips with a warning if absent. Returns true if the table is now safe to index.
    async dedupeForUniqueIndex(db, table, columns){
        const hasId = (await db.query(
            "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = 'id'",
            [this.dbName, table])).length > 0;
        if(!hasId){
            console.log('  cannot dedupe ' + table + ' (no `id` column to pick a surviving row) — skipping unique-index add.');
            return false;
        }
        const on  = columns.map(c => 't1.`' + c + '` = t2.`' + c + '`').join(' AND ');
        const res = await db.query('DELETE t1 FROM `' + table + '` t1 JOIN `' + table + '` t2 ON ' + on + ' AND t1.id < t2.id');
        console.log('  deduped ' + table + ': removed ' + (res && res.affectedRows != null ? res.affectedRows : '?') + ' stale duplicate row(s).');
        return true;
    }

    // Handle creating database tables. Runs on the caller's connection (same
    // pattern as alterTableForDrift) — leasing a fresh connection per table here
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
        // Strip `--` line comments BEFORE splitting on ';' (same as runMigrations):
        // a column comment may legitimately contain a ';' (e.g. "raw seconds; matches
        // …"), which would otherwise split the CREATE TABLE mid-statement and break a
        // fresh install. Existing DBs never hit this (verifyTables skips createTable
        // when the table already exists), so it was a latent fresh-install-only bug.
        let queries = this.stripSqlLineComments(data).split(';');
        let query   = null;
        console.log('Creating ' + table + ' table and indexes...');
        try {
            // Loop through SQL queries
            for(query of queries){
                query = query.trim();
                // Ignore empty queries
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

    // Handle releasing a connection and freeing it up for additional queries
    async releaseConnection(){
        if(this.transactionConnection != null){
            // console.log("releasing database connection");
            await this.transactionConnection.release();
            this.transactionConnection = null;
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
    
    async deleteBlockByIndex(blockIndex){
        await this.beginTransaction()
        let connection = await this.getConnection()

        try {
            // Resurrect any dispenser that THIS (now-orphaned) block soft-expired:
            // clear the expiry mark so it is open again. Must run before the
            // dispenser row-delete below — a dispenser both OPENED and expired in
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
            await this.commitTransaction()

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
                    // — getBlockHash's axios body and insertEvent's JSON.stringify both throw
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
                    // tx_index is BIGINT UNSIGNED — coerce the BigInt to Number for the same
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
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query, [blockIndex])
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error selecting max block height:', err);
            return null
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
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
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
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
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
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
                return false;
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
            data
        ) VALUES (?, ?, ?, ?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
        const ownLease = (this.transactionConnection == null)

        try {
            // Store raw strings here — never allocate index_addresses/index_transactions
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
                tx.data
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

    // Lookup a record in the `index_transactions` table and return record id
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

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hashes and return hardcoded record id
        if(hash==null||hash=='')
            return 1;
        var id = await this.getTransactionId(hash);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: if a
            // concurrent caller inserted the same hash between our lookup and here,
            // the IGNORE skips the duplicate and the refetch below resolves to the
            // canonical row id — so two callers can never create duplicate rows.
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

    // Lookup a record in the `index_addresses` table and return record id
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

    // Create records in the 'index_addresses' table and return record id
    async createAddress(address){
        // Ignore empty address and return hardcoded record id
        if(address==null||address=='')
            return 1;
        var id = await this.getAddressId(address);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: if a
            // concurrent caller inserted the same address between our lookup and here,
            // the IGNORE skips the duplicate and the refetch below resolves to the
            // canonical row id — so two callers can never create duplicate rows.
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

    async insertEvent(code, data){
        const query = `
            INSERT INTO events (
            time,
            code,
            data
        ) VALUES (?, ?, ?);
        `;
        
        let connection = await this.getConnection()
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
        const ownLease = (this.transactionConnection == null)
        
        try {
            let timeString = new Date().toISOString().slice(0, 19).replace('T', ' ');
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

    async deleteAndCompareTxsNotInList(txidList) {
        let deletedTxHashes = []
        let db = await this.getConnection();

        const query = `
            SELECT tx_hash AS hash
                FROM mempool_transactions;
        `;

        try {
            let rows = await db.query(query);

            for (let nextRowIndex in rows) {
                let nextRow = rows[nextRowIndex]

                const txid = nextRow["hash"]
                const txidIndex = bs(txidList, txid, function (element, needle) { return needle.localeCompare(element) })

                if (txidIndex < 0) {
                    deletedTxHashes.push(txid)
                } else {
                    txidList.splice(txidIndex, 1)
                }
            }

            if (deletedTxHashes.length > 0) {
                let placeholders = deletedTxHashes.map(() => '?').join(',')
                let deleteQuery = `DELETE FROM mempool_transactions WHERE tx_hash IN (${placeholders})`
                await db.query(deleteQuery, deletedTxHashes);
            }

            return { transactionsDeleted: deletedTxHashes.length}
        } catch (err) {
            console.error('Error querying mempool_transactions:', err);
            return { transactionsDeleted: 0 }
        } finally {
            if (this.transactionConnection == null) {
                await db.release()
            }
        }
    }
    
    async insertDispenser(openDispenser) {
        const query = `
            INSERT INTO dispensers (
            tx_index,
            address_id,
            expiration
        ) VALUES (?, ?, ?);
        `;
        // expiration is a raw unix timestamp (seconds) stored as-is into a BIGINT UNSIGNED
        // column. It is deliberately NOT wrapped in FROM_UNIXTIME(): FROM_UNIXTIME() caps at
        // 2147483647 (Y2038) and returns NULL above it, which would silently drop every
        // expiration in 2038–2106 even though the decoder accepts values up to 4294967295
        // (XChainDecoder.js DISPENSER parse). Matches xchain-indexer dispensers.expiration.
        
        let connection = await this.getConnection()
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
        const ownLease = (this.transactionConnection == null)
        
        try {
            let txIndex = openDispenser.txIndex
            let addressId = await this.createAddress(openDispenser.address)
            let expiration = openDispenser.expiration
            
            await connection.query(query, [
                txIndex,
                addressId,
                expiration
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
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
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
    // expired_block_index — filtered out here so an expired dispenser stops
    // capturing payment outputs exactly as the old hard-delete did).
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
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the
        // catch path's endTransaction() releases it and nulls the field — so the
        // finally must key off this entry-time snapshot, not the mutated field,
        // or it would release the same pooled socket a second time.
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
    // never roll back committed block data — at worst soft-expired rows linger a
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
}

module.exports = Database