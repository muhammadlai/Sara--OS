import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJinaClient, getJinaKey, redact, probeJina, JINA_STATUS } from './jina.mjs';
import { createLedger, EVENTS } from './ledger.mjs';
import { createResearchEngine } from './research.mjs';
import { createDiscovery, dedupeProspects } from './discovery.mjs';
import { scoreSignals } from './scoring.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function startJinaStub(handler) {
  const hits = { search: 0, read: 0, other: 0, lastAuth: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.lastAuth = req.headers.authorization || '';
    if (url.pathname.startsWith('/search/')) hits.search += 1;
    else if (url.pathname.startsWith('/read/')) hits.read += 1;
    else hits.other += 1;
    handler({ req, res, url, hits });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        hits,
        searchBase: `http://127.0.0.1:${port}/search`,
        readerBase: `http://127.0.0.1:${port}/read`,
      });
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function engineFor(stub, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aitzaz-w2-'));
  const env = { JINA_API_KEY: extra.key ?? 'test-jina-key-do-not-commit' };
  const jina = createJinaClient({
    searchBase: stub.searchBase,
    readerBase: stub.readerBase,
    env,
    timeoutMs: extra.timeoutMs ?? 400,
    maxRetries: extra.maxRetries ?? 3,
    sleeper: extra.sleeper || (async () => {}),
    allowPrivate: true,
  });
  const ledger = createLedger(home);
  const research = createResearchEngine({ jina, ledger, env });
  const discovery = createDiscovery({ engine: research, dryRun: extra.dryRun !== false });
  return { home, env, jina, ledger, research, discovery };
}

test('missing JINA_API_KEY fails closed and does not advance stage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aitzaz-w2-'));
  const ledger = createLedger(home);
  const lead = ledger.upsertLead({ id: 'acme', company: 'Acme', stage: 'new' });
  const research = createResearchEngine({
    ledger,
    env: {},
    jina: createJinaClient({ env: {} }),
  });
  const result = await research.researchUrl({ url: 'https://example.com', leadId: 'acme' });
  assert.equal(result.status, 'RESEARCH_FAILED');
  assert.equal(result.reason, 'missing_api_key');
  assert.equal(result.stage_advanced, false);
  assert.equal(ledger.readLead('acme').stage, 'new');
  assert.equal(lead.stage, 'new');
  const events = ledger.listEvents({ leadId: 'acme' });
  assert.ok(events.some((e) => e.event === EVENTS.RESEARCH_FAILED));
});

test('successful reader research logs provenance, confidence, timestamp and advances stage', async () => {
  const stub = await startJinaStub(({ res }) => {
    json(res, 200, {
      data: {
        url: 'https://desert-logistics.example/about',
        title: 'Desert Logistics',
        content: 'Fleet operator importing heavy vehicles for West Africa distribution. '.repeat(8),
      },
    });
  });
  try {
    const { research, ledger } = engineFor(stub);
    ledger.upsertLead({ id: 'desert', company: 'Desert Logistics', stage: 'new' });
    const result = await research.researchUrl({ url: 'https://desert-logistics.example/about', leadId: 'desert' });
    assert.equal(result.status, 'RESEARCH_LOGGED');
    assert.equal(result.verified, true);
    assert.equal(result.stage, 'researched');
    assert.equal(result.stage_advanced, true);
    assert.equal(result.provenance, 'https://desert-logistics.example/about');
    assert.ok(result.confidence > 0 && result.confidence <= 1);
    assert.ok(result.timestamp);
    assert.equal(ledger.readLead('desert').stage, 'researched');
    assert.ok(ledger.readLead('desert').verified_score != null);
  } finally {
    stub.server.close();
  }
});

test('HTTP 500 is retried then RESEARCH_FAILED without stage advance', async () => {
  const stub = await startJinaStub(({ res }) => json(res, 500, { error: 'boom' }));
  try {
    const { research, ledger } = engineFor(stub, { maxRetries: 2 });
    ledger.upsertLead({ id: 'x', stage: 'new' });
    const result = await research.search({ query: 'buyers Nigeria', leadId: 'x' });
    assert.equal(result.status, 'RESEARCH_FAILED');
    assert.equal(result.reason, 'http_500');
    assert.ok(stub.hits.search >= 3);
    assert.equal(ledger.readLead('x').stage, 'new');
  } finally {
    stub.server.close();
  }
});

test('timeout fails as RESEARCH_FAILED reason timeout', async () => {
  const stub = await startJinaStub(() => { /* never respond */ });
  try {
    const { research } = engineFor(stub, { timeoutMs: 40, maxRetries: 0 });
    const result = await research.search({ query: 'slow' });
    assert.equal(result.status, 'RESEARCH_FAILED');
    assert.equal(result.reason, 'timeout');
  } finally {
    stub.server.close();
  }
});

test('invalid JSON 200 is treated as zero/invalid results', async () => {
  const stub = await startJinaStub(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not-json{{{');
  });
  try {
    const { research } = engineFor(stub);
    const result = await research.search({ query: 'x' });
    assert.equal(result.status, 'RESEARCH_FAILED');
    assert.ok(['zero_results', 'invalid_response'].includes(result.reason));
  } finally {
    stub.server.close();
  }
});

test('zero results do not mark researched', async () => {
  const stub = await startJinaStub(({ res }) => json(res, 200, { data: [] }));
  try {
    const { research, ledger } = engineFor(stub);
    ledger.upsertLead({ id: 'empty', stage: 'contacted' });
    const result = await research.search({ query: 'no hits', leadId: 'empty' });
    assert.equal(result.status, 'RESEARCH_FAILED');
    assert.equal(result.reason, 'zero_results');
    assert.equal(ledger.readLead('empty').stage, 'contacted');
  } finally {
    stub.server.close();
  }
});

test('401 authentication failure does not retry', async () => {
  const stub = await startJinaStub(({ res }) => json(res, 401, { error: 'unauthorized' }));
  try {
    const { research } = engineFor(stub, { maxRetries: 4 });
    const result = await research.search({ query: 'secret' });
    assert.equal(result.status, 'RESEARCH_FAILED');
    assert.equal(result.reason, 'authentication_failed');
    assert.equal(stub.hits.search, 1);
  } finally {
    stub.server.close();
  }
});

test('search preserves source URLs from the real HTTP payload only', async () => {
  const stub = await startJinaStub(({ res }) => {
    json(res, 200, {
      data: [
        { title: 'Lagos Fleet Co', url: 'https://lagos-fleet.example', description: 'Importer' },
        { title: 'No URL row' },
      ],
    });
  });
  try {
    const { research } = engineFor(stub);
    const result = await research.search({ query: 'fleet Nigeria' });
    assert.equal(result.status, 'RESEARCH_LOGGED');
    assert.equal(result.results[0].url, 'https://lagos-fleet.example');
    assert.ok(result.results.every((r) => r.url || r.title));
    assert.ok(!JSON.stringify(result).includes('Invented Corp'));
  } finally {
    stub.server.close();
  }
});

test('discovery dry-run deduplicates and does not write leads', async () => {
  const stub = await startJinaStub(({ res }) => {
    json(res, 200, {
      data: [
        { title: 'Acme Logistics', url: 'https://www.acme.example/about' },
        { title: 'Acme Logistics Home', url: 'https://acme.example/' },
        { title: 'Beta Haulage', url: 'https://beta.example' },
      ],
    });
  });
  try {
    const { discovery, ledger } = engineFor(stub, { dryRun: true });
    const result = await discovery.discover({ queries: ['fleet buyers'] });
    assert.equal(result.status, 'DISCOVERY_SOURCE');
    assert.equal(result.dry_run, true);
    assert.equal(result.prospects.length, 2);
    assert.equal(result.applied.length, 0);
    assert.equal(ledger.listLeads().length, 0);
  } finally {
    stub.server.close();
  }
});

test('dedupeProspects collapses same host', () => {
  const out = dedupeProspects([
    { url: 'https://www.a.example/x', title: 'A' },
    { url: 'https://a.example/y', title: 'A2' },
    { url: 'https://b.example', title: 'B' },
  ]);
  assert.equal(out.length, 2);
});

test('scoring: manual notes stay unverified and do not become verified_score alone', () => {
  const scored = scoreSignals([
    { source: 'manual', verified: false, dimension: 'purchase_volume', value: 3, text: 'said they buy a lot' },
  ]);
  assert.equal(scored.verified_score, null);
  assert.ok(scored.draft_score != null);
  assert.equal(scored.unverified_signal_count, 1);
});

test('verified discovery signals feed W1 scoring when apply is on', async () => {
  const stub = await startJinaStub(({ res }) => {
    json(res, 200, { data: [{ title: 'Gamma Transport', url: 'https://gamma.example', description: 'procurement' }] });
  });
  try {
    const { discovery, ledger } = engineFor(stub, { dryRun: false });
    const result = await discovery.discover({ queries: ['procurement'], dryRun: false });
    assert.equal(result.status, 'DISCOVERY_SOURCE');
    assert.equal(result.applied.length, 1);
    const lead = ledger.readLead(result.applied[0].lead_id);
    assert.ok(lead.verified_score != null);
    assert.ok(lead.signals.some((s) => s.verified === true && s.url === 'https://gamma.example'));
    assert.notEqual(lead.stage, 'researched');
  } finally {
    stub.server.close();
  }
});

test('secret is never present in research output or ledger files', async () => {
  const secret = 'jina-super-secret-key-xyz';
  const stub = await startJinaStub(({ res, hits }) => {
    assert.equal(hits.lastAuth, `Bearer ${secret}`);
    json(res, 200, { data: [{ title: 'Ok', url: 'https://ok.example', description: 'x' }] });
  });
  try {
    const { research, ledger, env } = engineFor(stub, { key: secret });
    const result = await research.search({ query: 'ok', leadId: 'sec' });
    const blob = JSON.stringify(result) + readFileSync(ledger.eventsPath, 'utf8');
    assert.equal(blob.includes(secret), false);
    assert.equal(redact(`Bearer ${secret}`).includes(secret), false);
    assert.equal(getJinaKey(env), secret);
  } finally {
    stub.server.close();
  }
});

test('W2 files exist in the repository (new implementation, not b1a6f79)', () => {
  for (const f of ['research.mjs', 'discovery.mjs', 'ledger.mjs', 'cli.mjs', 'test-research.mjs', 'jina.mjs']) {
    assert.ok(existsSync(join(ROOT, 'worker', f)), f);
  }
});

test('jina health is NOT_CONFIGURED without a key', async () => {
  const report = await probeJina({ env: {} });
  assert.equal(report.status, JINA_STATUS.NOT_CONFIGURED);
  assert.equal(report.key_present, false);
  assert.equal(report.live, false);
  assert.equal(report.reason, 'missing_api_key');
});

test('jina health is NOT_AUTHORIZED on loopback 401 (TEST ADAPTER)', async () => {
  const stub = await startJinaStub(({ res }) => json(res, 401, { error: 'unauthorized' }));
  try {
    const report = await probeJina({
      env: { JINA_API_KEY: 'test-jina-key-do-not-commit' },
      searchBase: stub.searchBase,
      readerBase: stub.readerBase,
      timeoutMs: 400,
      maxRetries: 0,
      allowPrivate: true,
    });
    assert.equal(report.status, JINA_STATUS.NOT_AUTHORIZED);
    assert.equal(report.key_present, true);
    assert.equal(JSON.stringify(report).includes('test-jina-key-do-not-commit'), false);
  } finally {
    stub.server.close();
  }
});

test('jina health is CONNECTED only after loopback 2xx (TEST ADAPTER)', async () => {
  const stub = await startJinaStub(({ res }) => json(res, 200, { data: [{ title: 'ok', url: 'https://example.com' }] }));
  try {
    const report = await probeJina({
      env: { JINA_API_KEY: 'test-jina-key-do-not-commit' },
      searchBase: stub.searchBase,
      readerBase: stub.readerBase,
      timeoutMs: 400,
      maxRetries: 0,
      allowPrivate: true,
    });
    assert.equal(report.status, JINA_STATUS.CONNECTED);
    assert.equal(report.search.ok, true);
  } finally {
    stub.server.close();
  }
});

test('jina health is UNREACHABLE on loopback timeout (TEST ADAPTER)', async () => {
  const stub = await startJinaStub(() => { /* hang */ });
  try {
    const report = await probeJina({
      env: { JINA_API_KEY: 'test-jina-key-do-not-commit' },
      searchBase: stub.searchBase,
      readerBase: stub.readerBase,
      timeoutMs: 40,
      maxRetries: 0,
      allowPrivate: true,
    });
    assert.equal(report.status, JINA_STATUS.UNREACHABLE);
  } finally {
    stub.server.close();
  }
});

test('live Jina health runs only when JINA_API_KEY is set', async (t) => {
  const key = getJinaKey(process.env);
  if (!key) {
    t.skip('JINA_API_KEY unset — live Jina probe not run');
    return;
  }
  const report = await probeJina({ timeoutMs: 8000, maxRetries: 0 });
  assert.ok(Object.values(JINA_STATUS).includes(report.status));
  assert.equal(report.live, true);
  assert.equal(JSON.stringify(report).includes(key), false);
});
