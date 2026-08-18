/**
 * W6 Daily Autonomous Worker.
 * Orchestrates existing W1–W5 modules. Does not duplicate their logic.
 * Never marks SENT unless an authorized provider/adapter confirms it.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLedger, EVENTS } from './ledger.mjs';
import { createResearchEngine } from './research.mjs';
import { createDiscovery } from './discovery.mjs';
import { scoreSignals } from './scoring.mjs';
import { createOutreach, selectChannel } from './outreach.mjs';
import { createReplyWorker, outreachAllowed } from './replies.mjs';
import { createScheduler, dateKeyInZone, loadJson } from './scheduler.mjs';
import { buildDailyReport, emptyCounts } from './report.mjs';

const DRY_NOTIFIER = {
  notify: async () => ({ ok: false, reason: 'dry_run' }),
};

function researchedToday(lead, dateKey, tz) {
  const ts = lead?.last_research?.timestamp;
  if (!ts) return false;
  return dateKeyInZone(new Date(ts), tz) === dateKey;
}

function sentToday(lead, dateKey, tz) {
  const ts = lead?.last_outreach_at;
  if (!ts) return false;
  return dateKeyInZone(new Date(ts), tz) === dateKey;
}

function needsFollowUp(lead, now, days) {
  if (!lead || !outreachAllowed(lead)) return false;
  if (lead.last_classification === 'FOLLOW_UP') return true;
  const last = lead.last_outreach_at;
  if (!last) return false;
  const lastT = new Date(last).getTime();
  if (!Number.isFinite(lastT)) return false;
  if (now.getTime() - lastT < days * 24 * 60 * 60 * 1000) return false;
  const replyT = lead.last_reply_at ? new Date(lead.last_reply_at).getTime() : 0;
  return replyT < lastT;
}

export function listRuns(root) {
  const dir = join(root, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadJson(join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
}

export function createDailyWorker(options = {}) {
  const ledger = options.ledger || createLedger(options.home);
  const scheduler = options.scheduler || createScheduler({
    home: options.home || ledger.root,
    now: options.now,
    env: options.env,
    timezone: options.timezone,
    hour: options.hour,
    minute: options.minute,
    queries: options.queries,
    highPriorityScore: options.highPriorityScore,
    maxResearch: options.maxResearch,
    maxOutreach: options.maxOutreach,
    followUpDays: options.followUpDays,
    staleLockMs: options.staleLockMs,
  });
  const nowFn = options.now || scheduler.now;
  const research = options.research || createResearchEngine({
    ledger,
    jina: options.jina,
    env: options.env,
  });
  const discovery = options.discovery || createDiscovery({
    engine: research,
    dryRun: false,
  });
  const outreach = options.outreach || createOutreach({
    ledger,
    email: options.email,
    teams: options.teams,
    linkedin: options.linkedin,
    notifier: options.notifier,
    requireApproval: options.requireApproval,
    limits: options.limits,
  });

  const runsDir = join(ledger.root, 'runs');
  const reportsDir = join(ledger.root, 'reports');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  function runPath(id) {
    return join(runsDir, `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
  }

  function saveRun(run) {
    writeFileSync(runPath(run.id), JSON.stringify(run, null, 2));
    writeFileSync(join(ledger.root, 'current-run.json'), JSON.stringify(run, null, 2));
    return run;
  }

  function readRun(id) {
    return loadJson(runPath(id), null);
  }

  function latestCompleted() {
    const runs = listRuns(ledger.root).filter((r) => r.status === 'COMPLETED' || r.status === 'FAILED');
    return runs.length ? runs[runs.length - 1] : null;
  }

  function repliesWorker(dryRun) {
    if (options.replies) return options.replies;
    return createReplyWorker({
      ledger,
      inbox: options.inbox,
      notifier: dryRun ? DRY_NOTIFIER : options.notifier,
    });
  }

  async function stepDiscovery(run, dryRun) {
    const queries = options.queries || scheduler.config.queries;
    const result = await discovery.discover({ queries, dryRun });
    run.steps.discovery = {
      status: result.status,
      reason: result.reason || null,
      dry_run: Boolean(result.dry_run),
      prospects: (result.prospects || []).length,
      applied: (result.applied || []).length,
      errors: result.errors || [],
    };
    run.counts.leads_discovered = dryRun
      ? (result.prospects || []).length
      : (result.applied || []).length || (result.prospects || []).length;
    if (result.status !== 'DISCOVERY_SOURCE') {
      run.errors.push({
        step: 'discovery',
        status: result.status,
        reason: result.reason || 'discovery_failed',
      });
      if (result.reason && /missing_api_key|http_|timeout|authentication/.test(String(result.reason))) {
        run.counts.provider_errors += 1;
      }
    }
    return result;
  }

  async function stepResearch(run, dryRun) {
    if (dryRun) {
      run.steps.research = { status: 'SKIPPED', reason: 'dry_run' };
      return;
    }
    const tz = scheduler.config.timezone;
    const dateKey = run.date_key;
    const leads = ledger.listLeads();
    let researched = 0;
    const details = [];
    for (const lead of leads) {
      if (researched >= scheduler.config.maxResearch) break;
      if (researchedToday(lead, dateKey, tz)) continue;
      if (lead.stage === 'researched' && lead.last_research) continue;
      const url = lead.url || lead.website || (lead.signals || []).find((s) => s.url)?.url;
      let result;
      if (url) {
        result = await research.researchUrl({ url, leadId: lead.id, company: lead.company });
      } else if (lead.company) {
        result = await research.search({ query: String(lead.company), leadId: lead.id, company: lead.company });
      } else {
        continue;
      }
      details.push({ lead_id: lead.id, status: result.status, reason: result.reason || null });
      if (result.status === 'RESEARCH_LOGGED') researched += 1;
      else {
        run.errors.push({ step: 'research', lead_id: lead.id, status: result.status, reason: result.reason });
        if (result.reason && result.reason !== 'zero_results') run.counts.provider_errors += 1;
      }
    }
    run.counts.leads_researched = researched;
    run.steps.research = { status: 'OK', researched, details: details.slice(-30) };
  }

  function stepScore(run) {
    const threshold = scheduler.config.highPriorityScore;
    const leads = ledger.listLeads();
    const high = [];
    for (const lead of leads) {
      const scores = scoreSignals(lead.signals || []);
      if (scores.verified_score !== lead.verified_score || scores.draft_score !== lead.draft_score) {
        ledger.writeLead({ ...lead, ...scores });
      }
      const score = scores.verified_score ?? lead.verified_score;
      if (score != null && Number(score) >= threshold) {
        high.push({ id: lead.id, verified_score: score, company: lead.company || null });
      }
    }
    run.counts.high_priority_leads = high.length;
    run.steps.score = { status: 'OK', high_priority: high.slice(0, 50), threshold };
  }

  async function stepOutreach(run, dryRun) {
    const tz = scheduler.config.timezone;
    const dateKey = run.date_key;
    const auth = outreach.authMap();
    const now = nowFn();
    const leads = ledger.listLeads();
    const followUps = [];
    let attempted = 0;

    for (const lead of leads) {
      if (needsFollowUp(lead, now, scheduler.config.followUpDays)) {
        followUps.push(lead.id);
      }
    }
    run.counts.follow_ups = followUps.length;

    const candidates = [];
    for (const lead of leads) {
      if (!outreachAllowed(lead)) {
        run.counts.blocked_actions += 1;
        continue;
      }
      if (sentToday(lead, dateKey, tz)) continue;
      candidates.push(lead);
    }

    for (const lead of candidates) {
      if (attempted >= scheduler.config.maxOutreach) break;
      const selected = selectChannel(lead, auth);
      if (selected.channel === 'NO_OUTREACH') {
        run.counts.blocked_actions += 1;
        continue;
      }

      const channel = selected.channel === 'MANUAL_ASSIST' ? 'linkedin' : String(selected.channel).toLowerCase();
      if (channel === 'email' && !lead.email) continue;
      if (channel === 'teams' && !lead.teams_chat_id) continue;
      const prep = outreach.prepare({ leadId: lead.id, channel });
      if (prep.status !== 'OUTREACH_PREPARED') {
        run.errors.push({ step: 'prepare', lead_id: lead.id, status: prep.status, reason: prep.reason });
        continue;
      }

      if (dryRun) {
        attempted += 1;
        run.counts.approvals_pending += 1;
        continue;
      }

      if (options.autoApprove === true) {
        outreach.approve(lead.id, prep.outreach.fingerprint);
      }

      const sent = await outreach.send({
        leadId: lead.id,
        channel,
        fingerprint: prep.outreach.fingerprint,
      });
      attempted += 1;

      if (sent.status === 'OUTREACH_SENT') {
        run.counts.confirmed_sends += 1;
      } else if (sent.status === 'OUTREACH_PENDING_APPROVAL') {
        run.counts.approvals_pending += 1;
      } else if (sent.status === 'OUTREACH_BLOCKED') {
        run.counts.blocked_actions += 1;
      } else if (sent.status === 'RATE_LIMITED') {
        run.counts.rate_limits += 1;
      } else if (sent.status === 'OUTREACH_MANUAL_ASSIST' || sent.status === 'MANUAL_ASSIST_REQUIRED') {
        run.counts.manual_assist_actions += 1;
      } else if (sent.status === 'ADAPTER_UNAVAILABLE' || sent.status === 'CHANNEL_NOT_AUTHORIZED') {
        run.counts.failed_sends += 1;
        run.counts.provider_errors += 1;
        run.errors.push({ step: 'outreach', lead_id: lead.id, status: sent.status, reason: sent.reason });
      } else if (sent.status === 'OUTREACH_FAILED' || sent.status === 'SEND_FAILED') {
        run.counts.failed_sends += 1;
        if (sent.reason && sent.reason !== 'duplicate' && sent.reason !== 'lead_not_found') {
          run.counts.provider_errors += 1;
        }
        run.errors.push({ step: 'outreach', lead_id: lead.id, status: sent.status, reason: sent.reason });
      } else if (sent.status === 'OUTREACH_REJECTED') {
        run.counts.blocked_actions += 1;
      }
    }

    run.counts.outreach_attempted = attempted;
    run.steps.outreach = {
      status: dryRun ? 'DRY_RUN' : 'OK',
      dry_run: dryRun,
      sent: false,
      note: dryRun ? 'dry-run: prepared only, never sent' : 'send only after provider confirmation',
    };
  }

  async function stepReplies(run, dryRun) {
    const replies = repliesWorker(dryRun);
    const result = await replies.checkInbox();
    run.steps.replies = {
      status: result.status,
      reason: result.reason || null,
      count: result.count || (result.processed || []).length,
    };
    if (result.status === 'REPLY_CHECK_FAILED') {
      run.counts.provider_errors += 1;
      run.errors.push({ step: 'replies', status: result.status, reason: result.reason });
      return result;
    }
    for (const item of result.processed || []) {
      if (item.status === 'DUPLICATE') continue;
      if (item.status === 'REPLY_CHECK_FAILED') {
        run.counts.provider_errors += 1;
        continue;
      }
      if (item.status === 'REPLY_UNMATCHED' || item.status === 'REPLY_CLASSIFIED') {
        run.counts.replies_received += 1;
      }
      const cls = item.classification?.classification;
      if (cls === 'INTERESTED') run.counts.interested_replies += 1;
      if (cls === 'QUESTION') run.counts.questions += 1;
      if (cls === 'PRICE_REQUEST') run.counts.price_requests += 1;
      if (cls === 'OPT_OUT') run.counts.opt_outs += 1;
      if (cls === 'FOLLOW_UP') run.counts.follow_ups += 1;
    }
    return result;
  }

  function persistReport(run) {
    const adapters = outreach.statuses();
    const report = buildDailyReport({
      runId: run.id,
      dateKey: run.date_key,
      timezone: run.timezone,
      dryRun: run.dry_run,
      status: run.status,
      counts: run.counts,
      adapters,
      errors: run.errors,
      notes: run.notes,
    });
    run.report = report;
    writeFileSync(join(reportsDir, `${run.id}.md`), report.text);
    writeFileSync(join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(reportsDir, 'latest.md'), report.text);
    ledger.append({
      event: EVENTS.DAILY_REPORT,
      run_id: run.id,
      status: run.status,
      date_key: run.date_key,
      dry_run: run.dry_run,
    });
    return report;
  }

  async function execute({ dryRun = false, force = false } = {}) {
    const now = nowFn();
    const dateKey = scheduler.dateKey(now);
    const completedToday = listRuns(ledger.root).find((r) => r.date_key === dateKey && r.status === 'COMPLETED')
      || (scheduler.readState().last_completed_date_key === dateKey ? { id: scheduler.readState().last_run_id, status: 'COMPLETED' } : null);
    const lockInfo = scheduler.lockStatus();

    if (!force && completedToday) {
      const skip = {
        status: 'DAILY_RUN_SKIPPED',
        reason: 'duplicate_run',
        run_id: completedToday.id,
        date_key: dateKey,
        existing_status: completedToday.status,
      };
      ledger.append({ event: EVENTS.DAILY_RUN_SKIPPED, run_id: completedToday.id, status: 'skipped', error: 'duplicate_run', date_key: dateKey });
      return skip;
    }

    if (!force && lockInfo.locked) {
      const skip = {
        status: 'DAILY_RUN_SKIPPED',
        reason: 'run_in_progress',
        run_id: lockInfo.lock?.run_id || `run_${dateKey}`,
        date_key: dateKey,
      };
      ledger.append({ event: EVENTS.DAILY_RUN_SKIPPED, run_id: skip.run_id, status: 'skipped', error: 'run_in_progress', date_key: dateKey });
      return skip;
    }

    const instance = randomBytes(3).toString('hex');
    const runId = `run_${dateKey}_${instance}`;
    const acquired = scheduler.acquireLock(runId);
    if (!acquired.ok) {
      const skip = {
        status: 'DAILY_RUN_SKIPPED',
        reason: acquired.reason,
        run_id: runId,
        date_key: dateKey,
      };
      ledger.append({ event: EVENTS.DAILY_RUN_SKIPPED, run_id: runId, status: 'skipped', error: acquired.reason, date_key: dateKey });
      return skip;
    }

    const recovered = [];
    if (acquired.recovered?.run_id) {
      const prev = readRun(acquired.recovered.run_id);
      if (prev && prev.status === 'RUNNING') {
        prev.status = 'FAILED';
        prev.reason = 'stale_lock_recovered';
        prev.finished_at = now.toISOString();
        saveRun(prev);
        ledger.append({
          event: EVENTS.DAILY_RUN_FAILED,
          run_id: prev.id,
          status: 'failed',
          error: 'stale_lock_recovered',
          date_key: prev.date_key,
        });
        recovered.push(prev.id);
      }
    }

    const run = {
      id: runId,
      date_key: dateKey,
      timezone: scheduler.config.timezone,
      status: 'RUNNING',
      dry_run: Boolean(dryRun),
      started_at: now.toISOString(),
      finished_at: null,
      pid: process.pid,
      counts: emptyCounts(),
      steps: {},
      errors: [],
      notes: recovered.length ? [`Restart recovery: marked ${recovered.join(', ')} FAILED (stale lock).`] : [],
      recovered_from: recovered,
    };
    saveRun(run);
    scheduler.writeState({ current_run_id: runId, last_run_id: runId, last_status: 'RUNNING', last_started_at: run.started_at });
    ledger.append({
      event: EVENTS.DAILY_RUN_STARTED,
      run_id: runId,
      status: 'running',
      date_key: dateKey,
      dry_run: run.dry_run,
    });

    try {
      await stepDiscovery(run, dryRun);
      saveRun(run);
      await stepResearch(run, dryRun);
      saveRun(run);
      stepScore(run);
      saveRun(run);
      await stepOutreach(run, dryRun);
      saveRun(run);
      await stepReplies(run, dryRun);
      run.status = 'COMPLETED';
      run.finished_at = nowFn().toISOString();
      persistReport(run);
      saveRun(run);
      scheduler.writeState({
        current_run_id: null,
        last_run_id: runId,
        last_completed_date_key: dateKey,
        last_status: 'COMPLETED',
        last_finished_at: run.finished_at,
      });
      ledger.append({
        event: EVENTS.DAILY_RUN_COMPLETED,
        run_id: runId,
        status: 'ok',
        date_key: dateKey,
        dry_run: run.dry_run,
      });
      return {
        status: 'DAILY_RUN_COMPLETED',
        run_id: runId,
        date_key: dateKey,
        dry_run: run.dry_run,
        counts: run.counts,
        report: run.report,
        errors: run.errors,
        steps: run.steps,
      };
    } catch (err) {
      run.status = 'FAILED';
      run.reason = err.message || 'unhandled';
      run.finished_at = nowFn().toISOString();
      run.errors.push({ step: 'execute', status: 'DAILY_RUN_FAILED', reason: run.reason });
      persistReport(run);
      saveRun(run);
      scheduler.writeState({
        current_run_id: null,
        last_run_id: runId,
        last_status: 'FAILED',
        last_finished_at: run.finished_at,
      });
      ledger.append({
        event: EVENTS.DAILY_RUN_FAILED,
        run_id: runId,
        status: 'failed',
        error: run.reason,
        date_key: dateKey,
      });
      return {
        status: 'DAILY_RUN_FAILED',
        run_id: runId,
        reason: run.reason,
        date_key: dateKey,
        dry_run: run.dry_run,
        counts: run.counts,
        report: run.report,
        errors: run.errors,
      };
    } finally {
      scheduler.releaseLock(runId);
    }
  }

  function status() {
    const snap = scheduler.snapshot();
    const currentId = snap.state.current_run_id;
    const lastId = snap.state.last_run_id;
    const current = currentId ? readRun(currentId) : (snap.lock.locked ? readRun(snap.lock.lock?.run_id) : null);
    const last = lastId ? readRun(lastId) : latestCompleted();
    const latestReport = loadJson(join(reportsDir, 'latest.json'), last?.report || null);
    return {
      worker: 'W6 DAILY AUTONOMOUS WORKER',
      timezone: snap.timezone,
      schedule: `${String(snap.hour).padStart(2, '0')}:${String(snap.minute).padStart(2, '0')} ${snap.timezone}`,
      date_key: snap.date_key,
      current_run: current ? { id: current.id, status: current.status, started_at: current.started_at, dry_run: current.dry_run } : null,
      last_run: last ? { id: last.id, status: last.status, started_at: last.started_at, finished_at: last.finished_at, dry_run: last.dry_run } : null,
      next_run: snap.next_run,
      status: current?.status === 'RUNNING' ? 'RUNNING' : (last?.status || 'NEVER_RUN'),
      lock: snap.lock,
      adapters: outreach.statuses(),
      counts: last?.counts || emptyCounts(),
      report: latestReport,
    };
  }

  function report() {
    const latest = loadJson(join(reportsDir, 'latest.json'), null);
    if (latest) return latest;
    const last = latestCompleted();
    if (last?.report) return last.report;
    return buildDailyReport({
      status: 'NEVER_RUN',
      dateKey: scheduler.dateKey(),
      timezone: scheduler.config.timezone,
      notes: ['No daily run has completed on this host.'],
    });
  }

  return {
    ledger,
    scheduler,
    research,
    discovery,
    outreach,
    execute,
    status,
    report,
    readRun,
    listRuns: () => listRuns(ledger.root),
  };
}
