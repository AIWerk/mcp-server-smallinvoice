#!/usr/bin/env node
// Generates src/tools/generated.ts from:
//   - smallinvoice-tool-naming.json (146 ops with tool_name, method, path, annotations)
//   - smallinvoice-swagger-v2.0.0.json (parameter + body definitions)
//
// Usage: node scripts/generate-tools.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const SWAGGER_PATH = join(root, '../aiwerkmcp.com/brian-agent/docs/research/smallinvoice-swagger-v2.0.0.json');
const NAMING_PATH = join(root, '../aiwerkmcp.com/brian-agent/docs/research/smallinvoice-tool-naming.json');
const OUT_PATH = join(root, 'src/tools/generated.ts');

const swagger = JSON.parse(readFileSync(SWAGGER_PATH, 'utf-8'));
const namingData = JSON.parse(readFileSync(NAMING_PATH, 'utf-8'));
const ops = namingData.operations;

// Resolve $ref in swagger
function resolveRef(ref, spec) {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (const p of parts) node = node[p];
  return node;
}

// camelCase from snake_case
function toCamel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// PascalCase from snake_case
function toPascal(snake) {
  const c = toCamel(snake);
  return c[0].toUpperCase() + c.slice(1);
}

// camelCase: invoiceId → invoice_id
function toSnake(camel) {
  return camel.replace(/([A-Z])/g, (_, c) => `_${c.toLowerCase()}`);
}

// "vat_rate" → "Vat rate", "name" → "Name"
function humanize(snakeName) {
  return snakeName.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// Extract path template params: '/invoices/{invoiceId}/payments/{paymentId}' → ['invoiceId', 'paymentId']
function extractPathParams(path) {
  const matches = path.match(/\{([^}]+)\}/g) ?? [];
  return matches.map(m => m.slice(1, -1));
}

// Resolve a shared parameter by $ref
function resolveParam(param) {
  if (param.$ref) return resolveRef(param.$ref, swagger);
  return param;
}

// Get Swagger type → Zod type string. fieldName used for humanize fallback.
function swaggerTypeToZod(prop, required = false, fieldName = '') {
  const type = prop.type;
  const rawDesc = (prop.description ?? '').trim();
  const desc = (rawDesc || humanize(fieldName)).replace(/'/g, "\\'").replace(/\n/g, ' ');
  const descStr = `.describe('${desc}')`;
  const optStr = required ? '' : '.optional()';

  if (type === 'integer') return `z.number().int()${optStr}${descStr}`;
  if (type === 'number') return `z.number()${optStr}${descStr}`;
  if (type === 'boolean') return `z.boolean()${optStr}${descStr}`;
  if (type === 'array') return `z.array(z.unknown())${optStr}${descStr}`;
  if (type === 'object') return `z.record(z.string(), z.unknown())${optStr}${descStr}`;
  // default to string
  return `z.string()${optStr}${descStr}`;
}

// Build Zod object entries from a swagger definition
function buildBodySchema(defName) {
  const def = swagger.definitions?.[defName];
  if (!def || !def.properties) return [];
  const required = new Set(def.required ?? []);
  const entries = [];
  for (const [propName, prop] of Object.entries(def.properties)) {
    const snakeProp = /^[a-z_]+$/.test(propName) ? propName : propName;
    const zodType = swaggerTypeToZod(prop, required.has(propName), propName);
    entries.push(`  ${snakeProp}: ${zodType}`);
  }
  return entries;
}

// Build Zod schema fields for all params of an operation.
// Also returns pathFieldMap: {urlPlaceholder → snake_field_name} for use in buildPathExpr.
function buildSchemaFields(swaggerPath, method, op) {
  const fields = [];
  const params = op.parameters ?? [];
  const bodyFields = [];
  // Map from URL placeholder name → snake field name, using swagger param 'name' field
  const pathFieldMap = {};

  // Build placeholder → fieldName map using POSITIONAL matching.
  // Swagger path params and URL placeholders appear in the same order,
  // but their names can differ (e.g., {reminderIds} vs param.name='remindersIds').
  const urlPlaceholders = extractPathParams(swaggerPath);
  const swaggerPathParams = params
    .map(resolveParam)
    .filter(p => p && p.in === 'path');
  for (let i = 0; i < urlPlaceholders.length; i++) {
    const ph = urlPlaceholders[i];
    // Use the swagger param at the same position, fall back to toSnake of placeholder
    const swaggerParam = swaggerPathParams[i];
    pathFieldMap[ph] = swaggerParam ? toSnake(swaggerParam.name) : toSnake(ph);
  }

  for (const rawParam of params) {
    const param = resolveParam(rawParam);
    if (!param) continue;

    if (param.in === 'path') {
      const snakeName = toSnake(param.name);
      const desc = (param.description ?? param.name).replace(/'/g, "\\'");
      // Plural param names (e.g. {categoryIds}, {productIds}) are comma-separated strings
      const isPlural = /ids$/i.test(param.name) && param.name.toLowerCase() !== 'ids';
      if (param.type === 'integer' && !isPlural) {
        fields.push(`  ${snakeName}: z.number().int().describe('${desc}')`);
      } else {
        fields.push(`  ${snakeName}: z.string().describe('${desc}')`);
      }
    } else if (param.in === 'query') {
      const snakeName = toSnake(param.name);
      const rawDesc = (param.description ?? '').trim();
      const desc = (rawDesc || humanize(snakeName)).replace(/'/g, "\\'");
      const zodBase = param.type === 'integer' ? 'z.number().int()' : 'z.string()';
      fields.push(`  ${snakeName}: ${zodBase}.optional().describe('${desc}')`);
    } else if (param.in === 'body') {
      // Resolve body schema
      const schema = param.schema ?? {};
      const ref = schema.$ref;
      if (ref) {
        const defName = ref.split('/').pop();
        bodyFields.push(...buildBodySchema(defName));
      }
    }
  }

  // Body fields go after path/query params
  fields.push(...bodyFields);
  return { fields, pathFieldMap };
}

// Build the URL template expression for a path, using a mapping of urlPlaceholder → fieldName.
// The map comes from swagger param definitions so we use the param's actual 'name' field,
// not the URL placeholder (which can differ in the swagger, e.g. {reminderIds} vs name:'remindersIds').
function buildPathExpr(swaggerPath, pathFieldMap) {
  return swaggerPath.replace(/\{([^}]+)\}/g, (_, urlPlaceholder) => {
    // Look up the field name from the map; fall back to toSnake of the placeholder
    const fieldName = pathFieldMap?.[urlPlaceholder] ?? toSnake(urlPlaceholder);
    return `\${args.${fieldName}}`;
  });
}

// POST sub-resource tools that modify a parent entity's state → snapshot the parent before creating.
// Generic POSTs that CREATE a new top-level entity have no pre-state to snapshot.
const POST_PARENT_SNAPSHOT_TOOLS = new Set([
  'create_contact_account',
  'create_contact_address',
  'create_contact_person',
  'record_invoice_payment',
]);

// Build the client call for each operation.
// pathFieldMap: {urlPlaceholder → snake_field_name} for consistent arg references.
function buildClientCall(op, swaggerPath, method, pathParams, queryParams, hasBody, camelName, action, pathFieldMap) {
  const pathExpr = buildPathExpr(swaggerPath, pathFieldMap);
  const usesTemplate = swaggerPath.includes('{');
  const pathArg = usesTemplate ? `\`${pathExpr}\`` : `'${swaggerPath}'`;

  // Helper: get the snake field name for a URL placeholder
  const fieldOf = ph => pathFieldMap?.[ph] ?? toSnake(ph);
  const pathFieldNames = pathParams.map(fieldOf);

  if (action === 'pdf') {
    // Find the ID param (singular, not plural) before /pdf
    const idPh = [...pathParams].reverse().find(p => {
      const f = fieldOf(p);
      return !f.endsWith('_ids');
    });
    const idArg = idPh ? `args.${fieldOf(idPh)}` : `'unknown'`;
    return `  return client.getPdf(${pathArg}, ${idArg});`;
  }

  if (method === 'GET') {
    if (pathParams.length === 0 && queryParams.length === 0) {
      return `  return client.get(${pathArg});`;
    }
    if (pathParams.length === 0 && queryParams.length > 0) {
      return `  return client.get(${pathArg}, args as Record<string, string | number | boolean | undefined | null>);`;
    }
    return `  const { ${pathFieldNames.join(', ')}, ...query } = args;\n  return client.get(${pathArg}, query as Record<string, string | number | boolean | undefined | null>);`;
  }

  if (method === 'DELETE') {
    if (pathParams.length === 0) {
      return `  return client.delete(${pathArg});`;
    }
    const lastPh = pathParams[pathParams.length - 1];
    const isPlural = /ids$/i.test(lastPh) && lastPh.toLowerCase() !== 'ids';
    const lastFieldName = fieldOf(lastPh);
    // Build entity path template: last placeholder → ${id}, preceding ones → ${args.field}
    const entityPathTemplate = swaggerPath.replace(/\{([^}]+)\}/g, (_, ph) => {
      if (ph === lastPh) return '${id}';
      return `\${args.${fieldOf(ph)}}`;
    });
    const idsExpr = isPlural
      ? `String(args.${lastFieldName}).split(',').map(s => s.trim()).filter(Boolean)`
      : `[args.${lastFieldName}]`;
    // Use string concatenation to avoid premature template-literal expansion in the codegen
    const entityPathFnStr = '(id) => `' + entityPathTemplate + '`';
    const snapshotArg = `{ toolName: '${camelName}', ids: ${idsExpr}, entityPathFn: ${entityPathFnStr} }`;
    return `  return client.delete(${pathArg}, ${snapshotArg});`;
  }

  if (method === 'POST') {
    if (!hasBody) return `  return client.post(${pathArg});`;

    // Sub-resource POST tools that mutate a parent entity — snapshot the parent first
    if (POST_PARENT_SNAPSHOT_TOOLS.has(op.tool_name)) {
      const parentIdPh = pathParams.find(p => /Id$/i.test(p) && !/Ids$/i.test(p));
      if (parentIdPh) {
        const parentFieldName = fieldOf(parentIdPh);
        const parentPlaceholder = `{${parentIdPh}}`;
        const parentPathTemplate = swaggerPath.substring(0, swaggerPath.indexOf(parentPlaceholder) + parentPlaceholder.length);
        const entityPathExpr = buildPathExpr(parentPathTemplate, pathFieldMap);
        const snapshotArg = `, { toolName: '${camelName}', id: args.${parentFieldName}, entityPath: \`${entityPathExpr}\` }`;
        if (pathParams.length === 0) {
          return `  return client.post(${pathArg}, args${snapshotArg});`;
        }
        return `  const { ${pathFieldNames.join(', ')}, ...body } = args;\n  return client.post(${pathArg}, body${snapshotArg});`;
      }
    }

    if (pathParams.length === 0) {
      return `  return client.post(${pathArg}, args);`;
    }
    return `  const { ${pathFieldNames.join(', ')}, ...body } = args;\n  return client.post(${pathArg}, body);`;
  }

  if (method === 'PUT') {
    const idPh = pathParams.find(p => p.endsWith('Id'));
    const snakeId = idPh ? fieldOf(idPh) : null;
    const snapshotArg = snakeId ? `, { toolName: '${camelName}', id: args.${snakeId} }` : '';
    if (pathParams.length === 0) {
      return `  return client.put(${pathArg}, args${snapshotArg});`;
    }
    return `  const { ${pathFieldNames.join(', ')}, ...body } = args;\n  return client.put(${pathArg}, body${snapshotArg});`;
  }

  if (method === 'PATCH') {
    if (action === 'assign-groups' || action === 'remove-groups') {
      // Snapshot the parent entity (e.g. /contacts/{contactId}) before modifying its groups
      const parentIdPh = pathParams.find(p => /Id$/i.test(p) && !/Ids$/i.test(p));
      const parentFieldName = parentIdPh ? fieldOf(parentIdPh) : null;
      if (parentFieldName) {
        const parentPlaceholder = `{${parentIdPh}}`;
        const parentPathTemplate = swaggerPath.substring(0, swaggerPath.indexOf(parentPlaceholder) + parentPlaceholder.length);
        const entityPathExpr = buildPathExpr(parentPathTemplate, pathFieldMap);
        const snapshotArg = `, { toolName: '${camelName}', id: args.${parentFieldName}, entityPath: \`${entityPathExpr}\` }`;
        return `  return client.patch(${pathArg}, undefined${snapshotArg});`;
      }
      return `  return client.patch(${pathArg}, undefined);`;
    }

    if (action === 'change-status') {
      const idPh = pathParams.find(p => p.endsWith('Id'));
      const snakeId = idPh ? fieldOf(idPh) : null;
      const entityBasePath = swaggerPath.replace(/\/change-status.*$/, '');
      const entityPathExpr = buildPathExpr(entityBasePath, pathFieldMap);
      const snapshotArg = snakeId
        ? `, { toolName: '${camelName}', id: args.${snakeId}, entityPath: \`${entityPathExpr}\` }`
        : '';
      if (pathParams.length === 0) {
        return `  return client.patch(${pathArg}, args${snapshotArg});`;
      }
      return `  const { ${pathFieldNames.join(', ')}, ...body } = args;\n  return client.patch(${pathArg}, body${snapshotArg});`;
    }

    if (action === 'send-by-email' || action === 'send-by-post') {
      const idPh = pathParams.find(p => p.endsWith('Id'));
      const snakeId = idPh ? fieldOf(idPh) : null;
      const entityBasePath = swaggerPath.replace(/\/send-by-(email|post).*$/, '');
      const entityPathExpr = buildPathExpr(entityBasePath, pathFieldMap);
      const snapshotArg = snakeId
        ? `, { toolName: '${camelName}', id: args.${snakeId}, entityPath: \`${entityPathExpr}\` }`
        : '';
      if (pathParams.length === 0) {
        return `  return client.patch(${pathArg}, args${snapshotArg});`;
      }
      return `  const { ${pathFieldNames.join(', ')}, ...body } = args;\n  return client.patch(${pathArg}, body${snapshotArg});`;
    }

    // Generic PATCH
    if (pathParams.length === 0) {
      return `  return client.patch(${pathArg}, args);`;
    }
    return `  const { ${pathFieldNames.join(', ')}, ...body } = args;\n  return client.patch(${pathArg}, body);`;
  }

  return `  // TODO: ${method} ${swaggerPath}\n  throw new Error('not implemented');`;
}

// Group ops by tag for section comments
const groups = {};
for (const op of ops) {
  const tag = op.tags?.[0] ?? 'Other';
  if (!groups[tag]) groups[tag] = [];
  groups[tag].push(op);
}

const lines = [
  '// AUTO-GENERATED by scripts/generate-tools.mjs — do not edit by hand.',
  '// Re-generate with: node scripts/generate-tools.mjs',
  '',
  "import { z } from 'zod';",
  "import type { SmallinvoiceClient } from '../api.js';",
  '',
];

for (const [tag, tagOps] of Object.entries(groups)) {
  lines.push(`// ========== ${tag.toUpperCase()} ==========`);
  lines.push('');

  for (const op of tagOps) {
    const { tool_name, method, path: swaggerPath, summary, action, mutating, destructive } = op;
    const camelName = toCamel(tool_name);
    const pascalName = toPascal(tool_name);

    // Get swagger operation
    const swaggerOp = swagger.paths?.[swaggerPath]?.[method.toLowerCase()];
    if (!swaggerOp) {
      console.warn(`WARNING: no swagger op for ${method} ${swaggerPath}`);
    }

    const params = swaggerOp?.parameters ?? [];
    const pathParams = extractPathParams(swaggerPath);
    const queryParams = params.filter(p => {
      const resolved = resolveParam(p);
      return resolved?.in === 'query';
    });
    const hasBody = params.some(p => {
      const resolved = resolveParam(p);
      return resolved?.in === 'body';
    });

    const { fields: schemaFields, pathFieldMap } = buildSchemaFields(swaggerPath, method, swaggerOp ?? { parameters: [] });

    // Build schema
    lines.push(`export const ${camelName}Input = z.object({`);
    if (schemaFields.length > 0) {
      lines.push(...schemaFields.map(f => f + ','));
    }
    lines.push('});');

    // Build function
    const clientCall = buildClientCall(op, swaggerPath, method, pathParams, queryParams, hasBody, camelName, action, pathFieldMap);
    lines.push(`export async function ${camelName}(client: SmallinvoiceClient, args: z.infer<typeof ${camelName}Input>): Promise<unknown> {`);
    lines.push(clientCall);
    lines.push('}');
    lines.push('');
  }
}

// Export all tool names for registration
lines.push('// All tool definitions for server registration');
lines.push('// eslint-disable-next-line @typescript-eslint/no-explicit-any');
lines.push('export const ALL_TOOLS: Array<{ name: string; description: string; inputSchema: import(\'zod\').ZodTypeAny; handler: (client: SmallinvoiceClient, args: any) => Promise<unknown>; readOnlyHint: boolean; destructiveHint: boolean; }> = [');
for (const op of ops) {
  const { tool_name, summary, mutating, destructive, action } = op;
  const camelName = toCamel(tool_name);
  const isReadOnly = !mutating;
  const isDestructive = destructive;
  const actionNote = action === 'send-by-email' ? ' (SENDS REAL EMAIL — irreversible)'
    : action === 'send-by-post' ? ' (SENDS BY POST — irreversible)'
    : '';
  lines.push(`  {`);
  lines.push(`    name: '${tool_name}',`);
  lines.push(`    description: '${(summary + actionNote).replace(/'/g, "\\'")}',`);
  lines.push(`    inputSchema: ${camelName}Input,`);
  lines.push(`    handler: ${camelName},`);
  lines.push(`    readOnlyHint: ${isReadOnly},`);
  lines.push(`    destructiveHint: ${isDestructive},`);
  lines.push(`  },`);
}
lines.push('];');
lines.push('');

const output = lines.join('\n');
writeFileSync(OUT_PATH, output);
console.log(`Generated ${OUT_PATH} (${ops.length} tools, ${output.split('\n').length} lines)`);
