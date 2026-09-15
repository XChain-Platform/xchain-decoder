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

const { getLogger } = require('../../observability');
const logger = getLogger();

// Error codes that mean "could not reach the node at all" (socket / DNS /
// timeout level), as opposed to an HTTP or JSON-RPC level error from a node
// that is alive. Only these count toward endpoint failover.
const CONNECTION_ERROR_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'
])

module.exports = {
    CONNECTION_ERROR_CODES,
    logger,
}
