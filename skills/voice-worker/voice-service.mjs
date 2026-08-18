#!/usr/bin/env node
/**
 * VoiceService — Voicebox-backed speech abstraction for AITZAZ AI 2070.
 *
 * The rest of the system must call this interface, never Voicebox URLs directly.
 *
 * Real Voicebox REST (v0.5+):
 *   GET  /health
 *   GET  /profiles
 *   GET  /models/status
 *   GET  /history?limit=&profile_id=
 *   POST /speak     { text, profile?, engine?, personality?, language? }
 *   POST /generate  { profile_id, text, language, engine?, instruct?, personality?, seed? }
 *   GET  /history/{id}/export-audio
 *
 * POST /speak is the agent path. POST /generate is used when instruct/engine
 * extras (emotion, speed) cannot be expressed on /speak.
 *
 * Profile IDs are never invented. They come from GET /profiles.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const VOICEBOX_ENGINES = [
  'qwen',
  'qwen_custom_voice',
  'luxtts',
  'chatterbox',
  'chatterbox_turbo',
  'tada',
  'kokoro',
];

export const VOICEBOX_LANGUAGES = [
  'zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it',
  'he', 'ar', 'da', 'el', 'fi', 'hi', 'ms', 'nl', 'no', 'pl', 'sv', 'sw', 'tr',
];

export function mapDeliveryHints({ emotion, speed } = {}) {
  const parts = [];
  if (emotion && String(emotion).trim() && String(emotion).toLowerCase() !== 'neutral') {
    parts.push(`Deliver this with a ${String(emotion).trim()} professional tone`);
  }
  if (speed != null && speed !== '' && Number(speed) !== 1) {
    const n = Number(speed);
    if (Number.isFinite(n) && n > 1) parts.push('Speak a little faster, still clear and natural');
    else if (Number.isFinite(n) && n < 1) parts.push('Speak a little slower, with natural pauses');
  }
  return parts.length ? `${parts.join('. ')}.` : null;
}

export function validateGeneration(response) {
  const errors = [];
  if (!response || typeof response !== 'object') {
    return { verified: false, errors: ['empty_or_invalid_response'] };
  }
  const status = String(response.status || '').toLowerCase();
  if (status && status !== 'completed' && status !== 'success') {
    errors.push(`status_${status}`);
  }
  if (response.error) errors.push(`remote_error:${response.error}`);
  if (!response.id) errors.push('missing_generation_id');
  const hasPath = Boolean(response.audio_path || response.local_audio_path);
  if (!hasPath) errors.push('missing_audio_path');
  if (response.duration != null && Number(response.duration) <= 0) {
    errors.push('non_positive_duration');
  }
  if (response.local_audio_path && existsSync(response.local_audio_path)) {
    const size = statSync(response.local_audio_path).size;
    if (size < 44) errors.push('audio_file_too_small');
  }
  return { verified: errors.length === 0, errors };
}

export function createVoiceService(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.VOICEBOX_BASE_URL || 'http://127.0.0.1:17493').replace(/\/$/, '');
  const clientId = options.clientId || process.env.VOICEBOX_CLIENT_ID || 'aitzaz-ai-2070';
  const token = options.token || process.env.VOICEBOX_TOKEN || '';
  const timeoutMs = Number(options.timeoutMs || process.env.VOICEBOX_TIMEOUT_MS || 120000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const audioDir = options.audioDir || join(
    process.env.OPENCLAW_HOME || join(process.env.HOME || '/tmp', '.openclaw'),
    'voice',
    'audio',
  );

  const headers = () => {
    const h = {
      Accept: 'application/json',
      'X-Voicebox-Client-Id': clientId,
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  async function request(method, path, { json, raw } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = { method, headers: headers(), signal: controller.signal };
      if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      const res = await fetchImpl(`${baseUrl}${path}`, init);
      const contentType = res.headers.get('content-type') || '';
      let body = null;
      if (raw) {
        body = Buffer.from(await res.arrayBuffer());
      } else if (contentType.includes('application/json')) {
        body = await res.json();
      } else {
        const text = await res.text();
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
      }
      return { ok: res.ok, status: res.status, body, headers: res.headers };
    } catch (err) {
      const code = err.name === 'AbortError' ? 'timeout' : 'network';
      const error = new Error(`Voicebox ${method} ${path} failed (${code}): ${err.message}`);
      error.code = code;
      error.cause = err;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function health() {
    try {
      const { ok, status, body } = await request('GET', '/health');
      return {
        reachable: ok,
        http_status: status,
        voicebox: body && typeof body === 'object' ? body : {},
        base_url: baseUrl,
        client_id: clientId,
      };
    } catch (err) {
      return {
        reachable: false,
        http_status: 0,
        voicebox: {},
        base_url: baseUrl,
        client_id: clientId,
        error: err.message,
        code: err.code || 'network',
      };
    }
  }

  function normalizeProfileList(body) {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    if (Array.isArray(body?.profiles)) return body.profiles;
    return [];
  }

  async function listProfiles() {
    const { ok, status, body } = await request('GET', '/profiles');
    if (!ok) {
      const error = new Error(`Voicebox GET /profiles failed (${status})`);
      error.httpStatus = status;
      error.body = body;
      throw error;
    }
    return normalizeProfileList(body);
  }

  async function listEngines() {
    try {
      const { ok, body } = await request('GET', '/models/status');
      if (!ok) return { available: false, models: [] };
      const models = Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  }

  async function listHistory({ profileId, limit = 20 } = {}) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (profileId) qs.set('profile_id', profileId);
    const { ok, body } = await request('GET', `/history?${qs}`);
    if (!ok) return { items: [], total: 0 };
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
    return { items, total: body?.total ?? items.length };
  }

  /**
   * Resolve the authorized Aitzaz profile from Voicebox.
   * Never fabricates an id. Returns { status: 'unbound' } when missing.
   */
  function resolveAuthorizedProfile(profiles, authorized) {
    const name = String(authorized?.name || 'Aitzaz').trim().toLowerCase();
    const configuredId = String(authorized?.id || '').trim();
    const list = Array.isArray(profiles) ? profiles : [];

    if (configuredId) {
      const byId = list.find((p) => String(p.id) === configuredId);
      if (!byId) {
        return {
          status: 'unbound',
          reason: 'configured_id_not_found_in_voicebox',
          configured_id: configuredId,
          name: authorized?.name || 'Aitzaz',
        };
      }
      return { status: 'bound', profile: byId, source: 'configured_id' };
    }

    const matches = list.filter((p) => String(p.name || '').trim().toLowerCase() === name);
    if (matches.length === 1) {
      return { status: 'bound', profile: matches[0], source: 'name' };
    }
    if (matches.length > 1) {
      return {
        status: 'unbound',
        reason: 'multiple_profiles_match_name',
        name: authorized?.name || 'Aitzaz',
        candidates: matches.map((p) => ({ id: p.id, name: p.name })),
      };
    }
    return {
      status: 'unbound',
      reason: 'authorized_profile_not_in_voicebox',
      name: authorized?.name || 'Aitzaz',
    };
  }

  function pickEngine(requested, models) {
    const ready = new Set(
      (models || [])
        .filter((m) => m.downloaded || m.loaded || m.ready)
        .map((m) => String(m.engine || m.model_name || '').toLowerCase()),
    );
    if (requested && VOICEBOX_ENGINES.includes(requested)) return requested;
    for (const engine of ['qwen', 'luxtts', 'kokoro', 'chatterbox', 'tada']) {
      if ([...ready].some((n) => n.includes(engine))) return engine;
    }
    return requested || null;
  }

  async function fetchAudio(generationId, destPath) {
    const { ok, status, body } = await request('GET', `/history/${encodeURIComponent(generationId)}/export-audio`, { raw: true });
    if (!ok || !body || !body.length) {
      return { saved: false, http_status: status, bytes: 0 };
    }
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, body);
    return { saved: true, http_status: status, bytes: body.length, path: destPath };
  }

  /**
   * speak({ text, voice_profile, language, emotion, speed, personality, engine })
   *
   * voice_profile may be a name ("Aitzaz") or a real Voicebox id previously
   * resolved from GET /profiles. This method does not invent ids.
   */
  async function speak({
    text,
    voice_profile,
    language = 'en',
    emotion,
    speed,
    personality = false,
    engine,
    authorizedProfile,
  } = {}) {
    if (!text || !String(text).trim()) {
      return {
        status: 'failed',
        phase: 'VOICE_GENERATION_FAILED',
        verified: false,
        error: 'empty_text',
      };
    }

    const lang = VOICEBOX_LANGUAGES.includes(language) ? language : 'en';
    const instruct = mapDeliveryHints({ emotion, speed });
    const useGenerate = Boolean(instruct || (engine && VOICEBOX_ENGINES.includes(engine)));

    let profileArg = voice_profile || authorizedProfile?.name || 'Aitzaz';
    let profileId = authorizedProfile?.id || null;
    if (authorizedProfile?.id) profileId = authorizedProfile.id;

    let remote;
    try {
      if (useGenerate) {
        if (!profileId) {
          const profiles = await listProfiles();
          const resolved = resolveAuthorizedProfile(profiles, {
            name: profileArg,
            id: authorizedProfile?.id || '',
          });
          if (resolved.status !== 'bound') {
            return {
              status: 'failed',
              phase: 'VOICE_GENERATION_FAILED',
              verified: false,
              error: resolved.reason || 'profile_unbound',
              resolution: resolved,
            };
          }
          profileId = resolved.profile.id;
          profileArg = resolved.profile.name;
        }
        const payload = {
          profile_id: profileId,
          text: String(text),
          language: lang,
        };
        if (engine && VOICEBOX_ENGINES.includes(engine)) payload.engine = engine;
        if (instruct) payload.instruct = instruct;
        if (personality === true) payload.personality = true;
        remote = await request('POST', '/generate', { json: payload });
      } else {
        const payload = {
          text: String(text),
          profile: String(profileArg),
          language: lang,
        };
        if (personality === true) payload.personality = true;
        if (engine && VOICEBOX_ENGINES.includes(engine)) payload.engine = engine;
        remote = await request('POST', '/speak', { json: payload });
      }
    } catch (err) {
      return {
        status: 'failed',
        phase: 'VOICE_GENERATION_FAILED',
        verified: false,
        error: err.message,
        code: err.code || 'network',
      };
    }

    if (remote.status === 202) {
      return {
        status: 'failed',
        phase: 'VOICE_GENERATION_FAILED',
        verified: false,
        error: 'voicebox_model_not_ready',
        http_status: 202,
        voicebox: remote.body,
      };
    }

    if (!remote.ok) {
      return {
        status: 'failed',
        phase: 'VOICE_GENERATION_FAILED',
        verified: false,
        error: remote.body?.detail || remote.body?.error || `http_${remote.status}`,
        http_status: remote.status,
        voicebox: remote.body,
      };
    }

    const generation = remote.body && typeof remote.body === 'object' ? remote.body : {};
    let localAudio = null;
    if (generation.id) {
      mkdirSync(audioDir, { recursive: true });
      const dest = join(audioDir, `${generation.id}.wav`);
      try {
        const saved = await fetchAudio(generation.id, dest);
        if (saved.saved) localAudio = dest;
      } catch {
        localAudio = null;
      }
    }

    const candidate = {
      ...generation,
      local_audio_path: localAudio,
    };
    const check = validateGeneration(candidate);
    if (!check.verified) {
      return {
        status: 'failed',
        phase: 'VOICE_GENERATION_FAILED',
        verified: false,
        error: check.errors.join(','),
        voice_profile: generation.profile_id || profileArg,
        audio: localAudio || generation.audio_path || null,
        duration: generation.duration ?? null,
        generation_id: generation.id || null,
        voicebox: generation,
      };
    }

    return {
      status: 'completed',
      phase: 'AUDIO_VALIDATED',
      verified: true,
      voice_profile: generation.profile_id || profileArg,
      audio: localAudio || generation.audio_path,
      duration: generation.duration ?? null,
      generation_id: generation.id,
      engine: generation.engine || engine || null,
      language: generation.language || lang,
      voicebox: generation,
    };
  }

  return {
    baseUrl,
    clientId,
    health,
    listProfiles,
    listEngines,
    listHistory,
    resolveAuthorizedProfile,
    pickEngine,
    fetchAudio,
    speak,
    request,
  };
}


