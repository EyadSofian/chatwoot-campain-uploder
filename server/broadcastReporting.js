// Read-only reporting. Never starts jobs, checks delivery, or sends messages.
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const day = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }) : '';
};
const text = (value) => String(value ?? '').trim();
const count = (value) => Math.max(0, Number(value) || 0);

export function authorizedReport(header, secret) {
  const token = text(header).replace(/^Bearer\s+/i, '');
  return Boolean(secret && token && Buffer.byteLength(token) === Buffer.byteLength(secret)
    && timingSafeEqual(Buffer.from(token), Buffer.from(secret)));
}

export function projectJob(job, logs, from, to) {
  if (job?.type !== 'send') return null;
  const times = new Map();
  for (const line of logs.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      const match = /Template sent and recorded in conversation #(\d+)/.exec(entry.message || '');
      if (match && day(entry.ts)) times.set(Number(match[1]), entry.ts);
    } catch { /* A truncated log line is not evidence. */ }
  }
  const s = job.settings || {};
  const base = {
    id: text(job.id), campaign: text(s.labelName || s.attrCol || job.id),
    template: text(s.templateName), category: text(s.templateCategory).toUpperCase(),
    inboxId: text(s.inboxId), operator: text(job.operatorName || s.operatorName),
    createdAt: text(job.createdAt), status: text(job.status),
    total: count(job.total), errors: count(job.counters?.errors),
    skipped: count(job.counters?.skipped),
    checked: count(job.deliveryCheck?.checked), checkedFailed: count(job.deliveryCheck?.failed),
  };
  const events = [];
  const seen = new Set();
  for (const item of job.sentTrack || []) {
    // For old jobs without logs, finish time is a conservative upper bound,
    // never a fabricated per-message send time. Running jobs remain undated.
    const logged = times.get(Number(item.convId));
    const acceptedAt = logged || job.finishedAt || '';
    const eventDay = day(acceptedAt);
    if (!eventDay || eventDay < from || eventDay > to) continue;
    const key = text(item.msgId) || `${item.convId}:${item.row?.phone_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ jobId: base.id, messageId: text(item.msgId), conversationId: text(item.convId),
      phone: text(item.row?.phone_number), acceptedAt,
      timeBasis: logged ? 'send_log' : 'job_finished_upper_bound', date: eventDay });
  }
  // No recipient names, CSV columns, message content, settings, or credentials.
  return events.length || (day(job.createdAt) >= from && day(job.createdAt) <= to)
    ? { ...base, accepted: events.length, events } : null;
}

export function registerBroadcastReporting(app, options = {}) {
  const directory = options.directory || path.join(process.env.JOBS_DIR || path.join(process.cwd(), 'data'), 'jobs');
  const cache = new Map();
  app.get('/api/reporting/broadcast', async (req, res) => {
    if (!authorizedReport(req.headers.authorization, options.token ?? process.env.CHATWOOT_API_TOKEN))
      return res.status(401).json({ error: 'Reporting credential required' });
    const { from, to } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')
      || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from > to
      || Date.parse(to) - Date.parse(from) > 366 * 86400000)
      return res.status(400).json({ error: 'Choose a valid period of up to 366 days' });
    const key = `${from}:${to}`;
    try {
      if (!cache.has(key) || Date.now() - cache.get(key).at > 60000) {
        if (cache.size >= 5) cache.delete(cache.keys().next().value);
        const pending = (async () => {
          const rows = [];
          let unreadable = 0;
          const files = (await fs.readdir(directory)).filter(f => f.endsWith('.json') && !f.endsWith('-input.json'));
          for (const file of files) {
            try {
              const job = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
              if (job.type !== 'send') continue;
              if (day(job.updatedAt || job.finishedAt) < from || day(job.startedAt || job.createdAt) > to) continue;
              const log = await fs.readFile(path.join(directory, file.replace(/\.json$/, '.log')), 'utf8').catch(() => '');
              const row = projectJob(job, log, from, to);
              if (row) rows.push(row);
            } catch { unreadable++; }
          }
          return { jobs: rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), unreadable, scanned: files.length };
        })();
        cache.set(key, { at: Date.now(), pending });
        pending.catch(() => cache.delete(key));
      }
      const snapshot = await cache.get(key).pending;
      const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
      const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 50)));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ from, to, timezone: 'Asia/Riyadh', fetchedAt: new Date().toISOString(),
        total: snapshot.jobs.length, scanned: snapshot.scanned, unreadable: snapshot.unreadable,
        offset, limit, jobs: snapshot.jobs.slice(offset, offset + limit),
        countersScope: 'whole_job', acceptedMeaning: 'accepted_by_chatwoot_not_verified_delivery' });
    } catch { return res.status(503).json({ error: 'Campaign reporting store unavailable' }); }
  });
}
