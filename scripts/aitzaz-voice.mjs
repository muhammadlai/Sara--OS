#!/usr/bin/env node
/**
 * Path-safe launcher. Finds the AITZAZ AI 2070 repo (never assumes $HOME/skills).
 * Usage from the git root:
 *   node scripts/aitzaz-voice.mjs health
 *   npm run voice:health
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot, usageHint, voiceWorkerEntry } from '../skills/voice-worker/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolveRepoRoot(join(here, '..')) || resolveRepoRoot(process.cwd());
const entry = voiceWorkerEntry(root);

if (!root || !entry || !existsSync(entry)) {
  console.error(JSON.stringify(usageHint(root), null, 2));
  process.exit(2);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
