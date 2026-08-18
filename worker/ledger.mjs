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
