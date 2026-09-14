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
 * The one place this service reads its environment.
 *
 * WHY A HOME AND NOT A READ AT EACH SITE. An environment read scattered
 * through the tree cannot be answered: nobody can say what this service is
 * configured by without reading every file, a test cannot set a value without
 * knowing which module happens to read it, and two modules reading the same
 * name with different fallbacks disagree with each other silently. One home
 * makes the whole surface one file long.
 *
 * WHAT LIVES HERE, AND WHAT DOES NOT. Every name a module outside the entry
 * points reads lives here, as the raw string the environment holds (or
 * undefined). Coercion does NOT: a read site
 * that parses a number, applies a floor or derives a fallback from another
 * setting keeps that code where it is and only takes the raw value from here.
 * The coerced TYPE is a decision about the setting, so moving it would be a
 * change of behaviour; moving only the read is not, because a raw value read
 * here is byte-for-byte the value the site used to read itself.
 *
 * EVERY VALUE IS READ LIVE, ON EACH ACCESS, and that is deliberate rather
 * than lazy. Several of these knobs are documented and tested as retunable
 * without rebuilding the object that uses them (the RPC concurrency cap says
 * so in as many words at its read site), and the suite sets them between
 * cases. A home that snapshotted the environment at require time would look
 * identical and quietly freeze all of that: the reads would keep returning
 * boot-time values and only a test that changes one mid-run would notice.
 * So the exported object is accessors over the block below, not a copy of it.
 *
 * The three process entry points (api.js, migrate.js, clear_reorg_halt.js)
 * read the environment directly and are exempt: they validate and report on
 * their configuration before anything else is loaded, which is the one job
 * that cannot go through a module that has already resolved it.
 *
 ********************************************************************/

'use strict';

/**
 * Every environment name this service reads, with whatever fallback its read
 * sites agreed on. This is the declaration: one line per name, and the list is
 * what a reader scans to learn how the service is configured.
 *
 * @returns {object} the current value of each name, read fresh
 */
function currentEnvironment() {
    return {
    // codemod:env-entries
        DB_QUERY_TIMEOUT: process.env.DB_QUERY_TIMEOUT,
    DECODER_POLL_SILENT_MS: process.env.DECODER_POLL_SILENT_MS,
    DECODER_RPC_CONCURRENCY: process.env.DECODER_RPC_CONCURRENCY,
    DECODER_STALL_ALERT_MS: process.env.DECODER_STALL_ALERT_MS,
    DECODER_STALL_FETCH_ATTEMPTS: process.env.DECODER_STALL_FETCH_ATTEMPTS,
    MIGRATION_STRICT_CHECKSUM: process.env.MIGRATION_STRICT_CHECKSUM,
    NODE_FAILOVER_THRESHOLD: process.env.NODE_FAILOVER_THRESHOLD,
    NODE_RPC_TIMEOUT: process.env.NODE_RPC_TIMEOUT,
    NODE_URL_FALLBACK: process.env.NODE_URL_FALLBACK ?? '',
        RPC_TIMEOUT_RETRY_DELAY_MS: process.env.RPC_TIMEOUT_RETRY_DELAY_MS,
    SHUTDOWN_TIMEOUT_MS: process.env.SHUTDOWN_TIMEOUT_MS,
    };
}

// One accessor per declared name, so `config.X` is a read of the environment
// at the moment of the call and not of a snapshot taken at require time.
// Enumerable, so the whole configuration still prints and spreads normally.
const config = {};
for (const name of Object.keys(currentEnvironment())) {
    Object.defineProperty(config, name, {
        enumerable: true,
        get() { return currentEnvironment()[name]; },
    });
}

module.exports = config;
