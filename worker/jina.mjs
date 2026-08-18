/**
 * Jina Reader / Search HTTP client for AITZAZ AI 2070 W2.
 * Key is read only from the environment. Never logged or serialized.
 */
const DEFAULT_SEARCH = 'https://s.jina.ai';
const DEFAULT_READER = 'https://r.jina.ai';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const AUTH = new Set([401, 403]);

export function getJinaKey(env = process.env) {
  const key = env.JINA_API_KEY;
  if (typeof key !== 'string' || !key.trim()) return null;
  return key.trim();
}

export function redact(value) {
  if (value == null) return value;
  const s = String(value);
  const key = getJinaKey();
  if (key && s.includes(key)) return s.split(key).join('[REDACTED]');
  return s.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function sleep(ms, sleeper) {
  return (sleeper || ((n) => new Promise((r) => setTimeout(r, n))))(ms);
}

function isPrivateUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

export function createJinaClient(options = {}) {
  const env = options.env || process.env;
  const searchBase = String(options.searchBase || env.JINA_SEARCH_BASE || DEFAULT_SEARCH).replace(/\/$/, '');
  const readerBase = String(options.readerBase || env.JINA_READER_BASE || DEFAULT_READER).replace(/\/$/, '');
  const timeoutMs = Number(options.timeoutMs || env.JINA_TIMEOUT_MS || 15000);
  const maxRetries = Number(options.maxRetries ?? 3);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleeper = options.sleeper;
  const allowPrivate = options.allowPrivate === true;

  async function request(url) {
    const key = getJinaKey(env);
    if (!key) {
      return { ok: false, reason: 'missing_api_key', status: 0, attempts: 0, body: null };
    }

    let last = { ok: false, reason: 'unknown', status: 0, attempts: 0, body: null };
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'X-Return-Format': 'json',
          },
          signal: controller.signal,
        });
        const status = res.status;
        let body = null;
        const text = await res.text();
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

        if (AUTH.has(status)) {
          return { ok: false, reason: 'authentication_failed', status, attempts: attempt, body, retried: false };
        }
        if (status >= 200 && status < 300) {
          return { ok: true, reason: null, status, attempts: attempt, body };
        }
        last = { ok: false, reason: `http_${status}`, status, attempts: attempt, body };
        if (!RETRYABLE.has(status) || attempt > maxRetries) return last;
      } catch (err) {
        const timeout = err?.name === 'AbortError';
        last = {
          ok: false,
          reason: timeout ? 'timeout' : 'network',
          status: 0,
          attempts: attempt,
          body: null,
          error: redact(err.message),
        };
        if (attempt > maxRetries) return last;
      } finally {
        clearTimeout(timer);
      }
      await sleep(50 * (2 ** (attempt - 1)), sleeper);
    }
    return last;
  }

  async function search(query) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty_query', status: 0, attempts: 0, body: null };
    return request(`${searchBase}/${encodeURIComponent(q)}`);
  }

  async function read(url) {
    const raw = String(url || '').trim();
    if (!raw) return { ok: false, reason: 'empty_url', status: 0, attempts: 0, body: null };
    const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!allowPrivate && isPrivateUrl(target) && !readerBase.includes('127.0.0.1') && !readerBase.includes('localhost')) {
      return { ok: false, reason: 'blocked_private_url', status: 0, attempts: 0, body: null };
    }
    return request(`${readerBase}/${target}`);
  }

  return { search, read, searchBase, readerBase, timeoutMs, maxRetries };
}
