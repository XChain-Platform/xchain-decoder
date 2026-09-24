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

const { format: formatLogLine } = require('node:util');
const { logger } = require('./constants.js')

module.exports = {
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
            logger.error(formatLogLine('Error looking up address record id in index_addresses table:', err));
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return false;
    },

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
    //
    // CANCELLATION GRACE. `graceFloor` is the oldest expiration still eligible for capture,
    // computed by dispenserCancelGrace.cancelGraceFloor from the block's own header time, and
    // null below DISPENSER_CANCEL_GRACE_ACTIVATION. A finite floor admits rows the soft-expire
    // has already stamped whose expiration is no older than it, which is how the decoder keeps
    // capturing payments to a dispenser the indexer holds fillable through its cancellation
    // grace period. It widens THIS query and nothing else: the expiry mark, the extend mirror,
    // the oracle-address resolution and the hard purge keep their timing, so the divergence
    // stays in the over-capture direction the advisory contract above calls safe. Rationale and
    // the reason the MARK must not move instead: src/protocol/dispenser_cancel_grace.js.
    //
    // THE FLOOR IS MEASURED AGAINST THE MARK BLOCK, NOT THE EXPIRATION. The indexer runs a
    // block's transactions BEFORE its expiration pass (xchain-indexer XChainIndexer.js, the
    // processTransaction loop ahead of util.processExpirations), and its cancel handler tests
    // only that the dispenser status is 'open' (actions/dispenser.js). So a cancel landing in
    // the first block whose header time passes expiration E is ACCEPTED, and the indexer then
    // settles fills until that cancel's block time plus DISPENSER_CLOSE_DELAY. Anchoring
    // retention on E alone ends capture at E + grace and loses the buyer's coin in the window
    // between the two. The block that stamps expired_block_index is exactly the last block in
    // which a cancel can be accepted, so its header time plus the same grace covers every
    // settleable fill by construction, with no slack constant. The join reads that header time
    // from this decoder's own blocks table rather than duplicating it on the dispenser row, so
    // the reorg clear at deleteBlockByIndex and the this-block restore in
    // extendOpenDispenserExpirationBySource keep the pair consistent by clearing one column.
    // The `expiration >= ?` disjunct stays: the mark time is always greater than the
    // expiration, so it is redundant for a row this decoder stamped, and it is what carries a
    // row whose mark block has no readable time.
    async getAllOpenDispenserAddresses(graceFloor){
        let db    = await this.getConnection();
        // Strict number test, not Number(): `Number(null)` is 0, which would arm a floor of
        // 1970 on the null cancelGraceFloor returns below the gate and widen the capture set
        // on an unarmed network. Fail closed on anything that is not already a finite number.
        const floor       = graceFloor
        const graceActive = (typeof floor === 'number') && Number.isFinite(floor)
        // Two literal statements rather than one composed string: the below-gate query must
        // stay exactly the text the fleet has been running, so a re-decode of pre-flag-day
        // history cannot drift on a formatting edit.
        let query = graceActive
            ? `SELECT ia.address AS address
            FROM dispensers op
            LEFT JOIN index_addresses ia ON ia.id = op.address_id
            LEFT JOIN blocks eb ON eb.block_index = op.expired_block_index
            WHERE op.expired_block_index IS NULL
               OR eb.block_time >= ?
               OR op.expiration >= ?`
            : `SELECT ia.address AS address
            FROM dispensers op
            LEFT JOIN index_addresses ia ON ia.id = op.address_id
            WHERE op.expired_block_index IS NULL`
        let addresses = new Set()
        try {
            let rows = graceActive ? await db.query(query, [floor, floor]) : await db.query(query);
            for (let row of rows){
                if (row["address"] != null)
                    addresses.add(row["address"])
            }
        } catch (err) {
            logger.error(formatLogLine('Error loading open dispenser addresses:', err));
            return null;
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return addresses;
    },

    async deleteOpenDispensers(blockIndex, minExpiration) {
        // SOFT-EXPIRE, don't hard-delete. minExpiration is the block's protocol
        // unix timestamp; expiration is a unix BIGINT, so compare
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
                logger.error(formatLogLine('Error soft-expiring dispensers:', err));
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
    },

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
            logger.error(formatLogLine('Error purging expired dispensers:', err));
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },

    // Number of rows in the dispensers table. The clear tool's first precondition:
    // a database that holds no dispenser state cannot have lost any to the purge.
    async countDispensers(){
        const query = `SELECT COUNT(*) AS n FROM dispensers;`
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            if (!Array.isArray(rows) || rows.length === 0 || rows[0].n == null)
                throw new Error('countDispensers: the dispensers count could not be read')
            return Number(rows[0].n)
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },

    // Whether this database has EVER decoded a DISPENSER action. A purged
    // dispenser leaves no row behind, so an empty dispensers table alone does not
    // prove nothing was purged; a database with no DISPENSER transaction at all does.
    // LIMIT 1 stops at the first hit; a database with none scans the table once,
    // which is acceptable for a one-off operator command.
    //
    // BOTH arms are load-bearing. A dispenser opened inside a BATCH is stored as
    // `BATCH|0|DISPENSER|0|...`, which a top-level `DISPENSER|%` prefix test cannot
    // see, and the decoder does register those (the batch sub-command capture gate is
    // in force on every network). Over-matching is deliberate and fail-safe: this
    // probe backs a REFUSAL, so a false positive costs the operator one replica
    // comparison plus an explicit --force, while a false negative silently certifies
    // a cleanliness that was never established. Do not narrow it again.
    async hasDispenserTransactions(){
        const query = `SELECT 1 FROM transactions WHERE data LIKE 'DISPENSER|%' OR data LIKE '%|DISPENSER|%' LIMIT 1;`
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            if (!Array.isArray(rows)) throw new Error('hasDispenserTransactions: the DISPENSER probe could not be read')
            return rows.length > 0
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },
}
