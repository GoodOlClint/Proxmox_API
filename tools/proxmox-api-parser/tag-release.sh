#!/usr/bin/env bash
# tag-release.sh — Tag and publish a GitHub Release for each product whose artifact
# changed in HEAD (ADR 0001). Run by CI after the artifact commit is pushed.
#
# Invariant: the tag that covers HEAD's content has a GitHub Release. Runs on every
# CI run, not only when an artifact changed, so a version whose tag came from the
# history backfill gets its Release the first time it is the live version.
#
# Optional inputs (per product p in pve pbs), written by the workflow's commit step:
#   $NOTES_DIR/$p-notes.md  release notes (diff summary); a summary line is used otherwise
# Tags: <p>/<docs_version>; if that tag exists with different content, <p>/<docs_version>-rN.
set -euo pipefail

NOTES_DIR="${NOTES_DIR:?set NOTES_DIR}"
DRY_RUN="${DRY_RUN:-0}"

# Content identity is the endpoint list, not the file bytes: meta carries
# source_url/source_sha256, which differ between a rehydrated snapshot
# (apidata.js) and a live fetch (apidoc.js) of the same schema.
same_endpoints() {
  node -e '
    const { execSync } = require("child_process");
    const [tag, file] = process.argv.slice(1);
    const tagged = JSON.parse(execSync(`git show ${tag}:${file}`, { maxBuffer: 1 << 30 })).endpoints;
    const head = JSON.parse(require("fs").readFileSync(file, "utf8")).endpoints;
    process.exit(JSON.stringify(tagged) === JSON.stringify(head) ? 0 : 1);
  ' "$1" "$2"
}

for p in pve pbs; do
  f="$p/$p-api.json"
  [ -f "$f" ] || continue
  ver=$(node -e "console.log(require('./$f').meta.docs_version || '')")
  if [ -z "$ver" ]; then
    echo "[tag-release] $p: no docs_version in $f, not tagging" >&2
    continue
  fi
  # walk <p>/<ver>, <p>/<ver>-r2, ... : reuse none if one already holds this content
  # (-rN, not -N: old-scheme docs versions like 6.2-1 carry a debian revision)
  base="$p/$ver"; tag="$base"; n=1; covered=0
  while git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do
    if same_endpoints "$tag" "$f"; then
      echo "[tag-release] $tag already covers this content"; covered=1; break
    fi
    n=$((n+1)); tag="$base-r$n"
  done
  if [ "$covered" != 1 ]; then
    echo "[tag-release] tagging $tag"
    git tag -a -m "$tag" "$tag"
    [ "$DRY_RUN" = 1 ] || git push origin "$tag"
  fi
  [ "$DRY_RUN" = 1 ] && continue
  if gh release view "$tag" >/dev/null 2>&1; then continue; fi
  notes="$NOTES_DIR/$p-notes.md"
  if [ ! -f "$notes" ]; then
    count=$(node -e "console.log(require('./$f').meta.total_endpoints)")
    printf '%s API %s — %s endpoints. Per-release changes: see pve/CHANGELOG.md for PVE; the commit history of %s for regeneration diffs.\n' "$(echo "$p" | tr a-z A-Z)" "$ver" "$count" "$p/" > "$notes"
  fi
  echo "[tag-release] release $tag"
  gh release create "$tag" --title "$tag" --notes-file "$notes" "$f" "$p"/openapi/*.json
done
