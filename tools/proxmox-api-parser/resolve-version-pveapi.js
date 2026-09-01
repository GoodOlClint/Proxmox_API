#!/usr/bin/env node
/**
 * resolve-version-pveapi.js — Determine the upstream docs package version of the live API.
 *
 * Usage:
 *   node resolve-version-pveapi.js --product pve [--apidoc <path>] [--repo <pve-docs clone>]
 *   node resolve-version-pveapi.js --product pbs
 *
 * Prints "<docs_version> <as_of_date>" for pve (the date of the pve-docs commit whose
 * apidata.js matches the live schema) or "<docs_version>" for pbs.
 *
 * For pve the version is read from the docs site AND derived from the matching
 * pve-docs commit via debian/changelog; the two must agree or the run fails.
 * See docs/decisions/0001.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const walker = require('./history-pveapi.js');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1] || null;
}

const SITES = {
  pve: { url: 'https://pve.proxmox.com/pve-docs/', re: /id="revnumber">\s*version\s+(\d+\.\d+\.\d+)/i, apidoc: 'https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js' },
  pbs: { url: 'https://pbs.proxmox.com/docs/', re: /Version\s+(\d+\.\d+\.\d+)\s+--/ },
};

const product = getArg('--product');
if (!SITES[product]) {
  process.stderr.write('Usage: --product pve|pbs\n');
  process.exit(1);
}

function fail(msg) {
  process.stderr.write(`[resolve-version] FATAL: ${msg}\n`);
  process.exit(1);
}

const debianRevision = /-\d+$/;

async function siteVersion() {
  const res = await fetch(SITES[product].url);
  if (!res.ok) fail(`HTTP ${res.status} fetching ${SITES[product].url}`);
  const m = (await res.text()).match(SITES[product].re);
  if (!m) fail(`no version string found on ${SITES[product].url} (site markup changed?)`);
  return m[1];
}

async function main() {
  const site = await siteVersion();
  if (product === 'pbs') {
    console.log(site);
    return;
  }

  const apidocPath = getArg('--apidoc') || path.join(__dirname, 'apidoc.js');
  if (!fs.existsSync(apidocPath)) {
    const res = await fetch(SITES.pve.apidoc);
    if (!res.ok) fail(`HTTP ${res.status} fetching ${SITES.pve.apidoc}`);
    fs.writeFileSync(apidocPath, await res.text(), 'utf8');
  }
  const repo = getArg('--repo') || path.join(__dirname, '.pve-docs-clone');
  if (!fs.existsSync(repo)) fail(`pve-docs clone not found at ${repo} (run history-pveapi.js first)`);

  const hashOf = (src) => crypto.createHash('sha256')
    .update(walker.stableStringify(walker.extractSchemaTree(src))).digest('hex');
  const live = hashOf(fs.readFileSync(apidocPath, 'utf8'));

  const commits = execSync(`git log --format="%H %aI" -- "${walker.APIDATA_PATH}"`, { cwd: repo, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((l) => { const [sha, date] = l.split(' '); return { sha, date }; });
  let match = null;
  for (const c of commits) {
    let src;
    try {
      src = execSync(`git show ${c.sha}:${walker.APIDATA_PATH}`, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { continue; }
    if (hashOf(src) === live) { match = c; break; }
  }
  if (!match) fail('live apidoc.js schema matches no pve-docs apidata.js commit');

  const changelog = fs.readFileSync(path.join(repo, 'debian', 'changelog'), 'utf8');
  const entry = walker.findVersionForCommitDate(new Date(match.date), walker.parseChangelog(changelog));
  if (!entry) fail(`no changelog release covers commit ${match.sha.slice(0, 10)} (${match.date})`);
  const repoVersion = entry.version.replace(debianRevision, '');
  if (repoVersion !== site) {
    fail(`version disagreement: site says ${site}, pve-docs commit ${match.sha.slice(0, 10)} maps to ${repoVersion}`);
  }
  process.stderr.write(`[resolve-version] ${site} = pve-docs ${match.sha.slice(0, 10)} (${match.date.slice(0, 10)})\n`);
  console.log(`${site} ${match.date.slice(0, 10)}`);
}

main().catch((e) => fail(e.message));
