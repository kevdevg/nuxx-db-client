#!/usr/bin/env node
/**
 * Clean whitelist synchronizer from `packages/db-client` to the public GitHub repository
 * (`https://github.com/kevdevg/nuxx-db-client.git`, branch `main`) without exposing
 * private monorepo history or sensitive tokens (Zero-Leak gate).
 *
 * Usage:
 *   node ./scripts/sync-github.mjs [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');

const DEFAULT_REMOTE = 'https://github.com/kevdevg/nuxx-db-client.git';
const REMOTE_URL = process.env.NUXX_DB_CLIENT_GH_REPO || DEFAULT_REMOTE;
const TARGET_BRANCH = 'main';
const IS_DRY_RUN = process.argv.includes('--dry-run');

const WHITELIST_FILES = [
  'package.json',
  'tsconfig.json',
  'tsup.config.ts',
  'plugin.json',
  'hooks.json',
  'README.md',
];

const WHITELIST_DIRS = ['assets', 'bin', 'scripts', 'skills', 'src'];

const CLEAN_GITIGNORE = [
  'node_modules/',
  'dist/',
  '.DS_Store',
  '.env',
  '.env.*',
  '*.tgz',
  '',
].join('\n');

// Assembled from fragments so this script itself never triggers literal token scans
const ZERO_LEAK_RULES = [
  {
    name: 'Nuxx Live API Key',
    regex: new RegExp(`${'ndb'}_${'live'}_[A-Za-z0-9]{8,}`),
  },
  {
    name: 'GitHub OAuth Token',
    regex: new RegExp(`${'gh'}${'o_'}`),
  },
  {
    name: 'GitHub Classic Personal Access Token',
    regex: new RegExp(`${'gh'}${'p_'}`),
  },
  {
    name: 'GitHub Fine-Grained Personal Access Token',
    regex: new RegExp(`${'github'}_${'pat_'}`),
  },
  {
    name: 'PEM Private Key',
    regex: new RegExp(`${'BEGIN'} .* ${'PRIVATE KEY'}`),
  },
];

function shouldExcludeEntry(entryName) {
  return (
    entryName === '.DS_Store' ||
    entryName === 'node_modules' ||
    entryName === 'dist' ||
    entryName === '.git' ||
    entryName === '.env' ||
    entryName.startsWith('.env.')
  );
}

function runGit(args, cwd, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function collectFilesRecursively(dirPath, baseDir = dirPath) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push({
        fullPath,
        relPath: path.relative(baseDir, fullPath),
      });
    }
  }
  return results;
}

function scanForLeaks(stagingDir) {
  const files = collectFilesRecursively(stagingDir);
  const violations = [];

  for (const file of files) {
    const content = fs.readFileSync(file.fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rule of ZERO_LEAK_RULES) {
        if (rule.regex.test(line)) {
          violations.push({
            file: file.relPath,
            line: idx + 1,
            rule: rule.name,
          });
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error('❌ [Zero-Leak] Sincronización abortada: se detectaron patrones sensibles:');
    for (const v of violations) {
      console.error(`   - ${v.file}:${v.line} -> ${v.rule}`);
    }
    process.exit(1);
  }

  return files.length;
}

function copyWhitelistedContent(destDir) {
  for (const relFile of WHITELIST_FILES) {
    const srcFile = path.join(PKG_ROOT, relFile);
    if (!fs.existsSync(srcFile)) {
      if (relFile === 'tsup.config.ts') continue;
      throw new Error(`Archivo requerido en lista blanca no encontrado: ${srcFile}`);
    }
    fs.copyFileSync(srcFile, path.join(destDir, relFile));
  }

  for (const relDir of WHITELIST_DIRS) {
    const srcDir = path.join(PKG_ROOT, relDir);
    if (!fs.existsSync(srcDir)) {
      throw new Error(`Directorio requerido en lista blanca no encontrado: ${srcDir}`);
    }
    const targetDir = path.join(destDir, relDir);
    fs.cpSync(srcDir, targetDir, {
      recursive: true,
      filter: (src) => !shouldExcludeEntry(path.basename(src)),
    });
  }

  fs.writeFileSync(path.join(destDir, '.gitignore'), CLEAN_GITIGNORE, 'utf8');
}

function clearWorkingTreeExceptGit(repoDir) {
  for (const entry of fs.readdirSync(repoDir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
  }
}

const pkgJson = JSON.parse(
  fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')
);
const version = pkgJson.version;
const commitMessage = `chore(release): sync @nuxx-brandly/db-client v${version} & nuxx-baas-plugin`;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nuxx-db-client-gh-sync-'));
const repoDir = path.join(tmpBase, 'repo');

try {
  if (IS_DRY_RUN) {
    fs.mkdirSync(repoDir, { recursive: true });
    runGit(['init', '-b', TARGET_BRANCH], repoDir);
    runGit(['remote', 'add', 'origin', REMOTE_URL], repoDir);
  } else {
    const lsRemoteOut = runGit(
      ['ls-remote', '--heads', REMOTE_URL, TARGET_BRANCH],
      PKG_ROOT
    );
    if (lsRemoteOut.length > 0) {
      runGit(
        ['clone', '--depth', '1', '--branch', TARGET_BRANCH, REMOTE_URL, repoDir],
        tmpBase
      );
      clearWorkingTreeExceptGit(repoDir);
    } else {
      fs.mkdirSync(repoDir, { recursive: true });
      runGit(['init', '-b', TARGET_BRANCH], repoDir);
      runGit(['remote', 'add', 'origin', REMOTE_URL], repoDir);
    }
  }

  copyWhitelistedContent(repoDir);
  const scannedCount = scanForLeaks(repoDir);

  const statusOutput = runGit(['status', '--porcelain'], repoDir);
  if (!statusOutput) {
    console.log(
      `✅ [sync-github] Sin cambios respecto a ${REMOTE_URL} (${scannedCount} archivos auditados Zero-Leak).`
    );
  } else if (IS_DRY_RUN) {
    const changedLines = statusOutput.split('\n').filter(Boolean);
    console.log(
      `✅ [sync-github --dry-run] Auditoría Zero-Leak aprobada (${scannedCount} archivos escaneados, 0 fugas).`
    );
    console.log(`📦 Destino: ${REMOTE_URL} (rama: ${TARGET_BRANCH})`);
    console.log(`📝 Commit:  ${commitMessage}`);
    console.log(`📂 Archivos preparados (${changedLines.length}):`);
    for (const line of changedLines) {
      console.log(`   ${line}`);
    }
  } else {
    try {
      runGit(['config', 'user.name'], repoDir);
    } catch {
      runGit(['config', 'user.name', 'Nuxx Release Bot'], repoDir);
    }
    try {
      runGit(['config', 'user.email'], repoDir);
    } catch {
      runGit(['config', 'user.email', 'bot@nuxx.app'], repoDir);
    }

    runGit(['add', '-A'], repoDir);
    runGit(['commit', '-m', commitMessage], repoDir);
    runGit(['push', '-u', 'origin', TARGET_BRANCH], repoDir);
    console.log(
      `🚀 [sync-github] Sincronizado v${version} hacia ${REMOTE_URL} (${scannedCount} archivos verificados).`
    );
  }
} finally {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
