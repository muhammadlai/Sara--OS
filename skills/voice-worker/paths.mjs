/**
 * Resolve the AITZAZ AI 2070 repository root without hardcoded home paths.
 * The worker lives at <repo>/skills/voice-worker/ — never /home/<user>/skills/.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = join('skills', 'voice-worker', 'voice-worker.mjs');

export function isRepoRoot(dir) {
  if (!dir) return false;
  const worker = join(dir, MARKER);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(worker) || !existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.name === 'aitzaz-ai-2070';
  } catch {
    return existsSync(worker);
  }
}

export function resolveRepoRoot(start) {
  if (process.env.AITZAZ_ROOT && isRepoRoot(process.env.AITZAZ_ROOT)) {
    return resolve(process.env.AITZAZ_ROOT);
  }
  const seeds = [];
  if (start) seeds.push(resolve(start));
  seeds.push(process.cwd());
  try {
    seeds.push(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  } catch { /* ignore */ }

  const seen = new Set();
  for (const seed of seeds) {
    let dir = seed;
    for (let i = 0; i < 12; i += 1) {
      if (seen.has(dir)) break;
      seen.add(dir);
      if (isRepoRoot(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function voiceWorkerEntry(root) {
  const base = root || resolveRepoRoot();
  return base ? join(base, MARKER) : null;
}

export function usageHint(root) {
  const repo = root || resolveRepoRoot() || '<AITZAZ-AI-2070-repo>';
  return {
    error: 'WRONG_WORKING_DIRECTORY',
    message: 'Run Voice Worker from the AITZAZ AI 2070 git root, not from $HOME.',
    repository_root: repo,
    worker: join(repo, MARKER),
    commands: [
      `cd ${repo}`,
      'node skills/voice-worker/voice-worker.mjs health',
      'npm run voice:health',
    ],
    do_not_use: '/home/<user>/skills/voice-worker/voice-worker.mjs',
  };
}
