#!/usr/bin/env node
/**
 * Zero-dependency validator for Nuxx BaaS manifest (`nuxx.json`).
 * Mirrors `services/core-api/src/nuxx-db/dto/nuxx-json.schema.ts` + MongoDB $lookup integrity rules.
 *
 * Usage:
 *   node validate-nuxx-json.mjs [path/to/nuxx.json]
 */

import fs from 'node:fs';
import path from 'node:path';

const targetArg = process.argv[2] || './nuxx.json';
const resolvedPath = path.resolve(process.cwd(), targetArg);

const VALID_COLUMN_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'objectId',
  'array',
  'object',
]);

const TYPE_SUGGESTIONS = {
  int: 'number',
  integer: 'number',
  float: 'number',
  decimal: 'number',
  double: 'number',
  text: 'string',
  varchar: 'string',
  uuid: 'string',
  email: 'string',
  url: 'string',
  json: 'object',
  jsonb: 'object',
  map: 'object',
  timestamp: 'date',
  datetime: 'date',
  bool: 'boolean',
  id: 'objectId',
  oid: 'objectId',
};

const RESERVED_TABLE_NAMES = new Set([
  'users',
  'workspaces',
  'brands',
  '__tombstones',
]);

const ALLOWED_ROOT_KEYS = new Set([
  'description',
  'agentHints',
  'archive',
  'pwa',
  'tables',
  'roles',
]);

const ALLOWED_ARCHIVE_KEYS = new Set([
  'rootTables',
  'fileExtension',
  'aiContext',
]);

const ALLOWED_PWA_KEYS = new Set([
  'enabled',
  'name',
  'shortName',
  'description',
  'themeColor',
  'backgroundColor',
  'preloadTables',
]);

const ALLOWED_HINTS_KEYS = new Set([
  'summary',
  'workflows',
  'readOnlyTables',
]);

const errors = [];
const warnings = [];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

if (!fs.existsSync(resolvedPath)) {
  console.error(`❌ [nuxx.json] Archivo no encontrado: ${resolvedPath}`);
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(resolvedPath, 'utf8');
} catch (err) {
  console.error(`❌ [nuxx.json] No se pudo leer ${resolvedPath}: ${err.message}`);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (err) {
  console.error(`❌ [nuxx.json] JSON inválido en ${resolvedPath}: ${err.message}`);
  process.exit(1);
}

if (!isPlainObject(doc)) {
  console.error('❌ [nuxx.json] La raíz debe ser un objeto JSON.');
  process.exit(1);
}

for (const key of Object.keys(doc)) {
  if (!ALLOWED_ROOT_KEYS.has(key)) {
    warnings.push(
      `Propiedad raíz desconocida "${key}" (será ignorada por Zod al sincronizar). Permitidas: ${[...ALLOWED_ROOT_KEYS].join(', ')}.`
    );
  }
}

if (doc.description !== undefined && typeof doc.description !== 'string') {
  errors.push('`description` debe ser un string.');
}

// Validate tables
const declaredTables = new Map(); // tableName -> Map<colName, colType>

if (!Array.isArray(doc.tables) || doc.tables.length === 0) {
  errors.push('`tables` debe ser un arreglo con al menos 1 tabla.');
} else {
  doc.tables.forEach((table, tIdx) => {
    const tPath = `tables[${tIdx}]`;
    if (!isPlainObject(table)) {
      errors.push(`${tPath}: debe ser un objeto.`);
      return;
    }

    const { tableName, description, columns, foreignKeys, requiresAuth } = table;
    if (typeof tableName !== 'string' || tableName.trim().length === 0) {
      errors.push(`${tPath}.tableName: debe ser un string no vacío.`);
      return;
    }

    const label = `tables[${tIdx}:"${tableName}"]`;

    if (RESERVED_TABLE_NAMES.has(tableName)) {
      if (tableName === 'users') {
        errors.push(
          `${label}: "users" es una colección reservada gestionada por Nuxx Auth (nuxx_db_users). Elimínala de \`tables\` (sí puedes apuntar un foreignKey a foreignTable: "users").`
        );
      } else {
        errors.push(`${label}: "${tableName}" es un nombre de tabla reservado por el motor.`);
      }
    }

    if (declaredTables.has(tableName)) {
      errors.push(`${label}: nombre de tabla duplicado "${tableName}".`);
    }

    if (description !== undefined && typeof description !== 'string') {
      errors.push(`${label}.description: debe ser un string.`);
    }
    if (requiresAuth !== undefined && typeof requiresAuth !== 'boolean') {
      errors.push(`${label}.requiresAuth: debe ser booleano (true/false).`);
    }

    const colMap = new Map();
    if (columns !== undefined && !Array.isArray(columns)) {
      errors.push(`${label}.columns: debe ser un arreglo.`);
    } else if (Array.isArray(columns)) {
      columns.forEach((col, cIdx) => {
        const cPath = `${label}.columns[${cIdx}]`;
        if (!isPlainObject(col)) {
          errors.push(`${cPath}: debe ser un objeto.`);
          return;
        }
        if (typeof col.name !== 'string' || col.name.trim().length === 0) {
          errors.push(`${cPath}.name: debe ser un string no vacío.`);
          return;
        }
        if (colMap.has(col.name)) {
          errors.push(`${cPath}: columna duplicada "${col.name}".`);
        }
        if (!VALID_COLUMN_TYPES.has(col.type)) {
          const hint = TYPE_SUGGESTIONS[String(col.type || '').toLowerCase()];
          errors.push(
            `${cPath} ("${col.name}"): tipo inválido "${col.type}". Tipos permitidos: ${[...VALID_COLUMN_TYPES].join(', ')}.${hint ? ` ¿Quisiste usar "${hint}"?` : ''}`
          );
        }
        if (col.required !== undefined && typeof col.required !== 'boolean') {
          errors.push(`${cPath} ("${col.name}").required: debe ser booleano.`);
        }
        if (col.description !== undefined && typeof col.description !== 'string') {
          errors.push(`${cPath} ("${col.name}").description: debe ser un string.`);
        }
        if (col.enum !== undefined) {
          if (!Array.isArray(col.enum) || col.enum.length === 0) {
            errors.push(
              `${cPath} ("${col.name}").enum: debe ser un arreglo no vacío de valores string o number.`
            );
          } else {
            col.enum.forEach((val, eIdx) => {
              if (
                (typeof val !== 'string' && typeof val !== 'number') ||
                (typeof val === 'number' && !Number.isFinite(val))
              ) {
                errors.push(
                  `${cPath} ("${col.name}").enum[${eIdx}]: debe ser string o number finito.`
                );
              }
            });
          }
        }

        if (col.name === '_id' && col.required === true) {
          errors.push(
            `${cPath} ("_id"): NO declares "_id" con required: true (rompe inserts donde _id se autogenera). Elimina "_id" de columns.`
          );
        } else if (col.name === '_id') {
          warnings.push(
            `${cPath} ("_id"): "_id" ya es gestionado automáticamente por el motor como ObjectId; no necesitas declararlo en columns.`
          );
        }

        if ((col.name === 'createdAt' || col.name === 'updatedAt') && col.required === true) {
          warnings.push(
            `${cPath} ("${col.name}"): el motor inyecta ${col.name} automáticamente; declararla required: true puede bloquear inserts que no la envíen manualmente.`
          );
        }

        colMap.set(col.name, col.type);
      });
    }

    declaredTables.set(tableName, colMap);

    if (foreignKeys !== undefined && !Array.isArray(foreignKeys)) {
      errors.push(`${label}.foreignKeys: debe ser un arreglo.`);
    }
  });

  // Second pass: validate foreignKeys referential integrity across tables
  doc.tables.forEach((table, tIdx) => {
    if (!isPlainObject(table) || !Array.isArray(table.foreignKeys)) return;
    const tableName = table.tableName;
    const label = `tables[${tIdx}:"${tableName}"]`;
    const colMap = declaredTables.get(tableName) || new Map();

    table.foreignKeys.forEach((fk, fkIdx) => {
      const fkPath = `${label}.foreignKeys[${fkIdx}]`;
      if (!isPlainObject(fk)) {
        errors.push(`${fkPath}: debe ser un objeto.`);
        return;
      }
      for (const field of ['localColumn', 'foreignTable', 'foreignColumn', 'as']) {
        if (typeof fk[field] !== 'string' || fk[field].trim().length === 0) {
          errors.push(`${fkPath}.${field}: debe ser un string no vacío.`);
        }
      }
      if (typeof fk.localColumn === 'string' && fk.localColumn.trim()) {
        if (!colMap.has(fk.localColumn)) {
          errors.push(
            `${fkPath}: localColumn "${fk.localColumn}" no existe en las columnas de "${tableName}".`
          );
        } else {
          const localType = colMap.get(fk.localColumn);
          if ((fk.foreignColumn === '_id' || !fk.foreignColumn) && localType !== 'objectId') {
            errors.push(
              `${fkPath}: localColumn "${fk.localColumn}" tiene tipo "${localType}", pero DEBE ser "objectId" al apuntar a "_id" para que MongoDB $lookup funcione.`
            );
          }
        }
      }
      if (typeof fk.foreignTable === 'string' && fk.foreignTable.trim()) {
        if (fk.foreignTable !== 'users' && !declaredTables.has(fk.foreignTable)) {
          errors.push(
            `${fkPath}: foreignTable "${fk.foreignTable}" no existe en \`tables\` (ni es "users").`
          );
        }
      }
      if (fk.as && fk.localColumn && fk.as === fk.localColumn) {
        warnings.push(
          `${fkPath}: el alias \`as: "${fk.as}"\` coincide con \`localColumn\`; usa un alias descriptivo distinto (ej. "${fk.localColumn.replace(/Id$/, '') || `${fk.as}Ref`}").`
        );
      }
    });
  });
}

// Validate roles
if (doc.roles !== undefined) {
  if (!Array.isArray(doc.roles)) {
    errors.push('`roles` debe ser un arreglo.');
  } else {
    doc.roles.forEach((role, rIdx) => {
      if (!isPlainObject(role) || typeof role.name !== 'string' || !role.name.trim()) {
        errors.push(`roles[${rIdx}]: debe ser un objeto con \`name\` (string no vacío).`);
      } else if (role.permissions !== undefined && !isPlainObject(role.permissions)) {
        errors.push(`roles[${rIdx}] ("${role.name}").permissions: debe ser un objeto.`);
      }
    });
    if (doc.roles.length > 0 && !declaredTables.has('roles')) {
      warnings.push(
        'Definiste semillas en `roles`, pero no declaraste una tabla `"tableName": "roles"` en `tables`. Declárala si planeas consultar o editar roles desde la app.'
      );
    }
  }
}

// Validate pwa
if (doc.pwa !== undefined) {
  if (!isPlainObject(doc.pwa)) {
    errors.push('`pwa` debe ser un objeto.');
  } else {
    for (const key of Object.keys(doc.pwa)) {
      if (!ALLOWED_PWA_KEYS.has(key)) {
        if (key === 'offlineTables') {
          errors.push(
            '`pwa.offlineTables` NO existe en Nuxx BaaS (Zod lo descarta). Cámbialo por `pwa.preloadTables`.'
          );
        } else {
          warnings.push(
            `\`pwa.${key}\` no forma parte de \`nuxxPwaConfigSchema\` y será descartado por el servidor (permitidos: ${[...ALLOWED_PWA_KEYS].join(', ')}).`
          );
        }
      }
    }
    if (doc.pwa.preloadTables !== undefined) {
      if (!Array.isArray(doc.pwa.preloadTables)) {
        errors.push('`pwa.preloadTables` debe ser un arreglo de strings.');
      } else {
        doc.pwa.preloadTables.forEach((tName, idx) => {
          if (typeof tName !== 'string' || !tName.trim()) {
            errors.push(`pwa.preloadTables[${idx}] debe ser un string no vacío.`);
          } else if (!declaredTables.has(tName)) {
            errors.push(
              `pwa.preloadTables[${idx}] ("${tName}") no coincide con ninguna tabla declarada en \`tables\`.`
            );
          }
        });
      }
    }
  }
}

// Validate archive
if (doc.archive !== undefined) {
  if (!isPlainObject(doc.archive)) {
    errors.push('`archive` debe ser un objeto.');
  } else {
    for (const key of Object.keys(doc.archive)) {
      if (!ALLOWED_ARCHIVE_KEYS.has(key)) {
        warnings.push(
          `\`archive.${key}\` será ignorado (permitidos: ${[...ALLOWED_ARCHIVE_KEYS].join(', ')}).`
        );
      }
    }
    if (doc.archive.rootTables !== undefined) {
      if (!Array.isArray(doc.archive.rootTables)) {
        errors.push('`archive.rootTables` debe ser un arreglo de strings.');
      } else {
        doc.archive.rootTables.forEach((tName, idx) => {
          if (typeof tName !== 'string' || !tName.trim()) {
            errors.push(`archive.rootTables[${idx}] debe ser un string no vacío.`);
          } else if (!declaredTables.has(tName)) {
            errors.push(
              `archive.rootTables[${idx}] ("${tName}") no coincide con ninguna tabla declarada en \`tables\`.`
            );
          }
        });
      }
    }
    if (
      doc.archive.fileExtension !== undefined &&
      (typeof doc.archive.fileExtension !== 'string' || !doc.archive.fileExtension.trim())
    ) {
      errors.push('`archive.fileExtension` debe ser un string no vacío.');
    }
    if (doc.archive.aiContext !== undefined && typeof doc.archive.aiContext !== 'string') {
      errors.push('`archive.aiContext` debe ser un string.');
    }
  }
}

// Validate agentHints
if (doc.agentHints !== undefined) {
  if (!isPlainObject(doc.agentHints)) {
    errors.push('`agentHints` debe ser un objeto.');
  } else {
    for (const key of Object.keys(doc.agentHints)) {
      if (!ALLOWED_HINTS_KEYS.has(key)) {
        warnings.push(`\`agentHints.${key}\` será ignorado (permitidos: summary, workflows, readOnlyTables).`);
      }
    }
    if (doc.agentHints.readOnlyTables !== undefined) {
      if (!Array.isArray(doc.agentHints.readOnlyTables)) {
        errors.push('`agentHints.readOnlyTables` debe ser un arreglo de strings.');
      } else {
        doc.agentHints.readOnlyTables.forEach((tName, idx) => {
          if (tName !== 'users' && !declaredTables.has(tName)) {
            warnings.push(
              `agentHints.readOnlyTables[${idx}] ("${tName}") no coincide con ninguna tabla en \`tables\`.`
            );
          }
        });
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn(`⚠️  Advertencias en ${path.basename(resolvedPath)} (${warnings.length}):`);
  for (const w of warnings) console.warn(`   - ${w}`);
}

if (errors.length > 0) {
  console.error(`❌ Falló la validación de ${resolvedPath} (${errors.length} error(es)):`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}

const totalCols = [...declaredTables.values()].reduce((acc, m) => acc + m.size, 0);
const totalFks = (doc.tables || []).reduce(
  (acc, t) => acc + (Array.isArray(t?.foreignKeys) ? t.foreignKeys.length : 0),
  0
);

console.log(
  `✅ nuxx.json válido (${declaredTables.size} tablas, ${totalCols} columnas, ${totalFks} foreignKeys, ${(doc.roles || []).length} roles seed).`
);
process.exit(0);
