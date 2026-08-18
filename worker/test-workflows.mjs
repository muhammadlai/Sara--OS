import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from './ledger.mjs';
import { createEmailAdapter } from './adapters.mjs';
import { createOutreach } from './outreach.mjs';
import { createNotifier } from './notify.mjs';
import {
  WORKFLOWS,
  resolveWorkflow,
  attachWorkflow,
  workflowAllowsPrepare,
  assertDraftHonest,
  scoreLeadForWorkflow,
} from './workflows.mjs';

test('canonical workflows exist and all require approval', () => {
  assert.ok(WORKFLOWS.b2b_trade);
  assert.ok(WORKFLOWS.roofing);
  assert.ok(WORKFLOWS.aca_medicare);
  for (const wf of Object.values(WORKFLOWS)) {
    assert.equal(wf.require_approval, true, wf.id);
  }
});

test('roofing draft cannot invent insurance payouts', () => {
  const bad = assertDraftHonest('Insurance will pay for your entire roof this week.', 'roofing');
  assert.equal(bad.ok, false);
  const ok = assertDraftHonest('We install commercial roofing if a conversation would help.', 'roofing');
  assert.equal(ok.ok, true);
});

test('ACA/Medicare draft cannot invent eligibility', () => {
  const bad = assertDraftHonest('You qualify for Medicare and a guaranteed subsidy.', 'aca_medicare');
  assert.equal(bad.ok, false);
  const ok = assertDraftHonest('If you want, we can review public plan options with an authorized agent.', 'aca_medicare');
  assert.equal(ok.ok, true);
});

test('opt-out blocks every vertical including roofing and ACA', () => {
  const lead = { id: 'x', do_not_contact: true };
  assert.equal(workflowAllowsPrepare(lead, 'roofing').ok, false);
  assert.equal(workflowAllowsPrepare(lead, 'aca_medicare').ok, false);
  assert.equal(workflowAllowsPrepare(lead, 'b2b_trade').ok, false);
});

test('workflow scoring does not invent verified facts', () => {
  const scored = scoreLeadForWorkflow({
    workflow: 'roofing',
    signals: [{ source: 'manual', verified: false, text: 'huge storm last night', dimension: 'product_match', value: 3 }],
  });
  assert.equal(scored.verified_score, null);
  assert.equal(scored.invented, false);
});

test('unconfigured email adapter is not SENT for a roofing lead', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aitzaz-wf-'));
  const ledger = createLedger(home);
  const lead = attachWorkflow({
    id: 'roof1',
    company: 'Local Roofing Co',
    email: 'ops@roof.example',
    property_type: 'commercial',
  }, 'roofing');
  ledger.upsertLead(lead);
  const outreach = createOutreach({
    ledger,
    email: createEmailAdapter({ env: {} }),
    notifier: createNotifier({ send: async () => ({ ok: true, reference: 'n' }) }),
    requireApproval: true,
  });
  const prep = outreach.prepare({ leadId: 'roof1', channel: 'email' });
  outreach.approve('roof1', prep.outreach.fingerprint);
  const sent = await outreach.send({ leadId: 'roof1', fingerprint: prep.outreach.fingerprint });
  assert.notEqual(sent.status, 'OUTREACH_SENT');
  assert.equal(sent.sent, false);
  assert.ok(['ADAPTER_UNAVAILABLE', 'OUTREACH_FAILED', 'SEND_FAILED'].includes(sent.status));
});

test('resolveWorkflow aliases do not invent a fourth product line', () => {
  assert.equal(resolveWorkflow({}, 'medicare').id, 'aca_medicare');
  assert.equal(resolveWorkflow({}, 'roof').id, 'roofing');
  assert.equal(resolveWorkflow({}, 'unknown_vertical').id, 'b2b_trade');
});
