#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as four parallel jobs (ci,
# drift-guards, docker-suites, coverage). The pre-push venue gate used to run
# only `npm run ci`, so a push could gate green locally and then go red on
# GitHub on a job the gate never ran (2026-08-15: exactly that, on three repos
# at once). This script IS the local twin of the workflow: every job's
# run-steps, transcribed, in job order. When ci.yml gains or changes a job,
# change this script in the same commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping. The
# coverage job clones the whole .ci-siblings roster before re-running the unit
# suite, so the roster is what need_sib demands, not just drift-guards' hub.
#
# Database: nothing here reads the venue's CI_DB_* on purpose. The two
# docker-gated tiers bring up their OWN MariaDB inside their compose fixture
# (test/{integration,e2e}/fixtures/docker-compose.test.yml) on ports 13318 and
# 13319, with fixture-local throwaway credentials that the tier's setup.js
# defaults to. Pointing them at a venue database would test the wrong server.
#
# Docker: the docker-suites job runs on a runner that has docker, and both
# tiers are useless without it, so a venue without docker FAILS here rather
# than skipping (a skip is exactly the green-locally / red-on-GitHub hole this
# script exists to close).
#
# Skipped by design: none. Every run-step of every push-triggered workflow is
# transcribed below. The actions-only steps (checkout, setup-node, the npm ci
# install, and the coverage job's sibling-clone loop) have no local twin by
# nature: the venue already ships a checkout, a node, installed modules, and
# the sibling roster, and need_sib proves the last of those.
#
# Out of scope: verify-tag.yml (push on tags v*) and audit.yml
# (schedule + workflow_dispatch + pull_request on manifest paths). Neither
# triggers on a push to develop or master, so neither belongs in a push gate.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
# >>> ci-tier (generated block; re-run the tier wirer to update) >>>
# Tier classes. A push grades the FAST tier only: the unit job, the pin and
# drift guards, and the structure and hygiene checks the hook runs before it
# dispatches. The tiers named below (coverage re-runs, perf scenarios) are
# skipped when the gate sets CI_TIER=fast, and each skip is recorded so the
# closing verdict can never claim a green it did not earn. Nothing stops
# being graded: a scheduled sweep re-runs this same script with CI_TIER=full
# on every repo every three hours and before any release or deploy, and a
# red there is tracked down and fixed first. CI_TIER is unset for a hand
# run, so a bare `npm run ci:full` still runs every tier as it always did.
CI_TIER_FULL_ONLY=(
  "coverage ratchet (coverage:check)"
)
DEFERRED=""
ci_tier_deferred() {
  [ "${CI_TIER:-full}" = "fast" ] || return 1
  local t
  for t in ${CI_TIER_FULL_ONLY[@]+"${CI_TIER_FULL_ONLY[@]}"}; do
    if [ "$t" = "$1" ]; then
      DEFERRED="$DEFERRED [$1]"
      echo; echo "ci:full ===== $1 DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
      return 0
    fi
  done
  return 1
}
# <<< ci-tier <<<
run_tier() {
  ci_tier_deferred "$1" && return 0  # ci-tier guard (generated)
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
need_sib() {
  local s missing
  for s in "$@"; do
    missing=""
    [ -e "$SIB/$s/package.json" ] || missing="$missing package.json"
    [ -e "$SIB/$s/.git" ] || missing="$missing .git"
    if [ -n "$missing" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s (missing:$missing)" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}
need_docker() {
  docker info >/dev/null 2>&1 || {
    echo "ci:full: VENUE LACKS DOCKER for $1; pin a docker venue with CI_VENUES=..." >&2
    exit 1
  }
}

need_sib xchain-encoder xchain-documentation xchain-hub xchain-indexer xchain-utxo-tracker xchain-node
export XCHAIN_REQUIRE_SIBLINGS=1

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci" npm run ci

# --- job: drift-guards -----------------------------------------------------
# Run FROM the parent so sync-coins.sh sees the canonical + vendored pair the
# way the workflow lays them out (hub checkout beside this repo's checkout).
sync_coins_check() { (cd "$SIB" && "xchain-hub/bin/sync-coins.sh" --check --only "$(basename "$SELF")"); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'

# --- identity pin (this gate only; no ci.yml job runs it) ------------------
# bin/pins/identity.json holds the sha256 of the vendored coin files and the
# two twin fixtures. Nothing else reads it, so this tier re-hashes the tree
# against it and fails on any moved, missing or unreadable file instead of
# letting the pin go stale.
run_tier "identity pin (vendored coins, twin fixtures)" node bin/pin-identity.js --check

# --- job: docker-suites ----------------------------------------------------
# Both tiers own their venue lifecycle inside their npm script (compose up
# --wait, mocha, down -v on any exit), so this transcribes the two run-steps
# and nothing else. The gate is docker itself, checked once before either.
need_docker "docker-suites (test:integration, test:e2e)"
run_tier "docker: integration tier (test:integration)" npm run test:integration
run_tier "docker: end-to-end tier (test:e2e)" npm run test:e2e

# --- job: coverage ---------------------------------------------------------
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
# >>> ci-tier summary (generated) >>>
echo "ci:full: tier class ${CI_TIER:-full}"
if [ -n "${DEFERRED:-}" ]; then
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
# <<< ci-tier summary <<<
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
# >>> ci-tier verdict (generated) >>>
if [ "${CI_TIER:-full}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs)"
fi
# <<< ci-tier verdict <<<
