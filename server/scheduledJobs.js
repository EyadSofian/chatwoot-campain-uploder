// Pure scheduling rules for send jobs. The timer and file I/O live in jobs.js;
// everything here is deterministic so it can be tested without a clock.

export const MIN_SCHEDULE_LEAD_MS = 60 * 1000;
export const MAX_SCHEDULE_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LATE_MINUTES = 60;

export function getScheduledJobMaxLateMs(env = process.env) {
  const minutes = Number.parseInt(env.SCHEDULED_JOB_MAX_LATE_MINUTES, 10);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MAX_LATE_MINUTES;
  return safe * 60 * 1000;
}

// Returns null when no schedule was requested, otherwise a normalized ISO
// string. Throws a 400-style error for anything ambiguous: a campaign must
// never fire at a time the operator did not intend.
export function parseScheduledAt(value, now = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  // Require an explicit offset so the server timezone can never shift the send time.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    throw scheduleError('scheduledAt must be an ISO timestamp with a timezone, e.g. 2026-09-24T09:00:00.000Z');
  }
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) throw scheduleError(`scheduledAt "${raw}" is not a valid date`);
  if (time < now + MIN_SCHEDULE_LEAD_MS) {
    throw scheduleError('scheduledAt must be at least 1 minute in the future');
  }
  if (time > now + MAX_SCHEDULE_AHEAD_MS) {
    throw scheduleError('scheduledAt cannot be more than 60 days ahead');
  }
  return new Date(time).toISOString();
}

// wait: not due yet. start: due and inside the late window. missed: the
// server was not running at the scheduled time, so sending now would reach
// customers at an unplanned hour.
export function classifyScheduledJob(scheduledAt, now = Date.now(), maxLateMs = getScheduledJobMaxLateMs()) {
  const time = Date.parse(scheduledAt);
  if (!Number.isFinite(time)) return 'missed';
  if (time > now) return 'wait';
  return now - time <= maxLateMs ? 'start' : 'missed';
}

function scheduleError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
