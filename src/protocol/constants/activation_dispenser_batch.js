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
 **********************************************************************/

// ORACLE_FEE_OUTPUT_ACTIVATION (PRICE v1 oracle usage fee): the flag-day
// at/above which the DECODER persists a native-coin output paying a DISPENSER's
// ORACLE_ADDRESS into transaction_outputs, so the indexer's validateOracleFee can see the
// fee that was actually paid. Keyed on BLOCK TIME (not height) because dispensers settle on
// BTC, LTC and DOGE, whose heights diverge; compared with the same >= semantics the indexer's
// protocol_changes gates use.
//
// The mainnet value is NOT free to choose: capturing a second output on a data-bearing
// transaction makes it fan out to two rows in getDecoderBlockData, and BELOW the indexer's
// FIX_OUTPUT_FANOUT flag-day (protocol_changes.js, mainnet block_time 1786060800) such a
// transaction is a consensus-critical fault that HALTS the block. This gate must therefore
// never precede FIX_OUTPUT_FANOUT; it is armed to exactly the same instant so capture begins
// in the same block the collapse does. Below it a Mode B create against a fee-bearing oracle
// is rejected with 'missing oracle fee output' whether or not the payer paid, which is the
// fail-closed direction and costs nothing while no mainnet chain holds a dispenser.
// testnet/regtest are genesis-on, matching FIX_OUTPUT_FANOUT there.
//
// Vendored byte-equal into xchain-decoder/src/protocol/constants.js; the parity suites keep
// the two copies and the indexer's FIX_OUTPUT_FANOUT timestamp in lockstep.
const ORACLE_FEE_OUTPUT_ACTIVATION = {
    mainnet: 1786060800,  // 2026-08-07 00:00:00 UTC, the contract-era flag-day FIX_OUTPUT_FANOUT rides
    testnet: 0,
    regtest: 0,
};

// ORACLE_FEE_SET_CAPTURE_ACTIVATION (PRICE v1 oracle usage fee, set-membership capture): the
// flag-day at/above which the DECODER captures a DISPENSER v2 (edit/refill) oracle-fee output
// by SET MEMBERSHIP over EVERY open Mode B dispenser of the paying SOURCE, instead of the one
// top-ranked row the legacy lookup picks. Keyed on BLOCK TIME with the same >= semantics as
// ORACLE_FEE_OUTPUT_ACTIVATION, which it never precedes: set capture only widens a capture
// that gate has already switched on.
//
// WHY IT EXISTS: a v2 payload names its target by DISPENSER_ACTION_INDEX, an id in the
// INDEXER's action space the decoder does not maintain, so the decoder resolves the oracle by
// SOURCE address. Capture is an address EQUALITY test, so when one source holds several open
// Mode B dispensers with DIFFERENT oracle addresses, a refill of any row but the top-ranked
// one resolves the wrong oracle, NOTHING is captured, and the indexer (which resolves the
// exact DISPENSER_ACTION_INDEX target) rejects a valid refill after the payer's native payment
// is already spent. Testing membership over the whole set captures the right output for every
// row; the extra outputs a multi-oracle source's refill may also capture are ones the indexer
// ignores, which is the over-capture direction the decoder's advisory open-view calls safe.
//
// CONSENSUS-AFFECTING: it changes the set of outputs persisted to transaction_outputs, so an
// ungated widening breaks from-genesis byte-identity and forks validators. The legacy
// single-pick therefore stays live BELOW the gate, and a re-decode of pre-flag-day history
// reproduces exactly what the fleet wrote live.
//
// mainnet is ARMED at the base gate's own instant by the 2026-09-09 ruling, the earliest the
// ordering above permits: the indexed mainnet history holds 0 dispensers (measured
// 2026-09-09), so set capture persists exactly the output set the legacy single-pick did and
// the arm rewrites no agreed history. A from-genesis OLD-vs-ON replay witness per chain is the
// proof. regtest holds no agreed history (its chains are recreated per run), so it is
// genesis-on and exercises the set path in the regtest venues.
//
// DEPLOY DEADLINE, once an instant is armed: EVERY decoder on that network MUST be running the
// armed value before the instant, or the fleet splits on the first refill of a source holding
// more than one open Mode B dispenser.
//
// Vendored byte-equal into xchain-decoder/src/protocol/constants.js; the conformance suite
// keeps the two copies in lockstep and refuses a value that precedes
// ORACLE_FEE_OUTPUT_ACTIVATION.
const ORACLE_FEE_SET_CAPTURE_ACTIVATION = {
    mainnet: 1786060800,  // ARMED by the 2026-09-09 ruling at its base gate's own instant, the earliest the ordering above permits; identity on the indexed mainnet history (0 dispensers, measured 2026-09-09)
    // ARMED AT GENESIS (instant 0 = always in force), operator-ratified 2026-08-18 under the
    // pre-launch ruling that every feature must be ACTIVE on testnet. This gate fixes a defect
    // that spends a payer native coin and gives nothing back, so a public testnet WILL hit it.
    // Safe at 0 because testnet decoder/indexer state is REBUILT from the chain before launch.
    testnet: 0,
    regtest: 0,
};

// DISPENSER_EXPIRY_REALIGN_ACTIVATION (dispenser soft-expire measurement point): the flag-day
// at/above which the DECODER soft-expires open dispensers AFTER the block's transaction loop
// instead of before it, putting its measurement point where the INDEXER's already is. Keyed on
// BLOCK TIME with the same >= semantics as ORACLE_FEE_OUTPUT_ACTIVATION, because dispensers
// settle on BTC, LTC and DOGE, whose heights diverge.
//
// WHY IT EXISTS: the two services expire the same dispenser at opposite ends of the same block.
// The decoder runs db.deleteOpenDispensers BEFORE its transaction loop and then loads the
// open-dispenser address set the loop tests every output against, so on the FIRST block whose
// header time passes an expiration the dispenser is already out of that set. The indexer runs
// utility.processExpirations AFTER its transaction loop (XChainIndexer.js, next to
// processBetPasses), so for every transaction in that same block it still treats the dispenser
// as open. The indexer only ever sees outputs the decoder persisted, so a native payment to
// that dispenser on the boundary block is dropped by the decoder and no DISPENSE ever reaches
// the indexer: the payer's coin is spent and nothing is dispensed for it. That is money-bearing
// and unreachable by any in-memory re-seed, because transactions preceding an edit in the block
// are already past.
//
// At/above the gate the soft-expire moves to the end of the block loop, inside the same block
// transaction, so both services measure expiry at the identical point and a boundary block
// yields the same DISPENSE set on both sides.
//
// CONSENSUS-AFFECTING: it changes the set of outputs persisted to transaction_outputs on
// boundary blocks, so an ungated move breaks from-genesis byte-identity and forks validators.
// The legacy block-start soft-expire therefore stays live BELOW the gate, and a re-decode of
// pre-flag-day history reproduces exactly what the fleet wrote live.
//
// mainnet is ARMED at genesis (instant 0) by the 2026-09-09 ruling: the indexed mainnet history
// holds 0 dispensers and 0 dispenses (measured 2026-09-09), so no block ever carried an expiry
// boundary the realigned soft-expire could move and the arm rewrites no agreed history. A
// from-genesis OLD-vs-ON replay witness per chain is the proof. regtest holds no agreed history
// (its chains are recreated per run), so it is genesis-on and exercises the realigned path in
// the regtest venues.
//
// DEPLOY DEADLINE, once an instant is armed: EVERY decoder on that network MUST be running the
// armed value before the instant, or the fleet splits on the first block whose header time
// passes an open dispenser's expiration.
//
// Vendored byte-equal into xchain-decoder/src/protocol/constants.js; the conformance suite
// keeps the two copies in lockstep.
const DISPENSER_EXPIRY_REALIGN_ACTIVATION = {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    // ARMED AT GENESIS (instant 0 = always in force), operator-ratified 2026-08-18 under the
    // pre-launch ruling that every feature must be ACTIVE on testnet. This gate fixes a defect
    // that spends a payer native coin and gives nothing back, so a public testnet WILL hit it.
    // Safe at 0 because testnet decoder/indexer state is REBUILT from the chain before launch.
    testnet: 0,
    regtest: 0,
};

// DISPENSER_CANCEL_GRACE_ACTIVATION (dispenser cancellation grace capture): the flag-day
// at/above which the DECODER keeps a just-expired dispenser in the block loop's payment
// CAPTURE SET for a grace window past its expiration. Keyed on BLOCK TIME with the same >=
// semantics as DISPENSER_EXPIRY_REALIGN_ACTIVATION, because dispensers settle on BTC, LTC
// and DOGE, whose heights diverge.
//
// WHY IT EXISTS: the indexer keeps a CANCELLED dispenser fillable past its own expiration.
// It excludes `cancelling` rows from its expiration pass (xchain-indexer/src/db/index_tables.js
// getExpiredItems, `s2.status='open'`), keeps them matchable through
// `status IN ('open','cancelling')` in findMatchingDispensers, and closes only at the
// cancel's block time plus DISPENSER_CLOSE_DELAY (3600s). The decoder mirrors no cancel at
// all, by design, so it soft-expires that dispenser at its raw expiration and drops the
// address from the capture set. Cancel a funded dispenser shortly before its expiration and
// a window opens: the indexer still settles fills, the decoder captures no output, and the
// buyer's native coin reaches the seller with no DISPENSE record and no inventory release.
//
// At/above the gate the CAPTURE SET alone widens: a row whose expiration is no older than
// the grace window stays an eligible payment destination even once the soft-expire has
// stamped it. The soft-expire itself, the expiry MARK, the extend mirror, the oracle-address
// resolution and the hard purge all keep their current timing, which confines the change to
// the over-capture direction the decoder's advisory contract (xchain-decoder/src/db.js,
// above extendOpenDispenserExpirationBySource) calls safe. Delaying the MARK instead reaches
// the legacy single-pick oracle resolution, whose ORDER BY ... LIMIT 1 then ranks a dead row
// first and captures nothing at all: the under-capture direction, a second money-bearing
// defect rather than a fix. Widen the capture set, never the mark.
//
// CONSENSUS-AFFECTING: it changes the set of outputs persisted to transaction_outputs, so an
// ungated widening breaks from-genesis byte-identity and forks validators. The unwidened
// capture set therefore stays live BELOW the gate, and a re-decode of pre-flag-day history
// reproduces exactly what the fleet wrote.
//
// mainnet is ARMED at genesis (instant 0) by the 2026-09-09 ruling: the indexed mainnet
// history holds 0 dispensers and 0 dispenses (measured 2026-09-09), so the widened capture
// set admits no output the unwidened one missed and the arm rewrites no agreed history. A
// from-genesis OLD-vs-ON replay witness per chain is the proof.
//
// DEPLOY DEADLINE, once an instant is armed: EVERY decoder on that network MUST be running
// the armed value before the instant, or the fleet splits on the first block whose header
// time passes a cancelled dispenser's expiration.
//
// Vendored byte-equal into xchain-decoder/src/protocol/constants.js; the conformance suite
// keeps the two copies in lockstep.
const DISPENSER_CANCEL_GRACE_ACTIVATION = {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    // ARMED AT GENESIS (instant 0 = always in force), matching the sibling
    // DISPENSER_EXPIRY_REALIGN_ACTIVATION under the pre-launch ruling that every feature must
    // be ACTIVE on testnet. This gate closes a defect that spends a payer's native coin and
    // gives nothing back, so a public testnet WILL hit it. Safe at 0 because testnet
    // decoder/indexer state is REBUILT from the chain before launch.
    testnet: 0,
    regtest: 0,
};

// BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION (output capture AND open-dispenser registration
// through a BATCH): the flag-day at/above which the DECODER reads a BATCH's SUB-COMMANDS
// instead of only its top-level ACTION name, both when deciding which native-coin outputs to
// persist and when deciding which dispensers to register. Keyed on BLOCK TIME with the same >=
// semantics as ORACLE_FEE_OUTPUT_ACTIVATION, because the affected settlement flows run on BTC,
// LTC and DOGE, whose heights diverge by millions of blocks.
//
// WHY IT EXISTS: capture reads the top-level action string. `decodedData.startsWith("COINPAY|")`
// is FALSE for `BATCH|0|COINPAY|0|x;COINPAY|0|y`, and resolveOracleFeeAddresses' matching
// `startsWith("DISPENSER|")` is false for a batched DISPENSER, so a BATCH carrying either action
// persists NO settlement output and NO oracle-fee output. The indexer only ever sees outputs the
// decoder persisted, so a batched COINPAY reaches it with an EMPTY COIN_DESTINATION and settles
// nothing ("COINPAY (skip): destination mismatch tx= payee=<seller>", witnessed on regtest), and
// a batched Mode B DISPENSER is rejected for a missing oracle fee whether or not the payer paid.
// Both are money-bearing: the payer's coin is spent and nothing settles. At/above the gate the
// capture decision runs over the batch's sub-command list, split exactly as the indexer's
// xchain-indexer/src/actions/batch/validate.js readCommands splits it, so a batched COINPAY
// captures the same outputs a top-level COINPAY does.
//
// THE OPEN-DISPENSER REGISTRY RIDES THE SAME INSTANT, deliberately, because it is the same
// blindness and the same decision. `decodedData.startsWith("DISPENSER")` is false for
// `BATCH|0|DISPENSER|0|...`, so a dispenser CREATED inside a batch never entered
// getAllOpenDispenserAddresses: payments to it were never classified as dispense outputs and no
// DISPENSE ever fired, while the INDEXER, which dispatches the sub-command, registered it. A
// user could open a dispenser in a batch, fund it, and it would never dispense. That registry IS
// the address set the dispense half of output capture tests against, so splitting the two across
// two flag-days would leave the decoder half-batch-aware for a stretch of chain with nothing
// gained. One instant arms both; xchain-decoder/test/unit/batch_dispenser_registration.test.js
// drives the coupling rather than asserting it in prose.
//
// CONSENSUS-AFFECTING: it changes the set of rows written to transaction_outputs, which changes
// indexer verdicts, which changes the ledger. An ungated flip makes a from-genesis re-decode
// capture outputs the live fleet never captured, so the legacy top-level-only view stays live
// BELOW the gate and pre-flag-day history re-decodes byte-identically.
//
// NEVER ARM IT BELOW two sibling instants, both asserted in
// test/unit/batch_sub_command_output_capture_activation.test.js:
//   * the indexer's FIX_OUTPUT_FANOUT. A BATCH is a data-bearing, non-COINPAY row, so the extra
//     captured outputs fan it out to several rows, and BELOW that flag-day
//     output_fanout.collapseOutputFanout treats that as a consensus-critical fault and HALTS the
//     block. Arming this gate earlier does not merely change a verdict, it stops the chain.
//   * the indexer's BATCH_ISSUANCE_LIMITS, which carries the batch-cumulative settlement ledger.
//     Capture without that ledger lets N COINPAY sub-commands settle N obligations from ONE
//     payment, which is the defect this spec's R5 closes; arming capture first would open it.
//
// null means DISARMED (never active), the fail-closed default: a network keeps the legacy
// top-level-only view until the operator ratifies an instant, chosen with the fleet's upgrade
// state in hand, because arming it too early forks the chain and arming it in the past rewrites
// agreed history. Mainnet is ARMED (below). testnet and regtest are genesis-on, matching BOTH
// sibling gates there (FIX_OUTPUT_FANOUT and BATCH_ISSUANCE_LIMITS are all-zeros off mainnet),
// so the venues exercise the sub-command path from block 0.
//
// DEPLOY DEADLINE, once an instant is armed: EVERY decoder on that network MUST be running the
// armed value before the instant, or the fleet splits on the first BATCH carrying a COINPAY or a
// Mode B DISPENSER.
//
// Vendored into xchain-decoder/src/protocol/constants.js AHEAD of the canonical copy in
// xchain-documentation/protocol/constants.js; the conformance suite requires that mirror to exist
// before mainnet may be armed.
const BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION = {
    mainnet: 1786838400,  // ARMED 2026-08-14 (operator, pre-launch): 2026-08-16T00:00:00Z, the
                          // SAME instant as BATCH_ISSUANCE_LIMITS carries in the indexer. One
                          // decision, one boundary: arming the issuance rework WITHOUT this one
                          // ships a mainnet where a batched COINPAY spends the coin and settles
                          // nothing, and a batched DISPENSER create never dispenses, because
                          // capture would still read only the top-level ACTION name. DEPLOY
                          // DEADLINE: every decoder on mainnet must run this value BEFORE the
                          // instant, or the fleet splits on the first BATCH carrying a COINPAY
                          // or a Mode B DISPENSER.
    testnet: 0,
    regtest: 0,
};

module.exports = {
    ORACLE_FEE_OUTPUT_ACTIVATION,
    ORACLE_FEE_SET_CAPTURE_ACTIVATION,
    DISPENSER_EXPIRY_REALIGN_ACTIVATION,
    DISPENSER_CANCEL_GRACE_ACTIVATION,
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
};
