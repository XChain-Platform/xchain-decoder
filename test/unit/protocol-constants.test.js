//  doctrine test-coverage program: unit coverage for src/protocol/constants.js.
// The decoder's copy of the protocol size/gas/XCALL limits is a consensus
// surface (it bounds what the decoder will accept before the indexer sees it);
// this pins the exported constants to sane, finite, positive integers and the
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
