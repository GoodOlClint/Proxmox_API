# Proxmox API Specs

Machine-readable specifications for the [Proxmox VE](https://www.proxmox.com/en/proxmox-virtual-environment) and [Proxmox Backup Server](https://www.proxmox.com/en/proxmox-backup-server) REST APIs, enriched with data no other spec project carries: per-endpoint version history (which PVE release introduced or changed each endpoint and parameter) and a validation-rule registry for all 124 custom PVE format types, extracted from the Perl source of 11 Proxmox repositories.

## Artifacts

| File | What it is |
|---|---|
| [pve/openapi/pve-openapi.json](pve/openapi/pve-openapi.json) | OpenAPI 3.0.3 spec for the current PVE API |
| [pve/openapi/pve-openapi.pve{4-9}.json](pve/openapi/) | Per-major-version specs — only endpoints that exist in that PVE release |
| [pve/pve-api.json](pve/pve-api.json) | Flat endpoint list with version history, permissions, and format annotations |
| [pve/format-registry.json](pve/format-registry.json) | Validation rules (regex/enum/property-string) for every custom PVE format type, with version history |
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

The PVE script fetches the live `apidoc.js` from pve.proxmox.com, clones the pve-docs repo to rebuild per-endpoint version history from its full commit log, and regenerates everything under `pve/`. The PBS script fetches `apidoc.js` from pbs.proxmox.com (same format, so the same parser handles both). A [scheduled GitHub Actions workflow](.github/workflows/update-pveapi.yml) does both daily and commits when upstream changed.

Split per-area endpoint files (for loading a single functional area) are not committed but can be generated locally with `node tools/proxmox-api-parser/parse-pveapi.js --split`.

## Roadmap

- PBS version history and format registry (PBS is Rust; the Perl-extraction pipeline doesn't apply)
- Proxmox Datacenter Manager, once its API stabilizes

## License and provenance

This repository is licensed [AGPL-3.0-or-later](LICENSE).

The specs are mechanically derived from Proxmox VE's published API metadata (`apidoc.js` from [pve-docs](https://github.com/proxmox/pve-docs)) and the Perl source of Proxmox VE, both © Proxmox Server Solutions GmbH and licensed AGPL-3.0-or-later. Endpoint descriptions, enum values, and defaults embedded in the generated files originate from that source.

"Proxmox" is a registered trademark of Proxmox Server Solutions GmbH. This project is not affiliated with or endorsed by Proxmox Server Solutions GmbH.
