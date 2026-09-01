# ADR 0001 — Upstream docs version is the release identity for tags and Releases

- **Status:** Accepted (operator, 2026-09-01)
- **Date:** 2026-09-01
- **Deciders:** operator + agent
- **Context source:** session 2026-09-01 — operator request to tag releases so downstream consumers can watch for API updates

## Context

Downstream consumers need a signal that the published API spec changed and a name for the version it represents. The generated artifacts carry no version: `apidoc.js` has no version string (`pve_version_hint` is `null` for both products). Two candidate sources were examined. The pve-docs clone HEAD's `debian/changelog` is *not* the live version — the live site lags the repo (680 endpoints at HEAD vs 678 live on 2026-09-01). The docs sites themselves print the built package version ("Version 9.2.4 Last updated Tue Aug 4" on pve.proxmox.com/pve-docs/, "Version 4.2.5 -- 05 August 2026" on pbs.proxmox.com/docs/), and for PVE the live schema stable-hashes to exactly one pve-docs `apidata.js` commit (`4e7ff22c70`, 2026-08-04), whose changelog mapping agrees with the site string. GitHub's "Watch → Releases" notifies only on Release objects, not on tags.

## Decision

The upstream **docs package version** is the release identity. Tags are namespaced per product: `pve/<version>` and `pbs/<version>` (e.g. `pve/9.2.4`, `pbs/4.2.5`). The version is read from the product's docs site at generation time and recorded in the artifact meta as `docs_version`; for PVE it is cross-checked by stable-hash match of the live schema against pve-docs `apidata.js` commits, and a mismatch between the two sources fails the run rather than guessing. A tag is created only when the artifact content changed; if content changes under an unchanged version string the tag gets a `-r2`, `-r3` suffix (`-rN`, because pre-7.0 docs versions such as `6.2-1` carry a debian revision of their own). Content identity is the endpoint list, not file bytes, so a rehydrated snapshot and a live fetch of the same schema share one tag. CI maintains the invariant that the tag covering the current artifact content has a GitHub Release (spec files as assets; the `diff-pveapi.js` summary as notes when the run produced one, a summary line otherwise). Historical backfill tags (ADR 0002) get no Release objects unless and until they are the live version — which is how `pve/9.2.4` got its Release on 2026-09-01.

## Rejected alternatives

- **pve-docs clone HEAD changelog version** — rejected: the live site is built from a released package and lags HEAD, so HEAD's version would over-claim (would have tagged 9.2.6 for a 9.2.4 schema).
- **Repo-own semver** (`v1.0.0`, bumped by CI) — rejected: the version consumers care about is Proxmox's, and a synthetic number would need a mapping table back to it.
- **Date-based tags** (`pve/2026-09-01`) — rejected as primary: not meaningful to consumers matching against an installed PVE; retained only as the fallback if a site version string cannot be read.
- **Tags only, no Releases** — rejected: GitHub's watch notifications require Release objects; tags alone force consumers to poll.
- **Releases for the historical backfill too** — rejected: 63 Release entries nobody was watching clutter the Releases page; tags suffice for history.

## Consequences

- The update scripts gain a version-resolution step (site scrape + PVE hash cross-check) and `docs_version` in meta; the parser's unused `pve_version_hint` is removed.
- The CI workflow gains a tag-and-release step after the artifact commit; `contents: write` already covers tags and Releases.
- A docs-site markup change breaks version resolution loudly (run fails) rather than silently tagging wrong; the fallback is operator-attended.
- PBS versions start at the current release; there is no PBS history to backfill (proxmox-backup does not commit its api-viewer data).
