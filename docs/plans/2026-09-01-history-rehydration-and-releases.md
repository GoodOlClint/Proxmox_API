# Change plan: history rehydration and release tagging

Status: Implemented 2026-09-01 (main rewritten, 69 tags pushed); awaiting first CI run for step 5/6 validation. Decisions: [ADR 0001](../decisions/0001-upstream-docs-version-is-the-release-identity-for-tags-and-releases.md), [ADR 0002](../decisions/0002-rewrite-main-once-with-per-version-historical-snapshots.md).

## Scope

1. Version resolution: read the docs package version from each product's docs site; for PVE cross-check it by stable-hash match of the live schema against pve-docs `apidata.js` commits. Record as `meta.docs_version`; drop the always-null `pve_version_hint`.
2. Rehydration: one-time rewrite of `main` as 69 historically-dated snapshot commits (`pve/pve-api.json` + `pve/openapi/pve-openapi.json`), tagged `pve/<version>`, with today's tooling and CI commits rebased on top.
3. CI tagging: after an artifact commit, tag `pve/<version>` / `pbs/<version>` when that product's artifact changed, and create a GitHub Release with the diff summary as notes and the spec files as assets.

Out of scope: PBS history (not walkable), a per-snapshot format registry, slimming `version_changes` payloads (noted below as follow-up).

## Measured facts

- Live PVE schema == pve-docs commit `4e7ff22c70` (2026-08-04) by stable hash; site says "Version 9.2.4" — sources agree. PBS site says "Version 4.2.5".
- A snapshot without history enrichment is ~3.1MB (api 1.3MB + spec 1.8MB); three consecutive snapshots grew the packed repo by ~8KB each. The modern artifacts are 3.8MB (api) and 4.3MB (spec) since the walker fix in `f6a371a` — the earlier 25MB versions were ~85% phantom `version_changes` payloads. The pre-force-push gate re-measures the full chain and requires < 100MB packed. **Measured 2026-09-01: 69 snapshots pack to 1.3MB.** (69, not 63: pve-docs versions before 7.0 carry a debian revision — `6.2-1`, `6.2-2` — and each was a distinct release; the earlier count stripped it. Versions above the live 9.2.4 — `9.2.5`, `9.2.6` — are left for CI to tag when the site publishes them.)

## Sequencing (each step a small commit; force-push only at step 5)

| # | Step | Definition of done (fails before / passes after) |
|---|---|---|
| 1 | `parse-pveapi.js --as-of <date>`: ignore history events dated after the cutoff. | Snapshot parsed with `--as-of 2020-01-01` has no `version_changes` entry dated 2020+ (grep proves 0; without the flag, >0). |
| 2 | `resolve-version-pveapi.js`: scrape site version; for PVE match live schema hash to a pve-docs commit and assert the changelog version agrees; print `docs_version`. Wire into both update scripts → `meta.docs_version`. | Run prints `9.2.4` / `4.2.5` today; artifacts remain deterministic across two runs; a deliberately wrong hash makes the run exit non-zero. |
| 3 | `rehydrate-pveapi.js` (tools/, never in CI): for each of the 69 versions, take the last `apidata.js` commit, generate api + spec with `--as-of`, commit on an orphan branch with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` = upstream commit date, tag `pve/<version>`. Dry-run to a scratch branch. | Scratch branch has 69 commits, dates monotonic, 69 tags, `git cat-file -s` sizes plausible, spot-check: `pve/6.2` tag's spec has the endpoint count the changelog reports for 6.2 (2 known: `DELETE /cluster/sdn/controllers/{controller}` present at 6.2, absent at 6.1). |
| 4 | Size gate: packed size of the scratch chain < 100MB. | Measured 1.3MB (2026-09-01). |
| 5 | Rewrite: rebase the existing modern commits onto the snapshot chain; keep the old `main` as `backup-pre-rehydration`; force-push `main` + tags. | `git log --oneline` = 69 snapshots then the modern commits; `origin/main` tree identical to pre-rewrite tree (`git diff backup-pre-rehydration origin/main` empty); CI run on the rewritten main is green with no artifact diff. |
| 6 | CI tag + Release step: after commit, per product whose `*-api.json` changed: tag (`-rN` suffix if the version already has different content; endpoint-level comparison), `gh release create` with the diff summary as notes and the spec files attached. | Simulated on a throwaway branch: a forced artifact change yields one tag and one Release with assets; a no-change run yields neither. |
| 7 | README: tags/Releases section for consumers; ADR status → Accepted. | Docs match behavior. |

## Rollout and rollback

Steps 1–2 and 6–7 are ordinary commits. Step 5 is the only destructive action: announced, performed once, `backup-pre-rehydration` retained locally and pushed as a branch for 30 days. Rollback within that window is `git push --force origin backup-pre-rehydration:main`; after it, corrections are new commits (ADR 0002).

## Follow-up (not this change)

`version_changes` entries still embed full old/new parameter schemas for genuine changes; storing only the differing fields would trim the artifacts further. Low priority now that the phantom events are gone.
