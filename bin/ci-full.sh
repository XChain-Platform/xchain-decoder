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
run_tier() {
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
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
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

need_sib xchain-encoder xchain-documentation xchain-hub xchain-indexer xchain-utxo-tracker

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
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
