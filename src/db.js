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
const config = require('./config');
const { DB_NAME_REGEX } = require('./db/constants.js')
const { resolveQueryTimeout } = require('./db/query_helpers.js')

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
            queryTimeout:     resolveQueryTimeout(config.DB_QUERY_TIMEOUT)
        };
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
        this._transactionLock = false;
        this._transactionLockQueue = [];
    }
}

module.exports = Database

const connectionLifecycle = require('./db/connection_lifecycle.js')
const databaseSetup = require('./db/database_setup.js')
const migrations = require('./db/migrations.js')
const migrationStatements = require('./db/migration_statements.js')
const tableDrift = require('./db/table_drift.js')
const blocks = require('./db/blocks.js')
const transactions = require('./db/transactions.js')
const mempool = require('./db/mempool.js')
const addressesAndEvents = require('./db/addresses_and_events.js')
const dispensers = require('./db/dispensers.js')
const dispenserQueries = require('./db/dispenser_queries.js')
const reorgHalt = require('./db/reorg_halt.js')

Object.assign(
    Database.prototype,
    connectionLifecycle,
    databaseSetup,
    migrations,
    migrationStatements,
    tableDrift,
    blocks,
    transactions,
    mempool,
    addressesAndEvents,
    dispensers,
    dispenserQueries,
    reorgHalt,
)

require('./db/migration_checksum_rebaselines.js')
require('./db/migration_preconditions.js')
