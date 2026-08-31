#!/usr/bin/env node
/**
 * format-history-pveapi.js — Build version history for PVE API format types.
 *
 * Clones the relevant Proxmox source repos, walks commits to files containing
 * register_format calls, and tracks when each format was introduced and when
 * its validation logic changed.
 *
 * Output: format-history.json
 *
 * Usage:
 *   node format-history-pveapi.js [--output <path>] [--keep-repos] [--clones-dir <path>]
 *
 * Options:
 *   --output <path>       Output file (default: tools/proxmox-api-parser/format-history.json)
 *   --keep-repos          Don't delete cloned repos when done
 *   --clones-dir <path>   Directory for repo clones (default: .pve-source-clones)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}
function hasFlag(name) { return args.includes(name); }

const outputPath = getArg('--output') || path.join(__dirname, 'format-history.json');
const keepRepos = hasFlag('--keep-repos');
const clonesDir = getArg('--clones-dir') || path.join(__dirname, '.pve-source-clones');

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[format-history] ${msg}\n`);
}

// ─── Repo definitions ───────────────────────────────────────────────────────

// Each repo entry lists the files we scan for register_format calls.
// The changelog_pkg is the package name in debian/changelog (used for version parsing).
const REPOS = [
  {
    name: 'pve-common',
    url: 'https://github.com/proxmox/pve-common.git',
    changelog_pkg: 'libpve-common-perl',
    files: ['src/PVE/JSONSchema.pm', 'src/PVE/Certificate.pm', 'src/PVE/CalendarEvent.pm'],
  },
  {
    name: 'pve-access-control',
    url: 'https://github.com/proxmox/pve-access-control.git',
    changelog_pkg: 'libpve-access-control',
    files: ['src/PVE/AccessControl.pm', 'src/PVE/Auth/Plugin.pm'],
  },
  {
    name: 'pve-storage',
    url: 'https://github.com/proxmox/pve-storage.git',
    changelog_pkg: 'libpve-storage-perl',
    files: ['src/PVE/Storage/Plugin.pm'],
  },
  {
    name: 'qemu-server',
    url: 'https://github.com/proxmox/qemu-server.git',
    changelog_pkg: 'qemu-server',
    files: [
      'PVE/QemuServer.pm', 'src/PVE/QemuServer.pm',
      'PVE/QemuServer/Drive.pm', 'src/PVE/QemuServer/Drive.pm',
      'PVE/QemuServer/PCI.pm', 'src/PVE/QemuServer/PCI.pm',
      'PVE/QemuServer/USB.pm', 'src/PVE/QemuServer/USB.pm',
      'PVE/QemuServer/CPUConfig.pm', 'src/PVE/QemuServer/CPUConfig.pm',
      'PVE/QemuServer/Network.pm', 'src/PVE/QemuServer/Network.pm',
    ],
  },
  {
    name: 'pve-firewall',
    url: 'https://github.com/proxmox/pve-firewall.git',
    changelog_pkg: 'pve-firewall',
    files: ['src/PVE/Firewall.pm', 'PVE/Firewall.pm'],
  },
  {
    name: 'pve-manager',
    url: 'https://github.com/proxmox/pve-manager.git',
    changelog_pkg: 'pve-manager',
    files: [
      'PVE/API2/Nodes.pm', 'PVE/API2/Backup.pm',
      'PVE/NodeConfig.pm', 'PVE/Status/Graphite.pm',
    ],
  },
  {
    name: 'pve-container',
    url: 'https://github.com/proxmox/pve-container.git',
    changelog_pkg: 'pve-container',
    files: ['src/PVE/LXC/Config.pm'],
  },
  {
    name: 'pve-network',
    url: 'https://github.com/proxmox/pve-network.git',
    changelog_pkg: 'libpve-network-perl',
    files: [
      'src/PVE/Network/SDN/VnetPlugin.pm',
      'src/PVE/Network/SDN/Zones/Plugin.pm',
      'src/PVE/Network/SDN/Controllers/Plugin.pm',
      'src/PVE/Network/SDN/Fabrics.pm',
      'src/PVE/Network/SDN/Dns/Plugin.pm',
      'src/PVE/Network/SDN/Ipams/Plugin.pm',
      'src/PVE/Network/SDN/SubnetPlugin.pm',
      'src/PVE/Network/SDN/Zones/EvpnPlugin.pm',
      'src/PVE/Network/SDN/Controllers/IsisPlugin.pm',
    ],
  },
  {
    name: 'pve-ha-manager',
    url: 'https://github.com/proxmox/pve-ha-manager.git',
    changelog_pkg: 'pve-ha-manager',
    files: ['src/PVE/HA/Tools.pm'],
  },
  {
    name: 'pve-guest-common',
    url: 'https://github.com/proxmox/pve-guest-common.git',
    changelog_pkg: 'libpve-guest-common-perl',
    files: ['src/PVE/VZDump/Common.pm', 'src/PVE/ReplicationConfig.pm'],
  },
  {
    name: 'pve-cluster',
    url: 'https://github.com/proxmox/pve-cluster.git',
    changelog_pkg: 'pve-cluster',
    files: ['src/PVE/DataCenterConfig.pm', 'data/PVE/DataCenterConfig.pm'],
  },
];

// ─── Parse debian/changelog ─────────────────────────────────────────────────

function parseChangelog(changelogText, pkgName) {
  const entries = [];
  const lines = changelogText.split('\n');
  let currentVersion = null;
  let currentSuite = null;
  // Match any package name — different repos use different names
  const headerRe = new RegExp(`^\\S+\\s+\\(([^)]+)\\)\\s+(\\S+);`);

  for (const line of lines) {
    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      currentVersion = headerMatch[1];
      currentSuite = headerMatch[2];
      continue;
    }
    const dateMatch = line.match(/^\s+--\s+.+\s{2}(.+)$/);
    if (dateMatch && currentVersion) {
      const date = new Date(dateMatch[1].trim());
      if (!isNaN(date.getTime())) {
        entries.push({
          version: currentVersion,
          suite: currentSuite,
          date,
          dateISO: date.toISOString().slice(0, 10),
        });
      }
      currentVersion = null;
      currentSuite = null;
    }
  }
  entries.sort((a, b) => b.date - a.date); // newest first
  return entries;
}

function pveMajorFromEntry(suite, version) {
  const suiteMap = { trixie: 9, bookworm: 8, bullseye: 7, buster: 6, stretch: 5 };
  if (suiteMap[suite]) return suiteMap[suite];
  const m = version.match(/^(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

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

function friendlyVersion(entry) {
  if (!entry || entry.version === 'unknown') return entry ? entry.version : 'unknown';
  const clean = entry.version.replace(/-\d+$/, '');
  const parts = clean.split('.');
  return parts.length >= 2 ? parts.slice(0, 2).join('.') : clean;
}

// ─── Extract format registrations from Perl source ──────────────────────────

/**
 * Extract all register_format calls from Perl source.
 * Returns a Map of format_name → { code_hash, line_context }
 *
 * We extract:
 *   register_format('name', \&validator)
 *   register_format('name', { ... })
 *   register_format('name', $hashref)
 *   register_format('name', $hashref, \&validator)
 *
 * We also look for known enum patterns like $valid_privs and $privgroups
 * to detect when enum values change.
 */
function extractFormats(source, filePath) {
  const formats = new Map();
  if (!source) return formats;

  // Find all register_format calls
  const registerRe = /register_format\s*\(\s*'([^']+)'/g;
  let match;
  while ((match = registerRe.exec(source)) !== null) {
    const name = match[1];
    // Get surrounding context (the function call + nearby lines) for change detection
    const startPos = match.index;
    // Find the end of this statement (matching parens)
    let depth = 0;
    let endPos = startPos;
    let foundOpen = false;
    for (let i = startPos; i < source.length; i++) {
      if (source[i] === '(') { depth++; foundOpen = true; }
      if (source[i] === ')') {
        depth--;
        if (foundOpen && depth === 0) { endPos = i + 1; break; }
      }
    }
    // Also capture any immediately preceding variable/hash definition
    // Look back up to 500 chars for a related my/our $var = { ... }
    const lookbackStart = Math.max(0, startPos - 500);
    const lookback = source.substring(lookbackStart, startPos);
    const context = lookback + source.substring(startPos, Math.min(endPos + 200, source.length));

    const codeHash = crypto.createHash('md5').update(context).digest('hex').slice(0, 12);

    formats.set(name, {
      code_hash: codeHash,
      file: filePath,
    });
  }

  // Special: detect $valid_privs / $privgroups changes for pve-priv
  if (source.includes('$privgroups') || source.includes('$valid_privs')) {
    // Hash the privilege-related code section
    const privMatch = source.match(/\$privgroups\s*=\s*\{[\s\S]*?\n\};/);
    if (privMatch && !formats.has('pve-priv')) {
      // pve-priv registration might be via register_format('pve-priv', ...) which we already caught
    }
    if (privMatch && formats.has('pve-priv')) {
      // Enhance the hash to include the privgroups definition
      const fullContext = privMatch[0];
      const privHash = crypto.createHash('md5').update(fullContext).digest('hex').slice(0, 12);
      const existing = formats.get('pve-priv');
      existing.code_hash = privHash; // Use privgroups hash since that's what actually defines valid values
    }
  }

  // Special: detect $icmp_type_names changes for pve-fw-icmp-type-spec
  if (source.includes('$icmp_type_names')) {
    const icmpMatch = source.match(/\$icmp_type_names\s*=\s*\{[\s\S]*?\n\};/);
    if (icmpMatch && formats.has('pve-fw-icmp-type-spec')) {
      const icmpHash = crypto.createHash('md5').update(icmpMatch[0]).digest('hex').slice(0, 12);
      formats.get('pve-fw-icmp-type-spec').code_hash = icmpHash;
    }
  }

  // Special: detect conntrack helper changes
  if (source.includes('$pve_fw_helpers')) {
    const helpersMatch = source.match(/\$pve_fw_helpers\s*=\s*\{[\s\S]*?\n\};/);
    if (helpersMatch && formats.has('pve-fw-conntrack-helper')) {
      const helpersHash = crypto.createHash('md5').update(helpersMatch[0]).digest('hex').slice(0, 12);
      formats.get('pve-fw-conntrack-helper').code_hash = helpersHash;
    }
  }

  return formats;
}

// ─── Extract actual enum/value content from source ──────────────────────────

/**
 * For formats with known enum structures, extract the actual values from source.
 * Returns an object with extracted values, or null if not extractable.
 */
function extractFormatValues(formatName, source) {
  if (!source) return null;

  switch (formatName) {
    case 'pve-priv':
      return extractPrivileges(source);
    case 'pve-fw-conntrack-helper':
      return extractHashKeys(source, /\$pve_fw_helpers\s*=\s*\{([\s\S]*?)\n\};/);
    case 'pve-fw-icmp-type-spec':
      return extractIcmpTypes(source);
    case 'pve-hotplug-features': {
      // These are validated in parse_hotplug_features — look for the valid key checks
      const featMatch = source.match(/my\s+\$res\s*=\s*\{\}[\s\S]*?return\s+\$res/);
      if (featMatch) {
        const keys = [...featMatch[0].matchAll(/\$res->\{['"]?(\w+)['"]?\}/g)].map(m => m[1]);
        if (keys.length > 0) return { type: 'enum', values: [...new Set(keys)].sort() };
      }
      return null;
    }
    case 'pve-storage-content':
      return extractStorageContent(source);
    case 'pve-storage-format': {
      const fmtMatch = source.match(/\$fmt\s*!~\s*m\/\^\(([^)]+)\)\$\//);
      if (fmtMatch) return { type: 'enum', values: fmtMatch[1].split('|').sort() };
      return null;
    }
    case 'pve-qm-image-format': {
      const qfmtMatch = source.match(/QEMU_FORMAT_RE\s*=\s*qr\/([^/]+)\//);
      if (qfmtMatch) return { type: 'enum', values: qfmtMatch[1].split('|').sort() };
      return null;
    }
    case 'pve-fw-loglevel': {
      const lvlMatch = source.match(/log_severity_hash\s*=[\s\S]*?\{([\s\S]*?)\}/);
      if (lvlMatch) {
        const keys = [...lvlMatch[1].matchAll(/'(\w[\w-]*)'/g)].map(m => m[1]);
        if (keys.length > 0) return { type: 'enum', values: [...new Set(keys)].sort() };
      }
      return null;
    }
    case 'pve-day-of-week': {
      const dowMatch = source.match(/verify_day_of_week[\s\S]*?m\/\^\(([^)]+)\)\$\//);
      if (dowMatch) return { type: 'enum', values: dowMatch[1].split('|').sort() };
      return null;
    }
    default:
      return null;
  }
}

function extractPrivileges(source) {
  // Extract from $privgroups structure — privilege names are string values in nested arrays
  const privMatch = source.match(/\$privgroups\s*=\s*\{([\s\S]*?)\n\};/);
  if (!privMatch) return null;
  const section = privMatch[1];
  // Find all quoted strings that look like privileges (X.Y or X.Y.Z)
  const privs = [...section.matchAll(/'([A-Z][a-zA-Z]+\.[A-Z][a-zA-Z.]+)'/g)].map(m => m[1]);
  // Also check for Permissions.Modify which is added standalone
  if (source.includes("'Permissions.Modify'") && !privs.includes('Permissions.Modify')) {
    privs.push('Permissions.Modify');
  }
  return privs.length > 0 ? { type: 'enum', values: [...new Set(privs)].sort() } : null;
}

function extractHashKeys(source, pattern) {
  const match = source.match(pattern);
  if (!match) return null;
  const keys = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    .filter(k => !k.match(/proto|dport|v[46]/)); // filter out property names
  return keys.length > 0 ? { type: 'enum', values: [...new Set(keys)].sort() } : null;
}

function extractIcmpTypes(source) {
  const v4Match = source.match(/\$icmp_type_names\s*=\s*\{([\s\S]*?)\n\};/);
  const v6Match = source.match(/\$icmpv6_type_names\s*=\s*\{([\s\S]*?)\n\};/);
  const result = {};
  if (v4Match) {
    result.icmpv4 = [...v4Match[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  }
  if (v6Match) {
    result.icmpv6 = [...v6Match[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  }
  return (result.icmpv4 || result.icmpv6) ? { type: 'enum_dual', ...result } : null;
}

function extractStorageContent(source) {
  // Content types are defined per-plugin as hash keys in content => [{ type => 1, ... }]
  // The verify_content function checks against valid_content_types('dir') which is the superset
  // Look for content hash definitions
  const contentMatches = [...source.matchAll(/content\s*=>\s*\[\s*\{([^}]+)\}/g)];
  const allTypes = new Set();
  for (const m of contentMatches) {
    const types = [...m[1].matchAll(/'?(\w+)'?\s*=>/g)].map(m2 => m2[1])
      .filter(t => !['optional', 'type', 'description'].includes(t));
    types.forEach(t => allTypes.add(t));
  }
  // Also check for 'import' which is added separately
  if (source.includes("'import'") || source.includes('"import"')) allTypes.add('import');
  return allTypes.size > 0 ? { type: 'enum', values: [...allTypes].sort() } : null;
}

// ─── Clone or update a repo ─────────────────────────────────────────────────

function ensureRepo(repo) {
  const repoPath = path.join(clonesDir, repo.name);
  if (fs.existsSync(repoPath)) {
    try {
      execSync('git pull --ff-only', { cwd: repoPath, stdio: 'pipe', timeout: 30000 });
    } catch (e) { /* ignore */ }
    return repoPath;
  }
  log(`Cloning ${repo.name}...`);
  execSync(`git clone --single-branch --no-tags "${repo.url}" "${repoPath}"`, {
    stdio: 'pipe',
    timeout: 120000,
  });
  return repoPath;
}

// ─── Process a single repo ──────────────────────────────────────────────────

function processRepo(repo) {
  const repoPath = ensureRepo(repo);
  log(`Processing ${repo.name}...`);

  // Parse changelog
  let changelogEntries = [];
  const changelogPath = path.join(repoPath, 'debian', 'changelog');
  if (fs.existsSync(changelogPath)) {
    const changelogText = fs.readFileSync(changelogPath, 'utf8');
    changelogEntries = parseChangelog(changelogText, repo.changelog_pkg);
    log(`  ${changelogEntries.length} changelog entries`);
  } else {
    log(`  WARNING: No debian/changelog found`);
  }

  // Find which tracked files actually exist in this repo
  const existingFiles = [];
  for (const f of repo.files) {
    try {
      execSync(`git log --oneline -1 -- "${f}"`, { cwd: repoPath, stdio: 'pipe' });
      existingFiles.push(f);
    } catch (e) { /* file never existed */ }
  }
  if (existingFiles.length === 0) {
    log(`  WARNING: No tracked files found`);
    return [];
  }
  log(`  Tracking ${existingFiles.length} files: ${existingFiles.join(', ')}`);

  // Get all commits touching any of our tracked files, oldest first
  const fileArgs = existingFiles.map(f => `"${f}"`).join(' ');
  let commitLog;
  try {
    commitLog = execSync(
      `git log --format="%H %aI" --diff-filter=AMRC -- ${fileArgs}`,
      { cwd: repoPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();
  } catch (e) {
    log(`  WARNING: git log failed: ${e.message}`);
    return [];
  }

  if (!commitLog) {
    log(`  No commits found`);
    return [];
  }

  const commits = commitLog.split('\n').filter(Boolean).map(line => {
    const [sha, dateStr] = line.split(' ');
    return { sha, date: new Date(dateStr), dateISO: dateStr.slice(0, 10) };
  }).reverse(); // oldest first

  log(`  ${commits.length} commits to process`);

  // Walk each commit
  const formatHistory = []; // { format_name, event_type, version, date, commit, repo, code_hash }
  let previousFormats = new Map();

  for (let ci = 0; ci < commits.length; ci++) {
    const commit = commits[ci];
    if ((ci + 1) % 20 === 0 || ci === commits.length - 1) {
      log(`  Commit ${ci + 1}/${commits.length} (${commit.dateISO})`);
    }

    // Collect formats from all tracked files at this commit
    // Keep source per file so we can extract values later
    const currentFormats = new Map();
    const fileSources = new Map();
    for (const filePath of existingFiles) {
      let source;
      try {
        source = execSync(`git show ${commit.sha}:${filePath}`, {
          cwd: repoPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
        });
      } catch (e) {
        continue; // file doesn't exist at this commit
      }

      fileSources.set(filePath, source);
      const fileFormats = extractFormats(source, filePath);
      for (const [name, info] of fileFormats) {
        currentFormats.set(name, { ...info, repo: repo.name });
      }
    }

    // Diff against previous
    const versionEntry = findVersionForCommitDate(commit.date, changelogEntries);
    const version = friendlyVersion(versionEntry);
    const docsVersion = versionEntry ? versionEntry.version : 'unknown';
    const pveMajor = versionEntry ? pveMajorFromEntry(versionEntry.suite, versionEntry.version) : null;

    // Helper: try to extract values for a format from any available source
    function tryExtractValues(name) {
      for (const [filePath, src] of fileSources) {
        const vals = extractFormatValues(name, src);
        if (vals) return vals;
      }
      return null;
    }

    // New formats
    for (const [name, info] of currentFormats) {
      if (!previousFormats.has(name)) {
        const event = {
          format_name: name,
          event_type: 'introduced',
          version,
          docs_version: docsVersion,
          pve_major: pveMajor,
          date: commit.dateISO,
          commit: commit.sha.slice(0, 10),
          repo: repo.name,
          file: info.file,
          code_hash: info.code_hash,
        };
        const values = tryExtractValues(name);
        if (values) event.values = values;
        formatHistory.push(event);
      }
    }

    // Changed formats (same name but different code hash)
    for (const [name, info] of currentFormats) {
      const prev = previousFormats.get(name);
      if (prev && prev.code_hash !== info.code_hash) {
        const event = {
          format_name: name,
          event_type: 'validation_changed',
          version,
          docs_version: docsVersion,
          pve_major: pveMajor,
          date: commit.dateISO,
          commit: commit.sha.slice(0, 10),
          repo: repo.name,
          file: info.file,
          code_hash: info.code_hash,
          previous_code_hash: prev.code_hash,
        };
        const values = tryExtractValues(name);
        if (values) event.values = values;
        formatHistory.push(event);
      }
    }

    // Removed formats
    for (const [name, info] of previousFormats) {
      if (!currentFormats.has(name)) {
        formatHistory.push({
          format_name: name,
          event_type: 'removed',
          version,
          docs_version: docsVersion,
          pve_major: pveMajor,
          date: commit.dateISO,
          commit: commit.sha.slice(0, 10),
          repo: repo.name,
          file: info.file,
        });
      }
    }

    previousFormats = currentFormats;
  }

  log(`  Found ${formatHistory.length} events for ${new Set(formatHistory.map(e => e.format_name)).size} formats`);
  return formatHistory;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const startTime = Date.now();

  // Ensure clones directory exists
  fs.mkdirSync(clonesDir, { recursive: true });

  // Process all repos
  const allEvents = [];
  for (const repo of REPOS) {
    try {
      const events = processRepo(repo);
      allEvents.push(...events);
    } catch (e) {
      log(`ERROR processing ${repo.name}: ${e.message}`);
    }
  }

  log(`\nTotal events: ${allEvents.length}`);

  // Organize by format name
  const formatMap = {};
  for (const event of allEvents) {
    const name = event.format_name;
    if (!formatMap[name]) {
      formatMap[name] = {
        introduced: null,
        changes: [],
        source_repo: null,
      };
    }
    const entry = formatMap[name];

    if (event.event_type === 'introduced' && !entry.introduced) {
      entry.introduced = {
        version: event.version,
        docs_version: event.docs_version,
        pve_major: event.pve_major,
        date: event.date,
        commit: event.commit,
        repo: event.repo,
        file: event.file,
      };
      if (event.values) entry.introduced.values = event.values;
      entry.source_repo = event.repo;
    } else if (event.event_type === 'validation_changed') {
      const change = {
        version: event.version,
        docs_version: event.docs_version,
        pve_major: event.pve_major,
        date: event.date,
        commit: event.commit,
        code_hash: event.code_hash,
        previous_code_hash: event.previous_code_hash,
      };
      if (event.values) change.values = event.values;
      entry.changes.push(change);
    } else if (event.event_type === 'removed') {
      entry.changes.push({
        version: event.version,
        docs_version: event.docs_version,
        date: event.date,
        commit: event.commit,
        type: 'removed',
      });
    }
  }

  // Build summary stats
  const introductionSummary = {};
  const changeSummary = {};
  let totalChanges = 0;
  for (const [name, entry] of Object.entries(formatMap)) {
    if (entry.introduced) {
      const v = entry.introduced.version;
      introductionSummary[v] = (introductionSummary[v] || 0) + 1;
    }
    for (const change of entry.changes) {
      if (change.type !== 'removed') {
        const v = change.version;
        changeSummary[v] = (changeSummary[v] || 0) + 1;
        totalChanges++;
      }
    }
  }

  // Sort summaries by version
  const sortVersion = (a, b) => {
    const parseV = v => {
      const parts = v.replace(/-.*/, '').split('.').map(Number);
      return (parts[0] || 0) * 1000 + (parts[1] || 0) * 10 + (parts[2] || 0);
    };
    return parseV(a) - parseV(b);
  };
  const sortedIntroSummary = {};
  for (const k of Object.keys(introductionSummary).sort(sortVersion)) {
    sortedIntroSummary[k] = introductionSummary[k];
  }
  const sortedChangeSummary = {};
  for (const k of Object.keys(changeSummary).sort(sortVersion)) {
    sortedChangeSummary[k] = changeSummary[k];
  }

  // Write output
  const output = {
    meta: {
      generated_at: new Date().toISOString(),
      repos_scanned: REPOS.map(r => r.name),
      total_formats_tracked: Object.keys(formatMap).length,
      total_change_events: totalChanges,
      total_introductions: Object.values(introductionSummary).reduce((a, b) => a + b, 0),
    },
    introduction_summary: sortedIntroSummary,
    change_summary: sortedChangeSummary,
    formats: formatMap,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nDone in ${elapsed}s`);

  // Print summary
  console.log('\nFormat introductions per version:');
  console.log('─'.repeat(40));
  for (const [version, count] of Object.entries(sortedIntroSummary)) {
    console.log(`  ${version.padEnd(12)} ${String(count).padStart(4)} formats`);
  }
  console.log('─'.repeat(40));
  console.log(`  Total: ${Object.keys(formatMap).length} formats tracked`);
  console.log(`  Changes: ${totalChanges} validation change events`);
  console.log(`\nOutput: ${outputPath}`);

  // Clean up clones if requested
  if (!keepRepos) {
    log('Cleaning up cloned repos...');
    fs.rmSync(clonesDir, { recursive: true, force: true });
  }
}

main();
