#!/usr/bin/env node
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
 * Operator migration CLI (decoder).
 *
 * Decoder startup auto-applies only `auto`-tagged schema migrations (additive,
 * idempotent). This is the explicit, operator-initiated path that ALSO applies
 * pending `manual` migrations: destructive / data-backfill / dedup-then-unique
 * ones that must not run unattended. Idempotent and ledger-tracked
 * (schema_migrations), so re-running only applies what's pending.
 *
 *   node src/migrate.js          # apply ALL pending (auto + manual)
 *   node src/migrate.js --file 2026-06-13-dispensers-expiration-bigint.sql
 *                                # apply ONLY the named migration(s)
 *
 * The `--file <name>` flag scopes the run to specific migration filename(s), so a
 * single pending manual migration can be rolled out to a fleet DB WITHOUT also
 * applying every other pending manual migration in the committed tree (which a
 * blanket `node src/migrate.js` would). Repeat the flag (or comma-separate) to
 * target several files; an unknown name fails loudly instead of applying nothing.
 *
 * Any argument this CLI does not recognize is REFUSED with the usage text and
 * exit 2. It is never ignored: a no-argument run means APPLY EVERYTHING, so an
 * ignored token (a typo, `--dry-run`, `--help`) would silently apply every
 * pending manual migration the operator was only asking about.
 *
 * Reads DECODER_DB_* from the service environment (.env).
 *
 ********************************************************************/

const dotenv   = require('dotenv');
dotenv.config();

const Database = require('../db.js');

// Spelled out for an operator reading it mid-incident: the difference between a
// blanket run and a scoped one is the whole risk of this command, so each mode
// says what it applies rather than naming a flag.
const USAGE = [
    'Usage: node src/migrate.js [--file <name.sql> ...]',
    '',
    '  (no arguments)         APPLY EVERYTHING. Runs every pending migration, auto',
    '                         AND manual, against the database in DECODER_DB_NAME.',
    '                         Manual migrations are the destructive / backfill ones.',
    '  --file, -f <name.sql>  APPLY ONE. Runs only the named migration file(s).',
    '                         Repeat the flag or comma-separate to name several.',
    '  --help, -h             Print this usage and exit 0. Touches no database.',
    '',
    'Reads DECODER_DB_HOST / DECODER_DB_PORT / DECODER_DB_NAME / DECODER_DB_USER /',
    'DECODER_DB_PASS from the service environment (.env). Any other argument is',
    'refused with exit 2, because ignoring one would mean APPLY EVERYTHING.',
].join('\n');

// Print the usage and exit. Returns null so main() bails even where process.exit
// is stubbed (tests), instead of falling through to an apply-everything run.
function refuse(message){
    console.error('migrate: ' + message);
    console.error(USAGE);
    process.exit(2);
    return null;
}

// Parse `--file <name>` / `--file=<name>` / `-f <name>` occurrences into a list of
// migration filenames. Values may be comma-separated. [] means no targeting flag
// (the apply-everything default); null means refused or served, so main() must stop.
function parseFileTargets(argv){
    const targets = [];
    const push = (v) => {
        for(const part of String(v).split(',')){
            const name = part.trim();
            if(name) targets.push(name);
        }
    };
    for(let i = 0; i < argv.length; i++){
        const a = argv[i];
        // Usage requests are served before anything else reads the environment, so
        // asking what this command does never needs a loaded .env and never runs.
        if(a === '--help' || a === '-h'){
            console.log(USAGE);
            process.exit(0);
            return null;  // (unreachable when exit is real; keeps a stubbed exit from applying)
        }
        const named = targets.length;
        if(a === '--file' || a === '-f'){
            const v = argv[i + 1];
            if(v === undefined || v.startsWith('-')){
                return refuse(a + ' requires a migration filename argument.');
            }
            push(v);
            i++;
        } else if(a.startsWith('--file=')){
            push(a.slice('--file='.length));
        } else {
            // Refuse anything else, including a bare filename: only --file scopes a
            // run, and guessing here is what turns a typo into APPLY EVERYTHING.
            return refuse('unrecognized argument "' + a + '".');
        }
        // A targeting flag that named nothing (`--file=`, `--file ,`) would leave the
        // scope empty, and an empty scope means APPLY EVERYTHING: the opposite of
        // what the operator asked for. Refuse instead of widening the run.
        if(targets.length === named){
            return refuse(a + ' names no migration file.');
        }
    }
    return targets;
}

async function main(){
    // Argv is settled first so `--help` answers without a loaded .env, and so a
    // refused argument never reaches the database checks below.
    const only = parseFileTargets(process.argv.slice(2));
    if(only === null) return;

    const host = process.env.DECODER_DB_HOST;
    const port = process.env.DECODER_DB_PORT;
    const name = process.env.DECODER_DB_NAME;
    const user = process.env.DECODER_DB_USER;
    const pass = process.env.DECODER_DB_PASS;
    if(!host || !name || !user){
        console.error('migrate: DECODER_DB_HOST / DECODER_DB_NAME / DECODER_DB_USER must be set (load the service .env).');
        process.exit(2);
    }

    const db = new Database(host, port, name, user, pass);

    try {
        const runOpts = { includeManual: true };
        if(only.length){
            runOpts.only = only;
            console.log('migrate: applying ONLY targeted migration(s) ' + JSON.stringify(only) + ' to ' + name + ' ...');
        } else {
            console.log('migrate: applying pending migrations (auto + manual) to ' + name + ' ...');
        }
        const res = await db.runMigrations(runOpts);
        if(res.lockSkipped){
            // #3162: a lock-skip examined nothing; do not report it as a completed run.
            console.error('migrate: SKIPPED - another process holds the migration lock (xchain_migrate_' + name + '). Nothing was applied and the schema may still be un-migrated. Re-run once the other migrator finishes.');
            process.exitCode = 2;
        } else {
            // `baselined` is reported apart from `applied`: those files ran NO statement,
            // they were recorded as applied because their precondition says this database
            // is already in the state they exist to produce.
            const baselined = (res.baselined && res.baselined.length)
                ? ' baselined-not-run=' + JSON.stringify(res.baselined) : '';
            console.log('migrate: done. applied=' + JSON.stringify(res.applied) + baselined +
                ' still-pending=' + JSON.stringify(res.pending));
        }
    } catch(err){
        console.error('migrate: FAILED: ' + ((err && err.stack) || err));
        process.exitCode = 1;
    } finally {
        try { if(db.pool) await db.pool.end(); } catch(_){}
    }
}

main();
