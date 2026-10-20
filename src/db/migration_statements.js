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

const { opensBackslashEscape } = require('./query_helpers.js')
const { ensureLedgerAppliedAtDatetime } = require('./migration_ledger.js')
const { stripBlockComments } = require('./migration_live_schema_guard.js')
const {
    hasUnquotedHash, isSimpleDestructiveStatement, createOutsideAllowList, isDestructiveAlter,
} = require('./migration_guards/destructive_statement_rules.js')

module.exports = {
    // Read a migration file's `-- xchain:migration mode=auto|manual` header tag.
    // Defaults to 'manual' when absent (conservative: unknown DDL never auto-runs).
    migrationMode(raw){
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
    },

    // Destructive-DDL scan for the auto-apply path. Given a migration file's
    // statement list (already line-comment-stripped and ';'-split), returns the
    // first statement that can lose, truncate, or rename data - or null when the
    // file is safe to auto-run. Pure string logic (no DB), unit-tested directly.
    // Byte-for-byte the same classifier as xchain-indexer/src/db/database/migration_scan.js
    // so the two migration runners stay legible as a pair.
    //
    // Flagged as destructive: any top-level DROP other than DROP INDEX and DROP TEMPORARY
    // TABLE (sequences, triggers, views, events and routines too), TRUNCATE, RENAME TABLE,
    // DELETE (any form), REPLACE INTO (atomic DELETE+INSERT), INSERT ... ON DUPLICATE
    // KEY UPDATE (rewrites every colliding row), LOAD DATA (rows from a file the
    // scanner cannot read), UPDATE (except the
    // committed AUTO_INCREMENT id=0 repair),
    // ALTER TABLE ... DROP <column|partition|bare identifier>,
    // ALTER TABLE ... RENAME (except RENAME INDEX/KEY), ALTER TABLE ... CHANGE
    // (rename+retype), CONVERT TO (rewrites every text column), MODIFY ... NOT NULL
    // (the statically detectable narrowing; the runner's live-schema guard catches a
    // width cut or a dropped attribute), MODIFY id without AUTO_INCREMENT (strips the
    // generated key), a MODIFY not opening its alter_spec (WAIT n / NOWAIT belongs to the head),
    // any ALTER TABLE PARTITION, TABLESPACE or ENGINE clause, ALTER IGNORE
    // TABLE (deletes duplicate-key rows), any other ALTER than ALTER [ONLINE] TABLE, a CREATE
    // TABLE naming an engine other than InnoDB, and any CREATE other than [TEMPORARY] TABLE and
    // [UNIQUE|FULLTEXT|SPATIAL] INDEX (triggers, events, routines and views run SQL
    // the scanner cannot read), and any SET other than SET NAMES or a single UTC
    // time_zone (session variables relax strict mode; SET STATEMENT ... FOR hides a statement).
    //
    // Deliberately NOT flagged (legitimate existing auto patterns): DROP INDEX/KEY,
    // DROP FOREIGN KEY/CONSTRAINT/CHECK/DEFAULT/PRIMARY KEY with the keyword bare and
    // unquoted (structural, no row data lost), a standalone DROP INDEX ... ON and
    // DROP TEMPORARY TABLE, ADD ..., plain InnoDB or engine-less CREATE
    // TABLE / CREATE TABLE IF NOT EXISTS (additive; but CREATE OR REPLACE TABLE IS flagged -
    // it is an atomic DROP+CREATE), CREATE [UNIQUE] INDEX, MODIFY that widens/nullables a
    // column, and ALTER ONLINE TABLE under the same clause rules as plain ALTER TABLE.
    destructiveAutoStatement(statements){
        // Drops that remove metadata only; anything else after DROP inside an
        // ALTER (COLUMN, PARTITION, or a bare column identifier) loses data.
        const SAFE_ALTER_DROP = new Set(['INDEX', 'KEY', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'DEFAULT', 'PRIMARY']);
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
            // Strip /* */ comments (line comments are gone) so comment prose never triggers or hides
            // a hit; quote-aware, so a '/*' literal and a later '*/' literal hide no real clause.
            const stmt = stripBlockComments(raw).trim();
            if(!stmt) continue;
            // Second layer behind stripSqlLineComments: MariaDB/MySQL honour `#` to
            // end-of-line as a comment, so `# note\nDROP TABLE balances` is a DROP every
            // ^-anchored check below is blind to. The strip removes it upstream; if one
            // ever reaches here the strip has regressed, and the only safe reading of a
            // comment introducer the classifier can still see is non-auto-eligible.
            if(hasUnquotedHash(stmt))                            return raw;
            if(isSimpleDestructiveStatement(stmt)) return raw;
            // A bare UPDATE can rewrite arbitrary row data. The one committed auto
            // pattern is the AUTO_INCREMENT id repair (`UPDATE <table> SET id = (...)
            // WHERE id = 0;` in 2026-06-10-mirror-id-autoincrement-repair.sql), which
            // touches only the sentinel id=0 row; carve exactly that shape out and
            // flag every other UPDATE.
            if(/^UPDATE\b/i.test(stmt) && !this.isIdRepairUpdate(stmt)) return raw;
            if(createOutsideAllowList(stmt)) return raw;
            // MariaDB spells it ALTER [ONLINE] [IGNORE] TABLE. ONLINE only picks the lock mode, so
            // it gets the plain clause checks; IGNORE silently deletes duplicate-key rows, so never.
            const alterHead = /^ALTER\s+((?:(?:ONLINE|IGNORE)\s+)*)TABLE\b/i.exec(stmt);
            if(alterHead && /\bIGNORE\b/i.test(alterHead[1])) return raw;
            if(alterHead && isDestructiveAlter(stmt, SAFE_ALTER_DROP)) return raw;
            // Any other ALTER (EVENT, VIEW, DATABASE, ...) is outside the allow-list, like CREATE.
            if(!alterHead && /^ALTER\b/i.test(stmt)) return raw;
        }
        return null;
    },

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
    isIdRepairUpdate(stmt){
        const head = /^UPDATE\s+(?:`[^`]+`|[A-Za-z0-9_$.]+)\s+SET\s+id\s*=\s*\(/i.exec(stmt);
        if(!head) return false;
        let i = head[0].length - 1;              // index of the opening '('
        let depth = 0;
        let quote = null;
        for(; i < stmt.length; i++){
            const ch = stmt[i];
            if(quote){
                if(opensBackslashEscape(stmt, i, quote)){ i++; continue; }
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
    },

    // Create the migration ledger if absent. Infrastructure, not a domain table, so it has no
    // src/sql file; verifyTables() creates it only to seed a database it builds from empty.
    async ensureMigrationsLedger(conn){
        await conn.query(
            'CREATE TABLE IF NOT EXISTS schema_migrations (' +
            "name VARCHAR(255) NOT NULL PRIMARY KEY, " +
            "checksum VARCHAR(64) NOT NULL, " +
            "mode VARCHAR(10) NOT NULL DEFAULT 'manual', " +
            'applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' +
            ') ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci'
        );
        await ensureLedgerAppliedAtDatetime(conn);
    },

    // Remove SQL line comments while respecting quoted strings, so a ';'
    // or ',' appearing inside comment prose is never mistaken for SQL structure.
    // Single/double-quote and backtick spans are preserved verbatim (doubled
    // quotes treated as escapes); a `--` or `#` outside any quote or block comment
    // skips to the end of its line. Newlines are kept so the column-split below
    // stays well-formed.
    //
    // `#` counts because MariaDB/MySQL honour it to end-of-line exactly like
    // `--`. Missing it made a `# note` line ahead of a destructive statement
    // invisible to the ^-anchored checks in destructiveAutoStatement: the
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
    // destructiveAutoStatement to flag.
    stripSqlLineComments(sql){
        let out = '';
        let quote = null;
        for(let i = 0; i < sql.length; i++){
            const ch = sql[i];
            if(quote){
                out += ch;
                if(opensBackslashEscape(sql, i, quote)){ out += sql[++i]; continue; }
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
    },

    // Split a SQL string into individual statements on `;`, but only when the `;`
    // sits outside a quoted string. A naive `.split(';')` tears a statement whose
    // string literal contains a semicolon (e.g. `SET data = 'a;b'`) into invalid
    // fragments, so no migration or seed carrying a semicolon in quoted data can
    // ship, and destructiveAutoStatement ends up classifying fragments rather than
    // real statements. `--` and `#` line comments are stripped first (same rule as
    // the callers used); the quote model matches stripSqlLineComments exactly
    // (single/double-quote and backtick spans, doubled-quote and backslash escapes).
    // Returns trimmed, non-empty statements. Mirrors xchain-indexer/src/db/index.js.
    splitSqlStatements(sql){
        const stripped = this.stripSqlLineComments(sql);
        const statements = [];
        let current = '';
        let quote = null;
        for(let i = 0; i < stripped.length; i++){
            const ch = stripped[i];
            if(quote){
                current += ch;
                if(opensBackslashEscape(stripped, i, quote)){ current += stripped[++i]; continue; }
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
    },
}
