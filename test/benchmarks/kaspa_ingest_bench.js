/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without any AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Benchmark the projection path: a captured real chain block through ingest -> write plan.
 *
 *     node test/benchmarks/kaspa_ingest_bench.js [rounds] [blocks-per-round]
 *
 * Why this exists next to the unit tests: the working set used to grow for the whole life of the
 * process, so a tick's cost grew with everything already processed. Nothing in a correctness suite
 * can see that - only a number over repeated rounds can. The benchmark prints per-round timing, so
 * a regression toward O(history) shows up as a rising sequence rather than a single slow number.
 * No thresholds are asserted: a shared CI box cannot promise wall-clock times, and a flaky budget
 * would be worse than no budget. It prints; a human reads the trend.
 **********************************************************************/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { ingest, IngestState } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_ingest.js'));
const { buildWritePlan } = require(path.join(ROOT, 'src', 'chain', 'kaspa', 'kaspa_store.js'));

const ROUNDS = Number(process.argv[2] || 8);
const PER_ROUND = Number(process.argv[3] || 25);
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'kaspa', 'chain_block_with_payload.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const withTxs = fixture.acceptedTransactions.filter((t) => t.inputs && t.inputs.length);

const round = (n) => {
    // Each round is a fresh chain of blocks: same transactions, distinct hashes and timestamps,
    // which is what the projection actually costs money on (hash ids, address ids, dispenser rows).
    const blocks = [];
    for (let i = 0; i < PER_ROUND; i += 1) {
        blocks.push({
            hash: String(n).padStart(2, '0').repeat(32) + String(i).padStart(2, '0').repeat(0),
            previousBlockHash: String(n).padStart(2, '0').repeat(32),
            timestamp: 1791716119000 + n * 1000 + i,
            acceptedTransactions: withTxs,
        });
    }
    return blocks;
};

const state = new IngestState();
const timings = [];
for (let n = 1; n <= ROUNDS; n += 1) {
    const blocks = round(n);
    const started = process.hrtime.bigint();
    const rows = ingest(blocks, { state }).rows;
    const plan = buildWritePlan(rows, { sinceBlockIndex: 0, events: [] });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    timings.push(ms);
    console.log('  round ' + String(n).padStart(2) + ': ' + ms.toFixed(2) + ' ms   blocks=' + rows.blocks.length +
        ' txs=' + rows.transactions.length + ' statements=' + plan.length +
        ' state.blocks=' + state.blocks.length + ' state.txs=' + state.transactions.length);
}

const first = timings[0];
const last = timings[timings.length - 1];
console.log('kaspa_ingest_bench: ' + ROUNDS + ' rounds x ' + PER_ROUND + ' blocks, first ' + first.toFixed(2) +
    ' ms, last ' + last.toFixed(2) + ' ms, ratio ' + (last / first).toFixed(2) + 'x');
console.log('  A ratio near 1 means the per-round cost does not follow history; a steadily rising ' +
    'sequence means the working set (or the plan) is growing with it.');
