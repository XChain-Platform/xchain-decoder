'use strict';

const { COMMAND_LIMIT,
        ACTION_LIMITS,
        GATED_ACTION_LIMITS,
        WEIGHT_BUDGET,
        COMMAND_WEIGHTS,
        COST_WEIGHTING_ACTIVATION } = require('../indexer_batch_limits.js')
const { hasProvablyRejectedSubCommand,
        subCommandTick,
        subCommandLimitKey,
        maxIdenticalMintTicks,
        subCommandActionName,
        expandAliasName } = require('./sub_commands.js')

// Does the indexer PROVABLY reject this whole BATCH, so that none of its sub-commands runs?
//
// Returns true only on evidence this module can establish from the command list ALONE. It is
// deliberately incomplete, and the three causes left out are left out for stated reasons
// rather than for want of effort:
//
//   * AN UNREGISTERED ACTION NAME (beyond the empty one). The indexer's activation scan
//     rejects any name absent from its protocol-change registry OR not yet active at this
//     block. Mirroring it needs that registry AND its per-name instants AND the indexer's
//     compiled consensus version vendored here. REFUSED, because a vendored NAME LIST is not
//     closed under registry growth: the registry only ever gains names, so a decoder whose
//     copy is one release stale reads a newly-registered ACTION as unknown and suppresses
//     capture for batches the indexer dispatches - under-capture, the money-bearing
//     direction, on exactly the networks (testnet/regtest, where new changes are
//     genesis-active) where this gate is live today. 53 names are enabled in the sibling and
//     absent from this decoder's VALID_ACTION_NAMES, so the gap is large and it moves.
//     Note also that the registry is a plain object, so `constructor`, `toString` and
//     `__proto__` read as REGISTERED AND ENABLED there; a name gate written from a list
//     would have to reproduce that too. Left open; the over-capture it costs is the safe
//     direction.
//   * A SLEEPING SOURCE. `indexerDb.isActionAllowed` reads the indexer's own address-sleep
//     state (db.isAddressSleeping) as of the block. That table does not exist in the decoder
//     and is not derivable from the transaction, so there is nothing here to mirror. Stated
//     plainly rather than approximated.
//   * THE AGGREGATE GAS PRE-CHECK ('invalid: GAS (insufficient)'). Same reason: it reads the
//     SOURCE's balances and the token set from the indexer database.
//
// A FOURTH cause, the BATCH_COST_WEIGHTING weight budget, IS mirrored, and unlike the caps
// above it is gated on its own vendored instant rather than assumed on (see
// isBatchCostWeightingActive). Its one deliberate under-estimate, the DEPLOY discount, is
// argued at subCommandCostWeight.
//
// Order of the checks is irrelevant to the verdict (any one of them means "rejected"), so
// this does NOT reproduce the indexer's error precedence, which decides only WHICH string a
// rejected batch reports.
//
// `consensusNetwork` and `blockTime` are OPTIONAL and default to "the weight budget is not
// provably active", so every caller written before the budget existed keeps today's verdicts.
function hasProvablyRejectedBatch(subCommands, aliases, consensusNetwork, blockTime){
    if (!Array.isArray(subCommands)) return false
    // The global command cap, counted over the raw ';'-split list with empty elements
    // included - the same list, and the same counting rule, the indexer caps.
    if (subCommands.length > COMMAND_LIMIT) return true
    if (hasProvablyRejectedSubCommand(subCommands)) return true

    const tally     = new Map()
    const mintTicks = []
    for (const command of subCommands){
        const key = subCommandLimitKey(command, aliases)
        if (key === null) continue
        if (key === 'MINT') mintTicks.push(subCommandTick('MINT', command))
        tally.set(key, (tally.get(key) || 0) + 1)
    }

    // The post-flag table: the ungated caps with the gated ones merged over them, exactly as
    // the indexer builds it when BATCH_ISSUANCE_LIMITS is active. Built per call from the
    // vendored constants so neither vendored table is ever mutated.
    const caps = Object.assign({}, ACTION_LIMITS, GATED_ACTION_LIMITS)
    for (const action of Object.keys(caps)){
        const count = (action === 'MINT') ? maxIdenticalMintTicks(mintTicks)
                                          : (tally.get(action) || 0)
        if (count > caps[action]) return true
    }

    // The weighted budget, which the indexer applies INSTEAD of the flat count at/after
    // BATCH_COST_WEIGHTING. The count cap above stays a sound pre-filter either way, because
    // every weight is >= 1 and the budget is the same number.
    if (isBatchCostWeightingActive(consensusNetwork, blockTime) &&
        batchCostWeight(subCommands, aliases) > WEIGHT_BUDGET) return true

    return false
}

// Is the indexer's BATCH_COST_WEIGHTING weight budget in force at this block?
//
// Its own vendored per-network instant, NOT the ordering argument the caps lean on. That
// argument is specific to BATCH_ISSUANCE_LIMITS, whose instant the decoder's capture gate is
// required to sit at or after; the weighting flag has the opposite relationship. Since the
// 2026-09-09 ruling armed it at mainnet genesis it sits BELOW capture there, and that is
// safe because the indexer applies the budget only inside its BATCH_ISSUANCE_LIMITS guard,
// which shares capture's instant: below it neither side weighs, and this mirror captures
// nothing to suppress. An absent or DISARMED (null) entry is inactive at every block time,
// which leaves over-capture in place rather than inventing a suppression rule.
function isBatchCostWeightingActive(consensusNetwork, blockTime){
    const activation = COST_WEIGHTING_ACTIVATION[consensusNetwork]
    if (typeof activation !== 'number') return false
    const t = Number(blockTime)
    if (!Number.isFinite(t)) return false
    return t >= activation
}

// The cost weight of ONE sub-command: a strict LOWER BOUND on the indexer's subCommandWeight.
//
// The bound is the whole design, because the directions are not symmetric. Charging MORE than
// the indexer pushes the sum over the budget for a batch the indexer really dispatches, which
// suppresses capture and loses a settlement output; charging LESS only leaves today's
// over-capture open for that shape.
//
// So DEPLOY is deliberately UNDER-charged at the default 1 rather than its table weight of
// 30: the indexer discounts a format-4 chunk carrier back to 1, and this module does not read
// FORMAT versions. DEPLOY is capped at 1 per BATCH by GATED_ACTION_LIMITS, so the whole
// under-estimate is bounded at 29 of the 250 budget. Every other weighted ACTION
// (AIRDROP/DIVIDEND/EXECUTE/XEXEC) is charged unconditionally by the indexer, so the table
// value is exact there.
//
// Alias expansion matches the indexer's, which normalizes the name before weighing; the
// module header's ordering argument covers that BATCH_SUBACTION_NORMALIZATION is on wherever
// capture runs. A name the table does not carry weighs 1, and hasOwnProperty keeps
// `constructor`/`__proto__` off the prototype chain.
function subCommandCostWeight(command, aliases){
    const rawName = subCommandActionName(command)
    if (rawName === null) return 1
    const action = expandAliasName(rawName, aliases)
    if (action === 'DEPLOY') return 1
    if (!Object.prototype.hasOwnProperty.call(COMMAND_WEIGHTS, action)) return 1
    const weight = COMMAND_WEIGHTS[action]
    return (Number.isInteger(weight) && weight >= 1) ? weight : 1
}

// Total cost weight of a BATCH: the sum of subCommandCostWeight over the raw ';'-split list,
// empty elements included, exactly the list the indexer weighs. Never throws (a crash here
// would take down block decoding); an unweighable list falls back to 0, which is "not
// provably rejected".
function batchCostWeight(subCommands, aliases){
    try {
        let total = 0
        for (const command of subCommands) total += subCommandCostWeight(command, aliases)
        return total
    } catch (e) {
        return 0
    }
}

module.exports = {
    hasProvablyRejectedBatch,
    isBatchCostWeightingActive,
    subCommandCostWeight,
    batchCostWeight,
}
