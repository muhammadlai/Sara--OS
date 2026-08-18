/**
 * Authorized inbox adapter used by W4.
 * W3 (Gmail OAuth/gws) is not present in this repository. This module is the
 * plug-in point: inject listInbox() or set GMAIL_ADAPTER_URL (HTTP).
 * Never invents messages. Unconfigured → gmail_unavailable.
 */
export function createInboxAdapter(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs || 8000);
  const listInbox = options.listInbox || null;
  const baseUrl = options.baseUrl || env.GMAIL_ADAPTER_URL || '';

  async function listReplies({ since } = {}) {
    if (typeof listInbox === 'function') {
      try {
        const listed = await listInbox({ since });
        if (!listed || listed.ok === false) {
          return {
            ok: false,
            reason: listed?.reason || 'gmail_unavailable',
            messages: [],
          };
        }
        return {
          ok: true,
          messages: Array.isArray(listed.messages) ? listed.messages : [],
        };
      } catch (err) {
        return { ok: false, reason: err.message || 'provider_error', messages: [] };
      }
    }

    if (!baseUrl) {
      return { ok: false, reason: 'gmail_unavailable', messages: [] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(String(baseUrl).replace(/\/$/, '') + '/messages');
      if (since) url.searchParams.set('since', since);
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) {
        return { ok: false, reason: `provider_http_${res.status}`, messages: [] };
      }
      const body = await res.json();
      const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body) ? body : [];
      return { ok: true, messages };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : (err.message || 'network');
      return { ok: false, reason, messages: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  function status() {
    if (typeof listInbox === 'function') return 'TEST_ADAPTER';
    if (baseUrl) return 'ADAPTER_URL';
    return 'NOT_AUTHORIZED';
  }

  return { listReplies, status, configured: Boolean(listInbox || baseUrl) };
}
