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
 * Kaspa chain puller + wRPC client (dependency-light)
 *
 * Division of labour with kaspa_ingest.js:
 *   node_client  fetches one slice of the virtual chain and keeps the cursor
 *   ingest       projects that slice onto table rows (pure, offline testable)
 *
 * Primitive, measured against kaspad v2.1.0:
 *   getVirtualChainFromBlockV2(startHash, minConfirmationCount, dataVerbosityLevel)
 *   · cursor  = the LAST entry of addedChainBlockHashes (the array is low -> high)
 *   · reorg   = removedChainBlockHashes, highest -> lowest; must be deleted and
 *               replayed for real (see kaspa_ingest.rollback)
 *   · start   = getBlockDagInfo().pruningPointHash — nothing older exists
 *   · KIP-15  = raw data lives ~30 hours, so this must stay continuously online
 *               and persist its cursor (see the checkpoint in kaspa_service.js)
 *
 * Three things the live runs taught us (KASPA-ADAPTER-V2.md §11):
 *   1. dataVerbosityLevel takes the enum NAME as a string ('High'). Numeric 2 and
 *      lowercase 'high' are both rejected by the node. That is why this module
 *      does not import a wasm enum: a string keeps it dependency-free.
 *   2. minConfirmationCount needs a buffer, otherwise chain blocks near the tip
 *      are added and removed between consecutive calls.
 *   3. Starting from the pruning point returns one very large first slice.
 *
 * The wRPC-JSON transport is optional: the client below loads `ws` lazily and
 * fails with the reason if it is missing, so the puller stays usable with any
 * injected rpc implementation (which is also how the tests drive it).
 ********************************************************************/
'use strict';

const { IngestState, ingest, rollback } = require('./kaspa_ingest.js');

// `ws` is the only transport dependency and it is declared in package.json, so it resolves at
// module scope (CODE-STYLE: require inside a body only for a computed path). The failure is
// remembered rather than thrown here, so a caller that injects WebSocketImpl never sees it.
let wsModule = null;
let wsLoadError = null;
try { wsModule = require('ws'); } catch (error) { wsLoadError = error; }

const VERBOSITY_NAMES = ['None', 'Low', 'High', 'Full'];

// Confirmations are "distance from virtual chain tip" in CHAIN BLOCKS (kaspad's own
// wording in the SDK types). The platform's reorg tolerance is time-shaped -- the
// utxo-tracker keeps a 120-block undo window on DOGE and LTC, about two hours -- so this
// default is sized to the same window instead of the ten blocks a first cut used, which at
// 10 BPS is roughly one second of exposure. Two hours behind the tip is also far inside the
// KIP-15 retention window, so a deeper cursor costs nothing but latency.
const DEFAULT_MIN_CONFIRMATION_COUNT = 72000;      // ~2 h at 10 chain blocks/s

// ── optional transport: raw JSON-RPC over the node's wRPC-JSON endpoint ────
// Measured working against kaspad v2.1.0 (ws://127.0.0.1:18110/json). It exists
// so a standalone run needs nothing but `ws`; the platform's own node connector
// can be passed to createRpcClient instead.
function createRpcClient({ url, timeoutMs = 15000, WebSocketImpl } = {}) {
    if (!url) throw new Error('createRpcClient needs a url (e.g. ws://127.0.0.1:18110/json)');
    const WebSocket = WebSocketImpl || wsModule;
    if (!WebSocket) {
        throw new Error('createRpcClient: the optional dependency "ws" is not installed. ' +
            'Install it, or pass WebSocketImpl, or drive KaspaChainPuller with the platform node connector. ' +
            'Underlying error: ' + String((wsLoadError && wsLoadError.message) || 'unknown'));
    }

    let socket = null;
    const pending = new Map();
    let nextId = 1;
    let closed = false;   // disconnect() is terminal for this client instance

    function ensureOpen() {
        if (socket && socket.readyState === 1) return Promise.resolve();
        return new Promise((resolve, reject) => {
            socket = new WebSocket(url);
            socket.on('open', () => resolve());
            socket.on('error', (error) => reject(error));
            socket.on('message', (data) => {
                let json;
                try { json = JSON.parse(String(data)); }
                catch (error) { return; }                 // not an RPC frame: ignore, never crash the loop
                const slot = pending.get(json.id);
                if (!slot) return;
                pending.delete(json.id);
                if (json.error) slot.reject(new Error(JSON.stringify(json.error).slice(0, 200)));
                else slot.resolve(json.params !== undefined ? json.params : json.result);
            });
            socket.on('close', () => {
                // Pending promises must not hang on a dropped socket: fail them.
                for (const slot of pending.values()) slot.reject(new Error('wRPC socket closed'));
                pending.clear();
                socket = null;
            });
        });
    }

    return {
        async connect() { closed = false; await ensureOpen(); return this; },
        async call(method, params = {}) {
            if (closed) throw new Error('wRPC client disconnected');
            await ensureOpen();
            // A disconnect can land while the await above is suspended, which used to surface as
            // "Cannot read properties of null (reading 'send')" instead of the documented error.
            // Callers branch on this message, so it has to be the one they get.
            if (closed || !socket) throw new Error('wRPC client disconnected');
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(method + ' timed out after ' + timeoutMs + 'ms'));
                }, timeoutMs);
                pending.set(id, {
                    resolve: (value) => { clearTimeout(timer); resolve(value); },
                    reject: (error) => { clearTimeout(timer); reject(error); },
                });
                socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            });
        },
        async disconnect() {
            closed = true;
            // Reject first, then close: relying on the close event left callers hanging when
            // the event never arrived, with only their own timeout as a backstop.
            for (const slot of pending.values()) slot.reject(new Error('wRPC client disconnected'));
            pending.clear();
            if (socket) socket.close();
            socket = null;
        },
        // The two calls the puller needs, so this object can be passed straight in.
        async getBlockDagInfo() { return await this.call('getBlockDagInfo'); },
        async getVirtualChainFromBlockV2(request) { return await this.call('getVirtualChainFromBlockV2', request); },
    };
}

module.exports = { createRpcClient, VERBOSITY_NAMES, DEFAULT_MIN_CONFIRMATION_COUNT };
