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
# Run the integration tier against a throwaway containerised venue.
#
# Brings up test/integration/fixtures/docker-compose.test.yml (a regtest bitcoind
# and a MariaDB, both on tmpfs), runs mocha against it, then tears the venue down
# whatever the outcome. Nothing on the host is created, mined on, or deleted.
#
# The venue is recreated per run, so every run starts from an empty chain at
# height 0 and an empty database. Set KEEP_VENUE=1 to leave the containers up
# afterwards when you want to inspect a failure.
#
set -u

cd "$(dirname "$0")/.." || exit 1

COMPOSE_FILE="test/integration/fixtures/docker-compose.test.yml"
KEEP_VENUE="${KEEP_VENUE:-0}"

teardown() {
  if [ "$KEEP_VENUE" = "1" ]; then
    echo "[integration] KEEP_VENUE=1, leaving the venue up ($COMPOSE_FILE)"
    return
  fi
  echo "[integration] Tearing down the venue"
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1
}
trap teardown EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "[integration] docker is required: this tier runs against a containerised regtest node." >&2
  exit 1
fi

# Start from a clean slate even if a previous run was killed before its teardown.
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1

echo "[integration] Bringing up the venue"
if ! docker compose -f "$COMPOSE_FILE" up -d --wait; then
  echo "[integration] Venue failed to become healthy" >&2
  docker compose -f "$COMPOSE_FILE" ps
  exit 1
fi

node ./node_modules/.bin/mocha --timeout 0 --exit \
  --require ./test/integration/setup.js 'test/integration/**/*.test.js'
status=$?

exit $status
