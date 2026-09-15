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

async function insertDispenserRow(database, connection, query, openDispenser){
    let txIndex = openDispenser.txIndex
    let addressId = await database.createAddress(openDispenser.address)
    let expiration = openDispenser.expiration
    // Mode B only: interned so a later v2 refill (whose payload names no address)
    // can still resolve which oracle-fee output to capture.
    let oracleAddressId = openDispenser.oracleAddress
        ? await database.createAddress(openDispenser.oracleAddress)
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
        ? await database.createAddress(openDispenser.sourceAddress)
        : null

    await connection.query(query, [
        txIndex,
        addressId,
        expiration,
        oracleAddressId,
        sourceAddressId
    ])
}

module.exports = {
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
            await insertDispenserRow(this, connection, query, openDispenser)
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                logger.error(formatLogLine('Error inserting transaction:', err));
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
            logger.error(formatLogLine('Error extending dispenser expiration:', err));
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
            logger.error(formatLogLine('Error reading dispenser oracle address:', err));
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
            logger.error(formatLogLine('Error reading dispenser oracle addresses:', err));
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
}
