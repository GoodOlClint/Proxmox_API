#!/usr/bin/env node
/**
 * history-pveapi.js — Build version history for every PVE API endpoint.
 *
 * Clones the proxmox/pve-docs repo, walks every commit to api-viewer/apidata.js,
 * parses each snapshot, and diffs consecutive versions to determine:
 *   - When each endpoint was first introduced
 *   - When parameters were added/removed/changed for each endpoint
 *   - When return types changed for each endpoint
 *
 * Output: endpoint-history.json
 *
 * Usage:
 *   node history-pveapi.js [--repo <path>] [--output <path>] [--keep-repo]
 *
 * Options:
 *   --repo <path>      Path to an existing pve-docs clone (skips cloning)
 *   --output <path>    Output file (default: tools/pve-api-parser/endpoint-history.json)
 *   --keep-repo        Don't delete the cloned repo when done
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const vm = require('vm');

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}
function hasFlag(name) {
  return args.includes(name);
}

const repoArg = getArg('--repo');
const outputPath = getArg('--output') || path.join(__dirname, 'endpoint-history.json');
const keepRepo = hasFlag('--keep-repo');

const REPO_URL = 'https://github.com/proxmox/pve-docs.git';
const APIDATA_PATH = 'api-viewer/apidata.js';

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[history-pveapi] ${msg}\n`);
}

// ─── Parse debian/changelog ─────────────────────────────────────────────────

function parseChangelog(changelogText) {
  const entries = [];
  const lines = changelogText.split('\n');
  let currentVersion = null;
  let currentSuite = null;

  for (const line of lines) {
    const headerMatch = line.match(/^pve-docs\s+\(([^)]+)\)\s+(\S+);/);
    if (headerMatch) {
      currentVersion = headerMatch[1];
      currentSuite = headerMatch[2];
      continue;
    }
    const dateMatch = line.match(/^\s+--\s+.+\s{2}(.+)$/);
    if (dateMatch && currentVersion) {
      const date = new Date(dateMatch[1].trim());
      entries.push({
        version: currentVersion,
        suite: currentSuite,
        date: date,
        dateISO: date.toISOString().slice(0, 10),
      });
      currentVersion = null;
      currentSuite = null;
    }
  }
  entries.sort((a, b) => b.date - a.date); // newest first
  return entries;
}

/**
 * Derive PVE major version. Newer releases use proper Debian suite names,
 * but PVE 4.x/5.x both used 'unstable' and PVE 6.x used 'pve'.
 * Fall back to the leading digit of the docs version number.
 */
function pveMajorFromEntry(suite, version) {
  const suiteMap = { trixie: 9, bookworm: 8, bullseye: 7 };
  if (suiteMap[suite]) return suiteMap[suite];
  // For 'unstable', 'pve', or unknown suites, use the version prefix
  const m = version.match(/^(\d+)\./);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Find the pve-docs release version that first contains a given commit date.
 * Returns the earliest changelog entry whose date >= commitDate.
 */
function findVersionForCommitDate(commitDate, changelogEntries) {
  let best = null;
  for (const entry of changelogEntries) {
    if (entry.date >= commitDate) {
      best = entry;
    } else {
      break;
    }
  }
  return best;
}

/**
 * Build a friendly PVE version label from a changelog entry.
 * pve-docs "8.2.0" on bookworm → "8.2", pve-docs "7.2-3" on bullseye → "7.2"
 */
function friendlyVersion(entry) {
  if (!entry || entry.version === 'unknown') return entry ? entry.version : 'unknown';
  const pveMajor = pveMajorFromEntry(entry.suite, entry.version);
  if (!pveMajor) return entry.version;
  const clean = entry.version.replace(/-\d+$/, '');
  const parts = clean.split('.');
  return parts.length >= 2 ? parts.slice(0, 2).join('.') : clean;
}

// ─── Extract the raw schema tree from apidata.js ────────────────────────────

function extractSchemaTree(source) {
  if (!source || source.trim().length === 0) return null;

  const pat = /(?:const|var|let)\s+(apiSchema|pveapi)\s*=\s*/;
  const match = source.match(pat);
  if (!match) return null;

  const varName = match[1];
  const startIdx = match.index + match[0].length;

  // Find matching bracket
  let depth = 0, inStr = false, esc = false, endIdx = -1;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === -1) return null;

  const jsonStr = source.substring(startIdx, endIdx);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    try {
      const sandbox = {};
      vm.runInNewContext(`var ${varName} = ${jsonStr};`, sandbox);
      return sandbox[varName];
    } catch (e2) {
      return null;
    }
  }
}

// ─── Extract detailed endpoint map from schema tree ─────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

/**
 * Walk the schema tree and build a Map of "METHOD /path" → endpoint detail object.
 * Each detail object contains: { params (sorted param names), returns_type, description }
 */
function extractEndpointMap(tree) {
  const map = new Map();

  function walk(node) {
    if (node.info) {
      const apiPath = node.path || '';
      for (const method of HTTP_METHODS) {
        const mi = node.info[method];
        if (!mi) continue;

        const key = `${method} ${apiPath}`;
        const paramNames = mi.parameters && mi.parameters.properties
          ? Object.keys(mi.parameters.properties).sort()
          : [];

        // Build a signature of parameter details for change detection
        const paramDetails = {};
        if (mi.parameters && mi.parameters.properties) {
          for (const [pName, pDef] of Object.entries(mi.parameters.properties)) {
            paramDetails[pName] = {
              type: pDef.type || null,
              optional: pDef.optional ? true : false,
              format: pDef.format || null,
              description: pDef.description || null,
            };
          }
        }

        // Returns signature
        const ret = mi.returns || {};
        const returnsSignature = {
          type: ret.type || null,
          properties: ret.properties ? Object.keys(ret.properties).sort() : null,
          items_type: ret.items ? (ret.items.type || 'object') : null,
        };

        map.set(key, {
          param_names: paramNames,
          param_details: paramDetails,
          returns: returnsSignature,
          description: mi.description || '',
        });
      }
    }
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }

  if (Array.isArray(tree)) {
    for (const root of tree) walk(root);
  } else if (typeof tree === 'object') {
    walk(tree);
  }

  return map;
}

// ─── Diff two endpoint maps ─────────────────────────────────────────────────

/**
 * Compare two endpoint maps and return { added, removed, paramChanges, returnChanges }
 */
function diffEndpointMaps(oldMap, newMap) {
  const added = [];
  const removed = [];
  const paramChanges = []; // { key, added_params, removed_params, changed_params }
  const returnChanges = []; // { key, old_returns, new_returns }

  // New endpoints
  for (const key of newMap.keys()) {
    if (!oldMap.has(key)) added.push(key);
  }

  // Removed endpoints
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) removed.push(key);
  }

  // Changed endpoints (exist in both)
  for (const [key, newDetail] of newMap) {
    if (!oldMap.has(key)) continue;
    const oldDetail = oldMap.get(key);

    // Parameter changes
    const oldParams = new Set(oldDetail.param_names);
    const newParams = new Set(newDetail.param_names);
    const addedParams = [...newParams].filter((p) => !oldParams.has(p));
    const removedParams = [...oldParams].filter((p) => !newParams.has(p));

    // Check for type/optional/format changes on existing params
    const changedParams = [];
    for (const pName of newDetail.param_names) {
      if (!oldDetail.param_details[pName]) continue; // new param, already captured
      const oldP = oldDetail.param_details[pName];
      const newP = newDetail.param_details[pName];
      if (oldP.type !== newP.type || oldP.optional !== newP.optional || oldP.format !== newP.format) {
        changedParams.push({
          name: pName,
          old: { type: oldP.type, optional: oldP.optional, format: oldP.format },
          new: { type: newP.type, optional: newP.optional, format: newP.format },
        });
      }
    }

    if (addedParams.length > 0 || removedParams.length > 0 || changedParams.length > 0) {
      paramChanges.push({ key, added_params: addedParams, removed_params: removedParams, changed_params: changedParams });
    }

    // Return type changes
    const oldRet = JSON.stringify(oldDetail.returns);
    const newRet = JSON.stringify(newDetail.returns);
    if (oldRet !== newRet) {
      returnChanges.push({ key, old_returns: oldDetail.returns, new_returns: newDetail.returns });
    }
  }

  return { added, removed, paramChanges, returnChanges };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const startTime = Date.now();

  // 1. Clone or use existing repo
  let repoPath = repoArg;
  let didClone = false;

  if (!repoPath) {
    repoPath = path.join(__dirname, '.pve-docs-clone');
    if (fs.existsSync(repoPath)) {
      log(`Using existing clone at ${repoPath}`);
      try { execSync('git pull --ff-only', { cwd: repoPath, stdio: 'pipe' }); } catch (e) {}
    } else {
      log(`Cloning ${REPO_URL} (this may take a minute)...`);
      execSync(`git clone --single-branch --no-tags "${REPO_URL}" "${repoPath}"`, {
        stdio: 'pipe',
        timeout: 180000,
      });
      didClone = true;
      log('Clone complete');
    }
  }

  // 2. Parse debian/changelog
  const changelogText = fs.readFileSync(path.join(repoPath, 'debian', 'changelog'), 'utf8');
  const changelogEntries = parseChangelog(changelogText);
  log(`Parsed ${changelogEntries.length} changelog entries (${changelogEntries[changelogEntries.length - 1].version} → ${changelogEntries[0].version})`);

  // 3. Get all commits to apidata.js, oldest first
  const commitLog = execSync(
    `git log --format="%H %aI" --follow --diff-filter=AM -- "${APIDATA_PATH}"`,
    { cwd: repoPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  ).trim();

  const commits = commitLog.split('\n').filter(Boolean).map((line) => {
    const [sha, dateStr] = line.split(' ');
    return { sha, date: new Date(dateStr), dateISO: dateStr.slice(0, 10) };
  }).reverse(); // oldest first

  log(`Found ${commits.length} commits to ${APIDATA_PATH}`);

  // 4. Walk each commit, extract full endpoint details, diff against previous
  // Track: when each endpoint was introduced, and all parameter/return changes
  const endpointIntroduced = {};   // "METHOD /path" → version info
  const endpointChangelog = {};    // "METHOD /path" → [ { version, date, changes } ]
  let previousMap = new Map();
  let processed = 0;
  let errors = 0;

  for (const commit of commits) {
    processed++;
    if (processed % 10 === 0 || processed === 1 || processed === commits.length) {
      log(`Processing commit ${processed}/${commits.length} (${commit.dateISO})...`);
    }

    let source;
    try {
      source = execSync(`git show ${commit.sha}:${APIDATA_PATH}`, {
        cwd: repoPath, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      });
    } catch (e) {
      errors++;
      continue;
    }

    let tree;
    try {
      tree = extractSchemaTree(source);
    } catch (e) {
      log(`  WARNING: Failed to extract tree at ${commit.sha.slice(0, 10)}: ${e.message}`);
      errors++;
      continue;
    }

    if (!tree) {
      log(`  WARNING: No schema tree at ${commit.sha.slice(0, 10)}, skipping`);
      errors++;
      continue;
    }

    let currentMap;
    try {
      currentMap = extractEndpointMap(tree);
    } catch (e) {
      log(`  WARNING: Failed to extract endpoints at ${commit.sha.slice(0, 10)}: ${e.message}`);
      errors++;
      continue;
    }

    if (currentMap.size === 0) {
      log(`  WARNING: No endpoints at ${commit.sha.slice(0, 10)}, skipping`);
      errors++;
      continue;
    }

    // Diff against previous
    const diff = diffEndpointMaps(previousMap, currentMap);
    const versionEntry = findVersionForCommitDate(commit.date, changelogEntries);
    const version = friendlyVersion(versionEntry);
    const docsVersion = versionEntry ? versionEntry.version : 'unknown';
    const pveMajor = versionEntry ? pveMajorFromEntry(versionEntry.suite, versionEntry.version) : null;
    const commitRef = commit.sha.slice(0, 10);

    // Record new endpoints
    for (const key of diff.added) {
      if (!endpointIntroduced[key]) {
        endpointIntroduced[key] = {
          since_version: version,
          since_docs_version: docsVersion,
          since_pve_major: pveMajor || null,
          since_date: commit.dateISO,
          since_commit: commitRef,
        };
      }
    }

    // Record parameter changes
    for (const change of diff.paramChanges) {
      if (!endpointChangelog[change.key]) endpointChangelog[change.key] = [];

      const entry = {
        version: version,
        docs_version: docsVersion,
        date: commit.dateISO,
        commit: commitRef,
        type: 'parameters_changed',
      };
      if (change.added_params.length > 0) entry.added_params = change.added_params;
      if (change.removed_params.length > 0) entry.removed_params = change.removed_params;
      if (change.changed_params.length > 0) entry.changed_params = change.changed_params;

      endpointChangelog[change.key].push(entry);
    }

    // Record return type changes
    for (const change of diff.returnChanges) {
      if (!endpointChangelog[change.key]) endpointChangelog[change.key] = [];

      endpointChangelog[change.key].push({
        version: version,
        docs_version: docsVersion,
        date: commit.dateISO,
        commit: commitRef,
        type: 'returns_changed',
        old_returns: change.old_returns,
        new_returns: change.new_returns,
      });
    }

    previousMap = currentMap;
  }

  log(`Processed ${processed} commits (${errors} errors/skips)`);
  log(`Tracked introduction for ${Object.keys(endpointIntroduced).length} endpoints`);
  log(`Tracked changes for ${Object.keys(endpointChangelog).length} endpoints`);

  // 5. Build summary stats
  const introVersionCounts = {};
  for (const entry of Object.values(endpointIntroduced)) {
    const v = entry.since_version;
    introVersionCounts[v] = (introVersionCounts[v] || 0) + 1;
  }

  const changeVersionCounts = {};
  for (const changes of Object.values(endpointChangelog)) {
    for (const c of changes) {
      changeVersionCounts[c.version] = (changeVersionCounts[c.version] || 0) + 1;
    }
  }

  const sortVersionEntries = (entries) => {
    return entries.sort((a, b) => {
      const parseV = (v) => {
        const parts = v.replace(/-.*/, '').split('.').map(Number);
        return (parts[0] || 0) * 1000 + (parts[1] || 0) * 10 + (parts[2] || 0);
      };
      return parseV(a[0]) - parseV(b[0]);
    });
  };

  const sortedIntroVersions = sortVersionEntries(Object.entries(introVersionCounts));
  const sortedChangeVersions = sortVersionEntries(Object.entries(changeVersionCounts));

  // Total change events
  let totalChanges = 0;
  for (const changes of Object.values(endpointChangelog)) {
    totalChanges += changes.length;
  }

  // 6. Write output
  const output = {
    meta: {
      generated_at: new Date().toISOString(),
      repo_url: REPO_URL,
      total_commits_analyzed: processed,
      total_endpoints_tracked: Object.keys(endpointIntroduced).length,
      total_endpoints_with_changes: Object.keys(endpointChangelog).length,
      total_change_events: totalChanges,
      parse_errors: errors,
    },
    introduction_summary: Object.fromEntries(sortedIntroVersions),
    change_summary: Object.fromEntries(sortedChangeVersions),
    endpoints: {},
  };

  // Merge introduction and changelog into a single per-endpoint entry
  const allKeys = new Set([...Object.keys(endpointIntroduced), ...Object.keys(endpointChangelog)]);
  for (const key of [...allKeys].sort()) {
    output.endpoints[key] = {};
    if (endpointIntroduced[key]) {
      output.endpoints[key].introduced = endpointIntroduced[key];
    }
    if (endpointChangelog[key] && endpointChangelog[key].length > 0) {
      output.endpoints[key].changes = endpointChangelog[key];
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  log(`Wrote ${outputPath}`);

  // 7. Clean up
  if (didClone && !keepRepo && !repoArg) {
    log('Cleaning up cloned repo...');
    fs.rmSync(repoPath, { recursive: true, force: true });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done in ${elapsed}s`);

  // Print summary
  console.log('\nEndpoints introduced per PVE version:');
  console.log('─'.repeat(45));
  for (const [version, count] of sortedIntroVersions) {
    console.log(`  PVE ${version.padEnd(12)} ${String(count).padStart(4)} endpoints`);
  }
  console.log('─'.repeat(45));
  console.log(`  Total: ${Object.keys(endpointIntroduced).length} endpoints tracked`);

  console.log('\nParameter/return changes per PVE version:');
  console.log('─'.repeat(45));
  for (const [version, count] of sortedChangeVersions) {
    console.log(`  PVE ${version.padEnd(12)} ${String(count).padStart(4)} changes`);
  }
  console.log('─'.repeat(45));
  console.log(`  Total: ${totalChanges} change events across ${Object.keys(endpointChangelog).length} endpoints`);

  console.log(`\nOutput: ${outputPath}`);
}

main();
