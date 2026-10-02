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

const { getLogger } = require('../observability')
const logger = getLogger();

const SATOSHIS_DECIMALS = 8
const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/

// MariaDB errnos for a write rejection that is a pure function of the row bytes + schema,
// i.e. deterministic: it fails identically on every instance and will never succeed on a
// retry. Distinguished from transient errors (deadlock 1213, lock-wait 1205, lost
// connection 2006/2013, query timeout) so the block loop can quarantine a poison row
// instead of retrying it forever. 1366=incorrect string value (e.g. a 4-byte UTF-8 char
// on a utf8mb3 column), 1406=data too long, 1264=out of range, 1265=data truncated,
// 1292=truncated wrong value. Raised as errors only under a strict sql_mode, which is
// why the pool pins DECODER_SQL_MODE below.
const DETERMINISTIC_WRITE_ERRNOS = new Set([1366, 1406, 1264, 1265, 1292])

// Pin every pooled session strict, so a lax my.cnf cannot store the truncated row a
// strict peer quarantines. Never add NO_BACKSLASH_ESCAPES: opensBackslashEscape in
// query_helpers.js assumes backslash escapes are on. assertStrictSqlMode checks both.
const DECODER_SQL_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'

const DEFAULT_QUERY_TIMEOUT_MS = 30000

module.exports = {
    logger,
    SATOSHIS_DECIMALS,
    DB_NAME_REGEX,
    DETERMINISTIC_WRITE_ERRNOS,
    DECODER_SQL_MODE,
    DEFAULT_QUERY_TIMEOUT_MS,
}
