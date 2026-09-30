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
const util = require('../util')
const Database = require('../db.js')
const { format: formatLogLine } = require('node:util');
const { logger } = require('./constants.js')

async function existingTableNames(database, db){
    // Snapshot the set of tables currently in this database. SHOW TABLES is a
    // direct query (no parameter binding quirks) and gives a clean per-DB list,
    // so the existence check below is reliable on a fresh DB.
    let existing = new Set();
    try {
        let rows = await db.query("SHOW TABLES FROM `" + database.dbName + "`");
        for (let row of rows){
            // SHOW TABLES returns one column named "Tables_in_<dbname>".
            for (let key in row){
                existing.add(String(row[key]));
                break;
            }
        }
    } catch(e){
        logger.info('Error listing tables in ' + database.dbName + ': ' + (e && e.sqlMessage ? e.sqlMessage : e));
        util.throwError('Error while listing tables in ' + database.dbName);
        try { await db.release(); } catch(_){}
        return null;
    }
    return existing;
}

async function verifyTableFiles(database, files, existing, db){
    let checked = 0;
    let created = 0;
    for (const file of files){
        // indexOf returns -1 when '.sql' is absent (e.g. the migrations/ subdirectory).
        // -1 is truthy, so the old `if(isSql)` processed non-.sql entries and tried to
        // read a directory as a table (EISDIR). Only process actual .sql files.
        var isSql = file.indexOf('.sql');
        if(isSql !== -1){
            let table = file.substring(0, file.indexOf('.sql'));
            checked++;
            try {
                if(existing.has(table)){
                    // Existing table: reconcile column drift against the SQL
                    // source so columns added upstream (e.g. transactions.raw_data)
                    // are auto-applied on stacks created from an older release,
                    // instead of surfacing later as a hard "Unknown column" error.
                    await database.alterTableForDrift(file, db);
                    // Also reconcile declared indexes. A UNIQUE index added to
                    // the SQL source AFTER a table was first created is otherwise
                    // never applied to existing databases, which silently degrades
                    // any INSERT ... ON DUPLICATE KEY UPDATE relying on it to a
                    // plain INSERT and accumulates duplicate rows.
                    await database.reconcileTableIndexes(file, db);
                } else {
                    await database.createTable(file, db);
                    existing.add(table);
                    created++;
                }
            } catch(e){
                logger.info('Error verifying table ' + table + ': ' + e.code);
                util.throwError('Error while trying to verify ' + table + ' table exists!');
                return null;
            }
        }
    }
    return { checked, created };
}

module.exports = {
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
                let db     = await this.createConnection(connectionParams);
                let result = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(result.length > 0)
                    return true;
                return false;
            } catch (e){
                attempts++;
                if(attempts >= maxAttempts)
                    throw new Error('Failed to verify database ' + this.dbName + ' after ' + maxAttempts + ' attempts: ' + (e.code || e.message));
                logger.error(formatLogLine('Error checking if database ' + this.dbName + ' exists (attempt ' + attempts + '/' + maxAttempts + '):', e))
                await util.sleep(5000);
            }
        }
    },

    async createDatabase(){
        // First time connecting, do not specify database name or we throw error
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        let databaseCreated = false;
        logger.info("Creating " + this.dbName + " database!");
        // Bounded retry (~75s of patience): see verifyDatabase above. A persistent auth or
        // config failure throws so the process exits and the container can be restarted,
        // rather than looping and re-logging the same error forever.
        let attempts = 0;
        const maxAttempts = 15;
        while(!databaseCreated){
            try {
                let db     = await this.createConnection(connectionParams);
                let result = await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                databaseCreated = true;
            } catch(e){
                attempts++;
                if(attempts >= maxAttempts)
                    throw new Error('Failed to create database ' + this.dbName + ' after ' + maxAttempts + ' attempts: ' + (e.code || e.message));
                logger.error(formatLogLine('Error creating database ' + this.dbName + ' (attempt ' + attempts + '/' + maxAttempts + '):', e))
                await util.sleep(5000);
            }
        }
        return true;
    },

    async verifyTables(){
        let files = fs.readdirSync(this.sqlPath);
        let db    = await this.getConnection();
        let existing = await existingTableNames(this, db);
        if(existing === null) return false;
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        logger.info('Verifying database and tables...');
        let result;
        try {
            result = await verifyTableFiles(this, files, existing, db);
            if(result === null) return false;
        } finally {
            // This is a direct pool lease (transactionConnection is null at startup),
            // so releaseConnection() (which only releases transactionConnection)
            // would be a no-op. Release the lease itself, or a fresh-DB boot leaks
            // one connection per created table plus this one and exhausts the pool.
            //
            // The swallow is deliberate here and at the eight sibling release sites
            // in this file. release() rejects only when the connection is already
            // ended or already back in the pool, so there is nothing left to leak and
            // nothing an operator would act on; every one of these sits in a finally
            // beside a catch that already reports the real cause. A line per site
            // would name the same fault twice and spend the log-retention window on
            // shutdown noise. The one exception is the temp-table drop in
            // deleteAndCompareTxsNotInList, which has a consequence on a LATER query.
            try { await db.release(); } catch(_){}
        }
        logger.info('Database and tables verified (' + result.checked + ' tables, ' + result.created + ' created).');
        return true;
    },

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
    // node src/db/migrate.js). The run holds a DB-scoped advisory lock so concurrent processes
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
        const result = await this.runMigrationsInner(opts);
        await this.assertDispenserExpirationIsBigintUnsigned();
        await this.assertPubkeyColumnIsUncompressedWide();
        await this.assertActionDataIsUtf8mb4();
        return result;
    },

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
    async assertActionDataIsUtf8mb4(){
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
                        'Run the pending migration: node src/db/migrate.js --file ' +
                        Database.startupAssertedMigrationFile('assertActionDataIsUtf8mb4') +
                        '. If that migration is ALREADY recorded in schema_migrations, the runner will not re-run it: a later ' +
                        'rebuild re-created the table at utf8mb3, so convert the column directly with the decoder stopped - ' +
                        'ALTER TABLE ' + String(row.tbl) + ' MODIFY data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
                    );
                }
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },

    //This is only used in tests
    async dropDatabase(){
        logger.info("Droping database")

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
    },
}
