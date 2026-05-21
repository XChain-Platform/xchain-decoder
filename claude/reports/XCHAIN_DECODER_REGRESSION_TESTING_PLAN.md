# XChain Decoder - Regression Testing Plan

**Component:** `xchain-decoder`  
**Date:** 2026-04-02  
**Author:** Senior QA Engineer (AI-assisted)  
**Version:** 1.0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope Definition](#2-scope-definition)
3. [Test Selection Criteria](#3-test-selection-criteria)
4. [Regression Test Inventory](#4-regression-test-inventory)
5. [Execution Strategy](#5-execution-strategy)
6. [Maintenance & Management Plan](#6-maintenance--management-plan)
7. [Relationship to Other Test Phases](#7-relationship-to-other-test-phases)

---

## 1. Executive Summary

The `xchain-decoder` is a high-criticality component that sits at the front of the XChain data pipeline. It polls cryptocurrency nodes (Bitcoin, Litecoin, Dogecoin) via JSON-RPC, decrypts AES-128-CTR obfuscated payloads, parses 19 ACTION types from four script formats, and writes decoded data to MariaDB. Any regression in its decoding logic propagates silently downstream — the indexer, explorer, and all consumer services will process incorrect data.

This plan defines a regression test suite that guards the decoder's stable behavior across code changes, dependency updates, and refactors. It leverages the existing test infrastructure (smoke, unit, integration, security, fuzz, chaos, e2e, benchmarks) to avoid duplication while ensuring comprehensive coverage of regression-critical paths.

---

## 2. Scope Definition

### 2.1 What the Regression Suite Covers

The regression suite is a **curated subset** of tests drawn from all existing test phases, plus targeted regression-specific tests. It covers:

| Category | What It Guards | Source Tests |
|----------|---------------|--------------|
| **Core Decryption** | AES-128-CTR deobfuscation with txid-derived key/IV; XCHN magic prefix detection; error silencing for bad decrypt | `removeObfuscation.test.js`, `deobfuscation.smoke.js`, `deobfuscation.security.test.js` |
| **Script Parsing** | OP_RETURN, P2SH, P2WSH, 1-of-3 multisig data extraction; source address resolution (including P2SH chase) | `parseTransaction.test.js`, `parseOpReturn.smoke.js`, `parseMultisig.smoke.js`, `opReturn.test.js`, `multisig.test.js`, `p2sh/*.test.js`, `p2wsh/*.test.js` |
| **ACTION Validation** | 19-name whitelist enforcement; pipe-delimited parsing; UTF-8 handling; MAX_ACTION_DATA_LENGTH (8192 bytes) | `actionValidation.security.test.js`, unit parse tests |
| **DISPENSER Protocol** | Pipe-delimited field parsing; expiration validation (0-4294967295); dispenser table writes; expiration cleanup; payment output recording | `dispensers.test.js`, `dispenserValidation.security.test.js`, boundary tests |
| **Database Integrity** | Block/transaction inserts; index deduplication (index_addresses, index_transactions); duplicate key handling (errno 1062); satoshi-to-decimal conversion | `databaseInit.smoke.js`, integration DB tests, `sqlParameterization.security.test.js` |
| **Blockchain Connectivity** | JSON-RPC retry logic; AuxPoW stripping (Dogecoin); HogEx/MWEB handling (Litecoin); 429 backoff; timeout behavior | `BlockchainConnector.test.js`, `connectorSecurity.security.test.js` |
| **Reorg Recovery** | Chain reorganization detection via previous_block_hash mismatch; block rollback; event logging | Chaos reorg tests, integration reorg scenarios |
| **Mempool Management** | Mempool poll cycle (60s); binary-search comparison; stale tx cleanup; batch fetch (1000 tx chunks) | Integration mempool tests, chaos mempool tests |
| **Multi-Network Support** | Bitcoin/Litecoin/Dogecoin x mainnet/testnet/regtest configurations; correct startBlockIndex values; network-specific parsing | `CryptoNetworks.test.js`, `cryptoNetworks.smoke.js` |
| **API Health** | Ping/health endpoints; rate limiting; graceful shutdown (SIGTERM/SIGINT) | `apiPing.smoke.js`, chaos signal tests |

### 2.2 What the Regression Suite Does NOT Cover

- **Performance benchmarks** — tracked separately via `test:bench` with baseline comparisons
- **Exploratory/ad-hoc testing** — manual investigation of new edge cases
- **Upstream service behavior** — coin node correctness, indexer logic
- **New feature validation** — covered by feature-specific test plans until stabilized

### 2.3 Regression Suite Boundaries

The regression suite tests the decoder **in isolation** (unit/security) and **in context** (integration/e2e). The boundary is:

- **Input boundary:** Raw block hex and raw transaction hex from coin node (mocked in unit tests, real in integration/e2e)  
- **Output boundary:** MariaDB table state after decoding (verified by direct SQL queries)  
- **Side-effect boundary:** JSON-RPC API responses (ping, health)

---

## 3. Test Selection Criteria

### 3.1 Inclusion Criteria (must meet at least one)

| # | Criterion | Rationale |
|---|-----------|-----------|
| C1 | Tests core decryption path (AES-128-CTR, key derivation, magic prefix) | Single point of failure — all ACTION data flows through decryption |
| C2 | Tests a script parsing type (OP_RETURN, P2SH, P2WSH, multisig) | Four distinct code paths; regressions can be type-specific |
| C3 | Tests ACTION name validation or payload parsing | Whitelist enforcement prevents injection of invalid ACTIONs |
| C4 | Tests database write correctness (inserts, deduplication, foreign keys) | Data integrity is the decoder's primary contract with downstream |
| C5 | Tests error handling for malformed/hostile input | Security regressions are silent and high-impact |
| C6 | Tests a previously-fixed bug | Bug regressions are the most common and preventable failure mode |
| C7 | Tests reorg detection and recovery | Data consistency depends on correct reorg handling |
| C8 | Tests network-specific behavior (Litecoin MWEB, Dogecoin AuxPoW) | Coin-specific code paths are fragile and rarely exercised in dev |
| C9 | Tests DISPENSER protocol lifecycle | Dispensers involve cross-block state (creation, payment, expiration) |

### 3.2 Prioritization Tiers

Tests are assigned to tiers that determine execution frequency:

| Tier | Name | Criteria Met | Typical Count | Target Runtime |
|------|------|-------------|---------------|----------------|
| **P0** | Critical | C1, C2, C3, C5 | ~40-60 tests | < 30 seconds |
| **P1** | High | C4, C6, C7, C9 | ~30-50 tests | < 2 minutes |
| **P2** | Standard | C8, stable features | ~20-40 tests | < 5 minutes |
| **P3** | Extended | Edge cases, rare paths | ~10-20 tests | < 15 minutes |

### 3.3 Exclusion Criteria

- Tests that are flaky (>2% failure rate on identical code) — quarantined until stabilized
- Tests that duplicate coverage already provided by a higher-tier test
- Tests for features still under active development (not yet stabilized)
- Pure performance tests (tracked separately)

---

## 4. Regression Test Inventory

### 4.1 P0 — Critical (run on every commit)

#### Decryption Core
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-DEC-001 | Valid AES-128-CTR decrypt with known txid produces expected plaintext | `removeObfuscation.test.js` | Crypto library updates breaking decryption |
| R-DEC-002 | XCHN magic prefix correctly detected and stripped | `removeObfuscation.test.js` | Prefix detection off-by-one |
| R-DEC-003 | Non-XCHN data returns null (not an error) | `removeObfuscation.test.js` | False positive decryption |
| R-DEC-004 | Malformed ciphertext silences OSSL errors, returns null | `deobfuscation.security.test.js` | Error leak or crash on bad input |
| R-DEC-005 | Key/IV derived from correct txid substring positions (0-16, 16-32) | `removeObfuscation.test.js` | Key derivation regression |

#### Script Parsing
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-SCR-001 | OP_RETURN data extracted from standard push | `parseOpReturn.smoke.js` | OP_RETURN parsing regression |
| R-SCR-002 | P2SH data reassembled from redeem scripts across inputs | `parseTransaction.test.js` | Multi-input reassembly failure |
| R-SCR-003 | P2WSH data reassembled from witness scripts across inputs | `parseTransaction.test.js` | Witness data extraction failure |
| R-SCR-004 | 1-of-3 multisig data from pubkeys 1 & 2 with first-byte strip | `parseMultisig.smoke.js` | Multisig parsing regression |
| R-SCR-005 | Source address resolved from first input's spent output | Integration tests | Source attribution failure |
| R-SCR-006 | P2SH source chases one level to redeeming tx's first input | Integration tests | P2SH source resolution failure |

#### ACTION Validation
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-ACT-001 | All 19 valid ACTION names accepted | `actionValidation.security.test.js` | Whitelist accidentally modified |
| R-ACT-002 | Unknown ACTION name rejected (not written to DB) | `actionValidation.security.test.js` | Validation bypass |
| R-ACT-003 | ACTION data > 8192 bytes rejected | Boundary tests | Size limit bypass |
| R-ACT-004 | Pipe-delimited parsing extracts correct field count | `parseTransaction.test.js` | Delimiter handling regression |
| R-ACT-005 | Invalid UTF-8 sequences handled (replacement chars, logged, skipped) | Unit tests | Crash on malformed text |

#### Security
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-SEC-001 | SQL parameterization on all insert paths | `sqlParameterization.security.test.js` | SQL injection regression |
| R-SEC-002 | Error messages do not leak internal paths or credentials | `errorSanitization.security.test.js` | Information disclosure |
| R-SEC-003 | Connection pool exhaustion handled gracefully | `connectionHandling.security.test.js` | DoS via connection leak |

### 4.2 P1 — High (run on PR merge to main)

#### Database Integrity
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-DB-001 | Block insert creates correct row with foreign keys | Integration tests | Schema migration regression |
| R-DB-002 | Transaction insert deduplicates via index_addresses/index_transactions | Integration tests | Dedup logic failure |
| R-DB-003 | Duplicate txid returns DUPLICATED_TRANSACTION (errno 1062) | Unit/integration | Duplicate handling regression |
| R-DB-004 | Satoshi-to-decimal conversion correct for boundary values | Boundary tests | Amount calculation error |
| R-DB-005 | Database auto-creation and table verification on startup | `databaseInit.smoke.js` | Schema init regression |

#### DISPENSER Protocol
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-DSP-001 | DISPENSER|0|... parsed with correct field extraction | `dispensers.test.js` | Field parsing regression |
| R-DSP-002 | Expiration validated (0 to 4294967295 range) | `dispenserValidation.security.test.js` | Expiration bypass |
| R-DSP-003 | Expired dispensers deleted on new block | Integration tests | Cleanup regression |
| R-DSP-004 | Payment to active dispenser address recorded in transaction_outputs | Integration tests | Payment detection failure |

#### Reorg Recovery
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-REORG-001 | Reorg detected when previous_block_hash mismatches | Chaos tests | Detection logic regression |
| R-REORG-002 | Reorg rolls back affected blocks and transactions | Chaos tests | Incomplete rollback |
| R-REORG-003 | Reorg event logged to events table | Integration tests | Audit trail failure |
| R-REORG-004 | Decoder resumes correct parsing after reorg recovery | Chaos tests | Post-reorg stuck state |

#### Bug Fix Regressions
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-BUG-xxx | (Template: each resolved bug gets a regression test) | Bug-specific test file | Specific bug reintroduction |

### 4.3 P2 — Standard (run nightly)

#### Multi-Network Support
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-NET-001 | Bitcoin mainnet/testnet/regtest configs correct | `CryptoNetworks.test.js` | Config regression |
| R-NET-002 | Litecoin HogEx flag (0x08) stripped before parsing | `XChainBlockDecoder.test.js` | Litecoin parsing failure |
| R-NET-003 | Dogecoin AuxPoW headers stripped via getBlockWithoutAuxPow() | `BlockchainConnector.test.js` | Dogecoin block parsing failure |
| R-NET-004 | MWEB extension data stripped for Litecoin | `XChainBlockDecoder.test.js` | MWEB crash |
| R-NET-005 | startBlockIndex correct for all 9 network combinations | `CryptoNetworks.test.js` | Wrong starting block |

#### Mempool Management
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-MEM-001 | Mempool poll fetches and parses unconfirmed txs | Integration tests | Mempool update failure |
| R-MEM-002 | Stale mempool txs removed via binary search comparison | Integration tests | Memory leak from stale txs |
| R-MEM-003 | Batch fetch works correctly at 1000-tx chunk boundaries | Integration tests | Batch boundary bug |

#### Blockchain Connectivity
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-RPC-001 | Retry logic (10 attempts, 500ms backoff) | `BlockchainConnector.test.js` | Retry regression |
| R-RPC-002 | HTTP 429 triggers 5s backoff (not 500ms) | `BlockchainConnector.test.js` | Rate limit handling failure |
| R-RPC-003 | Verification progress < 0.99 prevents parsing | Unit tests | Premature parsing on unsynced node |

### 4.4 P3 — Extended (run before release)

#### Edge Cases & Rare Paths
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-EDGE-001 | Zero-length ACTION data handled | Boundary tests | Null pointer on empty data |
| R-EDGE-002 | Transaction with no inputs (coinbase) skipped | Unit tests | Crash on coinbase tx |
| R-EDGE-003 | Concurrent decoder instances don't corrupt data | Chaos tests | Race condition |
| R-EDGE-004 | Graceful shutdown (SIGTERM/SIGINT) completes in-flight work | Chaos tests | Data loss on shutdown |
| R-EDGE-005 | Mid-transaction DB failure triggers rollback | Chaos tests | Partial write corruption |

#### Fuzz-Derived Regressions
| ID | Description | Source | Guards Against |
|----|-------------|--------|----------------|
| R-FUZZ-xxx | (Template: crashes found by fuzz testing become regression tests) | Derived from `test:fuzz` findings | Reintroduction of fuzz-discovered bugs |

---

## 5. Execution Strategy

### 5.1 Execution Schedule

| Trigger | Tiers Run | Estimated Time | Blocking? |
|---------|-----------|---------------|-----------|
| Every commit (pre-push hook or CI) | P0 | < 30 seconds | Yes — commit rejected on failure |
| PR merge to main | P0 + P1 | < 3 minutes | Yes — merge blocked on failure |
| Nightly CI run | P0 + P1 + P2 | < 8 minutes | No — failures create tickets |
| Pre-release gate | P0 + P1 + P2 + P3 | < 20 minutes | Yes — release blocked on failure |
| Dependency update (crypto libs, bitcoinjs-lib, mariadb) | Full suite + fuzz subset | < 30 minutes | Yes — update blocked on failure |

### 5.2 npm Script Integration

Regression tests should be runnable via dedicated npm scripts:

```bash
npm run test:regression          # P0 + P1 (default for development)
npm run test:regression:critical # P0 only (fast, for pre-commit)
npm run test:regression:full     # P0 + P1 + P2 + P3 (pre-release)
```

These scripts should use Mocha's `--grep` or tag-based filtering (via test naming convention or `.mocharc.yml` configuration) to select the appropriate test subset.

### 5.3 Test Naming Convention

All regression tests should follow the naming pattern:

```
[REGRESSION] <Tier> <Category>: <description>
```

Example:
```javascript
it('[REGRESSION] P0 DEC: AES-128-CTR decrypt produces correct plaintext for known txid', ...)
it('[REGRESSION] P1 DSP: expired dispenser deleted on new block', ...)
```

This enables grep-based tier selection:
```bash
mocha --grep "\[REGRESSION\] P0"        # Critical only
mocha --grep "\[REGRESSION\] P[01]"     # Critical + High
mocha --grep "\[REGRESSION\]"           # All regression tests
```

### 5.4 Managing Execution Time

| Strategy | Applied To | Impact |
|----------|-----------|--------|
| **In-memory DB (memdown)** | P0 unit tests that need LevelDB | Eliminates disk I/O |
| **Shared test fixtures** | All tiers | Avoids redundant setup of decoder instances and DB state |
| **Parallel test files** | P0, P1 | Mocha `--parallel` for independent test files |
| **Sinon stubs for RPC** | P0, P1 unit tests | Eliminates network latency |
| **Dedicated regtest instance** | P2, P3 integration tests | Real but fast (regtest mines instantly) |
| **Test data caching** | All tiers | Pre-computed encrypted payloads and block hex stored as fixtures |
| **Lazy DB setup** | P2, P3 | Only spin up MariaDB + regtest for tiers that need them |

### 5.5 CI/CD Pipeline Integration

```
Code Push
    |
    v
[Stage 1: Lint + P0 Regression]  <-- fast gate, < 30s
    |
    v (pass)
[Stage 2: Unit + P1 Regression]  <-- medium gate, < 3 min
    |
    v (pass)
[Stage 3: Integration + Security] <-- requires DB + regtest
    |
    v (pass)
[Stage 4: E2E]                    <-- full stack
    |
    v (nightly)
[Stage 5: P2 + P3 + Fuzz subset + Chaos subset]
    |
    v (pre-release)
[Stage 6: Full regression + Benchmarks + Mutation]
```

### 5.6 Failure Handling

| Failure Type | Action |
|-------------|--------|
| P0 failure on commit | **Block commit.** Developer must fix before pushing. |
| P1 failure on PR | **Block merge.** PR author investigates. If environment-specific, label as flaky and quarantine. |
| P2/P3 failure (nightly) | **Create ticket.** Assign to component owner. Severity based on tier. |
| Flaky test (>2% false failure rate) | **Quarantine.** Move to `test/quarantine/`. Track in issue tracker. Fix root cause or remove within 2 sprints. |
| New failure after dependency update | **Block update.** Investigate API changes in the dependency. Update test if behavior change is intentional; fix code if it's a regression. |

---

## 6. Maintenance & Management Plan

### 6.1 Adding New Regression Tests

| Trigger | Process |
|---------|---------|
| **Bug fix merged** | The bug fix PR MUST include a regression test tagged `[REGRESSION]` at the appropriate tier. The test must fail without the fix and pass with it. |
| **Feature stabilized** | When a feature exits "active development" status, its critical-path tests are promoted to the regression suite with appropriate tier tags. |
| **Fuzz/chaos finding** | Any crash or data corruption found by fuzz/chaos testing is distilled into a deterministic regression test with the exact input that triggered the failure. |
| **Dependency update** | If a dependency update required code changes, add regression tests covering the affected code paths. |
| **New ACTION type** | When a new ACTION is added to the whitelist, add P0 tests for its parsing and P1 tests for its database writes. |

### 6.2 Removing or Updating Tests

| Trigger | Process |
|---------|---------|
| **Feature removed** | Remove associated regression tests. Document in CHANGELOG. |
| **ACTION format changed** | Update test fixtures and expected values. Review all tests tagged with the affected ACTION name. |
| **Crypto library updated** | Re-verify all R-DEC-* tests. Update expected ciphertext/plaintext pairs if the library's behavior changed intentionally. |
| **Schema migration** | Update all R-DB-* tests that verify table structure or insert behavior. |
| **Test quarantined > 2 sprints** | Escalate. Either fix the flakiness or remove the test with documented justification. |

### 6.3 Ownership & Review

| Role | Responsibility |
|------|---------------|
| **PR Author** | Tag new regression tests with correct tier. Ensure existing regression tests pass before requesting review. |
| **PR Reviewer** | Verify that bug fix PRs include regression tests. Check tier assignment is appropriate. |
| **Component Owner** | Triage nightly regression failures. Maintain quarantine queue. Review tier assignments quarterly. |
| **QA Lead** | Review regression suite coverage quarterly. Ensure new features get regression coverage within one sprint of stabilization. |

### 6.4 Tracking & Reporting

#### Test Result Tracking

- **CI dashboard:** Each regression run produces a report with pass/fail/skip counts per tier  
- **Trend tracking:** Track regression suite pass rate over time (target: >99.5% on non-quarantined tests)  
- **Coverage mapping:** Maintain a matrix mapping regression test IDs to source files they exercise (Section 4 tables serve as the initial version)

#### Metrics to Monitor

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| P0 pass rate | 100% | Any failure |
| P1 pass rate | > 99% | 2+ failures in a week |
| P0 execution time | < 30s | > 45s |
| P0+P1 execution time | < 3 min | > 5 min |
| Quarantine queue size | 0 | > 5 tests |
| Time-to-regression-test (bug fixes) | Same PR | > 1 sprint |

#### Failure Investigation Template

When a regression test fails, the investigating developer fills out:

```
Test ID: R-XXX-NNN
Failed in: [commit hash / CI run link]
Tier: P0/P1/P2/P3
Root Cause: [code change / dependency update / environment / flaky]
Fix: [PR link]
Regression Test Updated: [yes/no — if the test itself needed updating]
```

---

## 7. Relationship to Other Test Phases

### 7.1 Test Phase Dependency Map

```
Smoke Tests ──────┐
                   ├──► Regression Suite (curated selection)
Unit Tests ────────┤
                   │
Security Tests ────┤
                   │
Integration Tests ─┤
                   │
Boundary Tests ────┘
                        ┌──► Regression Suite (findings become regression tests)
Fuzz Tests ─────────────┤
                        │
Chaos Tests ────────────┘

E2E Tests ──────────────────► Complementary (not drawn from, but validates same paths end-to-end)

Benchmarks ─────────────────► Separate track (performance, not correctness)
```

### 7.2 Reuse Strategy

| Existing Phase | What Regression Suite Reuses | What's Different |
|---------------|----------------------------|------------------|
| **Smoke Tests** | Test harness setup, module loading checks, basic parsing fixtures | Regression tests assert deeper correctness, not just "doesn't crash" |
| **Unit Tests** | Sinon stubs, fixture data (encrypted payloads, block hex), decoder instance factories | Regression tests are tagged and tier-assigned; unit tests are not |
| **Security Tests** | Validation test cases (ACTION names, SQL parameterization, error sanitization) | Regression suite includes the most critical security tests directly |
| **Integration Tests** | Regtest setup hooks (`prepareRegtest.test.js`), DB assertion helpers, transaction broadcast utilities | Regression tests run a curated subset; integration tests run exhaustively |
| **Boundary Tests** | Boundary value fixtures (max sizes, zero values, overflow values) | Regression tests focus on "this must not break"; boundary tests explore limits |
| **Fuzz Tests** | Crash-triggering inputs are captured and converted to deterministic regression tests | Fuzz tests are generative and slow; regression tests are deterministic and fast |
| **Chaos Tests** | Failure injection patterns (DB drop, RPC timeout, signal handling) | Regression tests verify recovery correctness; chaos tests verify resilience |
| **E2E Tests** | None directly (E2E tests the full stack, not decoder in isolation) | E2E validates the pipeline; regression validates the decoder's contract |

### 7.3 Avoiding Duplication

The regression suite does **not** duplicate tests — it **selects and tags** existing tests. The implementation approach:

1. **Tagging over copying:** Existing tests in `test/unit/`, `test/security/`, etc. are tagged with `[REGRESSION]` in their description string rather than copied into a separate directory.
2. **Mocha grep selection:** The `test:regression` scripts use `--grep` to select tagged tests across all directories.
3. **Single source of truth:** Each test lives in one file, in the directory matching its primary phase. The regression tag is an overlay.
4. **Regression-only tests:** Tests that exist solely to prevent a specific bug regression (R-BUG-xxx) live in `test/regression/` with clear references to the bug report.

### 7.4 Gap Analysis: What Regression Tests Add Beyond Existing Phases

| Gap | How Regression Suite Fills It |
|-----|------------------------------|
| No systematic "must not break" guarantee | Tier system ensures critical paths are verified on every commit |
| Bug fixes may not include prevention tests | Process requires regression test with every bug fix PR |
| Fuzz findings are transient | Crash inputs are captured as permanent regression tests |
| No fast feedback loop for core logic | P0 tier runs in < 30 seconds, suitable for pre-commit hooks |
| No coverage tracking over time | Regression test IDs mapped to source files; pass rates tracked |

---

## Appendix A: Regression Test ID Scheme

Format: `R-<CATEGORY>-<NUMBER>`

| Prefix | Category |
|--------|----------|
| R-DEC | Decryption / deobfuscation |
| R-SCR | Script parsing (OP_RETURN, P2SH, P2WSH, multisig) |
| R-ACT | ACTION validation and parsing |
| R-SEC | Security (injection, sanitization, connection handling) |
| R-DB | Database integrity (inserts, dedup, conversion) |
| R-DSP | DISPENSER protocol |
| R-REORG | Chain reorganization handling |
| R-MEM | Mempool management |
| R-NET | Multi-network / coin-specific behavior |
| R-RPC | Blockchain connectivity / JSON-RPC |
| R-EDGE | Edge cases and rare paths |
| R-BUG | Bug-fix specific regressions |
| R-FUZZ | Fuzz-derived regressions |

## Appendix B: Regression Suite Bootstrap Checklist

- [ ] Add `[REGRESSION]` tags to existing critical tests (per Section 4 inventory)
- [ ] Create `test/regression/` directory for bug-fix-specific tests
- [ ] Add npm scripts: `test:regression`, `test:regression:critical`, `test:regression:full`
- [ ] Configure Mocha grep patterns in `.mocharc.yml` for tier selection
- [ ] Set up CI pipeline stages (per Section 5.5)
- [ ] Create failure investigation template in issue tracker
- [ ] Document regression test requirement in PR template
- [ ] Establish quarterly review cadence for tier assignments
- [ ] Set up pass-rate tracking dashboard
- [ ] Tag initial set of tests and validate execution times meet tier targets
