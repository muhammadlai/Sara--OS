/**
 * W4 Reply Intelligence — classify inbound mail, update ledger, notify.
 * Does not invent messages. Inbox must come from an authorized adapter.
 */
import { createLedger, EVENTS } from './ledger.mjs';
import { createInboxAdapter } from './gmail.mjs';
import { createNotifier } from './notify.mjs';
import { classifyReply, isOptOut, NOTIFY_CATEGORIES } from './classifier.mjs';

function normalizeEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).replace(/^mailto:/, '');
}

function validateMessage(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed_message' };
  const message_id = raw.message_id || raw.id || raw.messageId || null;
  const thread_id = raw.thread_id || raw.threadId || null;
  const sender = raw.sender || raw.from || raw.from_email || null;
  if (!message_id || !sender) return { ok: false, reason: 'malformed_message' };
  return {
    ok: true,
    message: {
      message_id: String(message_id),
      thread_id: thread_id ? String(thread_id) : null,
      sender: String(sender),
      recipient: raw.recipient || raw.to || null,
      received_at: raw.received_at || raw.internalDate || raw.date || null,
      subject: raw.subject || '',
      snippet: raw.snippet || '',
      body: raw.body || raw.text || raw.snippet || '',
    },
  };
}

export function matchLead(leads, message) {
  const sender = normalizeEmail(message.sender);
  const thread = message.thread_id ? String(message.thread_id) : '';
  const subject = String(message.subject || '').toLowerCase();

  if (thread) {
    const byThread = leads.find((l) => String(l.thread_id || '') === thread);
    if (byThread) return { lead: byThread, method: 'thread_id' };
  }

  const byEmail = leads.filter((l) => {
    const emails = [l.email, l.contact_email, ...(l.emails || [])].map(normalizeEmail).filter(Boolean);
    return emails.includes(sender);
  });
  if (byEmail.length === 1) return { lead: byEmail[0], method: 'sender_email' };
  if (byEmail.length > 1) return { lead: null, method: 'ambiguous_sender' };

  const bySubject = leads.filter((l) => {
    const company = String(l.company || '').trim().toLowerCase();
    return company && company.length >= 3 && subject.includes(company);
  });
  if (bySubject.length === 1) return { lead: bySubject[0], method: 'subject_company' };

  return { lead: null, method: 'none' };
}

export function outreachAllowed(lead) {
  if (!lead) return false;
  if (lead.do_not_contact === true) return false;
  if (lead.suppressed === true) return false;
  return true;
}

export function createReplyWorker(options = {}) {
  const ledger = options.ledger || createLedger(options.home);
  const inbox = options.inbox || createInboxAdapter(options);
  const notifier = options.notifier || createNotifier(options);
  const seen = new Set();

  function alreadyProcessed(messageId) {
    if (seen.has(messageId)) return true;
    const events = ledger.listEvents({ limit: 2000 });
    return events.some((e) => e.message_id === messageId && (e.event === EVENTS.REPLY_RECEIVED || e.event === EVENTS.REPLY_CLASSIFIED));
  }

  async function processMessage(raw) {
    const checked = validateMessage(raw);
    if (!checked.ok) {
      const event = ledger.append({
        event: EVENTS.REPLY_CHECK_FAILED,
        status: 'failed',
        error: checked.reason,
      });
      return { status: 'REPLY_CHECK_FAILED', reason: checked.reason, event };
    }
    const msg = checked.message;
    if (alreadyProcessed(msg.message_id)) {
      return { status: 'DUPLICATE', message_id: msg.message_id, notified: false };
    }
    seen.add(msg.message_id);

    const leads = ledger.listLeads();
    const matched = matchLead(leads, msg);
    const classified = classifyReply({
      subject: msg.subject,
      body: msg.body,
      snippet: msg.snippet,
    });

    if (!matched.lead) {
      const event = ledger.append({
        event: EVENTS.REPLY_UNMATCHED,
        status: 'unmatched',
        message_id: msg.message_id,
        thread_id: msg.thread_id,
        sender: msg.sender,
        subject: msg.subject,
        received_at: msg.received_at,
        classification: classified.classification,
        confidence: classified.confidence,
        reason: classified.reason,
      });
      return {
        status: 'REPLY_UNMATCHED',
        classification: classified,
        message: msg,
        notified: false,
        event,
      };
    }

    const lead = matched.lead;
    const replies = Array.isArray(lead.replies) ? lead.replies : [];
    replies.push({
      message_id: msg.message_id,
      thread_id: msg.thread_id,
      classification: classified.classification,
      confidence: classified.confidence,
      received_at: msg.received_at,
    });

    const patch = {
      ...lead,
      replies,
      last_reply_at: msg.received_at || new Date().toISOString(),
      last_classification: classified.classification,
      thread_id: lead.thread_id || msg.thread_id,
    };

    if (isOptOut(classified.classification)) {
      patch.do_not_contact = true;
      patch.suppressed = true;
      patch.suppression_reason = 'opt_out';
    }

    const next = ledger.writeLead(patch);
    ledger.append({
      event: EVENTS.REPLY_RECEIVED,
      lead_id: next.id,
      status: 'ok',
      message_id: msg.message_id,
      thread_id: msg.thread_id,
      sender: msg.sender,
      recipient: msg.recipient,
      subject: msg.subject,
      received_at: msg.received_at,
    });
    ledger.append({
      event: EVENTS.REPLY_CLASSIFIED,
      lead_id: next.id,
      status: 'ok',
      message_id: msg.message_id,
      classification: classified.classification,
      confidence: classified.confidence,
      reason: classified.reason,
      signals: classified.signals,
      method: classified.method,
      stage: next.stage,
    });

    let optOutEvent = null;
    if (isOptOut(classified.classification)) {
      optOutEvent = ledger.append({
        event: EVENTS.OPT_OUT_RECORDED,
        lead_id: next.id,
        status: 'ok',
        message_id: msg.message_id,
        outreach_blocked: true,
      });
    }

    let notification = { attempted: false, sent: false, reason: null };
    if (NOTIFY_CATEGORIES.has(classified.classification)) {
      notification.attempted = true;
      const payload = {
        lead: next.id,
        company: next.company || null,
        classification: classified.classification,
        confidence: classified.confidence,
        subject: msg.subject,
        sender: msg.sender,
        timestamp: msg.received_at || new Date().toISOString(),
        thread_id: msg.thread_id,
        reason: classified.reason,
      };
      const sent = await notifier.notify(payload);
      if (sent.ok) {
        notification = { attempted: true, sent: true, reason: null, reference: sent.reference };
        ledger.append({
          event: EVENTS.NOTIFICATION_SENT,
          lead_id: next.id,
          status: 'ok',
          message_id: msg.message_id,
          classification: classified.classification,
          reference: sent.reference,
        });
      } else {
        notification = { attempted: true, sent: false, reason: sent.reason };
        ledger.append({
          event: EVENTS.NOTIFICATION_FAILED,
          lead_id: next.id,
          status: 'failed',
          error: sent.reason,
          message_id: msg.message_id,
          classification: classified.classification,
        });
      }
    }

    return {
      status: 'REPLY_CLASSIFIED',
      classification: classified,
      lead: next,
      message: msg,
      match: matched.method,
      outreach_allowed: outreachAllowed(next),
      notification,
      opt_out: Boolean(optOutEvent),
    };
  }

  async function checkInbox({ since } = {}) {
    const listed = await inbox.listReplies({ since });
    if (!listed.ok) {
      const event = ledger.append({
        event: EVENTS.REPLY_CHECK_FAILED,
        status: 'failed',
        error: listed.reason || 'gmail_unavailable',
      });
      return {
        status: 'REPLY_CHECK_FAILED',
        reason: listed.reason || 'gmail_unavailable',
        processed: [],
        event,
      };
    }

    const processed = [];
    for (const raw of listed.messages) {
      processed.push(await processMessage(raw));
    }
    return {
      status: 'REPLY_CHECK_OK',
      processed,
      count: processed.length,
    };
  }

  function summarize() {
    const events = ledger.listEvents({ limit: 500 });
    const replies = events.filter((e) => e.event === EVENTS.REPLY_CLASSIFIED);
    const unmatched = events.filter((e) => e.event === EVENTS.REPLY_UNMATCHED);
    const optouts = events.filter((e) => e.event === EVENTS.OPT_OUT_RECORDED);
    const notifOk = events.filter((e) => e.event === EVENTS.NOTIFICATION_SENT);
    const notifFail = events.filter((e) => e.event === EVENTS.NOTIFICATION_FAILED);
    const errors = events.filter((e) => e.event === EVENTS.REPLY_CHECK_FAILED);
    return {
      replies: replies.slice(-20),
      unmatched: unmatched.slice(-20),
      interested: replies.filter((e) => e.classification === 'INTERESTED').slice(-20),
      opt_outs: optouts.slice(-20),
      notifications_sent: notifOk.length,
      notifications_failed: notifFail.length,
      errors: errors.slice(-10),
    };
  }

  return { ledger, inbox, notifier, checkInbox, processMessage, summarize, outreachAllowed };
}
