/**
 * Voice Worker persistence — metadata only.
 * Generated audio lives under OPENCLAW_HOME/voice/audio (outside git).
 * Raw owner voice samples must never be stored in the repository.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const PHASES = [
  'VOICE_REQUESTED',
  'VOICE_GENERATION_STARTED',
  'VOICE_GENERATED',
  'AUDIO_VALIDATED',
  'DELIVERY_REQUESTED',
  'DELIVERY_CONFIRMED',
  'VOICE_GENERATION_FAILED',
];

export function voiceHome(root) {
  return root || join(process.env.OPENCLAW_HOME || join(process.env.HOME || '/tmp', '.openclaw'), 'voice');
}

export function ensureDirs(home) {
  for (const sub of ['', 'jobs', 'audio']) {
    const dir = sub ? join(home, sub) : home;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return home;
}

export function newJobId() {
  return `vw_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function createStore(home) {
  const root = ensureDirs(voiceHome(home));
  const jobsDir = join(root, 'jobs');
  const audioDir = join(root, 'audio');
  const bindingPath = join(root, 'profile-binding.json');
  const statusPath = join(root, 'status.json');

  function jobPath(id) {
    return join(jobsDir, `${id}.json`);
  }

  function writeJob(job) {
    const next = { ...job, updated_at: new Date().toISOString() };
    writeFileSync(jobPath(next.id), JSON.stringify(next, null, 2));
    return next;
  }

  function readJob(id) {
    return loadJson(jobPath(id), null);
  }

  function listJobs() {
    if (!existsSync(jobsDir)) return [];
    return readdirSync(jobsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadJson(join(jobsDir, f), null))
      .filter(Boolean)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  function createJob(fields) {
    const id = fields.id || newJobId();
    const job = {
      id,
      phase: 'VOICE_REQUESTED',
      client_requested_voice: true,
      voice_response_generated: false,
      response_text: fields.response_text || '',
      spoken_text: fields.spoken_text || fields.response_text || '',
      channel: fields.channel || 'unknown',
      client: fields.client || null,
      company: fields.company || null,
      conversation_id: fields.conversation_id || null,
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivery_status: 'not_requested',
      approval: 'pending',
      generation: null,
      delivery: null,
      error: null,
      verified: false,
      voice_profile: 'Aitzaz',
    };
    return writeJob(job);
  }

  function setBinding(binding) {
    writeFileSync(bindingPath, JSON.stringify({ ...binding, updated_at: new Date().toISOString() }, null, 2));
    return loadJson(bindingPath, null);
  }

  function getBinding() {
    return loadJson(bindingPath, null);
  }

  function writeStatus(status) {
    writeFileSync(statusPath, JSON.stringify({ ...status, updated_at: new Date().toISOString() }, null, 2));
    return loadJson(statusPath, null);
  }

  function getStatus() {
    return loadJson(statusPath, null);
  }

  function purgeExpiredAudio(ttlHours = 24) {
    if (!existsSync(audioDir)) return { removed: 0 };
    const cutoff = Date.now() - ttlHours * 3600 * 1000;
    let removed = 0;
    for (const file of readdirSync(audioDir)) {
      const path = join(audioDir, file);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch { /* skip */ }
    }
    return { removed };
  }

  function fingerprint(text) {
    return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
  }

  return {
    root,
    jobsDir,
    audioDir,
    bindingPath,
    statusPath,
    writeJob,
    readJob,
    listJobs,
    createJob,
    setBinding,
    getBinding,
    writeStatus,
    getStatus,
    purgeExpiredAudio,
    fingerprint,
  };
}
