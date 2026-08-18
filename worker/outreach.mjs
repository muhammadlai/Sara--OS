/**
 * W5 multi-channel outreach. Approval + opt-out + provider confirmation required.
 */
import { createHash } from 'node:crypto';
import { createLedger, EVENTS } from './ledger.mjs';
import { outreachAllowed } from './replies.mjs';
import { createNotifier } from './notify.mjs';
import { createEmailAdapter, createTeamsAdapter, createLinkedInAdapter, SEND } from './adapters.mjs';

const DEFAULT_LIMITS = { email: 20, teams: 30, linkedin: 5 };
const WINDOW_MS = 60 * 60 * 1000;

export function draftMessage(lead = {}, { channel = 'email' } = {}) {
  const company = lead.company || 'your team';
  const verified = (lead.signals || []).filter((s) => s && s.verified === true && s.source !== 'manual');
  const fact = verified[0]?.label || verified[0]?.text || null;
  const name = lead.contact_name || lead.name || null;
  const hello = name ? `Hello ${name}` : 'Hello';
  const researchLine = fact
    ? `I noticed ${String(fact).slice(0, 140)}.`
    : 'I work with operators who source equipment internationally.';
  const body = [
    `${hello},`,
    '',
    `I am reaching out from AITZAZ AI 2070 regarding ${company}.`,
    researchLine,
    'If a short conversation would be useful, I can share a concise overview — no fabricated claims, just what we can actually deliver.',
    '',
    'Best regards,',
    'Aitzaz',
  ].join('\n');
  const subject = `Introduction — ${company}`;
  return {
    channel,
    subject,
    body,
    verified_facts_used: verified.length,
    unverified_excluded: (lead.signals || []).filter((s) => s && s.verified !== true).length,
  };
}

export function selectChannel(lead = {}, auth = {}) {
  if (!outreachAllowed(lead)) return { channel: 'NO_OUTREACH', reason: 'do_not_contact' };
  const score = Number(lead.verified_score ?? lead.score ?? 0);
  const last = lead.last_classification;
  const emailOk = auth.email === true;
  const teamsOk = auth.teams === true;
  const linkedOk = auth.linkedin === true;

  if (last === 'OPT_OUT') return { channel: 'NO_OUTREACH', reason: 'do_not_contact' };
  if (lead.preferred_channel === 'teams' && teamsOk) return { channel: 'TEAMS', reason: 'preferred' };
  if (lead.preferred_channel === 'email' && emailOk) return { channel: 'EMAIL', reason: 'preferred' };
  if (lead.preferred_channel === 'linkedin') {
    return { channel: linkedOk ? 'LINKEDIN' : 'MANUAL_ASSIST', reason: linkedOk ? 'preferred' : 'linkedin_manual' };
  }
  if (lead.email && emailOk) return { channel: 'EMAIL', reason: 'has_email' };
  if (lead.teams_chat_id && teamsOk) return { channel: 'TEAMS', reason: 'has_teams' };
  if (score >= 7 && emailOk) return { channel: 'EMAIL', reason: 'high_score' };
  if (!emailOk && !teamsOk) {
    return { channel: 'MANUAL_ASSIST', reason: 'no_authorized_send_channel' };
  }
  if (emailOk) return { channel: 'EMAIL', reason: 'default_email' };
  return { channel: 'TEAMS', reason: 'fallback_teams' };
}

export function createOutreach(options = {}) {
  const ledger = options.ledger || createLedger(options.home);
  const notifier = options.notifier || createNotifier(options);
  const email = options.email || createEmailAdapter(options);
  const teams = options.teams || createTeamsAdapter(options);
  const linkedin = options.linkedin || createLinkedInAdapter(options);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const requireApproval = options.requireApproval !== false;

  function adapterFor(channel) {
    const c = String(channel || '').toLowerCase();
    if (c === 'email') return email;
    if (c === 'teams') return teams;
    if (c === 'linkedin') return linkedin;
    return null;
  }

  function authMap() {
    return {
      email: email.status() !== 'ADAPTER_UNAVAILABLE',
      teams: teams.status() === 'AUTHORIZED' || teams.status() === 'TEST_ADAPTER',
      linkedin: linkedin.status() === 'AUTHORIZED' || linkedin.status() === 'TEST_ADAPTER',
    };
  }

  function countRecent(channel) {
    const cutoff = Date.now() - WINDOW_MS;
    return ledger.listEvents({ limit: 2000 }).filter((e) => {
      if (e.channel !== channel) return false;
      if (e.event !== EVENTS.OUTREACH_SENT) return false;
      return new Date(e.timestamp).getTime() >= cutoff;
    }).length;
  }

  function fingerprint(leadId, channel, body) {
    return createHash('sha256').update(`${leadId}|${channel}|${body}`).digest('hex').slice(0, 24);
  }

  function alreadySent(fp) {
    return ledger.listEvents({ limit: 2000 }).some((e) => e.fingerprint === fp && e.event === EVENTS.OUTREACH_SENT);
  }

  function prepare({ leadId, channel, text } = {}) {
    const lead = ledger.readLead(leadId);
    if (!lead) {
      return { status: 'OUTREACH_FAILED', reason: 'lead_not_found' };
    }
    const draft = text ? { channel, subject: `Follow-up — ${lead.company || lead.id}`, body: text, verified_facts_used: 0, unverified_excluded: 0 } : draftMessage(lead, { channel });
    const fp = fingerprint(lead.id, channel, draft.body);
    const pending = {
      id: `out_${Date.now().toString(36)}`,
      lead_id: lead.id,
      channel,
      draft,
      fingerprint: fp,
      approval: 'pending',
    };
    const next = ledger.writeLead({
      ...lead,
      outreach_queue: [...(lead.outreach_queue || []).filter((o) => o.fingerprint !== fp), pending],
    });
    ledger.append({
      event: EVENTS.OUTREACH_PREPARED,
      lead_id: lead.id,
      channel,
      status: 'prepared',
      fingerprint: fp,
    });
    return { status: 'OUTREACH_PREPARED', lead: next, outreach: pending };
  }

  function approve(leadId, fingerprintValue) {
    const lead = ledger.readLead(leadId);
    if (!lead) return { status: 'OUTREACH_FAILED', reason: 'lead_not_found' };
    const queue = (lead.outreach_queue || []).map((o) => (
      o.fingerprint === fingerprintValue ? { ...o, approval: 'approved' } : o
    ));
    const next = ledger.writeLead({ ...lead, outreach_queue: queue });
    ledger.append({ event: EVENTS.OUTREACH_APPROVED, lead_id: leadId, status: 'ok', fingerprint: fingerprintValue, channel: queue.find((o) => o.fingerprint === fingerprintValue)?.channel });
    return { status: 'OUTREACH_APPROVED', lead: next };
  }

  function reject(leadId, fingerprintValue, reason = 'rejected') {
    const lead = ledger.readLead(leadId);
    if (!lead) return { status: 'OUTREACH_FAILED', reason: 'lead_not_found' };
    const queue = (lead.outreach_queue || []).map((o) => (
      o.fingerprint === fingerprintValue ? { ...o, approval: 'rejected', reject_reason: reason } : o
    ));
    const next = ledger.writeLead({ ...lead, outreach_queue: queue });
    ledger.append({ event: EVENTS.OUTREACH_REJECTED, lead_id: leadId, status: 'rejected', fingerprint: fingerprintValue, error: reason });
    return { status: 'OUTREACH_REJECTED', lead: next };
  }

  async function notifyOp(kind, payload) {
    const sent = await notifier.notify({ kind, ...payload });
    if (sent.ok) {
      ledger.append({ event: EVENTS.NOTIFICATION_SENT, lead_id: payload.lead_id, status: 'ok', channel: payload.channel, reference: sent.reference });
      return { sent: true, reference: sent.reference };
    }
    ledger.append({ event: EVENTS.NOTIFICATION_FAILED, lead_id: payload.lead_id, status: 'failed', channel: payload.channel, error: sent.reason });
    return { sent: false, reason: sent.reason };
  }

  async function send({ leadId, channel, fingerprint: fp, skipApproval = false } = {}) {
    const lead = ledger.readLead(leadId);
    if (!lead) return { status: 'OUTREACH_FAILED', reason: 'lead_not_found' };

    if (!outreachAllowed(lead)) {
      ledger.append({ event: EVENTS.OUTREACH_BLOCKED, lead_id: lead.id, channel, status: 'blocked', error: 'do_not_contact' });
      return { status: 'OUTREACH_BLOCKED', reason: 'do_not_contact' };
    }

    const item = (lead.outreach_queue || []).find((o) => o.fingerprint === fp) || null;
    const ch = channel || item?.channel;
    const draft = item?.draft || draftMessage(lead, { channel: ch });
    const hash = fp || fingerprint(lead.id, ch, draft.body);

    if (alreadySent(hash)) {
      return { status: 'OUTREACH_FAILED', reason: 'duplicate' };
    }

    if (item?.approval === 'rejected') {
      return { status: 'OUTREACH_REJECTED', reason: item.reject_reason || 'rejected' };
    }
    if (requireApproval && !skipApproval && item?.approval !== 'approved' && lead.outreach_approved !== true) {
      ledger.append({ event: EVENTS.OUTREACH_PENDING_APPROVAL, lead_id: lead.id, channel: ch, status: 'pending', fingerprint: hash });
      return { status: 'OUTREACH_PENDING_APPROVAL', reason: 'approval_required', fingerprint: hash, draft };
    }

    if (countRecent(ch, lead.id) >= (limits[ch] ?? 20)) {
      ledger.append({ event: EVENTS.RATE_LIMITED, lead_id: lead.id, channel: ch, status: 'rate_limited' });
      await notifyOp('rate_limited', { lead_id: lead.id, channel: ch });
      return { status: 'RATE_LIMITED', reason: 'hourly_limit' };
    }

    const adapter = adapterFor(ch);
    if (!adapter) {
      return { status: 'OUTREACH_FAILED', reason: 'unknown_channel' };
    }

    const result = await adapter.send({
      to: lead.email,
      chatId: lead.teams_chat_id,
      recipient: lead.linkedin || lead.email,
      subject: draft.subject,
      body: draft.body,
      leadId: lead.id,
      company: lead.company,
    });

    if (result.status === SEND.MANUAL_ASSIST_REQUIRED) {
      ledger.append({
        event: EVENTS.OUTREACH_MANUAL_ASSIST,
        lead_id: lead.id,
        channel: ch,
        status: 'manual',
        error: result.reason,
        fingerprint: hash,
      });
      await notifyOp('manual_assist', { lead_id: lead.id, channel: ch, reason: result.reason });
      return {
        status: 'OUTREACH_MANUAL_ASSIST',
        reason: result.reason,
        draft: result.draft || draft,
        sent: false,
      };
    }

    if (result.status === SEND.NOT_AUTHORIZED) {
      ledger.append({ event: EVENTS.CHANNEL_NOT_AUTHORIZED, lead_id: lead.id, channel: ch, status: 'unauthorized', error: result.reason });
      await notifyOp('not_authorized', { lead_id: lead.id, channel: ch, reason: result.reason });
      return { status: 'CHANNEL_NOT_AUTHORIZED', reason: result.reason, sent: false };
    }

    if (result.status === SEND.ADAPTER_UNAVAILABLE) {
      ledger.append({ event: EVENTS.OUTREACH_FAILED, lead_id: lead.id, channel: ch, status: 'unavailable', error: result.reason });
      return { status: result.status, reason: result.reason, sent: false };
    }

    if (result.status !== SEND.CONFIRMED || !result.message_id) {
      ledger.append({
        event: EVENTS.OUTREACH_FAILED,
        lead_id: lead.id,
        channel: ch,
        status: 'failed',
        error: result.reason || result.status,
        fingerprint: hash,
      });
      await notifyOp('send_failed', { lead_id: lead.id, channel: ch, reason: result.reason || result.status });
      return { status: 'OUTREACH_FAILED', reason: result.reason || result.status, sent: false };
    }

    ledger.append({
      event: EVENTS.OUTREACH_SENT,
      lead_id: lead.id,
      channel: ch,
      status: 'sent',
      provider_message_id: result.message_id,
      fingerprint: hash,
    });
    const next = ledger.writeLead({
      ...lead,
      last_outreach_at: result.timestamp || new Date().toISOString(),
      last_outreach_channel: ch,
    });
    await notifyOp('send_ok', { lead_id: lead.id, channel: ch, message_id: result.message_id });
    return {
      status: 'OUTREACH_SENT',
      sent: true,
      provider_message_id: result.message_id,
      channel: ch,
      lead: next,
    };
  }

  function statuses() {
    return {
      email: email.status(),
      teams: teams.status(),
      linkedin: linkedin.status(),
    };
  }

  function summarize() {
    const events = ledger.listEvents({ limit: 500 });
    return {
      statuses: statuses(),
      prepared: events.filter((e) => e.event === EVENTS.OUTREACH_PREPARED).slice(-10),
      sent: events.filter((e) => e.event === EVENTS.OUTREACH_SENT).slice(-10),
      failed: events.filter((e) => e.event === EVENTS.OUTREACH_FAILED).slice(-10),
      blocked: events.filter((e) => e.event === EVENTS.OUTREACH_BLOCKED).length,
      pending: events.filter((e) => e.event === EVENTS.OUTREACH_PENDING_APPROVAL).length,
      manual: events.filter((e) => e.event === EVENTS.OUTREACH_MANUAL_ASSIST).length,
      rate_limited: events.filter((e) => e.event === EVENTS.RATE_LIMITED).length,
    };
  }

  return {
    ledger, email, teams, linkedin, notifier,
    draftMessage, selectChannel, prepare, approve, reject, send, statuses, summarize, authMap,
  };
}
