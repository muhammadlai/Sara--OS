/**
 * Notification adapter. Never reports sent unless the adapter confirms.
 */
export function createNotifier(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sendImpl = options.send || null;
  const webhook = options.webhookUrl || env.NOTIFY_WEBHOOK_URL || '';
  const timeoutMs = Number(options.timeoutMs || 8000);

  async function notify(payload) {
    if (typeof sendImpl === 'function') {
      try {
        const result = await sendImpl(payload);
        if (result && result.ok === true) {
          return { ok: true, reference: result.reference || null };
        }
        return { ok: false, reason: result?.reason || 'adapter_rejected' };
      } catch (err) {
        return { ok: false, reason: err.message || 'adapter_error' };
      }
    }

    if (!webhook) {
      return { ok: false, reason: 'adapter_not_configured' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      let reference = null;
      try {
        const body = await res.json();
        reference = body.reference || body.id || null;
      } catch { /* no body */ }
      return { ok: true, reference };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : (err.message || 'network');
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  return { notify, configured: Boolean(sendImpl || webhook) };
}
