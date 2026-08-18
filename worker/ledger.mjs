/**
 * Worker ledger — append-only events for W1 + W2.
 * Stored under $OPENCLAW_HOME/worker (outside git).
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const EVENTS = {
  RESEARCH_LOGGED: 'RESEARCH_LOGGED',
  RESEARCH_FAILED: 'RESEARCH_FAILED',
  DISCOVERY_SOURCE: 'DISCOVERY_SOURCE',
  SIGNALS_UPDATED: 'SIGNALS_UPDATED',
  SEND_FAILED: 'SEND_FAILED',
  REPLY_RECEIVED: 'REPLY_RECEIVED',
  REPLY_CLASSIFIED: 'REPLY_CLASSIFIED',
  REPLY_UNMATCHED: 'REPLY_UNMATCHED',
  REPLY_CHECK_FAILED: 'REPLY_CHECK_FAILED',
  OPT_OUT_RECORDED: 'OPT_OUT_RECORDED',
  NOTIFICATION_SENT: 'NOTIFICATION_SENT',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
  OUTREACH_PREPARED: 'OUTREACH_PREPARED',
  OUTREACH_PENDING_APPROVAL: 'OUTREACH_PENDING_APPROVAL',
  OUTREACH_APPROVED: 'OUTREACH_APPROVED',
  OUTREACH_REJECTED: 'OUTREACH_REJECTED',
  OUTREACH_BLOCKED: 'OUTREACH_BLOCKED',
  OUTREACH_SENT: 'OUTREACH_SENT',
  OUTREACH_FAILED: 'OUTREACH_FAILED',
  OUTREACH_MANUAL_ASSIST: 'OUTREACH_MANUAL_ASSIST',
  CHANNEL_NOT_AUTHORIZED: 'CHANNEL_NOT_AUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  DAILY_RUN_STARTED: 'DAILY_RUN_STARTED',
  DAILY_RUN_COMPLETED: 'DAILY_RUN_COMPLETED',
  DAILY_RUN_FAILED: 'DAILY_RUN_FAILED',
  DAILY_RUN_SKIPPED: 'DAILY_RUN_SKIPPED',
  DAILY_REPORT: 'DAILY_REPORT',
};

export function workerHome(root) {
  return root || join(process.env.OPENCLAW_HOME || join(process.env.HOME || '/tmp', '.openclaw'), 'worker');
}

export function createLedger(home) {
  const root = workerHome(home);
  const eventsPath = join(root, 'ledger.jsonl');
  const leadsDir = join(root, 'leads');
  mkdirSync(leadsDir, { recursive: true });

  function leadPath(id) {
    const safe = String(id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    return join(leadsDir, `${safe}.json`);
  }

  function readLead(id) {
    const p = leadPath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }

  function writeLead(lead) {
    const next = { ...lead, updated_at: new Date().toISOString() };
    writeFileSync(leadPath(next.id), JSON.stringify(next, null, 2));
    return next;
  }

  function upsertLead(fields) {
    const id = fields.id || `lead_${randomBytes(4).toString('hex')}`;
    const prev = readLead(id) || {
      id,
      company: null,
      stage: 'new',
      score: null,
      verified_score: null,
      signals: [],
      research: [],
      created_at: new Date().toISOString(),
    };
    return writeLead({ ...prev, ...fields, id });
  }

  function listLeads() {
    return readdirSync(leadsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(leadsDir, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  }

  function append(event) {
    const row = {
      id: `evt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...event,
    };
    appendFileSync(eventsPath, `${JSON.stringify(row)}\n`);
    return row;
  }

  function listEvents({ leadId, limit = 100 } = {}) {
    if (!existsSync(eventsPath)) return [];
    const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    let rows = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    if (leadId) rows = rows.filter((r) => r.lead_id === leadId);
    return rows.slice(-limit);
  }

  return { root, eventsPath, leadsDir, readLead, writeLead, upsertLead, listLeads, append, listEvents };
}
