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

const config = require('../../config');
const Database = require('../../db.js')
const { logger } = require('../constants.js')

// Reconcile an applied file's checksum with the ledger: a match, a pinned rebaseline, or flagged drift
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

// Flag an auto file dated before a migration the ledger already applied
function guardMigrationFrontier(context, file, mode){
    // Backdating guard: the runner's dated-prefix check freezes the NAMING
    // convention, but nothing stopped a new file from being dated before a
    // migration the fleet already applied. Lexical apply order then puts it
    // in its date slot on a fresh DB and after the frontier on an aged one,
    // diverging the two schemas. `frontier` is the ledger state at run start
    // (appliedByName is not written during the loop, and the runner's precondition
    // baseline deliberately does not advance it), so files applied or
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

module.exports = { reconcileAppliedMigration, guardMigrationFrontier }
