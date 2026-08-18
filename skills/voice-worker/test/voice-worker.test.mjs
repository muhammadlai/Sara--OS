import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSimpleYaml } from '../yaml.mjs';
import { classifyVoiceIntent, decideVoiceOutput } from '../intent.mjs';
import { canDeliverAudio, planDelivery, confirmDelivery, UNSUPPORTED_AUDIO_MESSAGE } from '../channels.mjs';
import { applyPersonalityLayer } from '../personality.mjs';
import { createVoiceService, mapDeliveryHints, validateGeneration } from '../voice-service.mjs';
import { createVoiceWorker, loadVoiceConfig } from '../voice-worker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..');

function minimalWav() {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(0, 40);
  return Buffer.concat([header, Buffer.alloc(64)]);
}

function startMockVoicebox({ failGenerate = false, emptyProfiles = false, omitAudio = false } = {}) {
  const wav = minimalWav();
  const profiles = emptyProfiles
    ? []
    : [{ id: 'vb_live_aitzaz_7f3a', name: 'Aitzaz', language: 'en', personality: 'professional' }];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(200, { status: 'ok', model_loaded: true, gpu_available: false, backend_type: 'cpu' });
    }
    if (req.method === 'GET' && url.pathname === '/profiles') {
      return json(200, profiles);
    }
    if (req.method === 'GET' && url.pathname === '/models/status') {
      return json(200, { models: [{ model_name: 'qwen-1.7B', display_name: 'Qwen3-TTS 1.7B', downloaded: true, loaded: false }] });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/export-audio')) {
      if (omitAudio) return json(404, { error: 'missing' });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav);
    }
    if (req.method === 'POST' && (url.pathname === '/speak' || url.pathname === '/generate')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (failGenerate) return json(500, { error: 'tts_backend_failed' });
        json(200, {
          id: 'gen_test_001',
          profile_id: 'vb_live_aitzaz_7f3a',
          text: body.text,
          language: body.language || 'en',
          audio_path: omitAudio ? null : 'data/generations/gen_test_001.wav',
          duration: omitAudio ? null : 2.4,
          engine: body.engine || 'qwen',
          status: 'completed',
          error: null,
          created_at: new Date().toISOString(),
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('voice.yaml parses and does not invent a profile id', () => {
  const raw = readFileSync(join(SKILL, 'voice.yaml'), 'utf8');
  const cfg = parseSimpleYaml(raw);
  assert.equal(cfg.voice_profile.name, 'Aitzaz');
  assert.equal(cfg.voice_profile.owner, 'Aitzaz');
  assert.equal(cfg.voice_profile.consent_confirmed, true);
  assert.equal(cfg.voice_profile.id, '');
  assert.ok(cfg.personality.traits.includes('professional'));
  assert.equal(cfg.voicebox.client_id, 'aitzaz-ai-2070');
});

test('loadVoiceConfig reads the committed authorized profile', () => {
  const loaded = loadVoiceConfig(join(SKILL, 'voice.yaml'));
  assert.equal(loaded.config.voice_profile.name, 'Aitzaz');
  assert.equal(loaded.config.voice_profile.id, '');
});

test('classifies documented voice requests', () => {
  const samples = [
    'Can I hear your voice?',
    'Can you send me a voice message?',
    'Can we talk?',
    'Send me a quick voice reply.',
    'Please send a voice note.',
  ];
  for (const s of samples) {
    const r = classifyVoiceIntent(s);
    assert.equal(r.intent, 'VOICE_REQUEST', s);
  }
  assert.equal(classifyVoiceIntent('What is the lead time?').intent, 'TEXT_REQUEST');
});

test('Main Brain only uses Voice Worker for VOICE_REQUEST', () => {
  const yes = decideVoiceOutput({
    intent: 'VOICE_REQUEST',
    channel: 'telegram',
    channelSupportsAudio: true,
    consentConfirmed: true,
    profileEnabled: true,
    available: true,
    permission: true,
  });
  assert.equal(yes.mode, 'VOICE_RESPONSE');
  const no = decideVoiceOutput({ intent: 'TEXT_REQUEST', channel: 'telegram', channelSupportsAudio: true });
  assert.equal(no.mode, 'TEXT_RESPONSE');
  assert.equal(no.use_voice_worker, false);
});

test('LinkedIn is not an authorized audio channel', () => {
  assert.equal(canDeliverAudio('linkedin'), false);
  const plan = planDelivery({ channel: 'linkedin', audioPath: '/tmp/x.wav' });
  assert.equal(plan.status, 'unsupported');
  assert.equal(plan.message, UNSUPPORTED_AUDIO_MESSAGE);
  assert.equal(plan.confirmed, false);
});

test('delivery is not confirmed without a channel ack', () => {
  const plan = planDelivery({ channel: 'telegram', audioPath: '/tmp/x.wav', generationId: 'g1' });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.confirmed, false);
  const denied = confirmDelivery(plan, { ok: false });
  assert.equal(denied.confirmed, false);
  const ok = confirmDelivery(plan, { ok: true, reference: 'tg:99' });
  assert.equal(ok.confirmed, true);
  assert.equal(ok.phase, 'DELIVERY_CONFIRMED');
});

test('personality layer stays transparent and concise', () => {
  const spoken = applyPersonalityLayer('Sure, happy to. I can send you a quick voice introduction.', {
    includeDisclosure: true,
  });
  assert.match(spoken, /Aitzaz AI speaking on behalf of Aitzaz/);
  assert.doesNotMatch(spoken, /I'm Aitzaz personally speaking/i);
});

test('validateGeneration never assumes success', () => {
  assert.equal(validateGeneration(null).verified, false);
  assert.equal(validateGeneration({ status: 'failed', error: 'boom' }).verified, false);
  assert.equal(validateGeneration({ id: '1', audio_path: '/a.wav', duration: 1.2, status: 'completed' }).verified, true);
});

test('emotion/speed map to Voicebox instruct, not invented fields', () => {
  assert.equal(mapDeliveryHints({}), null);
  assert.match(mapDeliveryHints({ emotion: 'confident' }), /confident/);
});

test('VoiceService binds the real Voicebox profile id', async () => {
  const mock = await startMockVoicebox();
  try {
    const home = mkdtempSync(join(tmpdir(), 'aitzaz-voice-'));
    const svc = createVoiceService({ baseUrl: mock.url, audioDir: join(home, 'audio') });
    const profiles = await svc.listProfiles();
    const resolved = svc.resolveAuthorizedProfile(profiles, { name: 'Aitzaz', id: '' });
    assert.equal(resolved.status, 'bound');
    assert.equal(resolved.profile.id, 'vb_live_aitzaz_7f3a');
    assert.equal(resolved.source, 'name');
  } finally {
    mock.server.close();
  }
});

test('VoiceService does not invent an id when Voicebox has no Aitzaz profile', async () => {
  const mock = await startMockVoicebox({ emptyProfiles: true });
  try {
    const svc = createVoiceService({ baseUrl: mock.url, audioDir: join(tmpdir(), 'x') });
    const resolved = svc.resolveAuthorizedProfile(await svc.listProfiles(), { name: 'Aitzaz', id: '' });
    assert.equal(resolved.status, 'unbound');
    assert.equal(resolved.reason, 'authorized_profile_not_in_voicebox');
    assert.ok(!resolved.profile);
  } finally {
    mock.server.close();
  }
});

test('pipeline generates, validates, and refuses unverified audio', async () => {
  const mock = await startMockVoicebox();
  try {
    const home = mkdtempSync(join(tmpdir(), 'aitzaz-voice-'));
    const worker = createVoiceWorker({
      home,
      configPath: join(SKILL, 'voice.yaml'),
      baseUrl: mock.url,
    });
    const job = worker.requestVoice({
      client_text: 'Can you send me a voice message?',
      response_text: 'Sure, happy to. I can send you a quick voice introduction.',
      channel: 'local',
      client: 'Ahmed',
      company: 'Desert Logistics',
      conversation_id: 'conv-1',
      intro: true,
    });
    assert.equal(job.phase, 'VOICE_REQUESTED');
    assert.equal(job.approval, 'approved');
    assert.match(job.owner_notice.title, /Sir, client requested a voice reply/);

    const generated = await worker.generate(job.id);
    assert.equal(generated.phase, 'AUDIO_VALIDATED');
    assert.equal(generated.verified, true);
    assert.ok(generated.generation.audio);
    assert.ok(existsSync(generated.generation.audio));

    const delivered = worker.deliver(generated.id);
    assert.equal(delivered.delivery.confirmed, false);
    assert.equal(delivered.phase, 'DELIVERY_REQUESTED');
  } finally {
    mock.server.close();
  }
});

test('failed Voicebox generation becomes VOICE_GENERATION_FAILED', async () => {
  const mock = await startMockVoicebox({ failGenerate: true });
  try {
    const home = mkdtempSync(join(tmpdir(), 'aitzaz-voice-'));
    const worker = createVoiceWorker({ home, configPath: join(SKILL, 'voice.yaml'), baseUrl: mock.url });
    const job = worker.requestVoice({
      client_text: 'Send me a voice note',
      response_text: 'Of course.',
      channel: 'local',
    });
    const generated = await worker.generate(job.id);
    assert.equal(generated.phase, 'VOICE_GENERATION_FAILED');
    assert.equal(generated.verified, false);
  } finally {
    mock.server.close();
  }
});

test('client outbound requires approval before generate', async () => {
  const mock = await startMockVoicebox();
  try {
    const home = mkdtempSync(join(tmpdir(), 'aitzaz-voice-'));
    const worker = createVoiceWorker({ home, configPath: join(SKILL, 'voice.yaml'), baseUrl: mock.url });
    const job = worker.requestVoice({
      client_text: 'Send me a voice note',
      response_text: 'Happy to send a short intro.',
      channel: 'telegram',
      client: 'Ahmed',
    });
    assert.equal(job.approval, 'pending');
    const blocked = await worker.generate(job.id);
    assert.equal(blocked.error, 'approval_required');
    await worker.approve(job.id);
    const generated = await worker.generate(job.id);
    assert.equal(generated.phase, 'AUDIO_VALIDATED');
  } finally {
    mock.server.close();
  }
});

test('status reports OFFLINE when Voicebox is down', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aitzaz-voice-'));
  const worker = createVoiceWorker({
    home,
    configPath: join(SKILL, 'voice.yaml'),
    baseUrl: 'http://127.0.0.1:9',
    timeoutMs: 200,
  });
  const status = await worker.status();
  assert.equal(status.status, 'OFFLINE');
  assert.equal(status.profile.name, 'Aitzaz');
  assert.equal(status.profile.bound, false);
});
