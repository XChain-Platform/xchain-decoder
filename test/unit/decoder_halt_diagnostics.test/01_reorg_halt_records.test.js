// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function registerAvailableMarkerRecords(context) {
    const { assert, haltingDecoder, NODE_TIP, SAFE_DEPTH, linesFor } = context

    it('emits REORG_HALT with reason and depth when db.markReorgHalted is missing', async function () {
        // The db deliberately has no markReorgHalted: this is the bare return.
        const decoder = haltingDecoder({})
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        const halts = linesFor('REORG_HALT')
        assert.strictEqual(halts.length, 1, 'the halt must produce exactly one record')
        const line = halts[0]
        assert.ok(line.includes(' error '), 'REORG_HALT is an error-level event: ' + line)
        assert.ok(line.includes('coin=BTC'), 'the record must name the coin: ' + line)
        assert.ok(line.includes('network=regtest'), 'the record must name the network: ' + line)
        assert.ok(line.includes('depth=' + SAFE_DEPTH),
            'the record must carry the depth it was about to persist: ' + line)
        assert.ok(/reason="[^"]*safe-depth[^"]*"/.test(line),
            'the record must carry the reason it was about to persist: ' + line)
        assert.ok(line.includes('marker_write=unavailable'),
            'the record must say the marker could not be written: ' + line)
        assert.ok(line.includes('/status') && line.includes('/live'),
            'the record must say which surfaces will NOT report the halt: ' + line)
        // Nothing was attempted, so nothing may report an outcome.
        assert.strictEqual(linesFor('REORG_HALT_MARKER').length, 0)
        assert.strictEqual(decoder.getReorgHaltStatus().marker_persisted, false)
    })

    it('still emits REORG_HALT on the normal path, and says the marker was written', async function () {
        let marked = null
        // The db contract markReorgHalted answers on: TRUE only once a REORG_HALT row
        // is readable. A stub returning undefined would be a stub asserting a write it
        // never confirmed, which is the exact defect these cases exist for.
        const decoder = haltingDecoder({ markReorgHalted: async (r) => { marked = r; return true } })
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)

        const halts = linesFor('REORG_HALT')
        assert.strictEqual(halts.length, 1)
        assert.ok(halts[0].includes('marker_write=attempting'), halts[0])
        // The pre-write record cannot know the outcome, so it must not claim one.
        assert.ok(!halts[0].includes('marker_persisted='),
            'the pre-write record must not assert persistence: ' + halts[0])

        const outcome = linesFor('REORG_HALT_MARKER')
        assert.strictEqual(outcome.length, 1, 'the write outcome must produce exactly one record')
        assert.ok(outcome[0].includes('marker_persisted=true'), outcome[0])
        assert.ok(outcome[0].includes('attempts=1'), outcome[0])
        assert.ok(marked && /safe-depth/.test(marked), 'the durable marker is still written')
        assert.strictEqual(decoder.getReorgHaltStatus().marker_persisted, true)
    })
}

function registerRefusedMarkerRecord(context) {
    const { assert, haltingDecoder, NODE_TIP, linesFor, sink } = context

    // The failure the bootstrap gate exists to stop: the marker write fails, the
    // process exits, the restart policy recycles the container, the entry guard reads
    // a row that was never written, and the gate counts zero markers and publishes the
    // database as known-good. Before this, insertEvent swallowed the write error and
    // returned false, markReorgHalted handed that straight back, haltReorg discarded
    // it, and the one structured record said marker_persisted=true regardless.
    it('reports marker_persisted=false when the durable write is refused, and still aborts', async function () {
        let attempts = 0
        const decoder = haltingDecoder({ markReorgHalted: async () => { attempts++; return false } })
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/,
            'a marker failure must never mask or replace the abort')

        const outcome = linesFor('REORG_HALT_MARKER')
        assert.strictEqual(outcome.length, 1)
        assert.ok(outcome[0].includes('marker_persisted=false'),
            'a refused write must never report as persisted: ' + outcome[0])
        assert.strictEqual(attempts, 2, 'a refused write is retried once on a fresh connection')
        assert.ok(outcome[0].includes('attempts=2'), outcome[0])
        assert.strictEqual(decoder.getReorgHaltStatus().marker_persisted, false)
        assert.strictEqual(decoder.getReorgHaltStatus().halted, true)

        // Read the operator line off the SINK, not off console.error. The halt
        // path now goes through the one logger like everything else, so the
        // shipper this suite already installs is where the line lands; a
        // console capture would see nothing and report the line as missing.
        const critical = sink.lines.filter((l) => l.includes('could NOT be persisted'))
        assert.strictEqual(critical.length, 1,
            'the only live evidence of an unrecorded halt must be logged: ' + JSON.stringify(sink.lines))
        assert.ok(/full resync/i.test(critical[0]),
            'the line must name the required operator action: ' + critical[0])
        assert.ok(/not a valid bootstrap source/i.test(critical[0]), critical[0])
    })
}

function registerThrownMarkerAndMemoryRecords(context) {
    const { assert, haltingDecoder, NODE_TIP, linesFor } = context

    it('carries the cause when the marker write throws rather than returning false', async function () {
        const realError = console.error
        console.error = () => {}
        try {
            const decoder = haltingDecoder({
                markReorgHalted: async () => { throw new Error('lost connection to server') }
            })
            await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)
            const outcome = linesFor('REORG_HALT_MARKER')
            assert.strictEqual(outcome.length, 1)
            assert.ok(outcome[0].includes('marker_persisted=false'), outcome[0])
            assert.ok(outcome[0].includes('lost connection to server'),
                'the cause must ride the record: ' + outcome[0])
        } finally {
            console.error = realError
        }
    })

    it('reports the halt in memory even when nothing durable can be written', async function () {
        const decoder = haltingDecoder({})
        await assert.rejects(() => decoder.verifyReorg(NODE_TIP), /safe-depth/)
        assert.strictEqual(decoder.reorgHalted, true)
        assert.match(decoder.reorgHaltReason, /safe-depth/)
    })
}

module.exports = function registerReorgHaltRecords(context) {
    registerAvailableMarkerRecords(context)
    registerRefusedMarkerRecord(context)
    registerThrownMarkerAndMemoryRecords(context)
}
