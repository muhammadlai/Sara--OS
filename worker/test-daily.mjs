import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, EVENTS } from './ledger.mjs';
import { createEmailAdapter, createTeamsAdapter, createLinkedInAdapter } from './adapters.mjs';
import { createOutreach } from './outreach.mjs';
import { createReplyWorker } from './replies.mjs';
import { createNotifier } from './notify.mjs';
import { createScheduler, nextRunAt, shouldRunNow, dateKeyInZone, zonedParts } from './scheduler.mjs';
import { createDailyWorker } from './daily.mjs';
import { buildDailyReport, REPORT_GREETING } from './report.mjs';

function home() {
  return mkdtempSync(join(tmpdir(), 'aitzaz-w6-'));
}

function stubJina(hits = [{ title: 'Desert Fleet', url: 'https://desert-fleet.example', snippet: 'importer' }]) {
  return {
    search: async () => ({
      ok: true,
      status: 200,
      attempts: 1,
      body: { data: hits },
    }),
    read: async (url) => ({
      ok: true,
      status: 200,
      attempts: 1,
      body: { data: { url, title: 'About', content: 'Fleet operator importing heavy vehicles. '.repeat(10) } },
    }),
  };
}

function setup(extra = {}) {
  const dir = extra.home || home();
  const ledger = extra.ledger || createLedger(dir);
  const sends = extra.sends || [];
  const emailSend = extra.emailSend || (async (payload) => {
    sends.push({ channel: 'email', ...payload });
    return { ok: true, message_id: `em-${sends.length}` };
  });
  const outreach = extra.outreach || createOutreach({
    ledger,
    email: extra.email || createEmailAdapter({ send: extra.noEmail ? undefined : emailSend, env: extra.noEmail ? {} : undefined }),
    teams: extra.teams || createTeamsAdapter({ env: {}, send: extra.teamsSend }),
    linkedin: extra.linkedin || createLinkedInAdapter({ env: {} }),
    notifier: extra.notifier || createNotifier({ send: extra.notifySend || (async () => ({ ok: true, reference: 'n' })) }),
    requireApproval: extra.requireApproval !== false,
    limits: extra.limits,
  });
  const inboxMessages = extra.inboxMessages || [];
  const replies = extra.replies || createReplyWorker({
    ledger,
    inbox: extra.inbox || { listReplies: async () => ({ ok: true, messages: inboxMessages }) },
    notifier: extra.notifier || createNotifier({ send: extra.notifySend || (async () => ({ ok: true, reference: 'n' })) }),
  });
  const now = extra.now || (() => extra.nowDate || new Date('2026-08-18T09:00:00.000Z'));
  const worker = createDailyWorker({
    home: dir,
    ledger,
    outreach,
    replies,
    jina: extra.jina || stubJina(extra.hits),
    env: extra.env || { JINA_API_KEY: 'test-jina-key-do-not-commit' },
    now,
    timezone: extra.timezone || 'UTC',
    hour: extra.hour ?? 10,
    minute: extra.minute ?? 0,
    queries: extra.queries || ['fleet buyers UAE'],
    autoApprove: extra.autoApprove === true,
    requireApproval: extra.requireApproval,
    limits: extra.limits,
    highPriorityScore: extra.highPriorityScore,
    maxOutreach: extra.maxOutreach,
    maxResearch: extra.maxResearch,
    followUpDays: extra.followUpDays,
    staleLockMs: extra.staleLockMs,
  });
  return { dir, ledger, worker, outreach, sends };
}

test('scheduler timezone: Karachi 10:00 gate and next run', () => {
  const tz = 'Asia/Karachi';
  const before = new Date('2026-08-18T04:00:00.000Z'); // 09:00 PKT
  const at = new Date('2026-08-18T05:00:00.000Z'); // 10:00 PKT
  assert.equal(zonedParts(at, tz).hour, 10);
  assert.equal(dateKeyInZone(at, tz), '2026-08-18');
  assert.equal(shouldRunNow(before, { timezone: tz, hour: 10, minute: 0 }), false);
  assert.equal(shouldRunNow(at, { timezone: tz, hour: 10, minute: 0 }), true);
  assert.equal(shouldRunNow(at, { timezone: tz, hour: 10, minute: 0 }, '2026-08-18'), false);
  const nextBefore = nextRunAt(before, { timezone: tz, hour: 10, minute: 0 });
  assert.equal(dateKeyInZone(nextBefore, tz), '2026-08-18');
  assert.equal(zonedParts(nextBefore, tz).hour, 10);
  const nextAfter = nextRunAt(new Date('2026-08-18T06:00:00.000Z'), { timezone: tz, hour: 10, minute: 0 });
  assert.equal(dateKeyInZone(nextAfter, tz), '2026-08-19');
});

test('daily execution: discovery → research → score → confirmed send → reply', async () => {
  const { ledger, worker, sends } = setup({ autoApprove: true });
  ledger.upsertLead({
    id: 'acme',
    company: 'Acme Logistics',
    email: 'buyer@acme.example',
    stage: 'new',
    url: 'https://acme.example',
  });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.status, 'DAILY_RUN_COMPLETED');
  assert.ok(result.counts.leads_discovered >= 1);
  assert.ok(result.counts.leads_researched >= 1);
  assert.equal(ledger.readLead('acme').stage, 'researched');
  assert.equal(result.counts.confirmed_sends, 1);
  assert.equal(sends.length, 1);
  assert.equal(result.report.mode, 'TEST ADAPTER');
  assert.match(result.report.text, /Sir, I handled today's outreach/);
  assert.ok(ledger.listEvents({ limit: 2000 }).some((e) => e.event === EVENTS.OUTREACH_SENT));
  assert.ok(ledger.listEvents({ limit: 2000 }).some((e) => e.event === EVENTS.DAILY_RUN_COMPLETED));
});

test('restart safety: stale lock is recovered and a new run completes', async () => {
  const dir = home();
  const { worker, ledger } = setup({ home: dir, autoApprove: true });
  writeFileSync(join(dir, 'daily.lock'), JSON.stringify({
    pid: 999999001,
    run_id: 'run_2026-08-18',
    started_at: '2026-08-17T01:00:00.000Z',
  }));
  writeFileSync(join(dir, 'runs', 'run_2026-08-18.json'), JSON.stringify({
    id: 'run_2026-08-18',
    date_key: '2026-08-18',
    status: 'RUNNING',
    started_at: '2026-08-17T01:00:00.000Z',
    counts: {},
    errors: [],
  }, null, 2));
  ledger.upsertLead({ id: 'r1', company: 'Recover Co', email: 'r@x.example' });
  const result = await worker.execute({ dryRun: false, force: true });
  assert.equal(result.status, 'DAILY_RUN_COMPLETED');
  const recovered = JSON.parse(readFileSync(join(dir, 'runs', 'run_2026-08-18.json'), 'utf8'));
  assert.equal(recovered.status, 'FAILED');
  assert.equal(recovered.reason, 'stale_lock_recovered');
  assert.ok(ledger.listEvents({ limit: 2000 }).some((e) => e.event === EVENTS.DAILY_RUN_FAILED && e.error === 'stale_lock_recovered'));
});

test('duplicate prevention: second run same day is skipped', async () => {
  const { worker } = setup({ autoApprove: true });
  const a = await worker.execute({ dryRun: true });
  const b = await worker.execute({ dryRun: true });
  assert.equal(a.status, 'DAILY_RUN_COMPLETED');
  assert.equal(b.status, 'DAILY_RUN_SKIPPED');
  assert.equal(b.reason, 'duplicate_run');
});

test('approval required: prepares but does not send', async () => {
  const { ledger, worker, sends } = setup({ autoApprove: false, requireApproval: true });
  ledger.upsertLead({ id: 'p', company: 'Pending Co', email: 'p@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.status, 'DAILY_RUN_COMPLETED');
  assert.equal(result.counts.confirmed_sends, 0);
  assert.ok(result.counts.approvals_pending >= 1);
  assert.equal(sends.length, 0);
  assert.ok(ledger.listEvents({ limit: 2000 }).some((e) => e.event === EVENTS.OUTREACH_PENDING_APPROVAL));
});

test('opt-out blocks daily outreach', async () => {
  const { ledger, worker, sends } = setup({
    autoApprove: true,
    jina: stubJina([]),
  });
  ledger.upsertLead({
    id: 'z',
    company: 'Opt Out Co',
    email: 'z@x.example',
    do_not_contact: true,
    suppressed: true,
  });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.counts.confirmed_sends, 0);
  assert.equal(sends.length, 0);
  assert.ok(result.counts.blocked_actions >= 1);
});

test('rate limits are recorded honestly', async () => {
  const { ledger, worker } = setup({
    autoApprove: true,
    limits: { email: 1 },
    maxOutreach: 5,
    jina: stubJina([]),
  });
  ledger.upsertLead({ id: 'a', company: 'A', email: 'a@x.example' });
  ledger.upsertLead({ id: 'b', company: 'B', email: 'b@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.counts.confirmed_sends, 1);
  assert.ok(result.counts.rate_limits >= 1);
});

test('provider unavailable is not a send', async () => {
  const { ledger, worker } = setup({
    autoApprove: true,
    noEmail: true,
    jina: stubJina([]),
  });
  ledger.upsertLead({ id: 'u', company: 'Unavail', email: 'u@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.counts.confirmed_sends, 0);
  assert.ok(result.counts.failed_sends + result.counts.manual_assist_actions + result.counts.provider_errors >= 1);
  assert.ok(!ledger.listEvents({ limit: 2000 }).some((e) => e.event === EVENTS.OUTREACH_SENT));
});

test('provider-confirmed send requires message_id', async () => {
  const { ledger, worker } = setup({
    autoApprove: true,
    jina: stubJina([]),
    emailSend: async () => ({ ok: true, message_id: 'prov-1' }),
  });
  ledger.upsertLead({ id: 'ok', company: 'Ok Co', email: 'ok@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.counts.confirmed_sends, 1);
  const sent = ledger.listEvents({ limit: 2000 }).find((e) => e.event === EVENTS.OUTREACH_SENT);
  assert.equal(sent.provider_message_id, 'prov-1');
});

test('failed send is not counted as confirmed', async () => {
  const { ledger, worker } = setup({
    autoApprove: true,
    jina: stubJina([]),
    emailSend: async () => ({ ok: false, reason: 'smtp_down' }),
  });
  ledger.upsertLead({ id: 'f', company: 'Fail Co', email: 'f@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.counts.confirmed_sends, 0);
  assert.ok(result.counts.failed_sends >= 1);
  assert.ok(result.counts.provider_errors >= 1);
});

test('reply processing classifies interested / question / price / opt-out', async () => {
  const { ledger, worker } = setup({
    autoApprove: true,
    jina: stubJina([]),
    inboxMessages: [
      { message_id: 'm1', sender: 'i@x.example', subject: 'Re', body: 'We are interested, let us talk' },
      { message_id: 'm2', sender: 'q@x.example', subject: 'Re', body: 'Can you share the brochure?' },
      { message_id: 'm3', sender: 'p@x.example', subject: 'Re', body: 'What is the unit price?' },
      { message_id: 'm4', sender: 'o@x.example', subject: 'Re', body: 'Please unsubscribe' },
    ],
  });
  ledger.upsertLead({ id: 'i', company: 'Int', email: 'i@x.example' });
  ledger.upsertLead({ id: 'q', company: 'Que', email: 'q@x.example' });
  ledger.upsertLead({ id: 'p', company: 'Pri', email: 'p@x.example' });
  ledger.upsertLead({ id: 'o', company: 'Opt', email: 'o@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.ok(result.counts.replies_received >= 4);
  assert.equal(result.counts.interested_replies, 1);
  assert.equal(result.counts.questions, 1);
  assert.equal(result.counts.price_requests, 1);
  assert.equal(result.counts.opt_outs, 1);
  assert.equal(ledger.readLead('o').do_not_contact, true);
});

test('report generation includes required lines and greeting', () => {
  const report = buildDailyReport({
    runId: 'run_2026-08-18',
    dateKey: '2026-08-18',
    timezone: 'Asia/Karachi',
    dryRun: true,
    counts: { confirmed_sends: 0, leads_discovered: 2 },
  });
  assert.equal(report.greeting, REPORT_GREETING);
  assert.match(report.text, /Leads discovered: 2/);
  assert.match(report.text, /Confirmed sends: 0/);
  assert.equal(report.mode, 'DRY-RUN');
});

test('dry-run never sends', async () => {
  let sent = 0;
  const { ledger, worker } = setup({
    autoApprove: true,
    emailSend: async () => {
      sent += 1;
      return { ok: true, message_id: 'should-not' };
    },
  });
  ledger.upsertLead({ id: 'd', company: 'Dry Co', email: 'd@x.example' });
  const result = await worker.execute({ dryRun: true });
  assert.equal(result.status, 'DAILY_RUN_COMPLETED');
  assert.equal(result.dry_run, true);
  assert.equal(sent, 0);
  assert.equal(result.counts.confirmed_sends, 0);
  assert.equal(result.report.mode, 'DRY-RUN');
  assert.ok(!ledger.listEvents({ limit: 2000 }).some((e) => e.event === EVENTS.OUTREACH_SENT));
});

test('ledger persistence of run files and events', async () => {
  const { dir, ledger, worker } = setup({ autoApprove: true, jina: stubJina([]) });
  ledger.upsertLead({ id: 'lg', company: 'Log', email: 'lg@x.example' });
  const result = await worker.execute({ dryRun: false });
  assert.equal(result.status, 'DAILY_RUN_COMPLETED');
  assert.ok(existsSync(join(dir, 'runs', `${result.run_id}.json`)));
  assert.ok(existsSync(join(dir, 'reports', 'latest.md')));
  const saved = JSON.parse(readFileSync(join(dir, 'runs', `${result.run_id}.json`), 'utf8'));
  assert.equal(saved.status, 'COMPLETED');
  assert.ok(saved.counts);
  const events = ledger.listEvents({ limit: 2000 }).map((e) => e.event);
  assert.ok(events.includes(EVENTS.DAILY_RUN_STARTED));
  assert.ok(events.includes(EVENTS.DAILY_RUN_COMPLETED));
  assert.ok(events.includes(EVENTS.DAILY_REPORT));
});

test('scheduler status exposes next run without inventing a live run', () => {
  const dir = home();
  const sched = createScheduler({
    home: dir,
    timezone: 'UTC',
    hour: 10,
    minute: 0,
    now: () => new Date('2026-08-18T09:00:00.000Z'),
  });
  const snap = sched.snapshot();
  assert.equal(snap.date_key, '2026-08-18');
  assert.equal(snap.should_run, false);
  assert.ok(snap.next_run);
  assert.equal(snap.lock.locked, false);
  assert.equal(snap.state.last_run_id, null);
});
