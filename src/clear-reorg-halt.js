/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Decoder - audited clear of a durable REORG_HALT marker
 *
 *   node src/clear-reorg-halt.js --reason "<why this database is known good>" [--force] [--dry-run]
 *   (under xchain-node: `xchain-node clear-reorg-halt <chain> <network> --reason "..."`)
 *
 * verifyReorg writes the REORG_HALT marker when a rollback crossed the dispenser
 * safe-depth window: soft-expired dispenser rows below that depth were already
 * hard-purged and cannot be resurrected, so the database MAY have lost
 * money-bearing dispenser state. Until now the only recovery was a full resync,
 * even for a database that never held a dispenser (a pre-launch mainnet decoder,
 * measured 2026-09-07: forty hours on an operator's hardware to replace a database
 * nothing had been purged from).
 *
 * This tool clears the marker WITHOUT deleting it: it writes a REORG_HALT_CLEARED
 * row that carries the operator's reason, the checks that passed and the halt it
 * supersedes, and db.readReorgHaltState lets the newest row decide. Preconditions:
 *
 *   1. no block is still missing above the tip (countReorgDeletesAboveTip == 0):
 *      the rolled-back range has been re-parsed. Cannot be forced; wait for the
 *      decoder to catch up.
 *   2. the database holds no dispenser state and never decoded a DISPENSER
 *      action, so the purge cannot have lost anything. --force overrides this one
 *      for an operator who has compared the dispensers table against a known-good
 *      replica; the clear row records that it was forced.
 *
 * Reads DECODER_DB_* from the service environment (.env), like migrate.js.
 *
 ********************************************************************/

'use strict'

const EXIT = {
    OK: 0,
    FAILED: 1,
    USAGE: 2,
    NOT_RESYNCED: 3,
    DISPENSER_STATE: 4
}

const USAGE = 'usage: node src/clear-reorg-halt.js --reason "<why this database is known good>" [--force] [--dry-run]'

function parseArgs(argv){
    const out = { reason: null, force: false, dryRun: false, help: false, bad: null }
    for (let i = 0; i < argv.length; i++){
        const a = argv[i]
        if (a === '--reason' || a === '-r'){
            const v = argv[i + 1]
            if (v === undefined || v.startsWith('-')){ out.bad = a + ' requires a text argument'; return out }
            out.reason = v; i++
        } else if (a.startsWith('--reason=')){
            out.reason = a.slice('--reason='.length)
        } else if (a === '--force'){
            out.force = true
        } else if (a === '--dry-run'){
            out.dryRun = true
        } else if (a === '--help' || a === '-h'){
            out.help = true
        } else {
            out.bad = 'unknown argument ' + a; return out
        }
    }
    return out
}

// The whole decision, with the database and the output injected so it can be
// exercised without MariaDB. Returns the process exit code.
async function run({ db, argv = [], log = console.log, error = console.error }){
    const args = parseArgs(argv)
    if (args.help){ log(USAGE); return EXIT.OK }
    if (args.bad){ error('clear-reorg-halt: ' + args.bad + '\n' + USAGE); return EXIT.USAGE }
    if (typeof args.reason !== 'string' || args.reason.trim().length < 8){
        error('clear-reorg-halt: --reason must say, in at least 8 characters, why this database is known good; it is recorded with the clear.\n' + USAGE)
        return EXIT.USAGE
    }

    const marker = await db.getReorgHaltMarker()
    if (!marker.halted){
        log('clear-reorg-halt: no live REORG_HALT marker'
            + (marker.cleared_at ? ' (last halt cleared ' + marker.cleared_at + ': ' + (marker.cleared_reason || 'no reason recorded') + ')' : '')
            + '. Nothing to do.')
        return EXIT.OK
    }
    log('clear-reorg-halt: live REORG_HALT marker' + (marker.at ? ' since ' + marker.at : '')
        + (marker.reason ? ': ' + marker.reason : ''))

    // Check 1: the rollback has been re-synced. Not forceable: a halt with blocks
    // still missing above the tip is a rollback in progress, and clearing it lets
    // the next verifyReorg resume past the window.
    const deletesAboveTip = await db.countReorgDeletesAboveTip()
    if (deletesAboveTip > 0){
        error('clear-reorg-halt: REFUSED. ' + deletesAboveTip + ' block(s) rolled back above the current tip have not been re-parsed yet. '
            + 'Wait for the decoder to catch up past the halt height, then run this again. This check cannot be forced.')
        return EXIT.NOT_RESYNCED
    }

    // Check 2: nothing the purge could have lost.
    const dispensers    = await db.countDispensers()
    const dispenserTxs  = await db.hasDispenserTransactions()
    const checks = { deletes_above_tip: deletesAboveTip, dispensers: dispensers, dispenser_transactions: dispenserTxs }
    const dispenserClean = (dispensers === 0 && dispenserTxs === false)
    if (!dispenserClean && !args.force){
        error('clear-reorg-halt: REFUSED. This database has held dispenser state (' + dispensers + ' dispenser row(s) now, '
            + (dispenserTxs ? 'DISPENSER actions decoded' : 'no DISPENSER action decoded') + '), so the purge the halt '
            + 'protects against may have dropped rows that a resync would recover. Compare the dispensers table against a '
            + 'known-good replica of this decoder; if it matches, run again with --force (the clear is recorded as forced). '
            + 'If it does not, resync from a known-good snapshot instead.')
        return EXIT.DISPENSER_STATE
    }

    const verdict = 'checks: rolled-back blocks above tip = 0; dispensers = ' + dispensers + '; DISPENSER actions decoded = ' + dispenserTxs
        + (dispenserClean ? ' (clean)' : ' (FORCED by the operator)')
    if (args.dryRun){
        log('clear-reorg-halt: dry run. ' + verdict + '. The marker would be cleared with reason: ' + args.reason.trim())
        return EXIT.OK
    }

    const result = await db.clearReorgHalt({ reason: args.reason.trim(), checks: checks, forced: !dispenserClean })
    if (result.alreadyClear){
        log('clear-reorg-halt: the marker was cleared by someone else while this ran. Nothing to do.')
        return EXIT.OK
    }
    if (!result.cleared){
        error('clear-reorg-halt: FAILED. The REORG_HALT_CLEARED row could not be written or read back; the halt is still live.')
        return EXIT.FAILED
    }
    log('clear-reorg-halt: cleared. ' + verdict + '. Recorded as events.code=REORG_HALT_CLEARED with reason: ' + args.reason.trim()
        + '. The decoder reports reorg_halted=false on its next probe (within a minute); the halt row itself is kept for the audit trail.')
    return EXIT.OK
}

async function main(){
    require('dotenv').config()
    const Database = require('./db.js')
    const host = process.env.DECODER_DB_HOST
    const port = process.env.DECODER_DB_PORT
    const name = process.env.DECODER_DB_NAME
    const user = process.env.DECODER_DB_USER
    const pass = process.env.DECODER_DB_PASS
    if (!host || !name || !user){
        console.error('clear-reorg-halt: DECODER_DB_HOST / DECODER_DB_NAME / DECODER_DB_USER must be set (load the service .env).')
        process.exit(EXIT.USAGE)
    }
    const db = new Database(host, port, name, user, pass)
    let code = EXIT.FAILED
    try {
        code = await run({ db, argv: process.argv.slice(2) })
    } catch (err){
        console.error('clear-reorg-halt: FAILED: ' + ((err && err.stack) || err))
    } finally {
        try { if (db.pool) await db.pool.end() } catch (_) {}
    }
    process.exitCode = code
}

if (require.main === module) main()

module.exports = { run, parseArgs, EXIT, USAGE }
