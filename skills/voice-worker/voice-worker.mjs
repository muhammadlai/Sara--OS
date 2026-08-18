#!/usr/bin/env node
/**
 * Voice Worker — AITZAZ AI 2070
 *
 * Pipeline:
 *   VOICE_REQUESTED → VOICE_GENERATION_STARTED → VOICE_GENERATED
 *   → AUDIO_VALIDATED → DELIVERY_REQUESTED → DELIVERY_CONFIRMED
 *   or VOICE_GENERATION_FAILED
 *
 * Does not report "Voice sent" unless the destination service confirms.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceService } from './voice-service.mjs';
import { classifyVoiceIntent, decideVoiceOutput } from './intent.mjs';
import { canDeliverAudio, getChannelCapability, planDelivery, confirmDelivery } from './channels.mjs';
import { applyPersonalityLayer, ownerVoiceNotice } from './personality.mjs';
import { createStore } from './store.mjs';
import { parseSimpleYaml } from './yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadVoiceConfig(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AITZAZ_VOICE_CONFIG,
    join(process.cwd(), 'workspace/voice.yaml'),
    join(HERE, 'voice.yaml'),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) {
      const parsed = parseSimpleYaml(readFileSync(path, 'utf8'));
      return { path, config: parsed };
    }
  }
  return {
    path: null,
    config: {
      voice_profile: { name: 'Aitzaz', owner: 'Aitzaz', language: 'en', enabled: true, consent_confirmed: true, id: '' },
      personality: { traits: ['professional', 'natural', 'confident', 'friendly', 'concise', 'business-oriented'], use_voicebox_personality_rewrite: true, disclosure: 'This is Aitzaz AI speaking on behalf of Aitzaz.', include_disclosure_on_intro: true },
      voicebox: { base_url: 'http://127.0.0.1:17493', client_id: 'aitzaz-ai-2070', preferred_engine: '', timeout_ms: 120000 },
      approval: { client_outbound: 'require_approval', local_preview: 'auto', owner_channel: 'auto' },
      retention: { audio_ttl_hours: 24, keep_metadata: true },
    },
  };
}

export function createVoiceWorker(options = {}) {
  const { path: configPath, config } = loadVoiceConfig(options.configPath);
  const store = createStore(options.home);
  const profile = config.voice_profile || {};
  const voicebox = config.voicebox || {};
  const personality = config.personality || {};
  const approvalCfg = config.approval || {};
  const retention = config.retention || {};

  const service = options.service || createVoiceService({
    baseUrl: options.baseUrl || process.env.VOICEBOX_BASE_URL || voicebox.base_url,
    clientId: options.clientId || process.env.VOICEBOX_CLIENT_ID || voicebox.client_id,
    token: options.token || process.env.VOICEBOX_TOKEN || '',
    timeoutMs: options.timeoutMs || voicebox.timeout_ms,
    fetchImpl: options.fetchImpl,
    audioDir: store.audioDir,
  });

  function authorizedMeta() {
    const binding = store.getBinding();
    return {
      name: profile.name || 'Aitzaz',
      owner: profile.owner || 'Aitzaz',
      language: profile.language || 'en',
      enabled: profile.enabled !== false,
      consent_confirmed: profile.consent_confirmed === true,
      purpose: profile.purpose || 'AITZAZ AI 2070 Worker Agent',
      id: binding?.profile_id || profile.id || '',
      binding_source: binding?.source || null,
    };
  }

  async function bindProfile() {
    const health = await service.health();
    if (!health.reachable) {
      return { status: 'unbound', error: 'voicebox_unreachable', health };
    }
    const profiles = await service.listProfiles();
    const resolved = service.resolveAuthorizedProfile(profiles, authorizedMeta());
    if (resolved.status === 'bound') {
      store.setBinding({
        profile_id: resolved.profile.id,
        name: resolved.profile.name,
        source: resolved.source,
        language: resolved.profile.language,
      });
    }
    return { ...resolved, health, profiles: profiles.map((p) => ({ id: p.id, name: p.name, language: p.language })) };
  }

  function needsApproval(channel) {
    const cap = getChannelCapability(channel);
    if (cap.audio_operation === 'localPreview') {
      return approvalCfg.local_preview === 'require_approval';
    }
    return approvalCfg.client_outbound !== 'auto';
  }

  function prepareSpokenText(text, { intro = false } = {}) {
    return applyPersonalityLayer(text, {
      traits: personality.traits,
      disclosure: personality.disclosure,
      includeDisclosure: Boolean(intro && personality.include_disclosure_on_intro),
    });
  }

  async function generateForJob(job, { force = false } = {}) {
    if (!force && job.approval !== 'approved' && needsApproval(job.channel)) {
      return { ...job, error: 'approval_required' };
    }
    const auth = authorizedMeta();
    if (!auth.consent_confirmed || auth.enabled === false) {
      job.phase = 'VOICE_GENERATION_FAILED';
      job.error = 'authorized_profile_not_enabled';
      return store.writeJob(job);
    }

    job.phase = 'VOICE_GENERATION_STARTED';
    store.writeJob(job);

    let bound = store.getBinding();
    if (!bound?.profile_id) {
      const resolved = await bindProfile();
      if (resolved.status !== 'bound') {
        job.phase = 'VOICE_GENERATION_FAILED';
        job.error = resolved.reason || resolved.error || 'profile_unbound';
        job.generation = resolved;
        return store.writeJob(job);
      }
      bound = store.getBinding();
    }

    const spoken = prepareSpokenText(job.spoken_text || job.response_text, { intro: job.intro === true });
    job.spoken_text = spoken;

    const result = await service.speak({
      text: spoken,
      voice_profile: bound.name || auth.name,
      language: job.language || auth.language || 'en',
      emotion: job.emotion,
      speed: job.speed,
      personality: personality.use_voicebox_personality_rewrite === true,
      engine: voicebox.preferred_engine || undefined,
      authorizedProfile: { id: bound.profile_id, name: bound.name || auth.name },
    });

    job.generation = result;
    job.verified = result.verified === true;
    job.voice_response_generated = result.verified === true;
    if (!result.verified) {
      job.phase = 'VOICE_GENERATION_FAILED';
      job.error = result.error || 'generation_unverified';
      return store.writeJob(job);
    }

    job.phase = 'AUDIO_VALIDATED';
    job.error = null;
    return store.writeJob(job);
  }

  function requestVoice({
    client_text,
    response_text,
    channel = 'unknown',
    client = null,
    company = null,
    conversation_id = null,
    emotion = null,
    speed = null,
    intro = false,
    auto_approve = false,
  } = {}) {
    const classified = classifyVoiceIntent(client_text || '');
    const decision = decideVoiceOutput({
      intent: classified.intent,
      channel,
      channelSupportsAudio: canDeliverAudio(channel),
      permission: true,
      available: true,
      consentConfirmed: authorizedMeta().consent_confirmed,
      profileEnabled: authorizedMeta().enabled,
    });

    const job = store.createJob({
      response_text,
      spoken_text: response_text,
      channel,
      client,
      company,
      conversation_id,
    });
    job.client_text = client_text || '';
    job.intent = classified;
    job.decision = decision;
    job.emotion = emotion;
    job.speed = speed;
    job.intro = intro === true;
    job.owner_notice = ownerVoiceNotice({
      client,
      company,
      channel,
      conversation: conversation_id,
      suggested: response_text,
    });

    if (auto_approve || !needsApproval(channel)) {
      job.approval = 'approved';
    }
    return store.writeJob(job);
  }

  async function approve(id) {
    const job = store.readJob(id);
    if (!job) return { error: 'job_not_found', id };
    job.approval = 'approved';
    return store.writeJob(job);
  }

  async function edit(id, text) {
    const job = store.readJob(id);
    if (!job) return { error: 'job_not_found', id };
    job.response_text = text;
    job.spoken_text = text;
    job.owner_notice = ownerVoiceNotice({
      client: job.client,
      company: job.company,
      channel: job.channel,
      conversation: job.conversation_id,
      suggested: text,
    });
    return store.writeJob(job);
  }

  async function cancel(id) {
    const job = store.readJob(id);
    if (!job) return { error: 'job_not_found', id };
    job.approval = 'cancelled';
    job.phase = 'VOICE_GENERATION_FAILED';
    job.error = 'cancelled_by_owner';
    return store.writeJob(job);
  }

  async function generate(id) {
    const job = store.readJob(id);
    if (!job) return { error: 'job_not_found', id };
    return generateForJob(job);
  }

  function deliver(id, { confirmed = false, reference = null } = {}) {
    const job = store.readJob(id);
    if (!job) return { error: 'job_not_found', id };
    if (job.phase !== 'AUDIO_VALIDATED' && job.phase !== 'DELIVERY_REQUESTED' && job.phase !== 'DELIVERY_CONFIRMED') {
      return { error: 'audio_not_ready', phase: job.phase, id };
    }
    const plan = planDelivery({
      channel: job.channel,
      audioPath: job.generation?.audio,
      generationId: job.generation?.generation_id,
    });
    const final = confirmed
      ? confirmDelivery(plan, { ok: true, reference })
      : plan;
    job.delivery = final;
    job.delivery_status = final.status;
    job.phase = final.phase;
    return store.writeJob(job);
  }

  async function status() {
    const health = await service.health();
    const binding = store.getBinding();
    const jobs = store.listJobs();
    const last = jobs[0] || null;
    const engines = health.reachable ? await service.listEngines() : { available: false, models: [] };
    const snapshot = {
      worker: 'VOICE WORKER',
      status: health.reachable ? 'READY' : 'OFFLINE',
      profile: {
        name: authorizedMeta().name,
        owner: authorizedMeta().owner,
        id: binding?.profile_id || null,
        bound: Boolean(binding?.profile_id),
        consent_confirmed: authorizedMeta().consent_confirmed,
      },
      voicebox: {
        reachable: health.reachable,
        base_url: service.baseUrl,
        client_id: service.clientId,
        health: health.voicebox || {},
        error: health.error || null,
      },
      engines: engines.models || [],
      last_action: last
        ? { id: last.id, phase: last.phase, channel: last.channel, verified: last.verified, updated_at: last.updated_at }
        : null,
      pending_approvals: jobs.filter((j) => j.approval === 'pending').length,
      recent: jobs.slice(0, 12).map(summarizeJob),
      config_path: configPath,
      retention_hours: retention.audio_ttl_hours || 24,
    };
    store.writeStatus(snapshot);
    store.purgeExpiredAudio(retention.audio_ttl_hours || 24);
    return snapshot;
  }

  return {
    config,
    configPath,
    store,
    service,
    authorizedMeta,
    bindProfile,
    classify: classifyVoiceIntent,
    decide: decideVoiceOutput,
    requestVoice,
    approve,
    edit,
    cancel,
    generate,
    deliver,
    status,
    prepareSpokenText,
    needsApproval,
  };
}

export function summarizeJob(job) {
  return {
    id: job.id,
    phase: job.phase,
    approval: job.approval,
    channel: job.channel,
    client: job.client,
    company: job.company,
    conversation_id: job.conversation_id,
    response_text: job.response_text,
    verified: job.verified,
    delivery_status: job.delivery_status,
    timestamp: job.updated_at || job.timestamp,
    error: job.error,
    audio: job.generation?.audio || null,
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const command = opts._[0] || 'help';
  const worker = createVoiceWorker({
    configPath: opts.config,
    home: opts.home,
  });

  switch (command) {
    case 'classify':
      print(worker.classify(opts._.slice(1).join(' ') || opts.text || ''));
      break;
    case 'request': {
      print(worker.requestVoice({
        client_text: opts['client-text'] || opts.text || '',
        response_text: opts.response || opts.reply || '',
        channel: opts.channel || 'local',
        client: opts.client || null,
        company: opts.company || null,
        conversation_id: opts.conversation || null,
        emotion: opts.emotion || null,
        speed: opts.speed || null,
        intro: opts.intro === true || opts.intro === 'true',
        auto_approve: opts['auto-approve'] === true,
      }));
      break;
    }
    case 'approve':
      print(await worker.approve(opts._[1] || opts.id));
      break;
    case 'edit':
      print(await worker.edit(opts._[1] || opts.id, opts.text || opts.response || ''));
      break;
    case 'cancel':
      print(await worker.cancel(opts._[1] || opts.id));
      break;
    case 'generate':
      print(await worker.generate(opts._[1] || opts.id));
      break;
    case 'deliver':
      print(worker.deliver(opts._[1] || opts.id, {
        confirmed: opts.confirmed === true || opts.confirmed === 'true',
        reference: opts.reference || null,
      }));
      break;
    case 'speak': {
      const job = worker.requestVoice({
        client_text: opts['client-text'] || 'send me a voice message',
        response_text: opts.text || opts.response || '',
        channel: opts.channel || 'local',
        client: opts.client || null,
        company: opts.company || null,
        conversation_id: opts.conversation || null,
        emotion: opts.emotion || null,
        speed: opts.speed || null,
        intro: opts.intro === true,
        auto_approve: opts['auto-approve'] === true || opts.channel === 'local',
      });
      if (job.approval !== 'approved') {
        print({ status: 'pending_approval', job: summarizeJob(job), notice: job.owner_notice });
        break;
      }
      const generated = await worker.generate(job.id);
      if (generated.verified && opts.deliver === true) {
        print(worker.deliver(job.id, { confirmed: false }));
      } else {
        print(generated);
      }
      break;
    }
    case 'bind':
      print(await worker.bindProfile());
      break;
    case 'profiles':
      print(await worker.service.listProfiles());
      break;
    case 'health':
      print(await worker.service.health());
      break;
    case 'status':
    case 'center':
      print(await worker.status());
      break;
    case 'jobs':
      print(worker.store.listJobs().map(summarizeJob));
      break;
    case 'job':
      print(worker.store.readJob(opts._[1] || opts.id));
      break;
    case 'purge':
      print(worker.store.purgeExpiredAudio(Number(opts.hours) || 24));
      break;
    case 'help':
    default:
      print({
        usage: 'node voice-worker.mjs <classify|request|approve|edit|generate|cancel|deliver|speak|bind|health|status|jobs|purge>',
        tool: 'voice.speak',
      });
  }
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main().catch((err) => {
    console.error(JSON.stringify({ status: 'failed', error: err.message }, null, 2));
    process.exit(1);
  });
}
