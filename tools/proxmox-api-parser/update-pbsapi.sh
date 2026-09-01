#!/usr/bin/env bash
# update-pbsapi.sh — Regenerate the published PBS artifacts under pbs/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PBS_DIR="$REPO_ROOT/pbs"
SOURCE_URL="https://pbs.proxmox.com/docs/api-viewer/apidoc.js"
APIDOC="$SCRIPT_DIR/pbs-apidoc.js"

mkdir -p "$PBS_DIR/openapi"

echo "[update-pbsapi] Fetching $SOURCE_URL..."
curl -fsSL "$SOURCE_URL" -o "$APIDOC"

# --history points at a file that doesn't exist yet: PBS version history is a
# roadmap item; when built, it lands at that path and enrichment turns on
echo "[update-pbsapi] Resolving upstream version..."
DOCS_VERSION=$(node "$SCRIPT_DIR/resolve-version-pveapi.js" --product pbs)

echo "[update-pbsapi] Running parser (docs $DOCS_VERSION)..."
node "$SCRIPT_DIR/parse-pveapi.js" \
  --input "$APIDOC" \
  --docs-version "$DOCS_VERSION" \
  --source-url "$SOURCE_URL" \
  --history "$SCRIPT_DIR/pbs-endpoint-history.json" \
  --output "$PBS_DIR/pbs-api.json"

echo "[update-pbsapi] Generating OpenAPI spec..."
node "$SCRIPT_DIR/openapi-pveapi.js" --compact --product pbs \
  --api "$PBS_DIR/pbs-api.json" \
  --output "$PBS_DIR/openapi/pbs-openapi.json"

SHA256=$(shasum -a 256 "$PBS_DIR/pbs-api.json" | awk '{print $1}')
COUNT=$(node -e "console.log(require('$PBS_DIR/pbs-api.json').meta.total_endpoints)")

echo "[update-pbsapi] SHA256:    $SHA256"
echo "[update-pbsapi] Version:   $DOCS_VERSION"
echo "[update-pbsapi] Endpoints: $COUNT"
echo "[update-pbsapi] Done."
