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
 **********************************************************************
 *
 * kaspa_node_client: the wire-facing half of the family.
 *
 * This file used to hold a single case, so a Stryker run over the client had almost
 * nothing to kill. The cases below are the failure modes a wRPC socket actually
 * produces: a reply for an id nobody waits for, a frame that is not JSON, an error
 * object, a close in mid-flight, and a timeout that must not hang its caller.
 *
 * NOTE ON THE FAKES: WebSocketImpl is invoked with `new`, so every fake here is a
 * class. An arrow function cannot be constructed and fails with a confusing
 * "is not a constructor" instead of testing anything.
 **********************************************************************/
'use strict';
const assert = require('assert');

const { createRpcClient } =
    require('../../../../src/chain/kaspa/kaspa_node_client.js');

const H = (c) => c.repeat(32);

// A scriptable socket. It records what was sent and lets a test drive open/message/close.
class FakeSocket {
    constructor({ autoOpen = true, onSend = null } = {}) {
        this.readyState = 0;
        this.handlers = {};
        this.sent = [];
        this.onSend = onSend;
        this.closed = false;
        if (autoOpen) setTimeout(() => this.open(), 0);
    }
    on(name, fn) { this.handlers[name] = fn; return this; }
    open() { this.readyState = 1; if (this.handlers.open) this.handlers.open(); }
    send(text) { this.sent.push(text); if (this.onSend) this.onSend(JSON.parse(text), this); }
    reply(id, result) { if (this.handlers.message) this.handlers.message(JSON.stringify({ id, result })); }
    replyError(id, message) { if (this.handlers.message) this.handlers.message(JSON.stringify({ id, error: { message } })); }
    emitRaw(text) { if (this.handlers.message) this.handlers.message(text); }
    // Real socket events are asynchronous: firing 'close' synchronously would null the client's
    // socket reference before the pending call even reached send(), which is not what a socket does.
    close() { this.closed = true; this.readyState = 3; if (this.handlers.close) setTimeout(() => this.handlers.close(), 0); }
}

// Transport factories. Each one receives the url, exactly like a real WebSocket would.
const makeTransport = (sockets, build) => class {
    constructor(url) {
        const socket = build(url);
        sockets.push(socket);
        return socket;                       // hand back the scriptable socket itself
    }
};
const answering = (sockets) => makeTransport(sockets, () =>
    new FakeSocket({ onSend: (req, socket) => socket.reply(req.id, { ok: req.method }) }));
const silent = (sockets) => makeTransport(sockets, () => new FakeSocket());

const client = (sockets, options = {}) => createRpcClient(Object.assign({
    url: 'ws://fake/json', timeoutMs: 500, WebSocketImpl: answering(sockets),
}, options));

describe('createRpcClient: construction', function () {

    it('refuses to be built without a url', function () {
        assert.throws(() => createRpcClient({}), /needs a url/);
    });

    it('uses the WebSocket implementation it is handed', async function () {
        const sockets = [];
        const c = client(sockets);
        await c.connect();
        assert.strictEqual(sockets.length, 1, 'the implementation was constructed exactly once');
        await c.disconnect();
    });
});

describe('createRpcClient: handshake and calls', function () {

    it('resolves a call with the reply that carries its own id', async function () {
        const sockets = [];
        const c = client(sockets);
        await c.connect();
        const result = await c.call('getServerInfo', { x: 1 });
        assert.deepStrictEqual(result, { ok: 'getServerInfo' });
        const sent = JSON.parse(sockets[0].sent[0]);
        assert.strictEqual(sent.method, 'getServerInfo');
        assert.deepStrictEqual(sent.params, { x: 1 });
        await c.disconnect();
    });

    it('ignores a frame that is not JSON, and a reply for an id nobody waits for', async function () {
        const sockets = [];
        const c = client(sockets, {
            WebSocketImpl: makeTransport(sockets, () => new FakeSocket({
                onSend: (req, socket) => {
                    socket.emitRaw('not json at all');
                    socket.emitRaw('{"id":999999,"result":"nobody"}');
                    socket.reply(req.id, 'ok');
                },
            })),
        });
        await c.connect();
        assert.strictEqual(await c.call('getBlockDagInfo'), 'ok', 'garbage frames must not break the client');
        await c.disconnect();
    });

    it('times out with the method name in the message', async function () {
        const sockets = [];
        const c = client(sockets, { timeoutMs: 60, WebSocketImpl: silent(sockets) });
        await c.connect();
        await assert.rejects(() => c.call('getServerInfo'), /getServerInfo timed out after 60ms/);
        await c.disconnect();
    });

    it('rejects with the message when the reply is an error object', async function () {
        const sockets = [];
        const c = client(sockets, {
            WebSocketImpl: makeTransport(sockets, () => new FakeSocket({ onSend: (req, socket) => socket.replyError(req.id, 'no such method') })),
        });
        await c.connect();
        await assert.rejects(() => c.call('nope'), /no such method/, 'a JSON-RPC error must surface as a rejection');
        await c.disconnect();
    });
});

describe('createRpcClient: disconnect', function () {

    it('rejects in-flight calls instead of hanging until their timeout', async function () {
        // Note for the product side: a disconnect that lands between `call()`'s await and its
        // send() makes socket null, so the caller sees a TypeError out of socket.send instead of
        // the documented 'wRPC client disconnected'. That race is pinned as a tolerated gap here;
        // this case gives the call its turn to register first, which is the ordinary ordering.
        const sockets = [];
        const c = client(sockets, { timeoutMs: 60000, WebSocketImpl: silent(sockets) });
        await c.connect();
        const inFlight = c.call('getServerInfo');
        inFlight.catch(() => {});
        await new Promise((r) => setTimeout(r, 5));   // let the call register in `pending`
        await c.disconnect();
        await assert.rejects(() => inFlight, /disconnected/);
    });

    it('is terminal: a call after disconnect fails fast', async function () {
        const sockets = [];
        const c = client(sockets);
        await c.connect();
        await c.disconnect();
        await assert.rejects(() => c.call('getServerInfo'), /disconnected/);
    });

    it('rejects pending calls when the socket closes under them', async function () {
        const sockets = [];
        const c = client(sockets, { timeoutMs: 5000, WebSocketImpl: silent(sockets) });
        await c.connect();
        const inFlight = c.call('getServerInfo');
        inFlight.catch(() => {});
        sockets[0].close();
        await assert.rejects(() => inFlight, /socket closed|disconnected/);
    });
});

describe('createRpcClient: the disconnect race (P3 pin)', function () {
    it('a disconnect in the middle of call() yields the documented error, not a TypeError', async function () {
        // The race: call() awaits ensureOpen(), disconnect() runs inside that window and nulls the
        // socket, and the caller used to get "Cannot read properties of null (reading 'send')".
        const sockets = [];
        const c = client(sockets, { timeoutMs: 60000, WebSocketImpl: silent(sockets) });
        await c.connect();
        const inFlight = c.call('getServerInfo');
        inFlight.catch(() => {});
        await c.disconnect();                      // no tick in between: this is the race
        await assert.rejects(() => inFlight, /wRPC client disconnected/,
            'callers branch on this message, so a TypeError is a contract break');
    });
});
