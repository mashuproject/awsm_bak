#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
compose_file="$repository_root/compose.coordination-e2e.yml"

cleanup() {
  docker compose -f "$compose_file" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM
cleanup
docker compose -f "$compose_file" up --build coordination-e2e-prepare
docker compose -f "$compose_file" up --build --detach --wait \
  coordination-e2e coordination-e2e-peer

AWSM_COORDINATION_E2E_BASE_URL="http://127.0.0.1:${AWSM_COORDINATION_E2E_PRIMARY_PORT:-3310}" \
AWSM_COORDINATION_E2E_CABLE_URL="ws://127.0.0.1:${AWSM_COORDINATION_E2E_PEER_PORT:-3311}/cable" \
AWSM_COORDINATION_E2E_COMPOSE_FILE="$compose_file" \
  node "$repository_root/apps/coordination-server/script/coordination-e2e.mjs"
