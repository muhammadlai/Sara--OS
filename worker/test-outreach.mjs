import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, EVENTS } from './ledger.mjs';
import { createEmailAdapter, createTeamsAdapter, createLinkedInAdapter, SEND } from './adapters.mjs';
import { createOutreach, selectChannel, draftMessage } from './outreach.mjs';
import { createNotifier } from './notify.mjs';

function home() {
  return mkdtempSync(join(tmpdir(), 'aitzaz-w5-'));
}

function setup(extra = {}) {
  const ledger = createLedger(home());
  const outreach = createOutreach({
    ledger,
    email: extra.email || createEmailAdapter({ send: extra.emailSend }),
    teams: extra.teams || createTeamsAdapter({ send: extra.teamsSend, token: extra.teamsToken }),
    linkedin: extra.linkedin || createLinkedInAdapter({ send: extra.linkedinSend, token: extra.linkedinToken }),
    notifier: extra.notifier || createNotifier({ send: extra.notifySend || (async () => ({ ok: true, reference: 'n' })) }),
    requireApproval: extra.requireApproval !== false,
    limits: extra.limits,
  });
  return { ledger, outreach };
}

test('email adapter success requires provider message_id', async () => {
  const email = createEmailAdapter({ send: async () => ({ ok: true, message_id: 'em-1' }) });
  const r = await email.send({ to: 'a@b.example', subject: 'Hi', body: 'Hello' });
  assert.equal(r.status, SEND.CONFIRMED);
  assert.equal(r.message_id, 'em-1');
});

test('email adapter unavailable without config', async () => {
  const email = createEmailAdapter({ env: {} });
  const r = await email.send({ to: 'a@b.example', body: 'x' });
  assert.equal(r.status, SEND.ADAPTER_UNAVAILABLE);
});

test('teams authorized success via test adapter', async () => {
  const teams = createTeamsAdapter({ send: async () => ({ ok: true, message_id: 'tm-1', conversation_id: 'chat-1' }) });
  const r = await teams.send({ chatId: 'chat-1', body: 'hello' });
  assert.equal(r.status, SEND.CONFIRMED);
  assert.equal(r.conversation_id, 'chat-1');
});

test('teams unauthorized without token', async () => {
  const teams = createTeamsAdapter({ env: {} });
  const r = await teams.send({ chatId: 'c', body: 'x' });
  assert.equal(r.status, SEND.NOT_AUTHORIZED);
});

test('teams provider failure from loopback Graph', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const teams = createTeamsAdapter({
      token: 'test-token',
      graphBase: `http://127.0.0.1:${port}`,
    });
    const r = await teams.send({ chatId: 'c1', body: 'hi' });
    assert.equal(r.status, SEND.FAILED);
    assert.equal(r.reason, 'http_500');
  } finally {
    server.close();
  }
});

test('linkedin official test adapter can confirm', async () => {
  const li = createLinkedInAdapter({ send: async () => ({ ok: true, message_id: 'li-1' }) });
  const r = await li.send({ recipient: 'urn:x', body: 'hi' });
  assert.equal(r.status, SEND.CONFIRMED);
});

test('linkedin without official API is MANUAL_ASSIST and never sent', async () => {
  const li = createLinkedInAdapter({ env: {} });
  const r = await li.send({ recipient: 'x', body: 'copy me', company: 'Acme' });
  assert.equal(r.status, SEND.MANUAL_ASSIST_REQUIRED);
  assert.ok(r.draft.body);
  assert.notEqual(r.status, SEND.CONFIRMED);
});

test('approval required before send', async () => {
  const { ledger, outreach } = setup();
  ledger.upsertLead({ id: 'a', email: 'a@x.example', company: 'Acme' });
  const prep = outreach.prepare({ leadId: 'a', channel: 'email' });
  const pending = await outreach.send({ leadId: 'a', fingerprint: prep.outreach.fingerprint });
  assert.equal(pending.status, 'OUTREACH_PENDING_APPROVAL');
  assert.ok(ledger.listEvents().some((e) => e.event === EVENTS.OUTREACH_PENDING_APPROVAL));
});

test('approval rejected stays auditable and does not send', async () => {
  const { ledger, outreach } = setup();
  ledger.upsertLead({ id: 'b', email: 'b@x.example', company: 'Beta' });
  const prep = outreach.prepare({ leadId: 'b', channel: 'email' });
  outreach.reject('b', prep.outreach.fingerprint, 'owner_said_no');
  const result = await outreach.send({ leadId: 'b', fingerprint: prep.outreach.fingerprint });
  assert.equal(result.status, 'OUTREACH_REJECTED');
  assert.ok(ledger.listEvents().some((e) => e.event === EVENTS.OUTREACH_REJECTED));
});

test('opt-out blocks email teams and linkedin', async () => {
  const { ledger, outreach } = setup({
    emailSend: async () => ({ ok: true, message_id: 'nope' }),
    teamsSend: async () => ({ ok: true, message_id: 'nope' }),
    linkedinSend: async () => ({ ok: true, message_id: 'nope' }),
    requireApproval: false,
  });
  ledger.upsertLead({ id: 'z', email: 'z@x.example', do_not_contact: true, teams_chat_id: 'c', linkedin: 'urn' });
  for (const channel of ['email', 'teams', 'linkedin']) {
    const r = await outreach.send({ leadId: 'z', channel });
    assert.equal(r.status, 'OUTREACH_BLOCKED', channel);
    assert.equal(r.reason, 'do_not_contact');
  }
});

test('channel selection respects suppression and auth', () => {
  assert.equal(selectChannel({ do_not_contact: true }, { email: true }).channel, 'NO_OUTREACH');
  assert.equal(selectChannel({ email: 'a@b.c' }, { email: true }).channel, 'EMAIL');
  assert.equal(selectChannel({ teams_chat_id: 'c', preferred_channel: 'teams' }, { teams: true }).channel, 'TEAMS');
  assert.equal(selectChannel({ preferred_channel: 'linkedin' }, { linkedin: false }).channel, 'MANUAL_ASSIST');
});

test('rate limiting blocks extra sends', async () => {
  const { ledger, outreach } = setup({
    requireApproval: false,
    limits: { email: 1 },
    emailSend: async () => ({ ok: true, message_id: `m-${Date.now()}` }),
  });
  ledger.upsertLead({ id: 'r', email: 'r@x.example', company: 'Rate' });
  const p1 = outreach.prepare({ leadId: 'r', channel: 'email', text: 'one' });
  const s1 = await outreach.send({ leadId: 'r', fingerprint: p1.outreach.fingerprint });
  assert.equal(s1.status, 'OUTREACH_SENT');
  const p2 = outreach.prepare({ leadId: 'r', channel: 'email', text: 'two' });
  const s2 = await outreach.send({ leadId: 'r', fingerprint: p2.outreach.fingerprint });
  assert.equal(s2.status, 'RATE_LIMITED');
});

test('duplicate fingerprint cannot be marked sent twice', async () => {
  const { ledger, outreach } = setup({
    requireApproval: false,
    emailSend: async () => ({ ok: true, message_id: 'dup-ok' }),
  });
  ledger.upsertLead({ id: 'd', email: 'd@x.example', company: 'Dup' });
  const p = outreach.prepare({ leadId: 'd', channel: 'email', text: 'same' });
  const a = await outreach.send({ leadId: 'd', fingerprint: p.outreach.fingerprint });
  const b = await outreach.send({ leadId: 'd', fingerprint: p.outreach.fingerprint });
  assert.equal(a.status, 'OUTREACH_SENT');
  assert.equal(b.status, 'OUTREACH_FAILED');
  assert.equal(b.reason, 'duplicate');
});

test('provider confirmation required — missing message_id is failure', async () => {
  const { ledger, outreach } = setup({
    requireApproval: false,
    emailSend: async () => ({ ok: true }),
  });
  ledger.upsertLead({ id: 'p', email: 'p@x.example', company: 'Prov' });
  const prep = outreach.prepare({ leadId: 'p', channel: 'email' });
  const r = await outreach.send({ leadId: 'p', fingerprint: prep.outreach.fingerprint });
  assert.equal(r.status, 'OUTREACH_FAILED');
  assert.ok(ledger.listEvents().some((e) => e.event === EVENTS.OUTREACH_FAILED));
  assert.ok(!ledger.listEvents().some((e) => e.event === EVENTS.OUTREACH_SENT));
});

test('provider failure is OUTREACH_FAILED', async () => {
  const { outreach, ledger } = setup({
    requireApproval: false,
    emailSend: async () => ({ ok: false, reason: 'smtp_down' }),
  });
  ledger.upsertLead({ id: 'f', email: 'f@x.example', company: 'Fail' });
  const prep = outreach.prepare({ leadId: 'f', channel: 'email' });
  const r = await outreach.send({ leadId: 'f', fingerprint: prep.outreach.fingerprint });
  assert.equal(r.status, 'OUTREACH_FAILED');
  assert.equal(r.reason, 'smtp_down');
});

test('ledger records prepared approved sent', async () => {
  const { ledger, outreach } = setup({
    emailSend: async () => ({ ok: true, message_id: 'ok-9' }),
  });
  ledger.upsertLead({ id: 'lg', email: 'lg@x.example', company: 'Log' });
  const prep = outreach.prepare({ leadId: 'lg', channel: 'email' });
  outreach.approve('lg', prep.outreach.fingerprint);
  const sent = await outreach.send({ leadId: 'lg', fingerprint: prep.outreach.fingerprint });
  assert.equal(sent.status, 'OUTREACH_SENT');
  const ev = ledger.listEvents({ leadId: 'lg' }).map((e) => e.event);
  assert.ok(ev.includes(EVENTS.OUTREACH_PREPARED));
  assert.ok(ev.includes(EVENTS.OUTREACH_APPROVED));
  assert.ok(ev.includes(EVENTS.OUTREACH_SENT));
});

test('draft does not present unverified research as verified', () => {
  const draft = draftMessage({
    company: 'Acme',
    signals: [
      { source: 'manual', verified: false, text: 'secret expansion in Mars' },
      { source: 'jina_search', verified: true, label: 'imports trailers' },
    ],
  });
  assert.match(draft.body, /imports trailers/);
  assert.doesNotMatch(draft.body, /Mars/);
  assert.equal(draft.verified_facts_used, 1);
  assert.equal(draft.unverified_excluded, 1);
});

test('linkedin path without adapter is manual-assist not sent', async () => {
  const { ledger, outreach } = setup({
    requireApproval: false,
    linkedin: createLinkedInAdapter({ env: {} }),
  });
  ledger.upsertLead({ id: 'li', company: 'LiCo', linkedin: 'urn:li:x' });
  const prep = outreach.prepare({ leadId: 'li', channel: 'linkedin' });
  const r = await outreach.send({ leadId: 'li', fingerprint: prep.outreach.fingerprint });
  assert.equal(r.status, 'OUTREACH_MANUAL_ASSIST');
  assert.equal(r.sent, false);
  assert.ok(ledger.listEvents().some((e) => e.event === EVENTS.OUTREACH_MANUAL_ASSIST));
});

test('notification failure is recorded honestly', async () => {
  const { ledger, outreach } = setup({
    requireApproval: false,
    emailSend: async () => ({ ok: true, message_id: 'm' }),
    notifySend: async () => ({ ok: false, reason: 'adapter_not_configured' }),
  });
  ledger.upsertLead({ id: 'n', email: 'n@x.example', company: 'Note' });
  const prep = outreach.prepare({ leadId: 'n', channel: 'email' });
  await outreach.send({ leadId: 'n', fingerprint: prep.outreach.fingerprint });
  assert.ok(ledger.listEvents().some((e) => e.event === EVENTS.NOTIFICATION_FAILED));
});

test('no tokens written to ledger', async () => {
  const secret = 'teams-secret-token-xyz';
  const { ledger, outreach } = setup({
    requireApproval: false,
    teamsToken: secret,
    teamsSend: async () => ({ ok: true, message_id: 't' }),
  });
  ledger.upsertLead({ id: 's', teams_chat_id: 'c', company: 'Sec' });
  const prep = outreach.prepare({ leadId: 's', channel: 'teams' });
  await outreach.send({ leadId: 's', fingerprint: prep.outreach.fingerprint });
  const blob = readFileSync(ledger.eventsPath, 'utf8');
  assert.equal(blob.includes(secret), false);
});
