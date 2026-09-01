#!/usr/bin/env node
/**
 * openapi-pveapi.js — Generate OpenAPI 3.0 spec from pve-api.json + format-registry.json
 *
 * Produces a standards-compliant OpenAPI 3.0.3 spec with:
 *   - All PVE API endpoints as paths/operations
 *   - Parameter validation from format-registry.json
 *   - x-since-version, x-pve-major, x-functional-area extensions
 *   - Optional per-major-version filtered specs
 *
 * Usage:
 *   node openapi-pveapi.js [options]
 *
 * Options:
 *   --api <path>       Path to pve-api.json (default: ../../pve-api.json)
 *   --formats <path>   Path to format-registry.json (default: ./format-registry.json)
 *   --output <path>    Output file (default: ./pve-openapi.json)
 *   --pretty           Pretty-print JSON (default)
 *   --compact           Minified JSON
 *   --version <N>      Generate spec for only PVE major version N (e.g., 8)
 *   --all-versions     Generate separate specs for PVE 4-9
 *   --yaml             Also output YAML (requires no deps — simple conversion)
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
function hasFlag(name) { return args.includes(name); }

const apiPath = getArg('--api') || path.join(__dirname, '..', '..', 'pve-api.json');
const formatsPath = getArg('--formats') || path.join(__dirname, 'format-registry.json');
const outputPath = getArg('--output') || path.join(__dirname, 'pve-openapi.json');
const compact = hasFlag('--compact');
const targetVersion = getArg('--version') ? parseInt(getArg('--version'), 10) : null;
const allVersions = hasFlag('--all-versions');

const PRODUCTS = {
  pve: { title: 'Proxmox VE API', name: 'Proxmox Virtual Environment', abbr: 'PVE', port: '8006', cookie: 'PVEAuthCookie', tokenPrefix: 'PVEAPIToken' },
  pbs: { title: 'Proxmox Backup Server API', name: 'Proxmox Backup Server', abbr: 'PBS', port: '8007', cookie: 'PBSAuthCookie', tokenPrefix: 'PBSAPIToken' },
};
const product = PRODUCTS[getArg('--product') || 'pve'];
if (!product) {
  process.stderr.write(`Unknown --product; valid: ${Object.keys(PRODUCTS).join(', ')}\n`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`[openapi-gen] ${msg}\n`);
}

// ─── Load inputs ────────────────────────────────────────────────────────────

log('Loading pve-api.json...');
const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
log(`  ${api.endpoints.length} endpoints`);

let formatRegistry = null;
if (fs.existsSync(formatsPath)) {
  log('Loading format-registry.json...');
  formatRegistry = JSON.parse(fs.readFileSync(formatsPath, 'utf8'));
  log(`  ${Object.keys(formatRegistry.formats).length} format definitions`);
} else {
  log('WARNING: format-registry.json not found, proceeding without format validation');
}

// Load format history for version-aware value resolution
const historyPath = path.join(__dirname, 'format-history.json');
let formatHistory = null;
if (fs.existsSync(historyPath)) {
  formatHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  log(`  ${Object.keys(formatHistory.formats).length} format histories loaded`);
}

/**
 * Resolve format enum values for a specific PVE major version.
 * Walks the format history to find the last snapshot of values at or before the target version.
 * Returns the values object or null if not available.
 */
function resolveValuesForVersion(formatName, pveMajorVersion) {
  if (!formatHistory || !formatHistory.formats[formatName]) return null;
  const fmt = formatHistory.formats[formatName];

  // Collect all events with values, in chronological order
  const snapshots = [];
  if (fmt.introduced && fmt.introduced.values && fmt.introduced.pve_major != null) {
    snapshots.push({ pve_major: fmt.introduced.pve_major, values: fmt.introduced.values });
  }
  for (const c of fmt.changes || []) {
    if (c.values && c.pve_major != null) {
      snapshots.push({ pve_major: c.pve_major, values: c.values });
    }
  }

  if (snapshots.length === 0) return null;

  // Find the last snapshot at or before the target version
  let best = null;
  for (const s of snapshots) {
    if (s.pve_major <= pveMajorVersion) {
      best = s.values;
    }
  }
  return best;
}

// Track the target PVE version for per-version spec generation
let currentTargetVersion = null;

// ─── Format → OpenAPI schema mapping ────────────────────────────────────────

/**
 * Convert a PVE format name to OpenAPI schema properties.
 * Returns additional schema properties (pattern, enum, format, etc.)
 */
function formatToSchema(formatName) {
  // Strip -list/-opt suffix to find base format in registry
  const baseName = formatName.replace(/-(list|opt)$/, '');
  const fmt = formatRegistry && (formatRegistry.formats[formatName] || formatRegistry.formats[baseName]);

  if (!fmt) {
    return { 'x-pve-format': formatName };
  }
  const extra = { 'x-pve-format': formatName };

  const isList = formatName.endsWith('-list') || formatName.endsWith('-opt');

  switch (fmt.validation) {
    case 'pattern':
      if (fmt.pattern && !isList) extra.pattern = fmt.pattern;
      break;
    case 'enum': {
      // Use version-specific values if generating a per-version spec
      let enumValues = fmt.enum;
      if (currentTargetVersion) {
        const resolved = resolveValuesForVersion(baseName, currentTargetVersion);
        if (resolved?.values) enumValues = resolved.values;
      }
      if (enumValues) {
        if (isList) {
          extra['x-enum-values'] = enumValues;
        } else {
          extra.enum = enumValues;
        }
      }
      break;
    }
    case 'enum_list': {
      if (fmt.enum) {
        extra['x-enum-values'] = fmt.enum;
      }
      break;
    }
    case 'union':
      // Can't perfectly represent unions in OpenAPI 3.0 without oneOf
      // Add a note about accepted values
      if (fmt.also_accepts) {
        extra['x-also-accepts'] = fmt.also_accepts;
      }
      break;
    case 'property_string':
      // Complex format — encoded as a string with structured sub-properties
      if (fmt.properties) {
        extra['x-property-string'] = fmt.properties;
      }
      break;
    case 'system_file':
      extra['x-validation-source'] = fmt.source;
      break;
    default:
      break;
  }

  if (fmt.min_length) extra.minLength = fmt.min_length;
  if (fmt.max_length) extra.maxLength = fmt.max_length;
  if (fmt.minimum !== undefined) extra.minimum = fmt.minimum;
  if (fmt.maximum !== undefined) extra.maximum = fmt.maximum;

  return extra;
}

/**
 * Convert an inline property-string format object to an OpenAPI schema.
 * These are object-typed formats embedded directly in the parameter definition.
 */
function inlineFormatToSchema(formatObj) {
  const properties = {};
  const required = [];

  for (const [propName, propDef] of Object.entries(formatObj)) {
    const prop = {
      type: mapType(propDef.type || 'string'),
    };
    if (propDef.description) prop.description = propDef.description;
    if (propDef.enum) prop.enum = propDef.enum;
    if (propDef.pattern) prop.pattern = propDef.pattern;
    if (propDef.minimum !== undefined) prop.minimum = propDef.minimum;
    if (propDef.maximum !== undefined) prop.maximum = propDef.maximum;
    if (propDef.default !== undefined) prop.default = mapDefault(propDef.default, propDef.type);
    if (propDef.maxLength) prop.maxLength = propDef.maxLength;
    if (propDef.format && typeof propDef.format === 'string') {
      Object.assign(prop, formatToSchema(propDef.format));
    }
    properties[propName] = prop;
    if (!propDef.optional) required.push(propName);
  }

  return {
    type: 'string',
    'x-property-string': properties,
    description: `Property string with keys: ${Object.keys(formatObj).join(', ')}`,
  };
}

// ─── Type mapping ───────────────────────────────────────────────────────────

function mapType(pveType) {
  const typeMap = {
    'string': 'string',
    'integer': 'integer',
    'number': 'number',
    'boolean': 'boolean',
    'array': 'array',
    'object': 'object',
    'null': 'string', // OpenAPI doesn't have null type in 3.0
    'any': 'string',
  };
  return typeMap[pveType] || 'string';
}

function mapDefault(val, type) {
  if (type === 'boolean') return val === 1 || val === true;
  if (type === 'integer' || type === 'number') return Number(val);
  return val;
}

// ─── Build parameter schema ─────────────────────────────────────────────────

function buildParamSchema(param) {
  const schema = {
    type: mapType(param.type || 'string'),
  };

  // Handle format
  if (param.format) {
    if (typeof param.format === 'string') {
      // Named format — look up in registry
      Object.assign(schema, formatToSchema(param.format));
    } else if (typeof param.format === 'object') {
      // Inline property-string definition
      Object.assign(schema, inlineFormatToSchema(param.format));
    }
  }

  // Numeric constraints
  if (param.minimum !== undefined) schema.minimum = param.minimum;
  if (param.maximum !== undefined) schema.maximum = param.maximum;
  if (param.maxLength !== undefined) schema.maxLength = param.maxLength;

  // Enums
  if (param.enum) schema.enum = param.enum;

  // Pattern
  if (param.pattern && !schema.pattern) schema.pattern = param.pattern;

  // Default
  if (param.default !== undefined) {
    schema.default = mapDefault(param.default, param.type);
  }

  return schema;
}

// ─── Build returns schema ───────────────────────────────────────────────────

function buildReturnsSchema(returns) {
  if (!returns || !returns.type || returns.type === 'null') {
    return null;
  }

  const schema = {};

  switch (returns.type) {
    case 'array':
      schema.type = 'array';
      if (returns.items) {
        schema.items = buildReturnItemsSchema(returns.items);
      } else if (returns.links) {
        schema.items = { type: 'object' };
      } else {
        schema.items = { type: 'object' };
      }
      break;
    case 'object':
      schema.type = 'object';
      if (returns.properties) {
        schema.properties = {};
        for (const [propName, propDef] of Object.entries(returns.properties)) {
          schema.properties[propName] = buildReturnPropertySchema(propDef);
        }
      }
      break;
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      schema.type = returns.type;
      break;
    default:
      schema.type = 'string';
  }

  if (returns.description) schema.description = returns.description;
  return schema;
}

function buildReturnItemsSchema(items) {
  if (!items) return { type: 'object' };

  const schema = { type: mapType(items.type || 'object') };

  if (items.properties) {
    schema.properties = {};
    for (const [propName, propDef] of Object.entries(items.properties)) {
      schema.properties[propName] = buildReturnPropertySchema(propDef);
    }
  }

  return schema;
}

function buildReturnPropertySchema(propDef) {
  const schema = { type: mapType(propDef.type || 'string') };
  if (propDef.description) schema.description = propDef.description;
  if (propDef.enum) schema.enum = propDef.enum;
  if (propDef.format && typeof propDef.format === 'string') {
    Object.assign(schema, formatToSchema(propDef.format));
  }
  if (propDef.minimum !== undefined) schema.minimum = propDef.minimum;
  if (propDef.maximum !== undefined) schema.maximum = propDef.maximum;
  if (propDef.optional) schema['x-optional'] = true;
  if (propDef.properties) {
    schema.properties = {};
    for (const [name, def] of Object.entries(propDef.properties)) {
      schema.properties[name] = buildReturnPropertySchema(def);
    }
  }
  if (propDef.items) {
    schema.items = buildReturnItemsSchema(propDef.items);
  }
  return schema;
}

// ─── Build permissions description ──────────────────────────────────────────

function describePermissions(permissions) {
  if (!permissions) return null;
  if (permissions.description) return permissions.description;
  if (permissions.user === 'all') return 'Accessible by all authenticated users.';
  if (permissions.user === 'world') return 'Accessible without authentication.';
  if (permissions.check) {
    return `Permission check: ${JSON.stringify(permissions.check)}`;
  }
  return null;
}

// ─── Build OpenAPI spec ─────────────────────────────────────────────────────

function generateSpec(endpoints, pveVersion) {
  const versionLabel = pveVersion ? `PVE ${pveVersion}.x` : 'latest';

  const spec = {
    openapi: '3.0.3',
    info: {
      title: `${product.title}${pveVersion ? ` (${product.abbr} ${pveVersion})` : ''}`,
      description: `${product.name} REST API specification.\n\n` +
        `Generated from the official Proxmox apidoc.js` +
        (formatRegistry ? ` with validation rules extracted from Perl source across 11 Proxmox repositories` : '') +
        `.\n\n` +
        `This spec includes x-since-version extensions on endpoints and parameters ` +
        `to indicate when each was introduced.`,
      version: pveVersion ? `${pveVersion}.0` : (api.meta.docs_version || '0.0'),
      contact: {
        name: 'Proxmox',
        url: 'https://www.proxmox.com',
      },
      license: {
        name: 'AGPL-3.0',
        url: 'https://www.gnu.org/licenses/agpl-3.0.html',
      },
      'x-source-sha256': api.meta.source_sha256 || null,
      'x-total-endpoints': endpoints.length,
    },
    servers: [
      {
        url: 'https://{host}:{port}/api2/json',
        description: `${product.name} API server`,
        variables: {
          host: {
            default: 'localhost',
            description: `${product.abbr} host address`,
          },
          port: {
            default: product.port,
            description: `${product.abbr} API port`,
          },
        },
      },
    ],
    security: [
      { apiToken: [] },
      { cookie: [] },
    ],
    paths: {},
    components: {
      securitySchemes: {
        apiToken: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: `${product.abbr} API token in format: ${product.tokenPrefix}=USER@REALM!TOKENID=SECRET`,
        },
        cookie: {
          type: 'apiKey',
          in: 'cookie',
          name: product.cookie,
          description: 'PVE authentication cookie obtained via POST /access/ticket',
        },
      },
      schemas: {},
    },
    tags: [],
  };

  // Build tags from functional areas
  const areaDescriptions = {
    vms: 'QEMU/KVM Virtual Machines',
    containers: 'LXC Containers',
    storage: 'Storage (node-level)',
    storage_config: 'Storage Configuration (cluster-level)',
    networking: 'Network Configuration',
    firewall: 'Firewall Rules and Configuration',
    cluster: 'Cluster Management',
    cluster_config: 'Cluster Configuration',
    nodes: 'Node Management',
    access: 'Authentication and Access Control',
    users: 'User Management',
    access_groups: 'Group Management',
    roles: 'Role Management',
    acl: 'Access Control Lists',
    access_domains: 'Authentication Domains',
    pools: 'Resource Pools',
    sdn: 'Software Defined Networking',
    ha: 'High Availability',
    backup: 'Backup and Restore',
    replication: 'Storage Replication',
    ceph: 'Ceph Storage',
    disks: 'Disk Management',
    apt: 'Package Management',
    services: 'System Services',
    certificates: 'TLS Certificates',
    tasks: 'Task Management',
    acme: 'ACME Certificate Management',
    metrics: 'Metrics and Monitoring',
    version: 'Version Information',
    other: 'Other',
  };

  const usedAreas = new Set(endpoints.map(e => e.functional_area));
  for (const area of [...usedAreas].sort()) {
    spec.tags.push({
      name: area,
      description: areaDescriptions[area] || area,
    });
  }

  // Build paths
  for (const ep of endpoints) {
    // Convert PVE path params {node} to OpenAPI {node}
    const oaPath = ep.path;

    if (!spec.paths[oaPath]) {
      spec.paths[oaPath] = {};
    }

    const method = ep.method.toLowerCase();
    const operation = {
      tags: [ep.functional_area],
      summary: ep.description || `${ep.method} ${ep.path}`,
      operationId: buildOperationId(ep),
      'x-functional-area': ep.functional_area,
    };
    if (ep.since_version) operation['x-since-version'] = ep.since_version;
    if (ep.since_date) operation['x-since-date'] = ep.since_date;
    if (ep.since_pve_major) operation['x-since-pve-major'] = ep.since_pve_major;

    if (ep.deprecated) {
      operation.deprecated = true;
    }

    if (ep.protected) {
      operation['x-protected'] = true;
    }

    // Permissions
    const permDesc = describePermissions(ep.permissions);
    if (permDesc) {
      operation['x-permissions'] = permDesc;
    }

    // Token access
    if (ep.allow_token === false) {
      operation['x-allow-token'] = false;
    }

    // Version changes
    if (ep.version_changes && ep.version_changes.length > 0) {
      operation['x-version-changes'] = ep.version_changes;
    }

    // Parameters (path + query for all methods, or path + body)
    const parameters = [];

    // Path parameters
    for (const param of ep.parameters.path_params) {
      parameters.push({
        name: param.name,
        in: 'path',
        required: true,
        description: param.description || undefined,
        schema: buildParamSchema(param),
      });
    }

    // Query parameters
    for (const param of ep.parameters.query_params) {
      parameters.push({
        name: param.name,
        in: 'query',
        required: !param.optional,
        description: param.description || undefined,
        schema: buildParamSchema(param),
      });
    }

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Request body (for POST/PUT)
    if (ep.parameters.body_params.length > 0) {
      const bodyProperties = {};
      const bodyRequired = [];

      for (const param of ep.parameters.body_params) {
        bodyProperties[param.name] = buildParamSchema(param);
        if (param.description) {
          bodyProperties[param.name].description = param.description;
        }
        if (!param.optional) {
          bodyRequired.push(param.name);
        }
      }

      operation.requestBody = {
        required: bodyRequired.length > 0,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: bodyProperties,
            },
          },
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              properties: bodyProperties,
            },
          },
        },
      };

      if (bodyRequired.length > 0) {
        operation.requestBody.content['application/json'].schema.required = bodyRequired;
        operation.requestBody.content['application/x-www-form-urlencoded'].schema.required = bodyRequired;
      }
    }

    // Responses
    operation.responses = {
      '200': {
        description: 'Successful response',
      },
    };

    const returnSchema = buildReturnsSchema(ep.returns);
    if (returnSchema) {
      // PVE wraps all responses in { data: ... }
      operation.responses['200'].content = {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: returnSchema,
            },
          },
        },
      };
    }

    // Add standard error responses
    operation.responses['400'] = {
      description: 'Bad request — invalid parameters',
      content: {
        'application/json': {
          schema: { '$ref': '#/components/schemas/ErrorResponse' },
        },
      },
    };
    operation.responses['401'] = {
      description: 'Authentication required',
    };
    operation.responses['403'] = {
      description: 'Permission denied',
    };
    if (ep.protected) {
      operation.responses['500'] = {
        description: 'Server error (protected endpoint — requires root access)',
      };
    }

    spec.paths[oaPath][method] = operation;
  }

  // Add common schemas
  spec.components.schemas.ErrorResponse = {
    type: 'object',
    properties: {
      errors: {
        type: 'object',
        description: 'Map of parameter names to error messages',
        additionalProperties: { type: 'string' },
      },
      data: {
        description: 'null on error',
        nullable: true,
      },
      status: {
        type: 'integer',
        description: 'HTTP status code',
      },
      message: {
        type: 'string',
        description: 'Error message',
      },
    },
  };

  // Add format schemas to components for reference
  if (formatRegistry) {
    const formatSchemas = {};
    for (const [name, fmt] of Object.entries(formatRegistry.formats)) {
      const schema = { type: 'string' };
      if (fmt.description) schema.description = fmt.description;
      if (fmt.pattern) schema.pattern = fmt.pattern;
      if (fmt.enum) schema.enum = fmt.enum;
      if (fmt.since_version) schema['x-since-version'] = fmt.since_version;
      if (fmt.since_pve_major) schema['x-since-pve-major'] = fmt.since_pve_major;
      if (fmt.validation) schema['x-validation-type'] = fmt.validation;
      if (fmt.source_repo) schema['x-source-repo'] = fmt.source_repo;
      // Only include formats that have real validation
      if (fmt.pattern || fmt.enum || fmt.properties) {
        formatSchemas[`format-${name}`] = schema;
      }
    }
    Object.assign(spec.components.schemas, formatSchemas);
  }

  return spec;
}

// ─── Operation ID generation ────────────────────────────────────────────────

function buildOperationId(ep) {
  // Convert "POST /nodes/{node}/qemu/{vmid}/status/start"
  // to "postNodesQemuStatusStart"
  const method = ep.method.toLowerCase();
  const parts = ep.path
    .split('/')
    .filter(Boolean)
    .filter(p => !p.startsWith('{'))
    .map((p, i) => {
      // camelCase each segment
      return p.split(/[-_]/).map((w, j) => {
        if (i === 0 && j === 0) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
      }).join('');
    });

  const pathPart = parts.map((p, i) =>
    i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)
  ).join('');

  return method + pathPart.charAt(0).toUpperCase() + pathPart.slice(1);
}

// ─── Simple YAML conversion ────────────────────────────────────────────────

function jsonToYaml(obj, indent) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  let out = '';

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        out += `${pad}-\n${jsonToYaml(item, indent + 1).replace(/^( *)/, '$1  ')}`;
      } else {
        out += `${pad}- ${yamlScalar(item)}\n`;
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined) continue;
      if (val === null) {
        out += `${pad}${yamlKey(key)}: null\n`;
      } else if (typeof val === 'object') {
        if (Array.isArray(val) && val.length === 0) {
          out += `${pad}${yamlKey(key)}: []\n`;
        } else if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) {
          out += `${pad}${yamlKey(key)}: {}\n`;
        } else {
          out += `${pad}${yamlKey(key)}:\n${jsonToYaml(val, indent + 1)}`;
        }
      } else {
        out += `${pad}${yamlKey(key)}: ${yamlScalar(val)}\n`;
      }
    }
  }
  return out;
}

function yamlKey(key) {
  if (/[:#{}[\],&*?|>!%@`]/.test(key) || /^\d/.test(key)) return `'${key}'`;
  return key;
}

function yamlScalar(val) {
  if (typeof val === 'string') {
    if (val === '' || val === 'true' || val === 'false' || val === 'null' ||
        /[:#{}[\],&*?|>!%@`\n]/.test(val) || /^\d/.test(val)) {
      return `'${val.replace(/'/g, "''")}'`;
    }
    return val;
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  return String(val);
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const startTime = Date.now();

  if (allVersions) {
    // Generate per-major-version specs
    for (const ver of [4, 5, 6, 7, 8, 9]) {
      const filtered = api.endpoints.filter(ep => {
        const major = ep.since_pve_major;
        return !major || major <= ver;
      });
      if (filtered.length === 0) continue;

      currentTargetVersion = ver;
      const spec = generateSpec(filtered, ver);
      const verOutputPath = outputPath.replace(/\.json$/, `.pve${ver}.json`);
      const json = compact ? JSON.stringify(spec) : JSON.stringify(spec, null, 2);
      fs.writeFileSync(verOutputPath, json, 'utf8');
      log(`PVE ${ver}: ${filtered.length} endpoints → ${verOutputPath}`);

      if (hasFlag('--yaml')) {
        const yamlPath = verOutputPath.replace(/\.json$/, '.yaml');
        fs.writeFileSync(yamlPath, jsonToYaml(spec), 'utf8');
      }
    }
  }

  if (targetVersion) {
    // Generate for specific version
    const filtered = api.endpoints.filter(ep => {
      const major = ep.since_pve_major;
      return !major || major <= targetVersion;
    });
    currentTargetVersion = targetVersion;
    const spec = generateSpec(filtered, targetVersion);
    const json = compact ? JSON.stringify(spec) : JSON.stringify(spec, null, 2);
    fs.writeFileSync(outputPath, json, 'utf8');
    log(`PVE ${targetVersion}: ${filtered.length} endpoints → ${outputPath}`);

    if (hasFlag('--yaml')) {
      const yamlPath = outputPath.replace(/\.json$/, '.yaml');
      fs.writeFileSync(yamlPath, jsonToYaml(spec), 'utf8');
    }
  } else if (!allVersions) {
    // Generate current/latest spec
    currentTargetVersion = null;
    const spec = generateSpec(api.endpoints, null);
    const json = compact ? JSON.stringify(spec) : JSON.stringify(spec, null, 2);
    fs.writeFileSync(outputPath, json, 'utf8');
    log(`Latest: ${api.endpoints.length} endpoints → ${outputPath}`);

    if (hasFlag('--yaml')) {
      const yamlPath = outputPath.replace(/\.json$/, '.yaml');
      fs.writeFileSync(yamlPath, jsonToYaml(spec), 'utf8');
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done in ${elapsed}s`);

  // Print stats
  if (allVersions) {
    console.log('\nOpenAPI specs generated for PVE 4-9');
    for (const ver of [4, 5, 6, 7, 8, 9]) {
      const p = outputPath.replace(/\.json$/, `.pve${ver}.json`);
      if (fs.existsSync(p)) {
        const sz = (fs.statSync(p).size / 1024 / 1024).toFixed(1);
        const cnt = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).paths).length;
        console.log(`  PVE ${ver}: ${cnt} paths, ${sz} MB → ${path.basename(p)}`);
      }
    }
  } else if (fs.existsSync(outputPath)) {
    const spec = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const pathCount = Object.keys(spec.paths).length;
    const fileSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`\nOpenAPI spec generated:`);
    console.log(`  Paths: ${pathCount}`);
    console.log(`  File size: ${fileSize} MB`);
    console.log(`  Output: ${outputPath}`);
  }
}

main();
