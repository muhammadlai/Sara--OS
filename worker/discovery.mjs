/**
 * W2 Discovery — configured search/signal queries.
 * DRY-RUN by default. Never invents companies or contacts.
 */
import { createResearchEngine } from './research.mjs';
import { EVENTS } from './ledger.mjs';
import { mergeSignals, scoreSignals } from './scoring.mjs';

function hostKey(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dedupeProspects(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = hostKey(item.url) || slug(item.company || item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, dedupe_key: key });
  }
  return out;
}

function prospectFromHit(hit, query) {
  if (!hit?.url && !hit?.title) return null;
  return {
    company: hit.title || hostKey(hit.url) || null,
    url: hit.url || null,
    title: hit.title || null,
    snippet: hit.snippet || '',
    provenance: hit.url || null,
    query,
    source: 'jina_search',
    verified: Boolean(hit.url),
  };
}

export function createDiscovery(options = {}) {
  const engine = options.engine || createResearchEngine(options);
  const { ledger } = engine;
  const dryRunDefault = options.dryRun !== false;

  async function discover({ queries = [], leadId, dryRun } = {}) {
    const isDry = dryRun ?? dryRunDefault;
    const qlist = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q || '').trim()).filter(Boolean);
    if (!qlist.length) {
      return {
        status: 'DISCOVERY_FAILED',
        reason: 'empty_query',
        dry_run: isDry,
        prospects: [],
        stage_advanced: false,
      };
    }

    const collected = [];
    const errors = [];
    for (const query of qlist) {
      const result = await engine.search({ query, leadId: null });
      if (result.status !== 'RESEARCH_LOGGED') {
        errors.push({ query, reason: result.reason, status: result.status });
        continue;
      }
      for (const hit of result.results || []) {
        const prospect = prospectFromHit(hit, query);
        if (prospect) collected.push(prospect);
      }
      ledger.append({
        event: EVENTS.DISCOVERY_SOURCE,
        lead_id: leadId || null,
        source: 'jina_search',
        status: 'ok',
        confidence: result.confidence,
        query,
        provenance: (result.results || []).map((h) => h.url).filter(Boolean),
      });
    }

    const prospects = dedupeProspects(collected);
    if (!prospects.length) {
      return {
        status: errors.length ? 'DISCOVERY_FAILED' : 'NO_RESULTS',
        reason: errors[0]?.reason || 'zero_results',
        dry_run: isDry,
        prospects: [],
        errors,
        stage_advanced: false,
      };
    }

    const applied = [];
    if (!isDry) {
      for (const p of prospects) {
        const id = leadId || hostKey(p.url) || slug(p.company) || `disc_${Date.now()}`;
        const lead = ledger.upsertLead({ id, company: p.company, source: 'web_discovery' });
        const signal = {
          source: 'jina_search',
          url: p.url,
          label: p.title || p.company,
          text: p.snippet,
          verified: true,
          dimension: 'product_match',
          value: 1.4,
          timestamp: new Date().toISOString(),
        };
        const signals = mergeSignals(lead.signals, [signal]);
        const scores = scoreSignals(signals);
        const next = ledger.writeLead({ ...lead, signals, ...scores });
        ledger.append({
          event: EVENTS.SIGNALS_UPDATED,
          lead_id: next.id,
          source: 'jina_search',
          status: 'ok',
          confidence: p.verified ? 0.6 : 0,
          stage: next.stage,
        });
        applied.push({ lead_id: next.id, score: next.verified_score, url: p.url });
      }
    }

    return {
      status: 'DISCOVERY_SOURCE',
      dry_run: isDry,
      prospects,
      applied,
      errors,
      stage_advanced: false,
      note: isDry ? 'dry-run: no CRM/lead writes, no outbound actions' : 'signals stored for scoring',
    };
  }

  return { engine, ledger, discover, dedupeProspects };
}
