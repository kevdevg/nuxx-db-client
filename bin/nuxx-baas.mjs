#!/usr/bin/env node
/**
 * Zero-dependency CLI for `@nuxx-brandly/db-client` & `nuxx-baas` skill helpers.
 *
 * Subcommands:
 *   nuxx-baas init                      Registers `node_modules/@nuxx-brandly/db-client/skills` in `.agents/skills.json`
 *   nuxx-baas validate [nuxx.json]      Validates `nuxx.json` schema & referential integrity
 *   nuxx-baas sync [nuxx.json]          Validates & hot-syncs `nuxx.json` to Nuxx BaaS without container redeploy
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
  validate [file]            Validate ./nuxx.json schema, foreignKeys, archive, and preloadTables
  sync [file]                Validate & hot-sync ./nuxx.json to Nuxx BaaS (<1s, zero redeploy)
  gen-types [in] [out]       Generate TypeScript types from ./nuxx.json (default: ./src/lib/database.types.ts)
  help                       Show this help message
`);
}

function loadEnvFilesFromCwd(cwd) {
  for (const filename of ['.env.local', '.env']) {
    const envPath = path.join(cwd, filename);
    if (!fs.existsSync(envPath)) continue;

    let raw;
    try {
      raw = fs.readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of raw.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const withoutExport = trimmed.startsWith('export ')
        ? trimmed.slice(7).trim()
        : trimmed;
      const eqIdx = withoutExport.indexOf('=');
      if (eqIdx <= 0) continue;

      const key = withoutExport.slice(0, eqIdx).trim();
      if (!key || key in process.env) continue;

      let val = withoutExport.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      } else {
        const hashIdx = val.indexOf(' #');
        if (hashIdx !== -1) {
          val = val.slice(0, hashIdx).trim();
        }
      }

      process.env[key] = val;
    }
  }
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

function runDelegatedScript(relativeScriptUrl, args, exitOnFinish = true) {
  const scriptPath = fileURLToPath(new URL(relativeScriptUrl, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`❌ Error al ejecutar ${path.basename(scriptPath)}: ${result.error.message}`);
    process.exit(1);
  }
  if (exitOnFinish || result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function runSync(args) {
  const targetFile = args[0] || './nuxx.json';
  const cwd = process.cwd();
  const resolvedPath = path.resolve(cwd, targetFile);

  // 1. Validate locally first (aborts with exit code 1 on failure)
  runDelegatedScript('../skills/nuxx-baas/scripts/validate-nuxx-json.mjs', [targetFile], false);

  // 2. Load .env.local / .env without overwriting existing process.env vars
  loadEnvFilesFromCwd(cwd);

  const apiUrl = (process.env.VITE_API_URL || 'https://api.nuxx.app/api/nuxx-db')
    .trim()
    .replace(/\/+$/, '');
  const appId = (process.env.VITE_APP_ID || process.env.VITE_PROJECT_ID || '').trim();
  const apiKey = (process.env.VITE_NUXX_DB_API_KEY || '').trim();

  const missing = [];
  if (!appId) missing.push('VITE_APP_ID (o VITE_PROJECT_ID)');
  if (!apiKey) missing.push('VITE_NUXX_DB_API_KEY');

  if (missing.length > 0) {
    console.error(
      `❌ Faltan variables requeridas para sincronizar el esquema: ${missing.join(', ')}.`
    );
    console.error(
      '   Defínelas en `.env` / `.env.local` (opcionalmente junto a `VITE_API_URL`) y vuelve a ejecutar `npx nuxx-baas sync`.'
    );
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const endpoint = `${apiUrl}/${encodeURIComponent(appId)}/schema/sync`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ephemeral-api-key': apiKey,
      },
      body: JSON.stringify(manifest),
    });
  } catch (err) {
    console.error(`❌ Error de red al conectar con ${endpoint}: ${err.message}`);
    process.exit(1);
  }

  const rawBody = await res.text().catch(() => '');
  let jsonBody = null;
  if (rawBody) {
    try {
      jsonBody = JSON.parse(rawBody);
    } catch {
      jsonBody = null;
    }
  }

  if (!res.ok) {
    const serverMsg = Array.isArray(jsonBody?.message)
      ? jsonBody.message.join('; ')
      : jsonBody?.message || jsonBody?.error?.message || jsonBody?.error || rawBody || res.statusText;
    console.error(`❌ Falló la sincronización en caliente (${res.status}): ${serverMsg}`);
    process.exit(1);
  }

  console.log(`✅ Esquema sincronizado en caliente para "${appId}" sin redesplegar contenedor`);
  process.exit(0);
}

const [, , command, ...restArgs] = process.argv;

switch (command) {
  case 'init':
    runInit();
    break;
  case 'validate':
    runDelegatedScript('../skills/nuxx-baas/scripts/validate-nuxx-json.mjs', restArgs);
    break;
  case 'sync':
    await runSync(restArgs);
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
