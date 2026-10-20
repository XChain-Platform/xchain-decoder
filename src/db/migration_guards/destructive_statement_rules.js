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

// The statement rules behind destructiveAutoStatement in ../migration_statements.js.
const { opensBackslashEscape, createNamesNonInnoDb, dropTargetDestroys } = require('../query_helpers.js')
const { alterSpecs, blankLiterals } = require('../migration_live_schema_guard.js')

// True when a `#` sits outside every quoted span - a line comment
// stripSqlLineComments should already have removed. Quote-aware so a `#`
// inside a string literal or a backtick identifier is not mistaken for one.
// Local rather than a method: runMigrations' callers build partial `this`
// objects, and a second prototype hop would break the guard on those.
function hasUnquotedHash(s){
    let q = null;
    for(let i = 0; i < s.length; i++){
        const c = s[i];
        if(q){
            if(opensBackslashEscape(s, i, q)){ i++; continue; }
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
}

// True for the only session SETs an auto file may carry: SET NAMES and a single UTC time_zone,
// the zone the pool is configured for (timezone 'Z'), so neither can relax a strict-mode check.
// Kept in step with the xchain-indexer classifier.
function autoEligibleSet(stmt){
    if(/^SET\s+NAMES\s+['"]?\w+['"]?(?:\s+COLLATE\s+['"]?\w+['"]?)?$/i.test(stmt)) return true;
    return /^SET\s+(?:SESSION\s+|LOCAL\s+|@@SESSION\.|@@LOCAL\.|@@)?time_zone\s*=\s*'\+00:00'$/i.test(stmt);
}

function isSimpleDestructiveStatement(stmt){
    // Server-side indirection escapes a statement-prefix classifier: a mode=auto
    // file can smuggle destructive SQL past every keyword check below via dynamic
    // SQL (`SET @s = 'DROP TABLE balances'; PREPARE stmt FROM @s; EXECUTE stmt;`)
    // or a `CALL proc()` whose body the scanner cannot see. None of these are used
    // by any committed auto migration, so treat them as non-auto-eligible. SET of a
    // user variable (`SET @s = ...`) exists to stage dynamic SQL for PREPARE, so
    // flag it too.
    if(/^PREPARE\b/i.test(stmt)) return true;
    if(/^EXECUTE\b/i.test(stmt)) return true;
    if(/^CALL\b/i.test(stmt)) return true;
    if(/^SET\s+@(?!@)/i.test(stmt)) return true;
    // Any other SET is an allow-list, not a deny-list: only SET NAMES and a single
    // UTC time_zone stay auto-eligible. A SET sql_mode (or foreign_key_checks, ...) turns
    // off the strict-mode backstop, so a later narrowing MODIFY in the same file truncates
    // silently instead of failing; and SET STATEMENT v=x FOR <stmt> hides a statement
    // behind the SET keyword from every check below.
    if(/^SET\b/i.test(stmt) && !autoEligibleSet(stmt)) return true;
    // DROP is an allow-list like CREATE: only a standalone index drop and a session temporary-table
    // drop stay auto-eligible, since a sequence, trigger, view, event or routine drop loses state or behaviour.
    if(/^DROP\b/i.test(stmt) && !/^DROP\s+(?:INDEX|TEMPORARY\s+TABLE)\b/i.test(stmt)) return true;
    // CREATE OR REPLACE TABLE is an atomic DROP TABLE IF EXISTS + CREATE: it destroys
    // every existing row. Plain CREATE TABLE / CREATE TABLE IF NOT EXISTS are additive
    // and stay unflagged (see the CREATE note below); only the OR REPLACE form loses
    // data. DROP TABLE is already flagged, so an author must not be able to slip the
    // data-losing idempotent-create variant past the auto guard.
    if(/^CREATE\s+OR\s+REPLACE\s+(TEMPORARY\s+)?TABLE\b/i.test(stmt)) return true;
    if(/^TRUNCATE\b/i.test(stmt)) return true;
    if(/^RENAME\s+TABLE\b/i.test(stmt)) return true;
    // Any DELETE removes row data - there is no non-destructive form - so match the
    // bare keyword, not `DELETE FROM`. The narrower form let valid-but-non-canonical
    // syntax slip the auto guard: `DELETE LOW_PRIORITY FROM`, `DELETE IGNORE FROM`,
    // and multi-table `DELETE t1 FROM t1 JOIN t2 ...` all delete rows yet omit an
    // immediate FROM. No false positive: a statement starting with DELETE is always DML.
    if(/^DELETE\b/i.test(stmt)) return true;
    // REPLACE INTO is an atomic DELETE+INSERT on every existing-key row it
    // touches - the same data-loss profile as DELETE, with no non-destructive
    // form - so match the bare keyword like DELETE above.
    if(/^REPLACE\b/i.test(stmt)) return true;
    // INSERT ... ON DUPLICATE KEY UPDATE overwrites columns of every existing
    // duplicate-key row it touches - the same data-rewrite profile the UPDATE arm
    // below hard-blocks, reached from a keyword that arm never sees. Plain INSERT
    // stays auto-eligible: with no ON DUPLICATE clause it only adds rows.
    if(/^INSERT\b[\s\S]*\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stmt)) return true;
    // LOAD DATA ... REPLACE INTO TABLE is a DELETE+INSERT on every key collision,
    // and the rows come from a file the classifier cannot read, so no form of it
    // can be judged safe from the statement text. No committed auto migration
    // loads a file; treat the whole form as non-auto-eligible.
    return /^LOAD\s+DATA\b/i.test(stmt);
}

// True for any CREATE other than an InnoDB table or an index. A trigger, event, routine or
// view carries SQL this classifier never reads, and the server runs it later (a trigger on
// every row write), the same blind spot as CALL above.
function createOutsideAllowList(stmt){
    if(!/^CREATE\b/i.test(stmt)) return false;
    // Allow the additive forms committed auto migrations use: [TEMPORARY] TABLE and INDEX.
    if(/^CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(stmt)) return createNamesNonInnoDb(stmt);
    return !/^CREATE\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?INDEX\b/i.test(stmt);
}

function isDestructiveAlter(stmt, safeAlterDrop){
    // Partition and tablespace clauses move or discard row data while carrying
    // none of the keywords the checks below look for: TRUNCATE PARTITION empties
    // a partition, EXCHANGE PARTITION swaps its rows out to another table,
    // DISCARD TABLESPACE deletes the table's data file. The additive members of
    // the class (ADD PARTITION, IMPORT TABLESPACE) are not separable from the
    // destructive ones by prefix, and no committed migration partitions anything,
    // so the whole class is non-auto-eligible - re-tag mode=manual to run one.
    if(/\bPARTITION(?:ING)?\b/i.test(stmt)) return true;
    if(/\bTABLESPACE\b/i.test(stmt)) return true;
    // Any ENGINE option rebuilds the whole table by copy, and a non-InnoDB engine loses rows on
    // restart (MEMORY) or escapes the reorg rollback (MyISAM, Aria), so it runs manual only.
    if(/\bENGINE\b/i.test(stmt)) return true;
    // Every DROP inside the ALTER must target a safe (metadata-only) object.
    if(dropTargetDestroys(stmt, safeAlterDrop)) return true;
    // RENAME TO / RENAME COLUMN / bare RENAME lose the old name; only
    // RENAME INDEX/KEY is a metadata-only rename.
    if(/\bRENAME\b(?!\s+(INDEX|KEY)\b)/i.test(stmt)) return true;
    // CHANGE [COLUMN] renames and retypes in one clause - manual only.
    if(/\bCHANGE\b/i.test(stmt)) return true;
    // CONVERT TO CHARACTER SET rewrites every text column of the table and can truncate or
    // re-encode row data.
    if(/\bCONVERT\s+TO\b/i.test(stmt)) return true;
    // MODIFY that adds NOT NULL narrows the column domain, except an AUTO_INCREMENT repair
    // (definitionally NOT NULL; 2026-06-10-mirror-id-autoincrement-repair.sql). Checked per
    // top-level clause, so one AUTO_INCREMENT clause cannot exempt a sibling NOT NULL clause.
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
           !/\bAUTO_INCREMENT\b/i.test(clause)) return true;
    }
    // Read each alter_spec past the head and any WAIT n / NOWAIT (an unparsed head is one spec).
    const parsed = alterSpecs(stmt);
    for(const spec of (parsed ? parsed.specs : [stmt])){
        // Restating id without AUTO_INCREMENT strips the attribute, so later inserts lose their key.
        if(/^\s*MODIFY\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?`?id`?(?=\s|$)/i.test(spec) &&
           !/\bAUTO_INCREMENT\b/i.test(spec)) return true;
        // A MODIFY keyword that does not open its spec is one no check here can place.
        if(/\bMODIFY\b/i.test(blankLiterals(spec)) && !/^\s*MODIFY\b/i.test(spec)) return true;
    }
    return false;
}

module.exports = { hasUnquotedHash, isSimpleDestructiveStatement, createOutsideAllowList, isDestructiveAlter }
