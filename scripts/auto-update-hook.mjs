#!/usr/bin/env node
/**
 * Zero-dependency Antigravity SessionStart OTA updater hook for `nuxx-baas-plugin`.
 *
 * Invariants:
 * - Never blocks on stdin.
 * - Never writes non-JSON noise to stdout; always prints `{}` or a valid `injectSteps` payload.
 * - Always exits with code `0`, even offline or on timeout.
 * - Only runs `git fetch` / `git pull --ff-only` when BOTH `.git` and `plugin.json`
 *   (`"name": "nuxx-baas-plugin"`) exist directly in `process.cwd()`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours (43200000 ms)
const GIT_TIMEOUT_MS = 3500;

function emitAndExit(payloadObj = {}) {
  try {
    fs.writeSync(1, `${JSON.stringify(payloadObj)}\n`);
  } catch {
    // Ignore stdout write errors
  }
  process.exit(0);
}

try {
  // Drain/ignore stdin without blocking execution
  if (process.stdin) {
    process.stdin.on('error', () => {});
    process.stdin.resume();
  }

  const cwd = process.cwd();
  const gitDir = path.join(cwd, '.git');
  const pluginJsonPath = path.join(cwd, 'plugin.json');

  // Only auto-update standalone git clones of `nuxx-baas-plugin`
  if (!fs.existsSync(gitDir) || !fs.existsSync(pluginJsonPath)) {
    emitAndExit({});
  }

  const initialManifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  if (initialManifest?.name !== 'nuxx-baas-plugin') {
    emitAndExit({});
  }

  const cacheDir =
    process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'nuxx-baas-plugin-cache');
  const stateFile = path.join(cacheDir, 'last-update-check.json');
  const forceCheck = process.env.NUXX_PLUGIN_FORCE_CHECK === '1';
  const now = Date.now();

  if (!forceCheck && fs.existsSync(stateFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (
        prev &&
        typeof prev.checkedAt === 'number' &&
        now - prev.checkedAt < CHECK_INTERVAL_MS
      ) {
        emitAndExit({});
      }
    } catch {
      // Corrupted cache file; proceed with fresh check
    }
  }

  // Persist checkedAt BEFORE network calls so offline sessions don't retry on every turn
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ checkedAt: now }), 'utf8');

  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };

  const runGit = (args) =>
    execFileSync('git', args, {
      cwd,
      env: gitEnv,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  runGit(['fetch', 'origin', 'main', '--quiet']);

  const localSha = runGit(['rev-parse', 'HEAD']);
  const remoteSha = runGit(['rev-parse', 'origin/main']);

  if (!localSha || !remoteSha || localSha === remoteSha) {
    emitAndExit({});
  }

  runGit(['pull', '--ff-only', 'origin', 'main', '--quiet']);

  const updatedSha = runGit(['rev-parse', 'HEAD']);
  if (!updatedSha || updatedSha === localSha) {
    emitAndExit({});
  }

  const updatedManifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  const version =
    typeof updatedManifest?.version === 'string' && updatedManifest.version.trim()
      ? updatedManifest.version.trim()
      : 'latest';

  emitAndExit({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: `✨ **Nuxx BaaS Plugin** actualizado automáticamente a \`v${version}\` desde GitHub.`,
          },
        },
      },
    ],
  });
} catch {
  emitAndExit({});
}
