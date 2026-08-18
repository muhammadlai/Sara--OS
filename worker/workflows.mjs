/**
 * Vertical workflow profiles for W1.
 * These do not send, do not invent contacts, and do not replace W2–W5.
 * Outreach still goes through worker/outreach.mjs (approval + provider confirmation).
 */
import { outreachAllowed } from './replies.mjs';
import { scoreSignals } from './scoring.mjs';

export const WORKFLOWS = {
  b2b_trade: {
    id: 'b2b_trade',
    name: 'B2B trade (canonical default)',
    require_approval: true,
    default_channel: 'email',
    required_fields: ['company'],
    scoring_dimensions: ['purchase_volume', 'product_match', 'region', 'payment', 'authority'],
    forbidden_claims: [],
    notes: 'Existing AITZAZ AI 2070 export SDR path.',
  },
  roofing: {
    id: 'roofing',
    name: 'Roofing',
    require_approval: true,
    default_channel: 'email',
    required_fields: ['company', 'property_type'],
    scoring_dimensions: ['product_match', 'region', 'purchase_volume'],
    forbidden_claims: [
      'insurance will pay',
      'guaranteed approval',
      'free roof no cost',
      'we already inspected your roof',
    ],
    notes: 'Storm/repair outreach must not invent inspections, insurance payouts, or site visits.',
  },
  aca_medicare: {
    id: 'aca_medicare',
    name: 'ACA / Medicare',
    require_approval: true,
    default_channel: 'email',
    required_fields: ['company'],
    scoring_dimensions: ['region', 'authority', 'product_match'],
    forbidden_claims: [
      'you are approved',
      'you qualify for medicare',
      'guaranteed subsidy',
      'enrolled you',
      'this is medical advice',
    ],
    notes: 'No eligibility, enrollment, or medical-advice claims. Opt-out and approval still apply.',
  },
};

export function listWorkflows() {
  return Object.values(WORKFLOWS).map((w) => ({
    id: w.id,
    name: w.name,
    require_approval: w.require_approval === true,
    default_channel: w.default_channel,
  }));
}

export function resolveWorkflow(lead = {}, requested) {
  const raw = requested || lead.workflow || lead.vertical || 'b2b_trade';
  const key = String(raw).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (key === 'medicare' || key === 'aca' || key === 'aca_medicare') return WORKFLOWS.aca_medicare;
  if (key === 'roof' || key === 'roofing') return WORKFLOWS.roofing;
  return WORKFLOWS[key] || WORKFLOWS.b2b_trade;
}

export function attachWorkflow(lead, requested) {
  const wf = resolveWorkflow(lead, requested);
  return { ...lead, workflow: wf.id };
}

export function workflowAllowsPrepare(lead, requested) {
  const wf = resolveWorkflow(lead, requested);
  if (!outreachAllowed(lead)) return { ok: false, reason: 'do_not_contact', workflow: wf.id };
  return { ok: true, reason: null, workflow: wf.id, require_approval: wf.require_approval === true };
}

export function assertDraftHonest(text, requested, lead = {}) {
  const wf = resolveWorkflow(lead, requested);
  const hay = String(text || '');
  for (const phrase of wf.forbidden_claims || []) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(hay)) {
      return { ok: false, reason: 'forbidden_claim', phrase, workflow: wf.id };
    }
  }
  return { ok: true, reason: null, workflow: wf.id };
}

export function scoreLeadForWorkflow(lead = {}, requested) {
  const wf = resolveWorkflow(lead, requested);
  const scores = scoreSignals(lead.signals || []);
  return {
    workflow: wf.id,
    ...scores,
    verified_only: scores.verified_score,
    invented: false,
  };
}
