# ADR 0002 — Rewrite main once with per-version historical snapshots

- **Status:** Accepted (operator, 2026-09-01)
- **Date:** 2026-09-01
- **Deciders:** operator + agent
- **Context source:** session 2026-09-01 — operator request to rehydrate commit history; see ADR 0001 for the tag scheme

## Context

The repo was published on 2026-08-31 with only current artifacts; its history starts at the tooling. The endpoint-history walk already visits every `api-viewer/apidata.js` commit in pve-docs (98 commits, 70 distinct docs versions, 4.2-2 → 9.2.6), so the spec as it stood at each past release is reproducible with the existing parser (`--input`). Consumers pinning a tag (ADR 0001) expect the spec files at their usual paths in that tag's tree. The repo is one day old with no known consumers, so a history rewrite costs nothing now and would break every clone later.

## Decision

Rewrite `main` exactly once: an orphan chain of **snapshot commits, one per pve-docs version at or below the live version** (69 on 2026-09-01: 4.2-2 → 9.2.4), each dated with the upstream commit's author date and containing only `pve/pve-api.json` and `pve/openapi/pve-openapi.json` as generated from the last `apidata.js` state within that version; then the existing tooling and CI commits rebased on top so the modern tree continues unchanged. Each snapshot is tagged `pve/<version>`. Snapshot enrichment uses the endpoint history cut off at the snapshot date (`--as-of`) so `version_changes` contain no future events, and the current curated format registry (an accepted approximation — validation rules are applied as known today). Per-major specs, `CHANGELOG.md`, the registry, and `pbs/` first appear in the modern commits. The rewrite is gated on a size measurement before the force-push; after it, `main` is never rewritten again.

## Rejected alternatives

- **Separate `history` branch, main untouched** — rejected: tags would point off-main and every future CI snapshot would have to land on two branches or the timeline forks.
- **Per-apidata-commit snapshots (98)** — rejected: several commits share one docs version, so tags need suffixes for no consumer benefit, and ~50% more history.
- **Full modern layout at every snapshot** (per-major specs, changelog-as-of, registry) — rejected: per-major specs at a 2017 snapshot are synthetic, and the tree would be ~4× larger.
- **Leave history as-is, tag forward only** — rejected: the operator wants consumers to be able to read from the repo what each past version introduced, and the data to do it is already walked daily.
- **Historical format registry** (re-extract validation rules per snapshot) — deferred, not rejected: the registry is hand-curated and not regenerable; a per-snapshot registry would be a separate project.

## Consequences

- One force-push of `main`, announced; the pre-rewrite history is kept on a local backup ref until the rewrite is verified.
- `parse-pveapi.js` gains `--as-of <date>` history filtering; a `rehydrate-pveapi.sh` script drives the 63-snapshot build and is kept in `tools/` so the procedure is reproducible, but it is a one-time operation and must never run in CI.
- Rewriting `main` again is forbidden after this; corrections to a historical snapshot are new commits, not amendments.
- Snapshot trees lack `format-registry.json`, so `update-pveapi.sh`'s fail-fast gate does not apply to them — the rehydration script generates with the registry from the working tree explicitly.
