/**
 * W2 Research engine — newly implemented (not recovered from b1a6f79).
 * Uses Jina Reader/Search. Never fabricates results. Never advances stage on failure.
 */
import { createJinaClient, getJinaKey, redact } from './jina.mjs';
import { createLedger, EVENTS } from './ledger.mjs';
import { mergeSignals, scoreSignals } from './scoring.mjs';

function nowIso() {
  return new Date().toISOString();
}

function confidenceFromContent(text, url) {
  const len = String(text || '').trim().length;
  if (!url) return 0;
  if (len >= 800) return 0.86;
  if (len >= 200) return 0.72;
  if (len >= 40) return 0.55;
  return 0.35;
}

function normalizeSearchHits(body) {
  const data = body?.data ?? body?.results ?? body;
  const list = Array.isArray(data) ? data : data && typeof data === 'object' && (data.url || data.title) ? [data] : [];
  return list
    .map((item) => {
      const url = item.url || item.link || item.source || null;
      const title = item.title || item.name || null;
      const snippet = item.description || item.content || item.snippet || '';
      if (!url && !title) return null;
      return {
        url,
        title,
        snippet: String(snippet).slice(0, 2000),
        provenance: url,
      };
    })
    .filter(Boolean);
}

function normalizeReader(body, requestedUrl) {
  const data = body?.data ?? body;
  if (!data || typeof data !== 'object') return null;
  const url = data.url || requestedUrl || null;
  const title = data.title || null;
  const content = data.content || data.description || data.text || '';
  if (!url && !String(content).trim()) return null;
  return {
    url,
    title,
    content: String(content).slice(0, 20000),
    provenance: url,
  };
}

export function createResearchEngine(options = {}) {
  const jina = options.jina || createJinaClient(options);
  const ledger = options.ledger || createLedger(options.home);

  function fail(lead, reason, extra = {}) {
    const event = ledger.append({
      event: EVENTS.RESEARCH_FAILED,
      lead_id: lead?.id || extra.lead_id || null,
      source: extra.source || 'jina',
      confidence: 0,
      status: 'failed',
      error: reason,
      stage: lead?.stage || extra.stage || 'new',
      result_status: extra.result_status || 'RESEARCH_FAILED',
    });
    return {
      status: 'RESEARCH_FAILED',
      reason,
      stage_advanced: false,
      stage: lead?.stage || extra.stage || 'new',
      verified: false,
      timestamp: event.timestamp,
      event,
      ...extra,
    };
  }

  function requireKey(lead, extra) {
    if (!getJinaKey(options.env || process.env)) {
      return fail(lead, 'missing_api_key', extra);
    }
    return null;
  }

  async function researchUrl({ url, leadId, company } = {}) {
    const lead = leadId ? (ledger.readLead(leadId) || ledger.upsertLead({ id: leadId, company })) : null;
    const missing = requireKey(lead, { source: 'jina_reader' });
    if (missing) return missing;

    const http = await jina.read(url);
    if (!http.ok) return fail(lead, http.reason, { source: 'jina_reader', http_status: http.status, attempts: http.attempts });

    const page = normalizeReader(http.body, url);
    if (!page || !String(page.content || '').trim()) {
      return fail(lead, 'zero_results', { source: 'jina_reader', result_status: 'NO_RESULTS', http_status: http.status });
    }

    const confidence = confidenceFromContent(page.content, page.url);
    const signal = {
      source: 'jina_reader',
      url: page.url,
      label: page.title || page.url,
      text: page.content.slice(0, 500),
      verified: true,
      dimension: 'product_match',
      value: 1.5,
      timestamp: nowIso(),
    };
    let nextLead = lead;
    if (lead) {
      const signals = mergeSignals(lead.signals, [signal]);
      const scores = scoreSignals(signals);
      nextLead = ledger.writeLead({
        ...lead,
        stage: 'researched',
        signals,
        ...scores,
        last_research: { url: page.url, confidence, timestamp: nowIso() },
      });
      ledger.append({
        event: EVENTS.SIGNALS_UPDATED,
        lead_id: nextLead.id,
        source: 'jina_reader',
        confidence,
        status: 'ok',
        stage: nextLead.stage,
      });
    }
    const event = ledger.append({
      event: EVENTS.RESEARCH_LOGGED,
      lead_id: nextLead?.id || null,
      source: 'jina_reader',
      confidence,
      status: 'ok',
      stage: nextLead?.stage || 'researched',
      provenance: page.url,
    });
    return {
      status: 'RESEARCH_LOGGED',
      reason: null,
      stage_advanced: Boolean(lead),
      stage: nextLead?.stage || 'researched',
      verified: true,
      confidence,
      timestamp: event.timestamp,
      provenance: page.url,
      title: page.title,
      excerpt: page.content.slice(0, 280),
      event,
      lead: nextLead,
    };
  }

  async function search({ query, leadId, company } = {}) {
    const lead = leadId ? (ledger.readLead(leadId) || ledger.upsertLead({ id: leadId, company })) : null;
    const missing = requireKey(lead, { source: 'jina_search' });
    if (missing) return missing;

    const http = await jina.search(query);
    if (!http.ok) return fail(lead, http.reason, { source: 'jina_search', http_status: http.status, attempts: http.attempts });

    const hits = normalizeSearchHits(http.body);
    if (!hits.length) {
      return fail(lead, 'zero_results', { source: 'jina_search', result_status: 'NO_RESULTS', http_status: http.status });
    }

    const confidence = Math.min(0.8, 0.4 + hits.length * 0.08);
    const signals = hits.slice(0, 8).map((h) => ({
      source: 'jina_search',
      url: h.url,
      label: h.title || h.url,
      text: h.snippet,
      verified: true,
      dimension: 'region',
      value: 1.2,
      timestamp: nowIso(),
    }));
    let nextLead = lead;
    if (lead) {
      const merged = mergeSignals(lead.signals, signals);
      const scores = scoreSignals(merged);
      nextLead = ledger.writeLead({
        ...lead,
        stage: 'researched',
        signals: merged,
        ...scores,
        last_research: { query, confidence, timestamp: nowIso(), hit_count: hits.length },
      });
      ledger.append({
        event: EVENTS.SIGNALS_UPDATED,
        lead_id: nextLead.id,
        source: 'jina_search',
        confidence,
        status: 'ok',
        stage: nextLead.stage,
      });
    }
    const event = ledger.append({
      event: EVENTS.RESEARCH_LOGGED,
      lead_id: nextLead?.id || null,
      source: 'jina_search',
      confidence,
      status: 'ok',
      stage: nextLead?.stage || 'researched',
      provenance: hits.map((h) => h.url).filter(Boolean),
    });
    return {
      status: 'RESEARCH_LOGGED',
      reason: null,
      stage_advanced: Boolean(lead),
      stage: nextLead?.stage || 'researched',
      verified: true,
      confidence,
      timestamp: event.timestamp,
      results: hits,
      event,
      lead: nextLead,
    };
  }

  function addManualNote({ leadId, company, text } = {}) {
    const lead = ledger.upsertLead({ id: leadId, company });
    const signal = {
      source: 'manual',
      verified: false,
      label: 'manual_note',
      text: String(text || '').slice(0, 2000),
      timestamp: nowIso(),
    };
    const signals = mergeSignals(lead.signals, [signal]);
    const scores = scoreSignals(signals);
    const next = ledger.writeLead({ ...lead, signals, ...scores });
    const event = ledger.append({
      event: EVENTS.SIGNALS_UPDATED,
      lead_id: next.id,
      source: 'manual',
      confidence: 0,
      status: 'unverified',
      stage: next.stage,
    });
    return {
      status: 'MANUAL_NOTE',
      source: 'manual',
      verified: false,
      stage_advanced: false,
      stage: next.stage,
      lead: next,
      event,
    };
  }

  return { jina, ledger, researchUrl, search, addManualNote, redact };
}
