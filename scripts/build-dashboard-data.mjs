#!/usr/bin/env node
/**
 * AITZAZ AI 2070 — dashboard data builder.
 *
 * Generates dashboard/data.json (and dashboard/data.js for file:// use)
 * from the REAL project files. No mock data is ever produced here:
 * every value in the output is parsed from an actual repository file.
 * Capabilities that do not exist in the repository are listed under
 * `future_phases` and shown in the dashboard as "future phase".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSimpleYaml } from '../skills/voice-worker/yaml.mjs';
import { nextRunAt } from '../worker/scheduler.mjs';
import { probeJina } from '../worker/jina.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dashboard');

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null);
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch { return null; }
};

/* ---------------- package / identity ---------------- */
const pkg = JSON.parse(read('package.json'));

/* ---------------- workspace 7-layer system ---------------- */
const LAYERS = ['IDENTITY', 'SOUL', 'AGENTS', 'USER', 'HEARTBEAT', 'MEMORY', 'TOOLS'];
const workspace = {};
for (const name of LAYERS) {
  const content = read(`workspace/${name}.md`);
  workspace[name] = content
    ? { exists: true, bytes: Buffer.byteLength(content), source: `workspace/${name}.md` }
    : { exists: false };
}

const identityMd = read('workspace/IDENTITY.md') ?? '';
const companyName = (identityMd.match(/- \*\*Name\*\*: (.+)/) ?? [])[1] ?? pkg.description;
const brandName = (identityMd.match(/- \*\*Brand\*\*: (.+)/) ?? [])[1] ?? pkg.name;
const roleLine = (identityMd.match(/^Role: (.+)$/m) ?? [])[1] ?? '';

const userMd = read('workspace/USER.md') ?? '';
const ownerName = (userMd.match(/- Name: (.+)/) ?? [])[1] ?? 'Aitzaz';

const soulMd = read('workspace/SOUL.md') ?? '';
const soulTraits = (soulMd.match(/## Core Traits\n([\s\S]*?)\n\n/) ?? [])[1]
  ?.split('\n').filter(Boolean) ?? [];
const securityProtocols = (soulMd.match(/## Security Protocols\n([\s\S]*?)(?=\n## |$)/) ?? [])[1]
  ?.split('\n').filter((l) => l.startsWith('- ') || /^\d+\./.test(l)).slice(0, 12) ?? [];

/* ---------------- agents: 10-stage pipeline ---------------- */
const agentsMd = read('workspace/AGENTS.md') ?? '';
const stages = [...agentsMd.matchAll(/^### Stage (\d+): (.+)$/gm)].map((m) => ({
  number: Number(m[1]), name: m[2], source: 'workspace/AGENTS.md',
}));

/* ---------------- tasks: heartbeat checks ---------------- */
const heartbeatMd = read('workspace/HEARTBEAT.md') ?? '';
const heartbeatChecks = [...heartbeatMd.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({
  number: Number(m[1]), name: m[2], source: 'workspace/HEARTBEAT.md',
}));

const reportingCadence = (identityMd.match(/## Reporting Cadence\n([\s\S]*?)(?=\n\n|$)/) ?? [])[1]
  ?.split('\n').filter((l) => l.startsWith('- ')) ?? [];

/* ---------------- tools ---------------- */
const toolsMd = read('workspace/TOOLS.md') ?? '';
const toolSections = [...toolsMd.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

/* ---------------- memory: 4-layer protocol ---------------- */
const memoryMd = read('workspace/MEMORY.md') ?? '';
const memoryLayers = [...memoryMd.matchAll(/\| \*\*L(\d): ([^|*]+)\*\* \| ([^|]+) \| ([^|]+) \|/g)]
  .map((m) => ({ layer: `L${m[1]}`, name: m[2].trim(), engine: m[3].trim(), how: m[4].trim(), source: 'workspace/MEMORY.md' }));

/* ---------------- skills (real, from skills/) ---------------- */
const skillsDir = join(ROOT, 'skills');
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const md = read(`skills/${d.name}/SKILL.md`) ?? '';
        const fmDesc = md.match(/^description:\s*"(.+)"/m)?.[1];
        const firstPara = md.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('name:') && !l.startsWith('>'));
        return {
          id: d.name,
          title: (md.match(/^# (.+)$/m) ?? [])[1] ?? d.name,
          description: fmDesc ?? firstPara ?? '',
          hasCode: ['chroma.mjs', 'sm.mjs', 'deliver.sh', 'voice-service.mjs', 'voice-worker.mjs'].some((f) => existsSync(join(skillsDir, d.name, f))),
          source: `skills/${d.name}/SKILL.md`,
        };
      })
  : [];

/* ---------------- product knowledge base (real) ---------------- */
const catalog = JSON.parse(read('product-kb/catalog.json') ?? '{}');
const productKb = {
  company: catalog.company ?? null,
  lastUpdated: catalog.last_updated ?? null,
  categories: (catalog.categories ?? []).map((c) => ({ id: c.id, name: c.name, products: (c.products ?? []).length })),
  productCount: (catalog.categories ?? []).reduce((n, c) => n + (c.products ?? []).length, 0),
  source: 'product-kb/catalog.json',
};

/* ---------------- verification (actually runs the real validator) ---------------- */
const validateOutput = run('bash', ['scripts/validate-template.sh']) ?? '';
const verification = {
  validatorScript: 'scripts/validate-template.sh',
  ranAt: new Date().toISOString(),
  passed: validateOutput.includes('All template checks passed.'),
  checks: validateOutput.split('\n').filter((l) => l.startsWith('OK ')).map((l) => l.slice(3)),
  ciWorkflow: existsSync(join(ROOT, '.github/workflows/validate.yml')),
  ciWorkflowSource: '.github/workflows/validate.yml',
};

/* ---------------- security posture (docs actually present) ---------------- */
const security = {
  policyFile: existsSync(join(ROOT, 'SECURITY.md')),
  reportingChannel: 'GitHub Security Advisories',
  soulProtocols: securityProtocols,
  promptInjectionDefense: /Prompt Injection Defense/.test(securityProtocols.join('\n') + soulMd),
  source: 'SECURITY.md / workspace/SOUL.md',
};

/* ---------------- git / activity (real history) ---------------- */
const gitRemote = run('git', ['config', '--get', 'remote.origin.url']);
const gitBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const gitLogRaw = run('git', ['log', '--pretty=format:%h|%ad|%s', '--date=short', '-n', '8']);
const activity = (gitLogRaw ? gitLogRaw.split('\n') : []).map((l) => {
  const [hash, date, ...rest] = l.split('|');
  return { hash, date, message: rest.join('|') };
});

const changelogMd = read('CHANGELOG.md') ?? '';
const latestChangelog = (changelogMd.match(/^## (?!Unreleased|\[)(.+)$/m) ?? [])[1] ?? null;

/* ---------------- voice worker (real config + optional runtime status) ---------------- */
const voiceYamlRaw = read('workspace/voice.yaml') || read('skills/voice-worker/voice.yaml') || '';
const voiceCfg = voiceYamlRaw ? parseSimpleYaml(voiceYamlRaw) : {};
const voiceRuntime = (() => {
  const home = process.env.OPENCLAW_HOME || join(process.env.HOME || '', '.openclaw');
  const statusFile = join(home, 'voice', 'status.json');
  if (!existsSync(statusFile)) return null;
  try { return JSON.parse(readFileSync(statusFile, 'utf8')); } catch { return null; }
})();
const voice = {
  worker: 'VOICE WORKER',
  worker_status: existsSync(join(ROOT, 'skills/voice-worker/voice-worker.mjs')) ? 'READY' : 'ERROR',
  voicebox_status: voiceRuntime?.voicebox?.reachable ? 'CONNECTED' : 'DISCONNECTED',
  profile_status: voiceRuntime?.profile?.bound ? (voiceRuntime.profile.name || 'Aitzaz') : 'NOT CONFIGURED',
  profile: {
    name: voiceCfg.voice_profile?.name || 'Aitzaz',
    owner: voiceCfg.voice_profile?.owner || 'Aitzaz',
    language: voiceCfg.voice_profile?.language || 'en',
    consent_confirmed: voiceCfg.voice_profile?.consent_confirmed === true,
    enabled: voiceCfg.voice_profile?.enabled !== false,
    id: voiceRuntime?.profile?.id || voiceCfg.voice_profile?.id || null,
    bound: Boolean(voiceRuntime?.profile?.bound || voiceRuntime?.profile?.id),
  },
  voicebox: voiceRuntime?.voicebox || {
    reachable: false,
    base_url: voiceCfg.voicebox?.base_url || 'http://127.0.0.1:17493',
    client_id: voiceCfg.voicebox?.client_id || 'aitzaz-ai-2070',
    note: 'Voicebox is not queried at dashboard build time unless a prior voice-worker status snapshot exists.',
  },
  engines: voiceRuntime?.engines || [],
  last_action: voiceRuntime?.last_action || null,
  recent: voiceRuntime?.recent || [],
  personality: voiceCfg.personality?.traits || [],
  source: voiceYamlRaw ? (existsSync(join(ROOT, 'workspace/voice.yaml')) ? 'workspace/voice.yaml' : 'skills/voice-worker/voice.yaml') : 'missing',
};

/* ---------------- W4 reply intelligence (module + optional local ledger) ---------------- */
const w4Present = existsSync(join(ROOT, 'worker/replies.mjs')) && existsSync(join(ROOT, 'worker/classifier.mjs'));
const w4Runtime = (() => {
  const home = process.env.OPENCLAW_HOME || join(process.env.HOME || '', '.openclaw');
  const ledgerFile = join(home, 'worker', 'ledger.jsonl');
  if (!existsSync(ledgerFile)) return null;
  try {
    const rows = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const classified = rows.filter((r) => r.event === 'REPLY_CLASSIFIED');
    return {
      replies: classified.slice(-12).map((r) => ({
        classification: r.classification, confidence: r.confidence, lead_id: r.lead_id,
        subject: r.subject || null, timestamp: r.timestamp, message_id: r.message_id || null,
      })),
      unmatched: rows.filter((r) => r.event === 'REPLY_UNMATCHED').length,
      opt_outs: rows.filter((r) => r.event === 'OPT_OUT_RECORDED').length,
      notifications_sent: rows.filter((r) => r.event === 'NOTIFICATION_SENT').length,
      notifications_failed: rows.filter((r) => r.event === 'NOTIFICATION_FAILED').length,
      errors: rows.filter((r) => r.event === 'REPLY_CHECK_FAILED').slice(-5),
    };
  } catch { return null; }
})();
const replies = {
  worker: 'W4 REPLY INTELLIGENCE',
  present: w4Present,
  inbox: process.env.GMAIL_ADAPTER_URL ? 'ADAPTER_URL' : 'NOT CONFIGURED',
  notifier: process.env.NOTIFY_WEBHOOK_URL ? 'WEBHOOK' : 'NOT CONFIGURED',
  method: 'rules',
  categories: ['INTERESTED', 'QUESTION', 'PRICE_REQUEST', 'FOLLOW_UP', 'NOT_INTERESTED', 'OPT_OUT', 'WRONG_PERSON', 'OUT_OF_OFFICE', 'UNKNOWN'],
  recent: w4Runtime?.replies || [],
  unmatched: w4Runtime?.unmatched || 0,
  opt_outs: w4Runtime?.opt_outs || 0,
  notifications_sent: w4Runtime?.notifications_sent || 0,
  notifications_failed: w4Runtime?.notifications_failed || 0,
  errors: w4Runtime?.errors || [],
  source: 'worker/replies.mjs + worker/classifier.mjs',
};

const w5Present = existsSync(join(ROOT, 'worker/outreach.mjs')) && existsSync(join(ROOT, 'worker/adapters.mjs'));
const outreachRuntime = (() => {
  const home = process.env.OPENCLAW_HOME || join(process.env.HOME || '', '.openclaw');
  const ledgerFile = join(home, 'worker', 'ledger.jsonl');
  if (!existsSync(ledgerFile)) return null;
  try {
    const rows = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return {
      sent: rows.filter((r) => r.event === 'OUTREACH_SENT').slice(-12),
      failed: rows.filter((r) => r.event === 'OUTREACH_FAILED').length,
      blocked: rows.filter((r) => r.event === 'OUTREACH_BLOCKED').length,
      pending: rows.filter((r) => r.event === 'OUTREACH_PENDING_APPROVAL').length,
      manual: rows.filter((r) => r.event === 'OUTREACH_MANUAL_ASSIST').length,
      rate_limited: rows.filter((r) => r.event === 'RATE_LIMITED').length,
    };
  } catch { return null; }
})();
const outreach = {
  worker: 'W5 MULTI-CHANNEL OUTREACH',
  present: w5Present,
  email: process.env.EMAIL_ADAPTER_URL || process.env.GMAIL_SEND_URL ? 'ADAPTER_URL' : 'ADAPTER_UNAVAILABLE',
  teams: process.env.TEAMS_ACCESS_TOKEN ? 'AUTHORIZED' : 'NOT_AUTHORIZED',
  linkedin: (process.env.LINKEDIN_ACCESS_TOKEN || process.env.LINKEDIN_ADAPTER_URL) ? 'AUTHORIZED' : 'MANUAL_ASSIST',
  sent: outreachRuntime?.sent || [],
  failed: outreachRuntime?.failed || 0,
  blocked: outreachRuntime?.blocked || 0,
  pending: outreachRuntime?.pending || 0,
  manual: outreachRuntime?.manual || 0,
  rate_limited: outreachRuntime?.rate_limited || 0,
  source: 'worker/outreach.mjs + worker/adapters.mjs',
};

const w6Present = existsSync(join(ROOT, 'worker/daily.mjs')) && existsSync(join(ROOT, 'worker/scheduler.mjs'));
const dailyRuntime = (() => {
  const home = process.env.OPENCLAW_HOME || join(process.env.HOME || '', '.openclaw');
  const workerDir = join(home, 'worker');
  const schedulerFile = join(workerDir, 'scheduler.json');
  const currentFile = join(workerDir, 'current-run.json');
  const latestReport = join(workerDir, 'reports', 'latest.json');
  const sched = existsSync(schedulerFile) ? (() => { try { return JSON.parse(readFileSync(schedulerFile, 'utf8')); } catch { return null; } })() : null;
  const current = existsSync(currentFile) ? (() => { try { return JSON.parse(readFileSync(currentFile, 'utf8')); } catch { return null; } })() : null;
  const report = existsSync(latestReport) ? (() => { try { return JSON.parse(readFileSync(latestReport, 'utf8')); } catch { return null; } })() : null;
  const last = current?.status && current.status !== 'RUNNING' ? current : (report ? { id: report.run_id, status: report.status, counts: report.counts, dry_run: report.dry_run } : null);
  return { sched, current: current?.status === 'RUNNING' ? current : null, last, report };
})();
const operations = {
  worker: 'W6 DAILY AUTONOMOUS WORKER',
  present: w6Present,
  current_run: dailyRuntime?.current ? { id: dailyRuntime.current.id, status: dailyRuntime.current.status, started_at: dailyRuntime.current.started_at } : null,
  last_run: dailyRuntime?.last ? { id: dailyRuntime.last.id, status: dailyRuntime.last.status, dry_run: dailyRuntime.last.dry_run || false } : null,
  next_run: nextRunAt(new Date(), {
    timezone: dailyRuntime?.sched?.timezone || process.env.WORKER_TZ || 'UTC',
    hour: Number(process.env.WORKER_HOUR || 10),
    minute: Number(process.env.WORKER_MINUTE || 0),
  }).toISOString(),
  status: dailyRuntime?.current?.status || dailyRuntime?.last?.status || (w6Present ? 'NEVER_RUN' : 'MISSING'),
  discovered: dailyRuntime?.report?.counts?.leads_discovered || dailyRuntime?.last?.counts?.leads_discovered || 0,
  researched: dailyRuntime?.report?.counts?.leads_researched || 0,
  approved: dailyRuntime?.report?.counts?.approvals_pending || 0,
  confirmed_sends: dailyRuntime?.report?.counts?.confirmed_sends || 0,
  failed: dailyRuntime?.report?.counts?.failed_sends || 0,
  manual_assist: dailyRuntime?.report?.counts?.manual_assist_actions || 0,
  replies: dailyRuntime?.report?.counts?.replies_received || 0,
  follow_ups: dailyRuntime?.report?.counts?.follow_ups || 0,
  errors: dailyRuntime?.report?.counts?.provider_errors || (dailyRuntime?.report?.errors || []).length || 0,
  mode: dailyRuntime?.report?.mode || null,
  timezone: dailyRuntime?.sched?.timezone || process.env.WORKER_TZ || 'UTC',
  source: 'worker/daily.mjs + $OPENCLAW_HOME/worker/runs (no live providers queried at build time)',
};

const workerModules = [
  { id: 'W1 ledger/scoring', role: 'Lead ledger + ICP scoring', source: 'worker/ledger.mjs + worker/scoring.mjs', file: 'worker/ledger.mjs' },
  { id: 'W1 workflows', role: 'Roofing / ACA-Medicare / B2B profiles (no send)', source: 'worker/workflows.mjs', file: 'worker/workflows.mjs' },
  { id: 'W2 research', role: 'Jina discovery/research', source: 'worker/research.mjs + worker/discovery.mjs', file: 'worker/research.mjs' },
  { id: 'W3 inbox', role: 'Authorized inbox adapter (no Gmail OAuth in repo)', source: 'worker/gmail.mjs', file: 'worker/gmail.mjs' },
  { id: 'W4 replies', role: 'Classifier + opt-out + notify', source: 'worker/replies.mjs', file: 'worker/replies.mjs' },
  { id: 'W5 outreach', role: 'Approval-gated multi-channel send', source: 'worker/outreach.mjs + worker/adapters.mjs', file: 'worker/outreach.mjs' },
  { id: 'W6 daily', role: 'Scheduled orchestrator', source: 'worker/daily.mjs', file: 'worker/daily.mjs' },
  { id: 'Voice Worker', role: 'Authorized Aitzaz voice via Voicebox REST', source: 'skills/voice-worker/voice-worker.mjs', file: 'skills/voice-worker/voice-worker.mjs' },
].map((m) => ({
  ...m,
  present: existsSync(join(ROOT, m.file)),
  status: existsSync(join(ROOT, m.file)) ? 'PRESENT' : 'MISSING',
}));
const workers = {
  present: existsSync(join(ROOT, 'worker')),
  module_count: workerModules.filter((m) => m.present).length,
  modules: workerModules,
  workflows: ['b2b_trade', 'roofing', 'aca_medicare'],
  pwa: existsSync(join(ROOT, 'dashboard/manifest.webmanifest')),
  gmail: process.env.GMAIL_ADAPTER_URL ? 'ADAPTER_URL' : 'NOT_AUTHORIZED',
  source: 'worker/* file presence (no live providers queried)',
};

const jinaHealth = await probeJina({ timeoutMs: 4000, maxRetries: 0 });
const apis = {
  jina: {
    status: jinaHealth.status,
    reason: jinaHealth.reason,
    key_present: jinaHealth.key_present,
    live: jinaHealth.live === true,
    search: jinaHealth.search,
    reader: jinaHealth.reader,
    note: jinaHealth.status === 'CONNECTED' ? 'real Jina 2xx' : 'CONNECTED only after a real Jina 2xx',
  },
  gmail: {
    status: 'NOT_AUTHORIZED',
    reason: 'gmail_oauth_not_in_repo',
    live: false,
    note: 'W3 Gmail OAuth is not implemented. Inbox uses GMAIL_ADAPTER_URL only.',
  },
  teams: {
    status: process.env.TEAMS_ACCESS_TOKEN ? 'NOT_CONFIGURED' : 'NOT_AUTHORIZED',
    reason: process.env.TEAMS_ACCESS_TOKEN ? 'graph_health_not_probed_this_phase' : 'missing_teams_token',
    live: false,
    note: 'Token presence is not CONNECTED. Graph health is a later phase.',
  },
  notifications: {
    status: 'NOT_CONFIGURED',
    reason: process.env.NOTIFY_WEBHOOK_URL ? 'webhook_health_not_probed_this_phase' : 'adapter_not_configured',
    live: false,
  },
  voicebox: {
    status: voiceRuntime?.voicebox?.reachable ? 'CONNECTED' : (voiceRuntime ? 'UNREACHABLE' : 'NOT_CONFIGURED'),
    reason: voiceRuntime?.voicebox?.reachable ? 'prior_voice_worker_health' : 'no_live_voicebox_probe_this_phase',
    live: Boolean(voiceRuntime?.voicebox?.reachable),
    note: 'CONNECTED only if a prior Voice Worker /health snapshot is reachable.',
  },
  scheduler: {
    status: w6Present ? 'NOT_CONFIGURED' : 'ERROR',
    reason: w6Present ? 'local_scheduler_not_an_external_api' : 'w6_missing',
    live: false,
    next_run: operations.next_run,
    last_status: operations.status,
  },
  source: 'worker/jina.mjs probeJina() + env presence. No fake CONNECTED.',
};

/* ---------------- future phases: honest non-existent features ---------------- */
const future_phases = [
  { area: 'W3', item: 'Gmail OAuth / gws send is not in this repository. Email send uses EMAIL_ADAPTER_URL / GMAIL_SEND_URL through W5. Unconfigured = ADAPTER_UNAVAILABLE / NOT_AUTHORIZED.' },
  { area: 'SDR / Work', item: 'Live CRM pipeline metrics (requires a connected Google Sheets / Notion CRM — configure deploy/config.sh)' },
  { area: 'Automation', item: 'Live heartbeat run history (heartbeat executes on the deployed OpenClaw gateway, not in this repository)' },
  { area: 'GitHub', item: 'ClawHub marketplace publication of the aitzaz-ai-2070 skill' },
  { area: 'Security', item: 'Gateway token rotation automation (currently manual, see SECURITY.md)' },
  { area: 'System', item: 'Authenticated multi-tenant web control panel (current monitoring UI is the OpenClaw gateway dashboard, see workspace/TOOLS.md)' },
  { area: 'Memory', item: 'ChromaDB / MemOS live indexes (exist only on a deployed server)' },
];

const data = {
  generatedAt: new Date().toISOString(),
  app: {
    name: 'AITZAZ AI 2070',
    tagline: 'A futuristic AI Operating System for B2B sales',
    owner: ownerName,
    package: { name: pkg.name, version: pkg.version },
    role: roleLine,
    company: companyName,
    brand: brandName,
  },
  workspace,
  aiBrain: { company: companyName, brand: brandName, soulTraits, source: 'workspace/IDENTITY.md + workspace/SOUL.md' },
  agents: { stages, count: stages.length, source: 'workspace/AGENTS.md' },
  tasks: { heartbeatChecks, count: heartbeatChecks.length, source: 'workspace/HEARTBEAT.md' },
  automation: { reportingCadence, source: 'workspace/IDENTITY.md' },
  tools: { sections: toolSections, source: 'workspace/TOOLS.md' },
  memory: { layers: memoryLayers, source: 'workspace/MEMORY.md' },
  skills,
  productKb,
  verification,
  security,
  git: { remote: gitRemote, branch: gitBranch, activity, source: 'git log' },
  changelog: { latest: latestChangelog, source: 'CHANGELOG.md' },
  voice,
  replies,
  outreach,
  operations,
  workers,
  apis,
  future_phases,
};

mkdirSync(OUT_DIR, { recursive: true });
const json = JSON.stringify(data, null, 2) + '\n';
writeFileSync(join(OUT_DIR, 'data.json'), json);
writeFileSync(join(OUT_DIR, 'data.js'), 'window.AITZAZ_DATA = ' + json);
console.log(`dashboard/data.json written (${data.skills.length} skills, ${stages.length} stages, ${heartbeatChecks.length} heartbeat checks, validation ${verification.passed ? 'PASSED' : 'FAILED'})`);
if (!verification.passed) process.exitCode = 1;
