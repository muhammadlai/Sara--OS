/**
 * W5 authorized channel adapters.
 * SEND_CONFIRMED only after the provider/adapter returns ok + message_id.
 */
export const SEND = {
  CONFIRMED: 'SEND_CONFIRMED',
  FAILED: 'SEND_FAILED',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  ADAPTER_UNAVAILABLE: 'ADAPTER_UNAVAILABLE',
  MANUAL_ASSIST_REQUIRED: 'MANUAL_ASSIST_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
};

function httpPost(fetchImpl, url, { headers = {}, body, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

export function createEmailAdapter(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sendImpl = options.send || null;
  const baseUrl = options.baseUrl || env.EMAIL_ADAPTER_URL || env.GMAIL_SEND_URL || '';

  return {
    channel: 'email',
    status() {
      if (sendImpl) return 'TEST_ADAPTER';
      if (baseUrl) return 'ADAPTER_URL';
      return 'ADAPTER_UNAVAILABLE';
    },
    async send({ to, subject, body, leadId } = {}) {
      if (typeof sendImpl === 'function') {
        const result = await sendImpl({ to, subject, body, leadId });
        if (result?.ok === true && result.message_id) {
          return { status: SEND.CONFIRMED, message_id: result.message_id, timestamp: result.timestamp || new Date().toISOString() };
        }
        return { status: SEND.FAILED, reason: result?.reason || 'provider_rejected' };
      }
      if (!baseUrl) {
        return { status: SEND.ADAPTER_UNAVAILABLE, reason: 'gmail_unavailable' };
      }
      try {
        const res = await httpPost(fetchImpl, String(baseUrl).replace(/\/$/, '') + '/send', {
          body: { to, subject, body, lead_id: leadId },
        });
        if (!res.ok) return { status: SEND.FAILED, reason: `http_${res.status}` };
        const json = await res.json().catch(() => ({}));
        if (!json.message_id && !json.id) return { status: SEND.FAILED, reason: 'missing_provider_message_id' };
        return {
          status: SEND.CONFIRMED,
          message_id: json.message_id || json.id,
          timestamp: json.timestamp || new Date().toISOString(),
        };
      } catch (err) {
        const reason = err?.name === 'AbortError' ? 'timeout' : (err.message || 'network');
        return { status: SEND.FAILED, reason };
      }
    },
  };
}

export function createTeamsAdapter(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sendImpl = options.send || null;
  const token = options.token || env.TEAMS_ACCESS_TOKEN || '';
  const graphBase = options.graphBase || env.TEAMS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0';

  return {
    channel: 'teams',
    status() {
      if (sendImpl) return 'TEST_ADAPTER';
      if (token) return 'AUTHORIZED';
      return 'NOT_AUTHORIZED';
    },
    async send({ chatId, body, leadId } = {}) {
      if (typeof sendImpl === 'function') {
        const result = await sendImpl({ chatId, body, leadId });
        if (result?.ok === true && result.message_id) {
          return {
            status: SEND.CONFIRMED,
            message_id: result.message_id,
            conversation_id: result.conversation_id || chatId || null,
            timestamp: result.timestamp || new Date().toISOString(),
          };
        }
        return { status: SEND.FAILED, reason: result?.reason || 'provider_rejected' };
      }
      if (!token) {
        return { status: SEND.NOT_AUTHORIZED, reason: 'missing_teams_token' };
      }
      if (!chatId) {
        return { status: SEND.FAILED, reason: 'missing_chat_id' };
      }
      try {
        const res = await httpPost(fetchImpl, `${String(graphBase).replace(/\/$/, '')}/chats/${encodeURIComponent(chatId)}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          body: { body: { contentType: 'text', content: body } },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: SEND.NOT_AUTHORIZED, reason: `http_${res.status}` };
        }
        if (!res.ok) return { status: SEND.FAILED, reason: `http_${res.status}` };
        const json = await res.json().catch(() => ({}));
        if (!json.id) return { status: SEND.FAILED, reason: 'missing_provider_message_id' };
        return {
          status: SEND.CONFIRMED,
          message_id: json.id,
          conversation_id: chatId,
          timestamp: json.createdDateTime || new Date().toISOString(),
        };
      } catch (err) {
        const reason = err?.name === 'AbortError' ? 'timeout' : (err.message || 'network');
        return { status: SEND.FAILED, reason };
      }
    },
  };
}

export function createLinkedInAdapter(options = {}) {
  const env = options.env || process.env;
  const sendImpl = options.send || null;
  const token = options.token || env.LINKEDIN_ACCESS_TOKEN || '';
  const officialUrl = options.baseUrl || env.LINKEDIN_ADAPTER_URL || '';

  return {
    channel: 'linkedin',
    status() {
      if (sendImpl) return 'TEST_ADAPTER';
      if (token || officialUrl) return 'AUTHORIZED';
      return 'MANUAL_ASSIST';
    },
    async send({ recipient, body, leadId, company } = {}) {
      if (typeof sendImpl === 'function') {
        const result = await sendImpl({ recipient, body, leadId });
        if (result?.ok === true && result.message_id) {
          return { status: SEND.CONFIRMED, message_id: result.message_id, timestamp: result.timestamp || new Date().toISOString() };
        }
        return { status: SEND.FAILED, reason: result?.reason || 'provider_rejected' };
      }
      if (!token && !officialUrl) {
        return {
          status: SEND.MANUAL_ASSIST_REQUIRED,
          reason: 'no_official_linkedin_api',
          draft: { recipient: recipient || null, company: company || null, body },
        };
      }
      return {
        status: SEND.MANUAL_ASSIST_REQUIRED,
        reason: 'official_linkedin_send_not_wired',
        draft: { recipient: recipient || null, company: company || null, body },
      };
    },
  };
}
