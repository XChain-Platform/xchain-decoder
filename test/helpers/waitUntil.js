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
 * Shared test synchronization helper.
 *
 * Tests must not sleep a fixed number of milliseconds and hope the thing
 * they are waiting for has happened by then: a wall-clock guess is either
 * too short (a flake on a loaded machine) or too long (a slow suite). Wait
 * on the actual signal instead.
 *
 * `waitUntil(predicate, opts)` polls `predicate` until it returns a truthy
 * value (or a truthy resolved value, for async predicates) and returns that
 * value, so callers can both synchronize on and read the result in one step:
 *
 *     const tx = await waitUntil(() => db.getTransaction(hash))
 *
 * If the predicate has not become truthy within `timeout`, it throws with
 * `message` so the failure names what was being awaited rather than surfacing
 * as an opaque test-runner timeout.
 */

/**
 * Poll `predicate` until it yields a truthy value or the timeout elapses.
 *
 * @param {() => (any|Promise<any>)} predicate  Evaluated each interval; may be sync or async.
 * @param {object}  [opts]
 * @param {number}  [opts.timeout=30000]  Max total wait, in ms.
 * @param {number}  [opts.interval=50]    Delay between polls, in ms.
 * @param {string}  [opts.message]        Thrown on timeout; defaults to a generic message.
 * @returns {Promise<any>}  The first truthy value the predicate produced.
 */
async function waitUntil(predicate, opts = {}) {
    const timeout  = opts.timeout  != null ? opts.timeout  : 30000
    const interval = opts.interval != null ? opts.interval : 50
    const message  = opts.message  || `waitUntil: condition not met within ${timeout}ms`

    const deadline = Date.now() + timeout
    // Loop at least once even if timeout is 0, then bound by the deadline.
    for (;;) {
        const value = await predicate()
        if (value) return value
        if (Date.now() >= deadline) throw new Error(message)
        await new Promise(resolve => setTimeout(resolve, interval))
    }
}

module.exports = { waitUntil }
