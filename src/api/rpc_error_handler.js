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
 *********************************************************************/

'use strict';

// Terminal error handler for the JSON-RPC API. Without one, Express's default
// handler answers a body-parser failure (malformed, non-object or oversized JSON)
// with an HTML page carrying the server stack trace. This maps those failures to
// a JSON-RPC error envelope and never echoes the error message or stack.

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

function classify(err) {
    if (err && err.type === 'entity.too.large') {
        return { status: 413, code: INVALID_REQUEST, message: 'Request body too large' };
    }
    if (err && err.type === 'entity.parse.failed') {
        return { status: 400, code: PARSE_ERROR, message: 'Parse error' };
    }
    const s = err && Number(err.status || err.statusCode);
    if (s >= 400 && s < 500) {
        return { status: s, code: INVALID_REQUEST, message: 'Invalid Request' };
    }
    return { status: 500, code: INTERNAL_ERROR, message: 'Internal error' };
}

function rpcErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const { status, code, message } = classify(err);
    if (status >= 500) console.error('rpc request failed:', err && err.message);
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

module.exports = { rpcErrorHandler };
