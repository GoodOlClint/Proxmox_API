# Proxmox API Specs

Machine-readable specifications for the [Proxmox VE](https://www.proxmox.com/en/proxmox-virtual-environment) and [Proxmox Backup Server](https://www.proxmox.com/en/proxmox-backup-server) REST APIs, enriched with data no other spec project carries: per-endpoint version history (which PVE release introduced or changed each endpoint and parameter) and a validation-rule registry for all 124 custom PVE format types, extracted from the Perl source of 11 Proxmox repositories.

## Artifacts

| File | What it is |
|---|---|
| [pve/openapi/pve-openapi.json](pve/openapi/pve-openapi.json) | OpenAPI 3.0.3 spec for the current PVE API |
| [pve/openapi/pve-openapi.pve{4-9}.json](pve/openapi/) | Per-major-version specs — only endpoints that exist in that PVE release |
| [pve/pve-api.json](pve/pve-api.json) | Flat endpoint list with version history, permissions, and format annotations |
| [pve/format-registry.json](pve/format-registry.json) | Validation rules (regex/enum/property-string) for every custom PVE format type, with version history |
| [pve/CHANGELOG.md](pve/CHANGELOG.md) | Per-release changelog: endpoints introduced and parameters changed in each PVE version |
| [pbs/openapi/pbs-openapi.json](pbs/openapi/pbs-openapi.json) | OpenAPI 3.0.3 spec for the current PBS API |
| [pbs/pbs-api.json](pbs/pbs-api.json) | Flat PBS endpoint list with permissions |

The OpenAPI specs work with any OpenAPI 3.0 tooling: Swagger UI and Postman for browsing, AutoRest/NSwag/openapi-generator for client generation, Prism for a mock server (`prism mock pve/openapi/pve-openapi.json`).

Vendor extensions carry the enrichment: `x-since-version` (when the endpoint was introduced), `x-pve-format` (link to the format registry), `x-enum-values` (concrete valid values for list parameters, e.g. all 42 privilege names on `pve-priv-list`), `x-property-string` (sub-property schemas for encoded string parameters), and `x-permissions` (required privileges per endpoint).

## Version history fields

Each endpoint in `pve-api.json` carries:

| Field | Type | Description |
|---|---|---|
| `since_version` | `string` | PVE version that introduced the endpoint (e.g. `"4.2"`, `"8.1"`) |
| `since_pve_major` | `number` | PVE major version number |
| `since_date` | `string` | ISO date of the introducing commit |
| `version_changes` | `array?` | Parameter/return changes across versions: each entry has `version`, `date`, `commit`, `type` (`parameters_changed` or `returns_changed`), and `added_params`/`removed_params`/`changed_params` |
| `last_changed_version` / `last_changed_date` | `string?` | Most recent change |

## Regenerating

```bash
bash tools/proxmox-api-parser/update-pveapi.sh   # PVE → pve/
bash tools/proxmox-api-parser/update-pbsapi.sh   # PBS → pbs/
```

The PVE script fetches the live `apidoc.js` from pve.proxmox.com, clones the pve-docs repo to rebuild per-endpoint version history from its full commit log, and regenerates everything under `pve/`. The PBS script fetches `apidoc.js` from pbs.proxmox.com (same format, so the same parser handles both). A [scheduled GitHub Actions workflow](.github/workflows/update-proxmox-specs.yml) does both daily and commits when upstream changed.

## Releases and tags

Every upstream API version is a git tag: `pve/<version>` and `pbs/<version>`, where the version is the Proxmox docs package version shown on the product's documentation site (e.g. `pve/9.2.4`, `pbs/4.2.5`). Each artifact also records it as `meta.docs_version`. A tag's tree holds the spec as it stood at that version, at the same paths as `main`.

- **Watch for updates**: GitHub → Watch → Custom → Releases. The current version of each product always has a GitHub Release with the spec files attached as assets; from 2026-09 onward each new version gets one, with the endpoint diff as release notes.
- **Pin a version**: `git checkout pve/8.3.0`, or fetch `https://raw.githubusercontent.com/GoodOlClint/Proxmox_API/pve/8.3.0/pve/openapi/pve-openapi.json`.
- **History**: PVE tags go back to `pve/4.2` (2016), rebuilt from the pve-docs commit history; those historical tags have no Release objects. PBS tags start at `pbs/4.2.5`.
- If upstream changes the API without changing the version string, the tag gets a revision suffix (`pve/9.2.4-r2`). Historical PVE versions before 7.0 keep their original debian-style numbering (`pve/6.2-1`).

## Seeing what changed

- **Between PVE releases**: [pve/CHANGELOG.md](pve/CHANGELOG.md) lists, for every PVE version back to 4.2, which endpoints were introduced and which parameters were added, removed, or changed. It is rendered from the pve-docs commit walk, so it updates automatically.
- **Between regenerations**: the artifacts are compact JSON, so file diffs are unreadable. Instead, each CI commit's message carries the `diff-pveapi.js` summary — endpoints added, removed, and changed for PVE and PBS since the previous commit. `git log` on `pve/` or `pbs/` shows the history of API changes. Artifacts are deterministic (no timestamps), so a run with no upstream change produces no commit.
- **Locally, any two versions**: `node tools/proxmox-api-parser/diff-pveapi.js --old <a>.json --new <b>.json` works on any two `pve-api.json`/`pbs-api.json` files, e.g. from `git show <rev>:pve/pve-api.json`.

Split per-area endpoint files (for loading a single functional area) are not committed but can be generated locally with `node tools/proxmox-api-parser/parse-pveapi.js --split`.

## Roadmap

- PBS version history and format registry (PBS is Rust; the Perl-extraction pipeline doesn't apply)
- Proxmox Datacenter Manager, once its API stabilizes

## Decisions

Architectural decisions are recorded in [docs/decisions/](docs/decisions/); change plans in [docs/plans/](docs/plans/).

## License and provenance

This repository is licensed [AGPL-3.0-or-later](LICENSE).

The specs are mechanically derived from Proxmox VE's published API metadata (`apidoc.js` from [pve-docs](https://github.com/proxmox/pve-docs)) and the Perl source of Proxmox VE, both © Proxmox Server Solutions GmbH and licensed AGPL-3.0-or-later. Endpoint descriptions, enum values, and defaults embedded in the generated files originate from that source.

"Proxmox" is a registered trademark of Proxmox Server Solutions GmbH. This project is not affiliated with or endorsed by Proxmox Server Solutions GmbH.
