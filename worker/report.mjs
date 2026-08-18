/**
 * W6 daily report. Confirmed sends are provider-confirmed only.
 */

export const REPORT_GREETING = "Sir, I handled today's outreach.";

export function emptyCounts() {
  return {
    leads_discovered: 0,
    leads_researched: 0,
    high_priority_leads: 0,
    approvals_pending: 0,
    outreach_attempted: 0,
    confirmed_sends: 0,
    failed_sends: 0,
    manual_assist_actions: 0,
    replies_received: 0,
    interested_replies: 0,
    questions: 0,
    price_requests: 0,
    opt_outs: 0,
    blocked_actions: 0,
    rate_limits: 0,
    provider_errors: 0,
    follow_ups: 0,
  };
}

export function classifyMode({ dryRun, adapters = {}, sent = 0 } = {}) {
  if (dryRun) return 'DRY-RUN';
  const values = Object.values(adapters);
  if (values.includes('TEST_ADAPTER')) return 'TEST ADAPTER';
  if (values.includes('MANUAL_ASSIST') || values.includes('MANUAL_ASSIST_REQUIRED')) return 'MANUAL-ASSIST';
  if (sent > 0) return 'REAL PROVIDER';
  if (values.some((v) => v === 'ADAPTER_URL' || v === 'AUTHORIZED')) return 'REAL PROVIDER';
  return 'MANUAL-ASSIST';
}

export function buildDailyReport({
  runId,
  dateKey,
  timezone,
  dryRun = false,
  status = 'COMPLETED',
  counts = {},
  adapters = {},
  errors = [],
  notes = [],
} = {}) {
  const c = { ...emptyCounts(), ...counts };
  const mode = classifyMode({ dryRun, adapters, sent: c.confirmed_sends });
  const lines = [
    REPORT_GREETING,
    '',
    `Run: ${runId || 'none'}`,
    `Date: ${dateKey || 'unknown'} (${timezone || 'UTC'})`,
    `Status: ${status}`,
    `Mode: ${mode}`,
    '',
    `Leads discovered: ${c.leads_discovered}`,
    `Leads researched: ${c.leads_researched}`,
    `High-priority leads: ${c.high_priority_leads}`,
    `Approvals pending: ${c.approvals_pending}`,
    `Outreach attempted: ${c.outreach_attempted}`,
    `Confirmed sends: ${c.confirmed_sends}`,
    `Failed sends: ${c.failed_sends}`,
    `Manual-assist actions: ${c.manual_assist_actions}`,
    `Replies received: ${c.replies_received}`,
    `Interested replies: ${c.interested_replies}`,
    `Questions: ${c.questions}`,
    `Price requests: ${c.price_requests}`,
    `Opt-outs: ${c.opt_outs}`,
    `Blocked actions: ${c.blocked_actions}`,
    `Rate limits: ${c.rate_limits}`,
    `Provider errors: ${c.provider_errors}`,
    `Follow-ups: ${c.follow_ups}`,
  ];
  if (errors.length) {
    lines.push('', 'Errors (honest):');
    for (const err of errors.slice(0, 20)) {
      lines.push(`- ${err.status || err.reason || 'error'}: ${err.reason || err.error || JSON.stringify(err)}`);
    }
  }
  if (notes.length) {
    lines.push('', ...notes);
  }
  lines.push('', 'Only provider-confirmed sends count as confirmed sends.');
  lines.push('DRY-RUN never sends. TEST ADAPTER is loopback only. MANUAL-ASSIST is not sent.');
  return {
    greeting: REPORT_GREETING,
    text: lines.join('\n'),
    counts: c,
    mode,
    run_id: runId || null,
    date_key: dateKey || null,
    timezone: timezone || 'UTC',
    status,
    dry_run: Boolean(dryRun),
    adapters,
    errors,
  };
}
