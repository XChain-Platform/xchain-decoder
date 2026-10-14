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
 ********************************************************************/

/*********************************************************************
 * Kaspa ingest service (the loop)
 *
 *   node client (pullOnce) -> kaspa_ingest (pure projection)
 *                          -> kaspa_store  (SQL text)
 *                          -> one transaction per tick
 *
 * Production requirements, each with the implementation that satisfies it:
 *
 *   1. ONE TRANSACTION PER TICK. The delete (rollback) and the writes must
 *      both land or neither: a half-written block is worse than a failed tick,
 *      because the next tick would build on a state the node never had.
 *   2. CHECKPOINT ON DISK, atomically (temp + rename). Restart resumes; it does
 *      not replay from the pruning point, and KIP-15 means the node cannot give
 *      the data back if it did (~30 hour retention).
 *   3. ERROR CLASSIFICATION + EXPONENTIAL BACKOFF. "transitional ibd state" and
 *      network faults are recoverable (the node is catching up, or the socket
 *      dropped); anything else is fatal and propagates. Recoverable failures do
 *      NOT consume the run() tick budget, and consecutive-recoverable count is
 *      capped so an operator can choose to restart instead of retrying forever.
 *   4. GRACEFUL STOP. requestStop() finishes the current tick, so shutdown never
 *      cuts a transaction in half.
 *   5. NO SILENT DEGRADATION. Anything skipped is logged and counted.
 *
 * The logger is injected: pass the platform's observability/logger in
 * production; the default is a minimal console logger with the same shape.
 ********************************************************************/
'use strict';

const fs = require('fs');
const path = require('path');

const { ingest, rollback, IngestState, chainTimeToSeconds } = require('./kaspa_ingest.js');
const { buildWritePlan, buildRollbackPlan, applyPlan, withTransaction, buildMempoolWritePlan } = require('./kaspa_store.js');

// ── default logger (console, same shape as observability/logger) ───────────
function createConsoleLogger(level = 'info') {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    const min = levels[level] === undefined ? levels.info : levels[level];
    const emit = (name, message, fields) => {
        if (levels[name] > min) return;
        const line = Object.assign({ ts: new Date().toISOString(), level: name, mod: 'kaspa', msg: String(message) }, fields || {});
        try { process.stdout.write(JSON.stringify(line) + '\n'); } catch (error) { /* logging must never be the failure */ }
    };
    return {
        error: (m, f) => emit('error', m, f),
        warn: (m, f) => emit('warn', m, f),
        info: (m, f) => emit('info', m, f),
        debug: (m, f) => emit('debug', m, f),
        child() { return this; },
    };
}

// ── error classification (explicit signals only; nothing is guessed) ───────
const RECOVERABLE_PATTERNS = [
    /transitional ibd state/i,          // node is in initial block download: RPC refuses for the duration
    /not synced|isSyncing|initial block download/i,
    /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|broken pipe/i,
    /connection closed|websocket/i,
    // #5 (2026-10-11 audit): the database lives in the same failure domain as the node. A DB
    // restart or a dropped pooled connection used to fall through to "fatal" and STOP the
    // decoder, because mariadb words it differently from the socket errors above
    // ("Connection lost: The server closed the connection"). Retrying is the deliberate choice:
    // a tick is one transaction over idempotent upserts, so a retry cannot double-write, and
    // halting a chain reader is the more expensive mistake.
    /connection lost|server closed the connection|PROTOCOL_CONNECTION_LOST/i,
    /lock wait timeout|ER_LOCK_WAIT_TIMEOUT|too many connections|ER_CON_COUNT_ERROR/i,
];

function classifyError(error) {
    const message = String((error && error.message) || error || '');
    for (const pattern of RECOVERABLE_PATTERNS) if (pattern.test(message)) return 'recoverable';
    return 'fatal';
}

class KaspaDecoderService {
    constructor({
        rpc, conn, networkId = 'testnet-10', minConfirmationCount = 72000, verbosity = 'High',
        logger, logLevel = null, checkpointFile = null, maxBackoffMs = 60000, baseBackoffMs = 2000,
        maxRecoverableRetries = Infinity, hashToIndexLimit = 200000, mempoolIntervalMs = 60000,
    } = {}) {
        if (!rpc) throw new Error('KaspaDecoderService needs an rpc');
        if (!conn) throw new Error('KaspaDecoderService needs a conn exposing query(sql, values)');
        this.rpc = rpc;
        this.conn = conn;
        this.networkId = networkId;
        this.minConfirmationCount = minConfirmationCount;
        this.verbosity = verbosity;
        // The level is passed in rather than read here: environment belongs to config (CODE-STYLE),
        // and a caller that wants a different level passes logLevel instead of setting an env var.
        this.log = logger || createConsoleLogger(logLevel);
        this.checkpointFile = checkpointFile;
        this.baseBackoffMs = baseBackoffMs;
        this.maxBackoffMs = maxBackoffMs;
        // Consecutive recoverable failures allowed before handing control back.
        // Default is unlimited: a long-lived service should keep retrying. Operators
        // set a finite value when they would rather restart than wait.
        this.maxRecoverableRetries = maxRecoverableRetries;

        this.checkpoint = null;
        this.state = new IngestState();
        this.hashToIndex = new Map();
        // Bounded: reorgs only ever touch recent chain blocks, so recording every
        // hash index ever seen is a memory leak, not a feature.
        this.hashToIndexLimit = hashToIndexLimit;
        this.writtenBlocks = 0;       // highest block_index written (incremental floor)
        this.eventsFlushed = 0;       // events table is append-only: cursor over state.events
        this.ticks = 0;
        this.backoffMs = baseBackoffMs;
        this.stopping = false;
        this.stats = {
            inserted: 0, deleted: 0, rollbacks: 0, errors: 0,
            recoverable: 0, skippedRows: 0, mempoolWritten: 0,
        };
        this.mempoolIntervalMs = mempoolIntervalMs;   // platform refreshes the mirror on an interval
        this.lastMempoolAt = 0;
        this.lastCheckpointSnapshot = null;   // #2: skip the write when nothing moved
    }

    // ── checkpoint, written atomically (temp + rename) ─────────────────────
    loadCheckpoint() {
        if (!this.checkpointFile) return null;
        try {
            if (!fs.existsSync(this.checkpointFile)) return null;
            const parsed = JSON.parse(fs.readFileSync(this.checkpointFile, 'utf8'));
            if (!parsed || typeof parsed.checkpoint !== 'string') throw new Error('checkpoint file has no cursor');
            if (parsed.networkId && parsed.networkId !== this.networkId) {
                // A checkpoint from another network is not a cursor we can trust: that hash does
                // not exist in this DAG, and following it makes the node refuse the next request.
                // An install that switched NETWORK in place hits exactly this, so refuse it loudly.
                this.log.warn('checkpoint belongs to another network; starting over',
                    { stored: String(parsed.networkId), running: this.networkId });
                return null;
            }
            this.checkpoint = parsed.checkpoint;
            this.writtenBlocks = Number(parsed.writtenBlocks || 0);
            this.ticks = Number(parsed.ticks || 0);
            this.log.info('resuming from checkpoint', {
                checkpoint: String(parsed.checkpoint).slice(0, 24) + '...',
                writtenBlocks: this.writtenBlocks, ticks: this.ticks,
            });
            return this.checkpoint;
        } catch (error) {
            // A corrupt checkpoint must not be fatal: fall back to the pruning point
            // and say so, rather than starting from a cursor nobody can trust.
            this.log.warn('checkpoint unreadable; starting over', { error: error.message });
            return null;
        }
    }

    saveCheckpoint() {
        // A cursor is a 64-hex block hash or nothing at all: writing anything else plants a value
        // the next start cannot follow. (This guard exists because a wrong field name once wrote
        // the literal string "undefined" here, and the test file caught it.)
        if (!this.checkpointFile) return;
        if (typeof this.checkpoint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(this.checkpoint)) return;
        // #2 (2026-10-11 audit): this wrote on every tick — a file write and a torn-file window
        // per tick even when nothing advanced. Only a moved cursor, floor or tick count is worth
        // a rename.
        // Deliberately NOT including this.ticks: it changes every tick, which would make the
        // guard below dead. Only a moved cursor or write floor is worth a rename.
        const snapshot = JSON.stringify([this.checkpoint, this.writtenBlocks]);
        if (snapshot === this.lastCheckpointSnapshot) return;
        const temporary = this.checkpointFile + '.tmp';
        const payload = JSON.stringify({
            checkpoint: this.checkpoint, writtenBlocks: this.writtenBlocks, ticks: this.ticks,
            networkId: this.networkId, savedAt: new Date().toISOString(),
        });
        fs.mkdirSync(path.dirname(this.checkpointFile), { recursive: true });
        fs.writeFileSync(temporary, payload);
        fs.renameSync(temporary, this.checkpointFile);
        this.lastCheckpointSnapshot = snapshot;
    }

    // Start cursor: the persisted one if there is one, else the pruning point
    // (nothing older exists on the node).
    // #3 (2026-10-11 audit): the checkpoint file is local state that can be stale, restored from
    // a backup, or copied between hosts. Its write floor decides what the incremental write
    // skips, so a wrong floor silently drops rows. The database is the authority.
    async reconcileWriteFloor() {
        if (typeof this.conn.query !== 'function') return null;
        try {
            const rows = await this.conn.query('SELECT MAX(block_index) AS max_written FROM `blocks`', []);
            const fromDb = Array.isArray(rows) && rows.length && rows[0].max_written !== null
                && rows[0].max_written !== undefined ? Number(rows[0].max_written) : null;
            if (fromDb !== null && fromDb !== this.writtenBlocks) {
                this.log.warn('checkpoint write floor disagrees with the database; trusting the database',
                    { checkpointSays: this.writtenBlocks, databaseSays: fromDb });
                this.writtenBlocks = fromDb;
            }
            return fromDb;
        } catch (error) {
            this.log.warn('write-floor reconciliation skipped', { error: String(error.message || error).slice(0, 120) });
            return null;
        }
    }

    async init() {
        // Order matters, and it is the pin that says so: loadCheckpoint() sets this.writtenBlocks
        // from the file, so the database reconciliation has to run AFTER it - otherwise the file's
        // floor silently overwrites the database's and rows in between are never written. It runs
        // unconditionally: a lost checkpoint file must not make an installation re-write a slice.
        const resumed = this.loadCheckpoint();
        await this.reconcileWriteFloor();
        if (resumed) {
            return this.checkpoint;
        }
        const dag = await this.rpc.getBlockDagInfo();
        this.checkpoint = String(dag.pruningPointHash);
        this.log.info('starting from the pruning point', { checkpoint: this.checkpoint.slice(0, 24) + '...' });
        return this.checkpoint;
    }

    // dataVerbosityLevel takes the enum NAME as a string. Measured: 'High' works,
    // numeric 2 and lowercase 'high' are both rejected by the node.
    verbosityLevel() {
        if (typeof this.verbosity === 'string' && ['None', 'Low', 'High', 'Full'].includes(this.verbosity)) {
            return this.verbosity;
        }
        return { 0: 'None', 1: 'Low', 2: 'High', 3: 'Full' }[Number(this.verbosity)] || 'High';
    }

    // ── one tick, one transaction ─────────────────────────────────────────
    async tick() {
        const response = await this.rpc.getVirtualChainFromBlockV2({
            startHash: this.checkpoint,
            minConfirmationCount: this.minConfirmationCount,
            dataVerbosityLevel: this.verbosityLevel(),
        });

        const removed = (response.removedChainBlockHashes || []).map(String);

        // Chain blocks are read defensively: the header is nested under
        // chainBlockHeader in the responses the node actually returns, but the
        // flat form appears too. A block with no hash at all is skipped loudly.
        const chainBlocks = (response.chainBlockAcceptedTransactions || []).map((block) => {
            const header = block.chainBlockHeader || {};
            const hash = header.hash || block.hash;
            if (!hash) {
                this.stats.skippedRows++;
                this.log.warn('chain block without a hash was skipped', { keys: Object.keys(block).join(',') });
                return null;
            }
            return {
                hash: String(hash),
                previousBlockHash: String(header.selectedParentHash || block.previousBlockHash || ''),
                timestamp: header.timestamp !== null && header.timestamp !== undefined ? header.timestamp : null,
                acceptedTransactions: block.acceptedTransactions || [],
            };
        }).filter(Boolean);

        // Where to roll back to: our own hash -> index map first, then the database.
        // After a restart the map is empty, and without the database fallback the
        // in-memory state rolled back while the rows and the write floor stayed put —
        // so the reverted rows persisted for good and the incremental write never
        // revisited them (found in the 2026-10-11 review).
        let rollbackFrom = null;
        if (removed.length) {
            const indexes = removed.map((hash) => this.hashToIndex.get(hash)).filter((v) => v !== null && v !== undefined);
            if (indexes.length) {
                rollbackFrom = Math.min(...indexes);
            } else if (typeof this.conn.query === 'function') {
                // blocks.block_hash_id -> index_transactions.hash is the same join the
                // platform's own getBlockIndex-style reads use.
                for (const hash of removed) {
                    let rows = [];
                    try {
                        rows = await this.conn.query(
                            'SELECT b.block_index, b.block_time FROM `blocks` b JOIN `index_transactions` t ON t.id = b.block_hash_id WHERE t.hash = ? LIMIT 1',
                            [hash]);
                    } catch (error) {
                        this.log.warn('rollback index lookup failed', { error: String(error.message || error).slice(0, 120) });
                    }
                    const index = Array.isArray(rows) && rows.length ? Number(rows[0].block_index) : null;
                    if (index !== null && !Number.isNaN(index)) {
                        rollbackFrom = rollbackFrom === null ? index : Math.min(rollbackFrom, index);
                    }
                }
                if (rollbackFrom === null) {
                    this.log.error('cannot resolve any removed chain block in memory or in the database; the rows for them may now be stale',
                        { removed: removed.length });
                }
            }
        }
        // The write floor has to move BEFORE the write plan is built, otherwise the
        // replacement chain blocks are filtered out as already-written. This exact
        // ordering was once inverted and the reorg case in the service tests caught it.
        if (removed.length && rollbackFrom === null) {
            // fail-closed. Read this beside the two branches above: when no removed chain block can
            // be located in the hash map or (if there is one) in the database, the write floor does
            // not move, so the replacement blocks are then filtered out as already-written while
            // the removed blocks' rows stay in the table - a divergence that only left an error
            // line in the log. A tick that cannot place its own rollback must not write.
            throw new Error('cannot resolve any removed chain block in memory or in the database; refusing to write');
        }
        if (rollbackFrom !== null) this.writtenBlocks = Math.max(0, rollbackFrom - 1);
        // The cursors are rewound here as well, and that is not redundant: ingest's own rollback finds
        // the removed block in state, and the working set is trimmed to the floor, so an older removed
        // block is usually gone and that rollback rewinds NOTHING. Measured consequence before this
        // line existed: the replacement chain was appended after the hole (block_index 3 where a
        // from-scratch run writes 2), which is a gap in the table the indexer joins on.
        if (rollbackFrom !== null) {
            this.state.nextBlockIndex = Math.min(this.state.nextBlockIndex, rollbackFrom);
            // nextTxIndex is deliberately NOT rewound. A block_index identifies a position in the
            // chain and the replacement chain must reuse it; tx_index is only a surrogate key, and
            // rewinding it is how the replacement transaction took the id of a row that was still
            // there - an ON DUPLICATE KEY UPDATE then overwrote that survivor's row (measured: the
            // row at tx_index 1 held a different transaction after the reorg). Ids stay monotonic.
        }

        // Reorg events. The indexer reads them with
        // `WHERE id = ? AND code='REORG'` (xchain-indexer/src/db/events/index.js:196),
        // and the platform's decoder writes one single-element array per rolled-back
        // block (see the comment in src/sql/events.sql).
        //
        // The event time is CHAIN data, never the wall clock: two nodes replaying the same
        // chain must produce byte-identical rows (whitepaper §1.2, "no wall-clock-dependent
        // branching"). The rolled-back block's own block_time is the deterministic source;
        // when even that is unknown the column stays NULL rather than being filled with now.
        // #4 (2026-10-11 audit): this map used to be rebuilt on EVERY tick over all history — O(n)
        // per tick, forever. Times are only needed for the blocks being rolled back, and removals
        // are rare, so it is built only when there is something to roll back.
        const chainTimeByHash = new Map();
        if (removed.length) {
            for (const b of this.state.blocks) chainTimeByHash.set(b.block_hash, b.block_time);
            // The working set is trimmed to the write floor (trimToFloor), so an older removed block
            // is usually NOT in state any more - and its event time must still come from the chain,
            // never from the clock (two nodes replaying one chain have to agree). The floor itself may
            // have come from the service's own hash map, in which case no query ran for it at all, so
            // this is the only place left that can answer. Removals are rare, so one query per
            // unresolved hash is the cheap side of the trade; a hash nobody can resolve stays NULL.
            for (const hash of removed) {
                if (chainTimeByHash.has(hash) || typeof this.conn.query !== 'function') continue;
                try {
                    const rows = await this.conn.query(
                        'SELECT b.block_time FROM `blocks` b JOIN `index_transactions` t ON t.id = b.block_hash_id WHERE t.hash = ? LIMIT 1',
                        [hash]);
                    if (Array.isArray(rows) && rows.length && rows[0].block_time !== undefined && rows[0].block_time !== null) {
                        chainTimeByHash.set(hash, rows[0].block_time);
                    }
                } catch (error) {
                    this.log.warn('removed block time lookup failed', { error: String(error.message || error).slice(0, 120) });
                }
            }
        }
        for (const hash of removed) {
            const index = this.hashToIndex.get(hash);
            const seconds = chainTimeByHash.has(hash) ? chainTimeToSeconds(chainTimeByHash.get(hash)) : null;
            this.state.events.push({
                time: seconds === null ? null : new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' '),
                code: 'REORG',
                data: JSON.stringify([{ block_index: index === undefined ? null : index, block_hash: hash }]),
            });
        }

        // In-memory state first (pure functions, replayable).
        if (removed.length) {
            rollback(this.state, removed);
            removed.forEach((hash) => this.hashToIndex.delete(hash));
        }
        let rows = this.state.rows();
        if (chainBlocks.length) {
            const before = this.state.nextBlockIndex;
            rows = ingest(chainBlocks, { state: this.state }).rows;
            let index = before;
            for (const block of chainBlocks) { this.hashToIndex.set(block.hash, index); index++; }
            while (this.hashToIndex.size > this.hashToIndexLimit) {
                const oldest = this.hashToIndex.keys().next().value;
                this.hashToIndex.delete(oldest);
            }
        }

        const deletePlan = rollbackFrom !== null ? buildRollbackPlan(rollbackFrom) : [];
        const newEvents = this.state.events.slice(this.eventsFlushed);   // only this tick's events
        const writePlan = buildWritePlan(rows, { sinceBlockIndex: this.writtenBlocks, events: newEvents });
        const nextWritten = rows.blocks.reduce((max, b) => Math.max(max, Number(b.block_index)), this.writtenBlocks);

        if (deletePlan.length || writePlan.length) {
            await withTransaction(this.conn, async () => {
                if (deletePlan.length) await applyPlan(this.conn, deletePlan);
                if (writePlan.length) await applyPlan(this.conn, writePlan);
            });
            this.stats.deleted += deletePlan.length;
            this.stats.inserted += writePlan.length;
            if (deletePlan.length) this.stats.rollbacks += 1;
            this.writtenBlocks = Math.max(this.writtenBlocks, nextWritten);
            // The flushed events are in the database and the cursor has moved: holding them
            // in memory for the lifetime of the process is a slow leak on a chain that reorgs.
            this.state.events = [];
            this.eventsFlushed = 0;
        }

        // The cursor follows what was actually WRITTEN, not an optional response field: a response
        // may carry only chainBlockAcceptedTransactions, and a checkpoint that never advances
        // re-ingests the whole slice on every restart - idempotent, but no progress at all.
        const added = (response.addedChainBlockHashes || []).map(String);
        // rows.blocks is already projected (block_index + block_hash_id), so the cursor has to
        // come from the ingest state, which still holds the hashes.
        const written = (this.state.blocks || []).slice()
            .sort((a, b) => Number(a.block_index) - Number(b.block_index));
        if (written.length) this.checkpoint = String(written[written.length - 1].block_hash);
        else if (added.length) this.checkpoint = added[added.length - 1];
        // Only AFTER the cursor above: the checkpoint is read out of state.blocks, so trimming first
        // would move it backwards to whatever block happens to be left. This is the fix for the
        // unbounded working set - every tick used to keep its rows forever, so memory grew for the
        // life of the process and each tick re-materialised the whole history.
        if (typeof this.state.trimToFloor === 'function') this.state.trimToFloor(this.writtenBlocks);
        this.ticks++;
        this.saveCheckpoint();

        return {
            tick: this.ticks, addedBlocks: chainBlocks.length, removedBlocks: removed.length,
            rollbackFrom, writeStatements: writePlan.length, deleteStatements: deletePlan.length,
            blocks: rows.blocks.length, transactions: rows.transactions.length,
            outputs: rows.transaction_outputs.length, checkpoint: this.checkpoint,
        };
    }

    // ── main loop: classify, back off, propagate the fatal ─────────────────
    async run({ intervalMs = 5000, maxTicks = Infinity, onTick = null } = {}) {
        let consecutive = 0;
        // Initialisation belongs INSIDE the retry loop, for the same reason ticks do. Measured on a
        // closed port: init() threw ECONNREFUSED, the part's start promise rejected, and the reader
        // never started - while a node that goes down LATER is retried with backoff. "The node is not
        // up yet" is the common case on a fresh boot, and it was the one case that ended everything.
        let initialised = this.checkpoint !== null;
        for (let i = 0; i < maxTicks && !this.stopping; i++) {
            try {
                if (!initialised) { await this.init(); initialised = true; }
                const result = await this.tick();
                this.backoffMs = this.baseBackoffMs;      // success resets the backoff
                consecutive = 0;
                this.log.info('tick done', {
                    tick: result.tick, added: result.addedBlocks, removed: result.removedBlocks,
                    wrote: result.writeStatements, deleted: result.deleteStatements,
                });
                if (typeof onTick === 'function') onTick(result);
                if (i + 1 < maxTicks && !this.stopping) await this.sleep(intervalMs);
            } catch (error) {
                this.stats.errors++;
                if (classifyError(error) === 'fatal') {
                    this.log.error('fatal error, stopping the loop', { error: String(error.message || error) });
                    throw error;
                }
                this.stats.recoverable++;
                consecutive++;
                if (consecutive > this.maxRecoverableRetries) {
                    this.log.error('too many consecutive recoverable failures, handing back', {
                        consecutive, limit: this.maxRecoverableRetries,
                        error: String(error.message || error).slice(0, 160),
                    });
                    throw error;
                }
                this.log.warn('recoverable error, backing off', {
                    consecutive, error: String(error.message || error).slice(0, 160), backoffMs: this.backoffMs,
                });
                await this.sleep(this.backoffMs);
                this.backoffMs = Math.min(this.maxBackoffMs, Math.round(this.backoffMs * 2));
                i--;                                       // a recoverable failure does not use up maxTicks
            }
        }
        return this.stats;
    }

    requestStop() { this.stopping = true; }

    // Mempool mirror (the platform refreshes its own on an interval). Write side
    // only: the caller supplies entries taken from the node's mempool RPC, because
    // which RPC is an installation decision, not one to guess here.
    async pollMempoolOnce(entries, { now = Date.now() } = {}) {
        if (now - this.lastMempoolAt < this.mempoolIntervalMs) return { skipped: true, reason: 'interval-not-reached' };
        this.lastMempoolAt = now;
        const plan = buildMempoolWritePlan(entries);
        if (!plan.length) return { skipped: false, written: 0 };
        await applyPlan(this.conn, plan);
        this.stats.mempoolWritten += plan.length;
        this.log.info('mempool mirror written', { rows: plan.length });
        return { skipped: false, written: plan.length };
    }

    sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
}

module.exports = { KaspaDecoderService, classifyError, createConsoleLogger, RECOVERABLE_PATTERNS };
