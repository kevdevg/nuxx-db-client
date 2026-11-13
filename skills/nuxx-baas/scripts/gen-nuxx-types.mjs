#!/usr/bin/env node
/**
 * Zero-dependency TypeScript interface generator for `nuxx.json`.
 * Generates row interfaces, Insert/Update helpers, and expanded ForeignKey fields.
 *
 * Usage:
 *   node gen-nuxx-types.mjs [path/to/nuxx.json] [path/to/output.ts]
 */

import fs from 'node:fs';
import path from 'node:path';

const inputArg = process.argv[2] || './nuxx.json';
const outputArg = process.argv[3] || './src/lib/database.types.ts';

const inputPath = path.resolve(process.cwd(), inputArg);
const outputPath = path.resolve(process.cwd(), outputArg);

if (!fs.existsSync(inputPath)) {
  console.error(`❌ Archivo no encontrado: ${inputPath}`);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (!Array.isArray(schema.tables) || schema.tables.length === 0) {
  console.error('❌ nuxx.json no contiene un arreglo válido en `tables`.');
  process.exit(1);
}

function toPascalCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[a-z]/, (chr) => chr.toUpperCase());
}

function mapColumnType(type) {
  switch (type) {
    case 'string':
    case 'date':
    case 'objectId':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'unknown[]';
    case 'object':
      return 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

const tableInterfaceNames = new Map();
for (const table of schema.tables) {
  tableInterfaceNames.set(table.tableName, `${toPascalCase(table.tableName)}Row`);
}

const lines = [
  '/* eslint-disable */',
  '// Auto-generated from nuxx.json by nuxx-baas-plugin (gen-nuxx-types.mjs).',
  '// Do not edit manually; re-run the generator after updating nuxx.json.',
  '',
  'export interface NuxxUserRef {',
  '  _id: string;',
  '  name: string;',
  '  email: string;',
  '  status?: string;',
  '  roleId?: string;',
  '}',
  '',
];

for (const table of schema.tables) {
  const ifaceName = tableInterfaceNames.get(table.tableName);
  if (table.description) {
    lines.push(`/** ${table.description} */`);
  }
  lines.push(`export interface ${ifaceName} {`);
  lines.push('  _id: string;');

  const reserved = new Set(['_id', 'createdAt', 'updatedAt']);
  for (const col of table.columns || []) {
    if (reserved.has(col.name)) continue;
    const optional = col.required ? '' : '?';
    const tsType = mapColumnType(col.type);
    const comment = col.description ? ` // ${col.description}` : '';
    lines.push(`  ${col.name}${optional}: ${tsType};${comment}`);
  }

  lines.push('  createdAt?: string;');
  lines.push('  updatedAt?: string;');

  for (const fk of table.foreignKeys || []) {
    const targetType =
      fk.foreignTable === 'users'
        ? 'NuxxUserRef'
        : tableInterfaceNames.get(fk.foreignTable) || 'Record<string, unknown>';
    lines.push(`  ${fk.as}?: ${targetType} | null;`);
  }

  lines.push('}');
  lines.push(
    `export type ${toPascalCase(table.tableName)}Insert = Omit<${ifaceName}, '_id' | 'createdAt' | 'updatedAt'> & { _id?: string };`
  );
  lines.push('');
}

lines.push('export interface NuxxDatabaseTables {');
for (const table of schema.tables) {
  lines.push(`  ${JSON.stringify(table.tableName)}: ${tableInterfaceNames.get(table.tableName)};`);
}
lines.push('}');
lines.push('');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log(`✅ Tipos generados exitosamente en ${outputPath} (${schema.tables.length} tablas).`);
