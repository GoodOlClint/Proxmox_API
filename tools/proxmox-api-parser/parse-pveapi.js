#!/usr/bin/env node
/**
 * PVE API Spec Parser
 *
 * Parses Proxmox VE's apidoc.js into a structured, machine-readable JSON artifact.
 *
 * Source format (apidoc.js):
 * --------------------------
 * The file starts with `const apiSchema = [...];\n` followed by ExtJS UI code.
 * The apiSchema is a JSON-compatible array of tree nodes. Each node has:
 *   - path      (string)  — the full API path for this node, e.g. "/cluster/replication/{id}"
 *   - text      (string)  — display label
 *   - leaf      (0|1)     — whether this node has children
 *   - children  (array)   — child nodes (recursive), present when leaf === 0
 *   - info      (object)  — keyed by HTTP method (GET, POST, PUT, DELETE), each containing:
 *       - description    (string)
 *       - method         (string)
 *       - name           (string)
 *       - allowtoken     (0|1)
 *       - protected      (0|1)
 *       - proxyto        (string|null)
 *       - parameters     (object) — { additionalProperties, properties: { paramName: { type, description, optional, ... } } }
 *       - returns        (object) — { type, description, properties, items, links, ... }
 *       - permissions    (object) — { check, description, user }
 *
 * The path field on each node is already the full absolute path (not a fragment).
 * The apiSchema array ends with `];\n` around line 65015, after which ExtJS UI code follows.
 *
 * No version string is embedded at file level; pveversion appears only as a return field
 * of the /nodes/{node}/status endpoint.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const vm = require('vm');

// ─── CLI argument parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}
function hasFlag(name) {
  return args.includes(name);
}

const inputPath = getArg('--input');
const outputPath = getArg('--output') || path.join(__dirname, 'pve-api.json');
const pretty = hasFlag('--pretty');
const split = hasFlag('--split');
const historyPath = getArg('--history') || path.join(__dirname, 'endpoint-history.json');
const asOf = getArg('--as-of');
const docsVersion = getArg('--docs-version');

const SOURCE_URL = 'https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js';
const CACHE_PATH = path.join(__dirname, 'apidoc.js');

// ─── Logging (to stderr so stdout stays clean for piping) ───────────────────

function log(msg) {
  process.stderr.write(`[pve-api-parser] ${msg}\n`);
}

// ─── Functional area classification ─────────────────────────────────────────

const AREA_RULES = [
  ['/cluster/sdn', 'sdn'],
  ['/cluster/ha', 'ha'],
  ['/cluster/backup', 'backup'],
  ['/cluster/firewall', 'firewall'],
  ['/cluster/replication', 'replication'],
  ['/cluster/acme', 'acme'],
  ['/cluster/metrics', 'metrics'],
  ['/cluster/config', 'cluster_config'],
  ['/cluster', 'cluster'],
  ['/nodes/{node}/qemu', 'vms'],
  ['/nodes/{node}/lxc', 'containers'],
  ['/nodes/{node}/storage', 'storage'],
  ['/nodes/{node}/network', 'networking'],
  ['/nodes/{node}/firewall', 'firewall'],
  ['/nodes/{node}/ceph', 'ceph'],
  ['/nodes/{node}/disks', 'disks'],
  ['/nodes/{node}/apt', 'apt'],
  ['/nodes/{node}/services', 'services'],
  ['/nodes/{node}/certificates', 'certificates'],
  ['/nodes/{node}/tasks', 'tasks'],
  ['/nodes/{node}', 'nodes'],
  ['/access/users', 'users'],
  ['/access/groups', 'access_groups'],
  ['/access/roles', 'roles'],
  ['/access/acl', 'acl'],
  ['/access/domains', 'access_domains'],
  ['/access', 'access'],
  ['/pools', 'pools'],
  ['/storage', 'storage_config'],
  ['/version', 'version'],
];

// Sort by prefix length descending so longest match wins
AREA_RULES.sort((a, b) => b[0].length - a[0].length);

function classifyArea(apiPath) {
  for (const [prefix, area] of AREA_RULES) {
    if (apiPath === prefix || apiPath.startsWith(prefix + '/')) {
      return area;
    }
  }
  // Fallback: derive from path segments so non-PVE trees (PBS: /admin/datastore,
  // /config/media-pool, ...) classify without product-specific rules
  const segs = apiPath.split('/').filter(Boolean);
  if (segs.length === 0) return 'other';
  const seg = (['admin', 'config'].includes(segs[0]) && segs[1]) ? segs[1] : segs[0];
  return seg.replace(/[{}]/g, '').replace(/-/g, '_');
}

// ─── Fetch helper ───────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Extract apiSchema from JS source ───────────────────────────────────────

function extractApiSchema(source) {
  // Strategy 1: Find the JSON array between `const apiSchema = [` and `];\n`
  // The array starts at line 1 and the closing `];` is on its own line.
  // PVE uses `const apiSchema = `, PBS uses `var apiSchema = `
  const markerMatch = source.match(/(?:const|var) apiSchema = /);
  if (!markerMatch) {
    throw new Error('Could not find "apiSchema = " in source');
  }

  const jsonStart = markerMatch.index + markerMatch[0].length;

  // Find the closing `];` — scan for `\n]` followed by `;` or `\n`
  // We know the structure ends with `]\n;` (the `]` and `;` are on separate lines)
  // Look for the pattern: newline, ], newline, ;
  let bracketDepth = 0;
  let inString = false;
  let escapeNext = false;
  let endIdx = -1;

  for (let i = jsonStart; i < source.length; i++) {
    const ch = source[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '[' || ch === '{') bracketDepth++;
    if (ch === ']' || ch === '}') {
      bracketDepth--;
      if (bracketDepth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  if (endIdx === -1) {
    throw new Error('Could not find end of apiSchema array');
  }

  const jsonStr = source.substring(jsonStart, endIdx);

  // Strategy 1: direct JSON.parse
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    log('JSON.parse failed, falling back to vm.runInNewContext: ' + e.message);
  }

  // Strategy 2: vm sandbox evaluation
  const sandbox = {};
  vm.runInNewContext(source.substring(0, endIdx + 1), sandbox);
  if (sandbox.apiSchema) {
    return sandbox.apiSchema;
  }

  // Strategy 3: try with the full variable assignment
  const sandbox2 = {};
  vm.runInNewContext(source.substring(startIdx, endIdx + 1) + ';', sandbox2);
  if (sandbox2.apiSchema) {
    return sandbox2.apiSchema;
  }

  throw new Error('Failed to extract apiSchema from source');
}

// ─── Extract path parameters from a path template ──────────────────────────

function extractPathParamNames(apiPath) {
  const matches = apiPath.match(/\{([^}]+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

// ─── Walk tree and collect endpoints ────────────────────────────────────────

function collectEndpoints(nodes) {
  const endpoints = [];
  const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

  function walk(node) {
    if (node.info) {
      const apiPath = node.path || '';
      const pathParamNames = extractPathParamNames(apiPath);

      for (const method of HTTP_METHODS) {
        const methodInfo = node.info[method];
        if (!methodInfo) continue;

        const description = methodInfo.description || '';
        const deprecated =
          !!(methodInfo.deprecated) ||
          /\bdeprecated\b/i.test(description);

        // Classify parameters
        const pathParams = [];
        const queryParams = [];
        const bodyParams = [];
        const props = (methodInfo.parameters && methodInfo.parameters.properties) || {};

        for (const [paramName, paramDef] of Object.entries(props)) {
          const param = {
            name: paramName,
            type: paramDef.type || paramDef.typetext || 'string',
            description: paramDef.description || '',
            optional: !!(paramDef.optional),
          };

          // Include additional useful fields
          if (paramDef.minimum !== undefined) param.minimum = paramDef.minimum;
          if (paramDef.maximum !== undefined) param.maximum = paramDef.maximum;
          if (paramDef.default !== undefined) param.default = paramDef.default;
          if (paramDef.enum) param.enum = paramDef.enum;
          if (paramDef.format) param.format = paramDef.format;
          if (paramDef.pattern) param.pattern = paramDef.pattern;
          if (paramDef.maxLength !== undefined) param.max_length = paramDef.maxLength;
          if (paramDef.minLength !== undefined) param.min_length = paramDef.minLength;
          if (paramDef.requires) param.requires = paramDef.requires;
          if (paramDef.typetext) param.type_text = paramDef.typetext;
          if (paramDef.renderer) param.renderer = paramDef.renderer;
          if (paramDef.verbose_description) param.verbose_description = paramDef.verbose_description;

          if (pathParamNames.includes(paramName)) {
            param.optional = false; // path params are never optional
            pathParams.push(param);
          } else if (method === 'GET' || method === 'DELETE') {
            queryParams.push(param);
          } else {
            bodyParams.push(param);
          }
        }

        // Build returns object
        const ret = methodInfo.returns || {};
        const returns = {
          type: ret.type || null,
          description: ret.description || null,
        };
        if (ret.items) returns.items = ret.items;
        if (ret.properties) returns.properties = ret.properties;
        if (ret.links) returns.links = ret.links;
        if (ret.additionalProperties !== undefined) returns.additional_properties = ret.additionalProperties;

        // Build permissions
        let permissions = null;
        if (methodInfo.permissions) {
          permissions = {};
          if (methodInfo.permissions.check) permissions.check = methodInfo.permissions.check;
          if (methodInfo.permissions.description) permissions.description = methodInfo.permissions.description;
          if (methodInfo.permissions.user) permissions.user = methodInfo.permissions.user;
        }

        endpoints.push({
          path: apiPath,
          method: method,
          description: description,
          functional_area: classifyArea(apiPath),
          parameters: {
            path_params: pathParams,
            query_params: queryParams,
            body_params: bodyParams,
          },
          returns: returns,
          permissions: permissions,
          protected: !!(methodInfo.protected),
          allow_token: methodInfo.allowtoken !== undefined ? !!(methodInfo.allowtoken) : true,
          deprecated: deprecated,
        });
      }
    }

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  for (const root of nodes) {
    walk(root);
  }

  return endpoints;
}

// ─── Build tree representation ──────────────────────────────────────────────

function buildTree(nodes) {
  function transformNode(node) {
    const result = {
      path: node.path || '',
      text: node.text || '',
    };

    if (node.info) {
      result.methods = Object.keys(node.info).filter(
        (k) => ['GET', 'POST', 'PUT', 'DELETE'].includes(k)
      );
    }

    if (node.children && Array.isArray(node.children)) {
      result.children = node.children.map(transformNode);
    }

    return result;
  }

  return nodes.map(transformNode);
}

// ─── Version hint extraction ────────────────────────────────────────────────

// ─── Output validation ─────────────────────────────────────────────────────

function validateOutput(output) {
  const warnings = [];

  if (output.meta.total_endpoints !== output.endpoints.length) {
    warnings.push(
      `meta.total_endpoints (${output.meta.total_endpoints}) != endpoints.length (${output.endpoints.length})`
    );
  }

  for (let i = 0; i < output.endpoints.length; i++) {
    const ep = output.endpoints[i];
    if (!ep.path) warnings.push(`Endpoint ${i}: empty path`);
    if (!ep.method) warnings.push(`Endpoint ${i}: empty method`);
    if (!ep.functional_area) warnings.push(`Endpoint ${i}: empty functional_area`);
    if (!ep.parameters || !Array.isArray(ep.parameters.path_params) ||
        !Array.isArray(ep.parameters.query_params) ||
        !Array.isArray(ep.parameters.body_params)) {
      warnings.push(`Endpoint ${i} (${ep.method} ${ep.path}): malformed parameters`);
    }
  }

  return warnings;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // 1. Get source
  let source;
  if (inputPath) {
    log(`Reading from ${inputPath}`);
    source = fs.readFileSync(path.resolve(inputPath), 'utf8');
  } else if (fs.existsSync(CACHE_PATH)) {
    log(`Using cached ${CACHE_PATH}`);
    source = fs.readFileSync(CACHE_PATH, 'utf8');
  } else {
    log(`Fetching apidoc.js from ${SOURCE_URL}`);
    source = await fetchUrl(SOURCE_URL);
    fs.writeFileSync(CACHE_PATH, source, 'utf8');
    log(`Saved to ${CACHE_PATH}`);
  }

  const lineCount = source.split('\n').length;
  const sizeKb = (Buffer.byteLength(source, 'utf8') / 1024).toFixed(1);
  log(`Loaded ${lineCount} lines (${sizeKb} KB)`);

  // 2. Compute SHA256
  const sha256 = crypto.createHash('sha256').update(source).digest('hex');

  // 3. Extract schema
  log('Extracting root data structure...');
  const apiSchema = extractApiSchema(source);
  log('Extracted root data structure');

  // 4. Walk tree
  log('Walking tree...');
  const endpoints = collectEndpoints(apiSchema);

  // 4b. Enrich with version history if available
  let historyEnriched = 0;
  if (fs.existsSync(historyPath)) {
    log(`Loading version history from ${historyPath}`);
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    for (const ep of endpoints) {
      const key = `${ep.method} ${ep.path}`;
      const entry = history.endpoints[key];
      if (entry) {
        if (entry.introduced) {
          ep.since_version = entry.introduced.since_version;
          ep.since_pve_major = entry.introduced.since_pve_major;
          ep.since_date = entry.introduced.since_date;
        }
        const changes = asOf ? (entry.changes || []).filter((c) => c.date <= asOf) : (entry.changes || []);
        if (changes.length > 0) {
          ep.version_changes = changes;
          ep.last_changed_version = changes[changes.length - 1].version;
          ep.last_changed_date = changes[changes.length - 1].date;
        }
        historyEnriched++;
      }
    }
    log(`Enriched ${historyEnriched}/${endpoints.length} endpoints with version history`);
  } else {
    log(`No history file at ${historyPath} — skipping version enrichment (run history-pveapi.js first)`);
  }

  // 5. Collect unique paths and areas
  const uniquePaths = new Set(endpoints.map((e) => e.path));
  const areaCounts = {};
  endpoints.forEach((e) => {
    areaCounts[e.functional_area] = (areaCounts[e.functional_area] || 0) + 1;
  });
  const areaCount = Object.keys(areaCounts).length;

  log(`Found ${endpoints.length} endpoints across ${areaCount} functional areas`);

  // 6. Version hint

  // 7. Build tree
  const tree = buildTree(apiSchema);

  // 8. Assemble output
  const output = {
    meta: {
      source_url: getArg('--source-url') || (inputPath ? path.resolve(inputPath) : SOURCE_URL),
      source_sha256: sha256,
      total_endpoints: endpoints.length,
      total_paths: uniquePaths.size,
      docs_version: docsVersion || null,
      history_as_of: asOf || null,
    },
    endpoints: endpoints,
    tree: tree,
  };

  // 9. Validate
  const warnings = validateOutput(output);
  if (warnings.length > 0) {
    log(`Validation warnings (${warnings.length}):`);
    warnings.forEach((w) => log(`  WARNING: ${w}`));
  } else {
    log('Validation passed — no warnings');
  }

  // 10. Write output
  const indent = pretty ? 2 : undefined;
  const json = JSON.stringify(output, null, indent);
  fs.writeFileSync(outputPath, json, 'utf8');
  log(`Writing output to ${outputPath}`);

  const outputSizeKb = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
  log(`Output size: ${outputSizeKb} KB`);

  // 11. Split files
  if (split) {
    const outputDir = path.dirname(outputPath);
    const outputBase = path.basename(outputPath, '.json');

    for (const [area, count] of Object.entries(areaCounts)) {
      const areaEndpoints = endpoints.filter((e) => e.functional_area === area);
      const areaOutput = {
        meta: {
          ...output.meta,
          functional_area: area,
          total_endpoints: areaEndpoints.length,
        },
        endpoints: areaEndpoints,
      };
      const areaFile = path.join(outputDir, `${outputBase}.${area}.json`);
      fs.writeFileSync(areaFile, JSON.stringify(areaOutput, null, indent), 'utf8');
    }
    log(`Wrote ${areaCount} split files`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`Done in ${elapsed}s. SHA256: ${sha256}`);

  // 12. Print summary to stdout
  console.log(JSON.stringify({
    total_endpoints: endpoints.length,
    total_paths: uniquePaths.size,
    functional_areas: areaCounts,
    sha256: sha256,
    output_file: outputPath,
    output_size_kb: parseFloat(outputSizeKb),
    generation_time_seconds: parseFloat(elapsed),
    warnings: warnings,
  }, null, 2));
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
