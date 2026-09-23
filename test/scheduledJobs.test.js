import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  MIN_SCHEDULE_LEAD_MS,
  classifyScheduledJob,
  getScheduledJobMaxLateMs,
  parseScheduledAt,
} from '../server/scheduledJobs.js';

// jobs.js resolves its data directory at import time.
const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uploader-scheduled-'));
process.env.JOBS_DIR = jobsDir;
process.env.CHATWOOT_API_TOKEN = 'test-token';
process.env.CHATWOOT_URL = 'https://chatwoot.test';
process.env.SCHEDULER_TICK_MS = '300000';
const { registerJobRoutes, runSchedulerTick } = await import('../server/jobs.js');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-09-23T10:00:00.000Z');

test('parseScheduledAt accepts future timestamps with an explicit timezone', () => {
  assert.equal(parseScheduledAt('', NOW), null);
  assert.equal(parseScheduledAt(undefined, NOW), null);
  assert.equal(parseScheduledAt('2026-09-23T13:30:00+03:00', NOW), '2026-09-23T10:30:00.000Z');
  assert.equal(parseScheduledAt('2026-09-24T09:00:00.000Z', NOW), '2026-09-24T09:00:00.000Z');
});

test('parseScheduledAt rejects ambiguous, past, too-soon and far-future times', () => {
  const reject = (value, pattern) => assert.throws(() => parseScheduledAt(value, NOW), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, pattern);
    return true;
  });
  reject('2026-09-23T12:00', /timezone/);
  reject('not-a-dateZ', /not a valid date/);
  reject('2026-09-23T09:00:00.000Z', /at least 1 minute/);
  reject(new Date(NOW + MIN_SCHEDULE_LEAD_MS - 1000).toISOString(), /at least 1 minute/);
  reject('2026-12-31T00:00:00.000Z', /60 days/);
});

test('classifyScheduledJob waits, starts inside the late window, then marks missed', () => {
  const at = new Date(NOW).toISOString();
  const lateWindow = 60 * MINUTE;
  assert.equal(classifyScheduledJob(at, NOW - 1, lateWindow), 'wait');
  assert.equal(classifyScheduledJob(at, NOW, lateWindow), 'start');
  assert.equal(classifyScheduledJob(at, NOW + lateWindow, lateWindow), 'start');
  assert.equal(classifyScheduledJob(at, NOW + lateWindow + 1, lateWindow), 'missed');
  assert.equal(classifyScheduledJob('garbage', NOW, lateWindow), 'missed');
});

test('late window is configurable and falls back to 60 minutes', () => {
  assert.equal(getScheduledJobMaxLateMs({}), 60 * MINUTE);
  assert.equal(getScheduledJobMaxLateMs({ SCHEDULED_JOB_MAX_LATE_MINUTES: '15' }), 15 * MINUTE);
  assert.equal(getScheduledJobMaxLateMs({ SCHEDULED_JOB_MAX_LATE_MINUTES: '-3' }), 60 * MINUTE);
});

// --- route-level behaviour -------------------------------------------------

function createApp() {
  const routes = [];
  const add = (method) => (routePath, handler) => routes.push({ method, routePath, handler });
  return {
    routes,
    use: add('USE'),
    get: add('GET'),
    post: add('POST'),
  };
}

const app = createApp();
registerJobRoutes(app);

async function call(method, url, body) {
  const [pathname] = url.split('?');
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const middleware = app.routes.find((r) => r.method === 'USE' && pathname.startsWith(r.routePath));
  await new Promise((resolve) => middleware.handler({}, res, resolve));
  for (const route of app.routes.filter((r) => r.method === method)) {
    const names = [];
    const pattern = new RegExp(`^${route.routePath.replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+)'; })}$`);
    const match = pathname.match(pattern);
    if (!match) continue;
    const params = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
    await route.handler({ params, query: {}, body: body || {} }, res);
    return res;
  }
  throw new Error(`no route for ${method} ${url}`);
}

function stubChatwoot(t, { templates = [{ name: 'promo', language: 'ar', status: 'APPROVED', components: [] }] } = {}) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const { pathname } = new URL(url);
    requests.push(`${method} ${pathname}`);
    const reply = (status, payload) => new Response(JSON.stringify(payload), { status });
    if (method === 'GET' && /\/inboxes\/24$/.test(pathname)) return reply(200, { id: 24, message_templates: templates });
    if (method === 'GET' && pathname.endsWith('/labels')) return reply(200, { payload: [{ title: 'sept_campaign' }] });
    return reply(404, { error: 'not stubbed' });
  };
  t.after(() => { global.fetch = originalFetch; });
  return requests;
}

function sendBody(scheduledAt) {
  return {
    scheduledAt,
    rows: [{ name: 'Test', phone_number: '+966500000001' }],
    settings: {
      accountId: '2',
      labelName: 'sept_campaign',
      inboxId: '24',
      templateName: 'promo',
      templateLang: 'ar',
      messageContent: 'hello',
    },
  };
}

const inMinutes = (n) => new Date(Date.now() + n * MINUTE).toISOString();

test('a scheduled send is stored without contacting customers until it is due', async (t) => {
  const requests = stubChatwoot(t);
  const created = await call('POST', '/api/jobs/send', sendBody(inMinutes(30)));
  assert.equal(created.statusCode, 202);
  const { job } = created.body;
  assert.equal(job.status, 'scheduled');

  await runSchedulerTick(Date.now());
  const stored = (await call('GET', `/api/jobs/${job.id}`)).body.job;
  assert.equal(stored.status, 'scheduled');
  assert.ok(requests.every((r) => r.startsWith('GET ')), `only preflight reads expected, got ${requests}`);

  const cancelled = await call('POST', `/api/jobs/${job.id}/stop`);
  assert.equal(cancelled.body.job.status, 'cancelled');

  await runSchedulerTick(Date.now() + 40 * MINUTE);
  assert.equal((await call('GET', `/api/jobs/${job.id}`)).body.job.status, 'cancelled');
});

test('a due scheduled job is handed to the send queue', async (t) => {
  stubChatwoot(t);
  const { job } = (await call('POST', '/api/jobs/send', sendBody(inMinutes(5)))).body;

  await runSchedulerTick(Date.now() + 6 * MINUTE);
  // The queue runs the job immediately; with no contact routes stubbed it
  // settles quickly. Wait for a settled state instead of racing its writes.
  let settled;
  for (let i = 0; i < 100 && !settled; i++) {
    const current = (await call('GET', `/api/jobs/${job.id}`)).body.job;
    if (current && !['scheduled', 'queued', 'running'].includes(current.status)) settled = current;
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(settled, 'scheduled job should have been picked up and run');
  assert.ok(settled.startedAt, 'job should have started');

  const log = await fs.readFile(path.join(jobsDir, 'jobs', `${job.id}.log`), 'utf8');
  assert.match(log, /Scheduled time reached/);
});

test('a job whose time passed while the server was down is marked missed, not sent', async (t) => {
  stubChatwoot(t);
  const { job } = (await call('POST', '/api/jobs/send', sendBody(inMinutes(5)))).body;

  await runSchedulerTick(Date.now() + 5 * MINUTE + getScheduledJobMaxLateMs() + MINUTE);
  const missed = (await call('GET', `/api/jobs/${job.id}`)).body.job;
  assert.equal(missed.status, 'missed');
  assert.match(missed.lastError, /not sent automatically/);
});

test('scheduled jobs cannot be requeued into an immediate duplicate', async (t) => {
  stubChatwoot(t);
  const { job } = (await call('POST', '/api/jobs/send', sendBody(inMinutes(10)))).body;
  const res = await call('POST', `/api/jobs/${job.id}/requeue-remaining`);
  assert.equal(res.statusCode, 409);
  await call('POST', `/api/jobs/${job.id}/stop`);
});

test('a schedule with a broken template is rejected up front and leaves no job behind', async (t) => {
  stubChatwoot(t, { templates: [] });
  const before = await fs.readdir(path.join(jobsDir, 'jobs'));
  const res = await call('POST', '/api/jobs/send', sendBody(inMinutes(30)));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Schedule rejected by preflight: Template "promo"/);
  assert.deepEqual(await fs.readdir(path.join(jobsDir, 'jobs')), before);
});

test('a past schedule is rejected', async (t) => {
  stubChatwoot(t);
  const res = await call('POST', '/api/jobs/send', sendBody(inMinutes(-5)));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /at least 1 minute/);
});
