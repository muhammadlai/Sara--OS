/**
 * W6 daily scheduler — timezone-aware, persistent, restart-safe.
 * Does not send. Does not invent completed runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { workerHome } from './ledger.mjs';

export const DEFAULT_SCHEDULE = {
  timezone: 'UTC',
  hour: 10,
  minute: 0,
  staleLockMs: 2 * 60 * 60 * 1000,
};

export function zonedParts(date, timeZone = 'UTC') {
  let tz = timeZone || 'UTC';
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const map = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second),
      timeZone: tz,
    };
  } catch {
    return zonedParts(date, 'UTC');
  }
}

export function dateKeyInZone(date, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function zonedWallToUtc(year, month, day, hour, minute, timeZone = 'UTC') {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const got = zonedParts(new Date(utcGuess), timeZone);
  const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
  return new Date(utcGuess + (utcGuess - gotUtc));
}

export function addCalendarDays(year, month, day, n) {
  const dt = new Date(Date.UTC(year, month - 1, day + n));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function nextRunAt(now, schedule = {}) {
  const tz = schedule.timezone || DEFAULT_SCHEDULE.timezone;
  const hour = Number(schedule.hour ?? DEFAULT_SCHEDULE.hour);
  const minute = Number(schedule.minute ?? DEFAULT_SCHEDULE.minute);
  const p = zonedParts(now, tz);
  let candidate = zonedWallToUtc(p.year, p.month, p.day, hour, minute, tz);
  if (now.getTime() >= candidate.getTime()) {
    const nxt = addCalendarDays(p.year, p.month, p.day, 1);
    candidate = zonedWallToUtc(nxt.year, nxt.month, nxt.day, hour, minute, tz);
  }
  return candidate;
}

export function shouldRunNow(now, schedule = {}, lastCompletedDateKey = null) {
  const tz = schedule.timezone || DEFAULT_SCHEDULE.timezone;
  const hour = Number(schedule.hour ?? DEFAULT_SCHEDULE.hour);
  const minute = Number(schedule.minute ?? DEFAULT_SCHEDULE.minute);
  const p = zonedParts(now, tz);
  const key = dateKeyInZone(now, tz);
  if (lastCompletedDateKey && lastCompletedDateKey === key) return false;
  if (p.hour > hour) return true;
  if (p.hour === hour && p.minute >= minute) return true;
  return false;
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function createScheduler(options = {}) {
  const root = workerHome(options.home);
  mkdirSync(root, { recursive: true });
  const statePath = join(root, 'scheduler.json');
  const lockPath = join(root, 'daily.lock');
  const nowFn = options.now || (() => new Date());
  const env = options.env || process.env;

  const config = {
    timezone: options.timezone || env.WORKER_TZ || DEFAULT_SCHEDULE.timezone,
    hour: options.hour ?? (env.WORKER_HOUR !== undefined ? Number(env.WORKER_HOUR) : DEFAULT_SCHEDULE.hour),
    minute: options.minute ?? (env.WORKER_MINUTE !== undefined ? Number(env.WORKER_MINUTE) : DEFAULT_SCHEDULE.minute),
    staleLockMs: options.staleLockMs ?? DEFAULT_SCHEDULE.staleLockMs,
    queries: options.queries || (env.WORKER_QUERIES ? String(env.WORKER_QUERIES).split('|').map((s) => s.trim()).filter(Boolean) : [
      'fleet buyers UAE',
      'equipment importers Nigeria',
    ]),
    highPriorityScore: options.highPriorityScore ?? Number(env.WORKER_HIGH_PRIORITY_SCORE || 7),
    maxResearch: options.maxResearch ?? Number(env.WORKER_MAX_RESEARCH || 20),
    maxOutreach: options.maxOutreach ?? Number(env.WORKER_MAX_OUTREACH || 20),
    followUpDays: options.followUpDays ?? Number(env.WORKER_FOLLOWUP_DAYS || 3),
  };

  function readState() {
    return loadJson(statePath, {
      last_run_id: null,
      last_completed_date_key: null,
      last_status: null,
      last_started_at: null,
      last_finished_at: null,
      current_run_id: null,
    });
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch, updated_at: nowFn().toISOString(), timezone: config.timezone };
    writeFileSync(statePath, JSON.stringify(next, null, 2));
    return next;
  }

  function readLock() {
    return loadJson(lockPath, null);
  }

  function lockStatus() {
    const lock = readLock();
    if (!lock) return { locked: false, stale: false, lock: null };
    const age = nowFn().getTime() - new Date(lock.started_at || 0).getTime();
    const alive = isPidAlive(lock.pid);
    const stale = !alive || age > config.staleLockMs;
    return { locked: !stale, stale, lock, alive };
  }

  function acquireLock(runId) {
    const status = lockStatus();
    if (status.locked) {
      return { ok: false, reason: 'lock_held', lock: status.lock };
    }
    const lock = {
      pid: process.pid,
      run_id: runId,
      started_at: nowFn().toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    const verify = readLock();
    if (!verify || verify.pid !== process.pid || verify.run_id !== runId) {
      return { ok: false, reason: 'lock_race', lock: verify };
    }
    return { ok: true, lock, recovered: status.stale ? status.lock : null };
  }

  function releaseLock(runId) {
    const lock = readLock();
    if (!lock) return;
    if (lock.pid === process.pid && (!runId || lock.run_id === runId)) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }

  function snapshot() {
    const now = nowFn();
    const state = readState();
    const lock = lockStatus();
    return {
      timezone: config.timezone,
      hour: config.hour,
      minute: config.minute,
      date_key: dateKeyInZone(now, config.timezone),
      now: now.toISOString(),
      next_run: nextRunAt(now, config).toISOString(),
      should_run: shouldRunNow(now, config, state.last_completed_date_key),
      state,
      lock,
      config,
    };
  }

  return {
    root,
    statePath,
    lockPath,
    config,
    now: nowFn,
    readState,
    writeState,
    readLock,
    lockStatus,
    acquireLock,
    releaseLock,
    snapshot,
    dateKey: (d = nowFn()) => dateKeyInZone(d, config.timezone),
    nextRunAt: (d = nowFn()) => nextRunAt(d, config),
    shouldRunNow: (d = nowFn(), completed = readState().last_completed_date_key) => shouldRunNow(d, config, completed),
  };
}
