#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
compose_file="$repository_root/compose.sync-proof.yml"

cleanup() {
  docker compose -f "$compose_file" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM
cleanup
docker compose -f "$compose_file" up --build coordination-proof-prepare
docker compose -f "$compose_file" up --build --no-deps \
  --abort-on-container-exit --exit-code-from replica-proof \
  coordination-proof coordination-proof-peer replica-proof
