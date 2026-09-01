#!/usr/bin/env node
/**
 * diff-pveapi.js — Compare two pve-api.json files and report differences.
 *
 * Usage:
 *   node diff-pveapi.js --old old/pve-api.json --new new/pve-api.json [--output <path>]
 *
 * Outputs a summary to stdout and writes the full diff JSON to --output
 * (default: pve-api-diff.json alongside --new).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

const oldPath = getArg('--old');
const newPath = getArg('--new');
const outArg = getArg('--output');

if (!oldPath || !newPath) {
  console.error('Usage: node diff-pveapi.js --old <path> --new <path>');
  process.exit(1);
}

// ─── Load files ─────────────────────────────────────────────────────────────

const oldData = JSON.parse(fs.readFileSync(path.resolve(oldPath), 'utf8'));
const newData = JSON.parse(fs.readFileSync(path.resolve(newPath), 'utf8'));

// ─── Build endpoint maps keyed by "METHOD /path" ────────────────────────────

function buildMap(data) {
  const map = new Map();
  for (const ep of data.endpoints) {
    map.set(`${ep.method} ${ep.path}`, ep);
  }
  return map;
}

const oldMap = buildMap(oldData);
const newMap = buildMap(newData);

// ─── Compute diffs ─────────────────────────────────────────────────────────

const added = [];
const removed = [];
const changed = [];

for (const [key, ep] of newMap) {
  if (!oldMap.has(key)) {
    added.push({ method: ep.method, path: ep.path, functional_area: ep.functional_area });
  }
}

for (const [key, ep] of oldMap) {
  if (!newMap.has(key)) {
    removed.push({ method: ep.method, path: ep.path, functional_area: ep.functional_area });
  }
}

// Deep-compare endpoints that exist in both
function endpointDiff(oldEp, newEp) {
  const diffs = [];

  if (oldEp.description !== newEp.description) {
    diffs.push({ field: 'description', old: oldEp.description, new: newEp.description });
  }
  if (oldEp.deprecated !== newEp.deprecated) {
    diffs.push({ field: 'deprecated', old: oldEp.deprecated, new: newEp.deprecated });
  }
  if (oldEp.protected !== newEp.protected) {
    diffs.push({ field: 'protected', old: oldEp.protected, new: newEp.protected });
  }

  // Compare parameter counts
  for (const paramType of ['path_params', 'query_params', 'body_params']) {
    const oldNames = (oldEp.parameters[paramType] || []).map((p) => p.name).sort();
    const newNames = (newEp.parameters[paramType] || []).map((p) => p.name).sort();
    if (JSON.stringify(oldNames) !== JSON.stringify(newNames)) {
      diffs.push({ field: `parameters.${paramType}`, old: oldNames, new: newNames });
    }
  }

  // Compare returns type
  if (JSON.stringify(oldEp.returns) !== JSON.stringify(newEp.returns)) {
    diffs.push({ field: 'returns', old: oldEp.returns.type, new: newEp.returns.type });
  }

  return diffs.length > 0 ? diffs : null;
}

for (const [key, newEp] of newMap) {
  if (oldMap.has(key)) {
    const diffs = endpointDiff(oldMap.get(key), newEp);
    if (diffs) {
      changed.push({
        method: newEp.method,
        path: newEp.path,
        functional_area: newEp.functional_area,
        changes: diffs,
      });
    }
  }
}

// ─── Area summary ───────────────────────────────────────────────────────────

function areaCounts(data) {
  const counts = {};
  for (const ep of data.endpoints) {
    counts[ep.functional_area] = (counts[ep.functional_area] || 0) + 1;
  }
  return counts;
}

const oldAreas = areaCounts(oldData);
const newAreas = areaCounts(newData);
const allAreas = new Set([...Object.keys(oldAreas), ...Object.keys(newAreas)]);
const areaDelta = {};
for (const area of allAreas) {
  const oldCount = oldAreas[area] || 0;
  const newCount = newAreas[area] || 0;
  if (oldCount !== newCount) {
    areaDelta[area] = { old: oldCount, new: newCount, delta: newCount - oldCount };
  }
}

// ─── Output ─────────────────────────────────────────────────────────────────

const diffResult = {
  meta: {
    old_file: oldPath,
    new_file: newPath,
    old_sha256: oldData.meta.source_sha256,
    new_sha256: newData.meta.source_sha256,
    old_total: oldData.endpoints.length,
    new_total: newData.endpoints.length,
    compared_at: new Date().toISOString(),
  },
  summary: {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    area_deltas: areaDelta,
  },
  added: added,
  removed: removed,
  changed: changed,
};

// Write diff file alongside --new
const diffOutputPath = outArg ? path.resolve(outArg) : path.join(path.dirname(path.resolve(newPath)), 'pve-api-diff.json');
fs.writeFileSync(diffOutputPath, JSON.stringify(diffResult, null, 2), 'utf8');

// Print summary
console.log(`PVE API Diff: ${oldPath} → ${newPath}`);
console.log(`  Old: ${oldData.endpoints.length} endpoints (SHA: ${oldData.meta.source_sha256.substring(0, 12)}...)`);
console.log(`  New: ${newData.endpoints.length} endpoints (SHA: ${newData.meta.source_sha256.substring(0, 12)}...)`);
console.log(`  Added:   ${added.length}`);
console.log(`  Removed: ${removed.length}`);
console.log(`  Changed: ${changed.length}`);

if (Object.keys(areaDelta).length > 0) {
  console.log(`  Area deltas:`);
  for (const [area, delta] of Object.entries(areaDelta)) {
    const sign = delta.delta > 0 ? '+' : '';
    console.log(`    ${area}: ${delta.old} → ${delta.new} (${sign}${delta.delta})`);
  }
}

if (added.length > 0) {
  console.log(`\n  New endpoints:`);
  added.forEach((e) => console.log(`    + ${e.method} ${e.path} [${e.functional_area}]`));
}

if (removed.length > 0) {
  console.log(`\n  Removed endpoints:`);
  removed.forEach((e) => console.log(`    - ${e.method} ${e.path} [${e.functional_area}]`));
}

console.log(`\nDiff written to: ${diffOutputPath}`);
