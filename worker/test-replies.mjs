import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'node:path';
import { classifyReply } from './classifier.mjs';
import { createLedger, EVENTS } from './ledger.mjs';
import { createInboxAdapter } from './gmail.mjs';
import { createNotifier } from './notify.mjs';
import { createReplyWorker, matchLead, outreachAllowed } from './replies.mjs';

function home() {
  return mkdtempSync(join(tmpdir(), 'aitzaz-w4-'));
}

function workerWith(messages, extra = {}) {
  const ledger = createLedger(home());
  const inbox = createInboxAdapter({
    listInbox: extra.listInbox || (async () => ({ ok: true, messages })),
  });
  const notifier = createNotifier({
    send: extra.send || (async () => ({ ok: true, reference: 'n1' })),
  });
  return createReplyWorker({ ledger, inbox, notifier });
}

const CASES = [
  ['INTERESTED', 'Re: intro', 'We are interested. Let\'s schedule a call next week.'],
  ['QUESTION', 'Question', 'Can you share lead times for 40 units?'],
  ['PRICE_REQUEST', 'Pricing', 'What is the unit price and quotation for 200 pieces?'],
  ['FOLLOW_UP', 'Checking in', 'Just following up — did you get my last note?'],
  ['NOT_INTERESTED', 'Re: offer', 'Thanks but we are not interested at this time.'],
  ['OPT_OUT', 'Stop', 'Please unsubscribe and do not contact me again.'],
  ['WRONG_PERSON', 'Re: you', 'I am the wrong person and no longer work here.'],
  ['OUT_OF_OFFICE', 'Automatic reply', 'I am currently out of office until Monday.'],
  ['UNKNOWN', 'Hi', 'Noted.'],
];

for (const [want, subject, body] of CASES) {
  test(`classifier: ${want}`, () => {
    const r = classifyReply({ subject, body });
    assert.equal(r.classification, want);
    assert.equal(r.method, 'rules');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(r.reason);
    if (want !== 'UNKNOWN') assert.ok(r.signals.length >= 1);
  });
}

test('thread matching uses thread_id when unique', () => {
  const leads = [
    { id: 'a', thread_id: 't-1', email: 'a@x.com', company: 'Acme' },
    { id: 'b', thread_id: 't-2', email: 'b@x.com', company: 'Beta' },
  ];
  const m = matchLead(leads, { thread_id: 't-2', sender: 'other@x.com', subject: 'hi' });
  assert.equal(m.lead.id, 'b');
  assert.equal(m.method, 'thread_id');
});

test('unmatched reply is REPLY_UNMATCHED and not attached', async () => {
  const w = workerWith([]);
  w.ledger.upsertLead({ id: 'known', email: 'known@co.example', company: 'Known Co', thread_id: 'thr-known' });
  const result = await w.processMessage({
    message_id: 'm-orphan',
    thread_id: 'thr-other',
    sender: 'stranger@else.example',
    subject: 'hello',
    body: 'We are interested',
    received_at: '2026-08-18T10:00:00Z',
  });
  assert.equal(result.status, 'REPLY_UNMATCHED');
  const lead = w.ledger.readLead('known');
  assert.equal((lead.replies || []).length, 0);
  assert.ok(w.ledger.listEvents().some((e) => e.event === EVENTS.REPLY_UNMATCHED));
});

test('duplicate provider message id is ignored', async () => {
  const w = workerWith([]);
  w.ledger.upsertLead({ id: 'acme', email: 'buyer@acme.example', company: 'Acme', thread_id: 't1' });
  const msg = {
    message_id: 'dup-1',
    thread_id: 't1',
    sender: 'buyer@acme.example',
    subject: 'interested',
    body: 'We are interested',
    received_at: '2026-08-18T10:00:00Z',
  };
  const first = await w.processMessage(msg);
  const second = await w.processMessage(msg);
  assert.equal(first.status, 'REPLY_CLASSIFIED');
  assert.equal(second.status, 'DUPLICATE');
  assert.equal(w.ledger.readLead('acme').replies.length, 1);
});

test('notification success is recorded only when adapter confirms', async () => {
  const w = workerWith([], { send: async () => ({ ok: true, reference: 'hook-9' }) });
  w.ledger.upsertLead({ id: 'hot', email: 'c@x.example', thread_id: 'th' });
  const result = await w.processMessage({
    message_id: 'n-ok',
    thread_id: 'th',
    sender: 'c@x.example',
    subject: 'yes',
    body: 'Interested — send more info',
    received_at: '2026-08-18T11:00:00Z',
  });
  assert.equal(result.notification.sent, true);
  assert.equal(result.notification.reference, 'hook-9');
  assert.ok(w.ledger.listEvents().some((e) => e.event === EVENTS.NOTIFICATION_SENT));
});

test('notification failure is honest when adapter is missing', async () => {
  const ledger = createLedger(home());
  ledger.upsertLead({ id: 'q', email: 'q@x.example', thread_id: 'tq' });
  const w = createReplyWorker({
    ledger,
    inbox: createInboxAdapter({ listInbox: async () => ({ ok: true, messages: [] }) }),
    notifier: createNotifier({}),
  });
  const result = await w.processMessage({
    message_id: 'n-fail',
    thread_id: 'tq',
    sender: 'q@x.example',
    subject: '?',
    body: 'Can you clarify MOQ?',
    received_at: '2026-08-18T11:00:00Z',
  });
  assert.equal(result.notification.sent, false);
  assert.equal(result.notification.reason, 'adapter_not_configured');
  assert.ok(w.ledger.listEvents().some((e) => e.event === EVENTS.NOTIFICATION_FAILED));
});

test('Gmail unavailable becomes REPLY_CHECK_FAILED', async () => {
  const w = createReplyWorker({
    ledger: createLedger(home()),
    inbox: createInboxAdapter({}),
    notifier: createNotifier({ send: async () => ({ ok: true }) }),
  });
  const result = await w.checkInbox();
  assert.equal(result.status, 'REPLY_CHECK_FAILED');
  assert.equal(result.reason, 'gmail_unavailable');
});

test('provider HTTP error from loopback inbox', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'down' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const w = createReplyWorker({
      ledger: createLedger(home()),
      inbox: createInboxAdapter({ baseUrl: `http://127.0.0.1:${port}` }),
      notifier: createNotifier({ send: async () => ({ ok: true }) }),
    });
    const result = await w.checkInbox();
    assert.equal(result.status, 'REPLY_CHECK_FAILED');
    assert.equal(result.reason, 'provider_http_503');
  } finally {
    server.close();
  }
});

test('malformed message does not invent ids', async () => {
  const w = workerWith([]);
  const result = await w.processMessage({ subject: 'hi', body: 'interested' });
  assert.equal(result.status, 'REPLY_CHECK_FAILED');
  assert.equal(result.reason, 'malformed_message');
});

test('opt-out blocks future outreach', async () => {
  const w = workerWith([]);
  w.ledger.upsertLead({ id: 'stop', email: 'p@x.example', thread_id: 'ts', do_not_contact: false });
  const result = await w.processMessage({
    message_id: 'opt-1',
    thread_id: 'ts',
    sender: 'p@x.example',
    subject: 'please stop',
    body: 'Remove me from this list and stop emailing.',
    received_at: '2026-08-18T12:00:00Z',
  });
  assert.equal(result.classification.classification, 'OPT_OUT');
  assert.equal(result.outreach_allowed, false);
  const lead = w.ledger.readLead('stop');
  assert.equal(lead.do_not_contact, true);
  assert.equal(outreachAllowed(lead), false);
  assert.ok(w.ledger.listEvents().some((e) => e.event === EVENTS.OPT_OUT_RECORDED));
});

test('loopback inbox success processes a real retrieved message only', async () => {
  const payload = {
    messages: [{
      message_id: 'live-1',
      thread_id: 'thr-live',
      sender: 'ops@gamma.example',
      recipient: 'sales@aitzaz.example',
      subject: 'Re: fleet',
      body: 'How much for 10 trucks?',
      received_at: '2026-08-18T09:00:00Z',
    }],
  };
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ledger = createLedger(home());
    ledger.upsertLead({ id: 'gamma', email: 'ops@gamma.example', company: 'Gamma', thread_id: 'thr-live' });
    const w = createReplyWorker({
      ledger,
      inbox: createInboxAdapter({ baseUrl: `http://127.0.0.1:${port}` }),
      notifier: createNotifier({ send: async () => ({ ok: true, reference: 'ok' }) }),
    });
    const result = await w.checkInbox();
    assert.equal(result.status, 'REPLY_CHECK_OK');
    assert.equal(result.processed[0].classification.classification, 'PRICE_REQUEST');
    assert.equal(result.processed[0].message.message_id, 'live-1');
  } finally {
    server.close();
  }
});

test('webhook notifier posts to loopback and does not claim success on 500', async () => {
  let saw = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      saw = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.writeHead(500);
      res.end('no');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const n = createNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    const sent = await n.notify({ classification: 'INTERESTED', lead: 'x' });
    assert.equal(sent.ok, false);
    assert.equal(sent.reason, 'http_500');
    assert.equal(saw.classification, 'INTERESTED');
  } finally {
    server.close();
  }
});

test('secrets are not written into ledger events', async () => {
  const secret = 'oauth-token-should-not-leak';
  const w = workerWith([]);
  w.ledger.upsertLead({ id: 's', email: 'a@b.example', thread_id: 't' });
  await w.processMessage({
    message_id: 'sec',
    thread_id: 't',
    sender: 'a@b.example',
    subject: 'interested',
    body: `We are interested ${secret}`,
    received_at: '2026-08-18T08:00:00Z',
  });
  const blob = readFileSync(w.ledger.eventsPath, 'utf8');
  assert.equal(blob.includes(secret), false);
});
