#!/usr/bin/env bash
# update-pveapi.sh — Regenerate the published artifacts under pve/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PVE_DIR="$REPO_ROOT/pve"
mkdir -p "$PVE_DIR/openapi"

# The registry is hand-curated and NOT regenerable; without it the OpenAPI
# step only warns and silently emits specs missing all format validation
if [ ! -f "$PVE_DIR/format-registry.json" ]; then
  echo "[update-pveapi] FATAL: $PVE_DIR/format-registry.json is missing (curated file, must be committed)" >&2
  exit 1
fi

# Build version history (clones pve-docs repo if needed)
echo "[update-pveapi] Building version history..."
node "$SCRIPT_DIR/history-pveapi.js" --keep-repo

echo "[update-pveapi] Running parser..."
node "$SCRIPT_DIR/parse-pveapi.js" --output "$PVE_DIR/pve-api.json"

echo "[update-pveapi] Building format version history..."
node "$SCRIPT_DIR/format-history-pveapi.js" --keep-repos

echo "[update-pveapi] Generating OpenAPI specs..."
node "$SCRIPT_DIR/openapi-pveapi.js" --compact \
  --api "$PVE_DIR/pve-api.json" \
  --formats "$PVE_DIR/format-registry.json" \
  --output "$PVE_DIR/openapi/pve-openapi.json"
node "$SCRIPT_DIR/openapi-pveapi.js" --compact --all-versions \
  --api "$PVE_DIR/pve-api.json" \
  --formats "$PVE_DIR/format-registry.json" \
  --output "$PVE_DIR/openapi/pve-openapi.json"

# Print stats
SHA256=$(shasum -a 256 "$PVE_DIR/pve-api.json" | awk '{print $1}')
COUNT=$(node -e "console.log(require('$PVE_DIR/pve-api.json').meta.total_endpoints)")
FORMATS=$(node -e "console.log(Object.keys(require('$PVE_DIR/format-registry.json').formats).length)")

echo "[update-pveapi] SHA256:    $SHA256"
echo "[update-pveapi] Endpoints: $COUNT"
echo "[update-pveapi] Formats:   $FORMATS"
echo "[update-pveapi] Done."
