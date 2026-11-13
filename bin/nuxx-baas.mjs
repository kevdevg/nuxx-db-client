#!/usr/bin/env node
/**
 * Zero-dependency CLI for `@nuxx-brandly/db-client` & `nuxx-baas` skill helpers.
 *
 * Subcommands:
 *   nuxx-baas init                      Registers `node_modules/@nuxx-brandly/db-client/skills` in `.agents/skills.json`
 *   nuxx-baas validate [nuxx.json]      Validates `nuxx.json` schema & referential integrity
 *   nuxx-baas gen-types [in] [out]      Generates TypeScript interfaces from `nuxx.json`
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ENTRY_PATH = 'node_modules/@nuxx-brandly/db-client/skills';

function normalizeSkillPath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function printHelp() {
  console.log(`Usage: nuxx-baas <command> [options]

Commands:
  init                       Link @nuxx-brandly/db-client AI skill in .agents/skills.json
  validate [file]            Validate ./nuxx.json schema, foreignKeys, and preloadTables
  gen-types [in] [out]       Generate TypeScript types from ./nuxx.json (default: ./src/lib/database.types.ts)
  help                       Show this help message
`);
}

function runInit() {
  const cwd = process.cwd();
  const agentsDir = path.join(cwd, '.agents');
  const skillsJsonPath = path.join(agentsDir, 'skills.json');

  let config = { entries: [] };

  if (fs.existsSync(skillsJsonPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
    } catch (err) {
      console.error(`❌ Error al parsear ${skillsJsonPath}: ${err.message}`);
      process.exit(1);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`❌ ${skillsJsonPath} debe contener un objeto JSON en la raíz.`);
      process.exit(1);
    }

    config = {
      ...parsed,
      entries: Array.isArray(parsed.entries) ? [...parsed.entries] : [],
    };
  }

  const normalizedTarget = normalizeSkillPath(SKILL_ENTRY_PATH);
  const alreadyExists = config.entries.some((entry) => {
    if (typeof entry === 'string') {
      return normalizeSkillPath(entry) === normalizedTarget;
    }
    if (typeof entry === 'object' && entry !== null) {
      return normalizeSkillPath(entry.path) === normalizedTarget;
    }
    return false;
  });

  if (!alreadyExists) {
    config.entries.push({ path: SKILL_ENTRY_PATH });
  }

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(skillsJsonPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (alreadyExists) {
    console.log(`✅ .agents/skills.json ya incluye "${SKILL_ENTRY_PATH}".`);
  } else {
    console.log(`✅ Skill Nuxx BaaS vinculada en ${skillsJsonPath} -> "${SKILL_ENTRY_PATH}".`);
  }
}

function runDelegatedScript(relativeScriptUrl, args) {
  const scriptPath = fileURLToPath(new URL(relativeScriptUrl, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`❌ Error al ejecutar ${path.basename(scriptPath)}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

const [, , command, ...restArgs] = process.argv;

switch (command) {
  case 'init':
    runInit();
    break;
  case 'validate':
    runDelegatedScript('../skills/nuxx-baas/scripts/validate-nuxx-json.mjs', restArgs);
    break;
  case 'gen-types':
    runDelegatedScript('../skills/nuxx-baas/scripts/gen-nuxx-types.mjs', restArgs);
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    process.exit(command ? 0 : 1);
    break;
  default:
    console.error(`❌ Subcomando desconocido: "${command}"\n`);
    printHelp();
    process.exit(1);
}
