// The decoder's copy of the protocol size/gas/XCALL limits is a consensus
// surface: it bounds what the decoder will accept before the indexer sees it.
// These pin the exported constants to finite, positive integers and to the
// handful of ordering invariants the wire format depends on.

const assert = require('assert');
const C = require('../../src/protocol/constants.js');

describe('protocol/constants', function () {
    const positiveInts = [
        'MAX_ACTION_DATA_LENGTH', 'OP_RETURN_PUSH_OVERHEAD', 'MAX_CODE_SIZE',
        'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XCALL_MIN_GAS', 'XCALL_MAX_GAS',
        'XCALL_MAX_HOPS', 'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MAX_DEADLINE_BLOCKS',
        'XCALL_MAX_RETURN_BYTES', 'XCALL_MAX_CALLS_PER_BLOCK',
        'MAX_DEPLOY_CHUNKS', 'MAX_DEPLOYCHUNK_PART_BYTES',
    ];

    for (const name of positiveInts) {
        it(`${name} is a positive safe integer`, function () {
            const v = C[name];
            assert.strictEqual(typeof v, 'number', `${name} must be a number`);
            assert.ok(Number.isSafeInteger(v), `${name} must be a safe integer`);
            assert.ok(v > 0, `${name} must be positive`);
        });
    }

    // Value pins for the four constants the cross-repo xcall gate freezes.
    // That gate (xchain-indexer/test/unit/xcall-constants-cross-repo.test.js)
    // rosters only xchain-vm / -indexer / -sdk plus the xchain-documentation
    // canonical, so this repo's mirror is tied to those values by nothing else:
    // shape assertions alone let a one-sided edit here pass every suite in the
    // platform. Same GOLDEN literals, same idiom as the sibling mirror suite in
    // xchain-explorer. A real protocol bump edits every copy, this one included.
    it('pins the gated cross-repo VM/XCALL limits to their GOLDEN values', function () {
        assert.strictEqual(C.MAX_CODE_SIZE, 65536);
        assert.strictEqual(C.XCALL_MAX_GAS, 200000);
        assert.strictEqual(C.XCALL_MAX_HOPS, 2);
        assert.strictEqual(C.XCALL_MIN_DEADLINE_BLOCKS, 10);
    });

    it('XCALL gas floor does not exceed its ceiling', function () {
        assert.ok(C.XCALL_MIN_GAS <= C.XCALL_MAX_GAS);
    });

    it('XCALL deadline floor does not exceed its ceiling', function () {
        assert.ok(C.XCALL_MIN_DEADLINE_BLOCKS <= C.XCALL_MAX_DEADLINE_BLOCKS);
    });

    it('a full DEPLOY payload cannot exceed chunks * part size in aggregate', function () {
        // Sanity relationship: the chunked-deploy envelope must be able to carry
        // at least one MAX_CODE_SIZE contract across its chunk budget.
        const capacity = C.MAX_DEPLOY_CHUNKS * C.MAX_DEPLOYCHUNK_PART_BYTES;
        assert.ok(capacity >= C.MAX_CODE_SIZE,
            'chunk budget must be able to carry a max-size contract');
    });

    it('GAS_TICK is the XCHAIN gas symbol', function () {
        assert.strictEqual(C.GAS_TICK, 'XCHAIN');
    });
});
