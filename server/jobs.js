import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.JOBS_DIR || path.join(process.cwd(), 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const PERMANENT_WA_ERRORS = new Set([
  131047, 131048, 131049, 131051, 131052, 131053,
  132000, 132001, 132005, 132007, 132012, 132015, 132016,
  133000, 133004, 133005, 133006, 133008, 133009, 133010,
]);
const RETRYABLE_WA_ERRORS = new Set([131026]);

const activeJobs = new Map();
const queueChains = new Map();
const maxParallelQueues = clampInt(process.env.MAX_PARALLEL_JOB_QUEUES || 3, 1, 8);
const globalQueueLimiter = createLimiter(maxParallelQueues);

export function registerJobRoutes(app) {
  app.use('/api/jobs', async (_req, res, next) => {
    try {
      await ensureStore();
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs', async (_req, res) => {
    const jobs = await listJobs();
    res.json({ jobs });
  });

  app.get('/api/jobs/latest', async (_req, res) => {
    const jobs = await listJobs();
    res.json({ job: jobs[0] || null });
  });

  app.get('/api/jobs/:id', async (req, res) => {
    const job = await readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  });

  app.get('/api/jobs/:id/logs', async (req, res) => {
    const logPath = getJobLogPath(req.params.id);
    const since = Math.max(0, Number(req.query.since || 0));
    try {
      const raw = await fs.readFile(logPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      res.json({ offset: lines.length, lines: lines.slice(since) });
    } catch {
      res.json({ offset: 0, lines: [] });
    }
  });

  app.get('/api/jobs/:id/failed.csv', async (req, res) => {
    const filePath = getJobFailedPath(req.params.id);
    try {
      try {
        await fs.access(filePath);
      } catch {
        const job = await readJob(req.params.id);
        if (job?.failedRecords?.length) {
          await writeFailedCsv(job);
          await fs.access(filePath);
        } else {
          throw new Error('No failed CSV for this job');
        }
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="failed-${req.params.id}.csv"`);
      createReadStream(filePath).pipe(res);
    } catch {
      res.status(404).json({ error: 'No failed CSV for this job' });
    }
  });

  app.post('/api/jobs/:id/stop', async (req, res) => {
    const job = await readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const active = activeJobs.get(req.params.id);
    if (active) active.stopRequested = true;
    job.stopRequested = true;
    if (job.status === 'queued') job.status = 'stopped';
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    res.json({ ok: true, job });
  });

  app.post('/api/jobs/:id/check-delivery', async (req, res) => {
    try {
      const job = await readJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.type !== 'send') return res.status(400).json({ error: 'Only send jobs can be checked' });
      const config = buildConfig(req.body?.settings || {});
      if (!config.token) return res.status(400).json({ error: 'Chatwoot API token is required' });
      const result = await checkJobDelivery(job, config);
      await writeFailedCsv(job);
      await writeJob(job);
      res.json({ ok: true, result, job });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/:id/retry-failed', async (req, res) => {
    try {
      const job = await readJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.type !== 'send') return res.status(400).json({ error: 'Only send jobs can retry failed messages' });
      const config = buildConfig(req.body?.settings || {});
      if (!config.token) return res.status(400).json({ error: 'Chatwoot API token is required' });
      const result = await retryJobDeliveryFailures(job, config);
      await writeFailedCsv(job);
      await writeJob(job);
      res.json({ ok: true, result, job });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/upload', async (req, res) => {
    try {
      const created = await createJob('upload', req.body);
      res.status(202).json({ job: created.publicJob });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/send', async (req, res) => {
    try {
      const created = await createJob('send', req.body);
      res.status(202).json({ job: created.publicJob });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}

async function ensureStore() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

async function createJob(type, body = {}) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) {
    const err = new Error('rows are required');
    err.status = 400;
    throw err;
  }

  const config = buildConfig(body.settings || {});
  if (!config.token) {
    const err = new Error('Chatwoot API token is required');
    err.status = 400;
    throw err;
  }
  const settings = normalizeSettings(body.settings || {});
  const queueInfo = getQueueInfo(type, settings, config);

  const job = {
    id: randomUUID(),
    type,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    total: rows.length,
    processed: 0,
    counters: {
      new: 0,
      updated: 0,
      failed: 0,
      sent: 0,
      skipped: 0,
      errors: 0,
    },
    queueKey: queueInfo.key,
    queueLabel: queueInfo.label,
    operatorName: settings.operatorName,
    settings: sanitizeSettings(body.settings || {}),
    stopRequested: false,
    lastError: '',
    sentTrack: [],
    failedRecords: [],
  };

  await writeJob(job);
  await clearJobFiles(job.id);
  await logJob(job, `Job queued: ${type} (${rows.length} rows) — ${queueInfo.label}`, 'info');
  if (settings.operatorName) await logJob(job, `Operator: ${settings.operatorName}`, 'info');

  const runtime = { config, rows, settings, stopRequested: false, queueKey: queueInfo.key };
  activeJobs.set(job.id, runtime);
  enqueueJob(job.id, queueInfo.key);

  return { publicJob: job };
}

async function runJob(jobId) {
  const runtime = activeJobs.get(jobId);
  const job = await readJob(jobId);
  if (!runtime || !job || job.stopRequested) return;

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.updatedAt = job.startedAt;
  await writeJob(job);
  await logJob(job, `Job started in ${job.queueLabel || runtime.queueKey || 'default queue'}; max parallel queues=${maxParallelQueues}`, 'info');

  try {
    if (job.type === 'upload') await runUploadJob(job, runtime);
    else if (job.type === 'send') await runSendJob(job, runtime);
    else throw new Error(`Unknown job type: ${job.type}`);

    if (runtime.stopRequested || job.stopRequested) {
      job.status = 'stopped';
      await logJob(job, 'Job stopped by user', 'warn');
    } else if (job.counters.failed || job.counters.errors) {
      job.status = 'completed_with_errors';
      await logJob(job, 'Job completed with errors', 'warn');
    } else {
      job.status = 'completed';
      await logJob(job, 'Job completed successfully', 'ok');
    }
  } catch (err) {
    job.status = 'failed';
    job.lastError = err.message;
    await logJob(job, `Job failed: ${err.message}`, 'error');
  } finally {
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await writeFailedCsv(job);
    await writeJob(job);
    activeJobs.delete(jobId);
  }
}

async function runUploadJob(job, runtime) {
  const { rows, settings } = runtime;
  const labelName = settings.labelName;
  const attrCol = settings.attrCol;
  const batchSize = Math.max(1, Math.min(Number(settings.uploadBatchSize || 10), 50));
  const batchDelay = Math.max(0, Number(settings.uploadBatchDelayMs ?? 500));

  if (!labelName) throw new Error('Label name is required');
  if (attrCol) ensureColumnExists(rows, attrCol, 'Custom attribute column');

  await logJob(job, `Upload started: ${rows.length} contacts, batch=${batchSize}, delay=${batchDelay}ms`, 'info');
  await ensureLabel(job, runtime.config, labelName);

  for (let i = 0; i < rows.length; i += batchSize) {
    if (runtime.stopRequested || job.stopRequested) break;
    const batch = rows.slice(i, i + batchSize);
    const batchNo = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(rows.length / batchSize);
    await logJob(job, `Batch ${batchNo}/${totalBatches}: ${batch.length} contacts`, 'info');

    const results = await Promise.allSettled(batch.map((row) => processContact(job, runtime, row)));
    for (const [index, result] of results.entries()) {
      const row = batch[index] || {};
      const name = row.name || row.phone_number || `row ${i + index + 1}`;
      job.processed++;
      if (result.status === 'fulfilled') {
        incrementUploadCounter(job, result.value.status);
      } else {
        const message = result.reason?.message || 'Unknown upload error';
        const code = extractHttpStatusCode(message) || extractWhatsAppErrorCode(message);
        job.counters.failed++;
        recordFailure(job, row, code, message, false);
        await logJob(job, `Upload failed: ${name} — ${message}`, 'error');
      }
    }
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    if (i + batchSize < rows.length && batchDelay) await sleep(batchDelay);
  }
}

async function runSendJob(job, runtime) {
  const { rows, settings } = runtime;
  const labelName = settings.labelName;
  const attrCol = settings.attrCol;
  const inboxId = settings.inboxId;
  const templateName = settings.templateName;
  const rate = Math.max(1, Math.min(Number(settings.sendRateLimit || 60), 100));
  const sendDelay = Math.ceil(60000 / rate);
  const campaignKey = `api_sent_${safeKey(labelName)}_${safeKey(templateName)}`;

  if (!labelName) throw new Error('Label name is required');
  if (!inboxId) throw new Error('WhatsApp inbox is required');
  if (!templateName) throw new Error('Template name is required');
  if (attrCol) ensureColumnExists(rows, attrCol, 'Custom attribute column');
  assertTemplateMappings(rows, settings);

  await logJob(job, `Send started: ${rows.length} contacts, rate=${rate}/min, delay=${sendDelay}ms`, 'info');
  await logJob(job, `Duplicate key: ${campaignKey}`, 'info');

  for (let i = 0; i < rows.length; i++) {
    if (runtime.stopRequested || job.stopRequested) break;
    const row = rows[i];
    const name = row.name || row.phone_number || `row ${i + 1}`;
    await logJob(job, `Sending ${i + 1}/${rows.length}: ${name}`, 'info');
    try {
      const result = await sendTemplateForRowWithRetry(job, runtime, row, campaignKey);
      job.processed++;
      if (result.status === 'sent') {
        job.counters.sent++;
        if (result.convId) job.sentTrack.push({ row, convId: result.convId, msgId: result.msgId });
      } else if (result.status === 'skipped') {
        job.counters.skipped++;
      } else {
        job.counters.errors++;
      }
    } catch (err) {
      const code = extractWhatsAppErrorCode(err.message);
      job.processed++;
      job.counters.errors++;
      recordFailure(job, row, code, err.message, false);
      await logJob(job, `${name} failed: ${err.message}`, 'error');
    }
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    if (i + 1 < rows.length && sendDelay) await sleep(sendDelay);
  }
}

function buildConfig(settings) {
  return {
    baseUrl: String(settings.chatwootUrl || process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, ''),
    accountId: String(settings.accountId || process.env.CHATWOOT_ACCOUNT_ID || '2'),
    token: String(settings.apiToken || process.env.CHATWOOT_API_TOKEN || '').trim(),
  };
}

function normalizeSettings(settings) {
  return {
    labelName: normalizeLabelTitle(settings.labelName || ''),
    originalLabelName: String(settings.labelName || '').trim(),
    attrCol: String(settings.attrCol || '').trim(),
    createNew: settings.createNew !== false,
    forceUpdate: Boolean(settings.forceUpdate),
    uploadBatchSize: Number(settings.uploadBatchSize || 10),
    uploadBatchDelayMs: Number(settings.uploadBatchDelayMs ?? 500),
    inboxId: String(settings.inboxId || '').trim(),
    templateName: String(settings.templateName || '').trim(),
    templateLang: String(settings.templateLang || 'ar').trim(),
    templateCategory: String(settings.templateCategory || 'MARKETING').trim(),
    bodyParams: String(settings.bodyParams || ''),
    messageContent: String(settings.messageContent || ''),
    normalizeVars: settings.normalizeVars !== false,
    headerMediaUrl: String(settings.headerMediaUrl || '').trim(),
    headerMediaType: String(settings.headerMediaType || '').trim(),
    sourceMode: String(settings.sourceMode || 'phone'),
    sourceColumn: String(settings.sourceColumn || '').trim(),
    postSendConversationStatus: normalizeConversationStatus(settings.postSendConversationStatus),
    duplicateGuard: settings.duplicateGuard !== false,
    sendRateLimit: Number(settings.sendRateLimit || 60),
    autoAssign: Boolean(settings.autoAssign),
    assignmentMode: String(settings.assignmentMode || 'by_csv'),
    assignmentTargetType: String(settings.assignmentTargetType || 'agent'),
    assignmentValueColumn: String(settings.assignmentValueColumn || settings.attrCol || '').trim(),
    fixedTargetId: String(settings.fixedTargetId || '').trim(),
    assignmentMap: settings.assignmentMap && typeof settings.assignmentMap === 'object' ? settings.assignmentMap : {},
    operatorName: String(settings.operatorName || '').trim().slice(0, 80),
  };
}

function normalizeConversationStatus(value) {
  const status = String(value || 'open').trim().toLowerCase();
  return ['open', 'pending', 'resolved'].includes(status) ? status : 'open';
}

function sanitizeSettings(settings) {
  const sanitized = normalizeSettings(settings);
  sanitized.chatwootUrl = String(settings.chatwootUrl || process.env.CHATWOOT_URL || '').replace(/\/$/, '');
  sanitized.accountId = String(settings.accountId || process.env.CHATWOOT_ACCOUNT_ID || '2');
  sanitized.apiToken = settings.apiToken ? '***from-ui***' : (process.env.CHATWOOT_API_TOKEN ? '***from-env***' : '');
  return sanitized;
}

async function cwFetch(job, config, pathName, method = 'GET', body, retries = 3) {
  const url = `${config.baseUrl}${pathName}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          api_access_token: config.token,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      const data = text ? tryJson(text) : {};
      if (TRANSIENT_STATUS.has(res.status) && attempt < retries) {
        const wait = retryDelay(attempt, res.status);
        await logJob(job, `HTTP ${res.status} on ${method} ${pathName}; retry in ${wait}ms`, 'warn');
        await sleep(wait);
        continue;
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        const wait = retryDelay(attempt, 0);
        await logJob(job, `Network error on ${method} ${pathName}: ${err.message}; retry in ${wait}ms`, 'warn');
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function retryDelay(attempt, status) {
  const base = status === 429 ? 2500 : 1500;
  const jitter = Math.floor(Math.random() * 600);
  return base * (attempt + 1) + jitter;
}

async function ensureLabel(job, config, label) {
  if (!label) throw new Error('Label name is empty after sanitizing');
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/labels`, 'GET');
  const labels = r.ok ? (r.data.payload || []) : [];
  if (labels.find((item) => item.title === label)) {
    await logJob(job, `Label exists: ${label}`, 'info');
    return true;
  }
  const cr = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/labels`, 'POST', {
    title: label,
    color: '#1f93ff',
    show_on_sidebar: true,
  });
  if (cr.ok) {
    await logJob(job, `Label created: ${label}`, 'ok');
    return true;
  }
  const msg = String(cr.data?.message || '').toLowerCase();
  if (cr.status === 422 && msg.includes('title has already been taken')) {
    await logJob(job, `Label already exists: ${label}`, 'info');
    return true;
  }
  throw new Error(`Failed to create label ${label}: HTTP ${cr.status} ${JSON.stringify(cr.data)}`);
}

async function processContact(job, runtime, row) {
  const result = await upsertContact(job, runtime, row, runtime.settings.attrCol);
  if (!result) throw new Error(`${row.name || row.phone_number} was not found/created`);
  const labeled = await assignLabel(job, runtime.config, result.id, runtime.settings.labelName, row.name || row.phone_number, result.isNew, result.existingLabels);
  if (!labeled) throw new Error(`${row.name || row.phone_number} label assignment failed`);
  await logJob(job, `${result.isNew ? 'Created' : 'Updated'} contact: ${row.name || row.phone_number} (#${result.id})`, result.isNew ? 'ok' : 'info');
  return { status: result.isNew ? 'new' : 'updated', id: result.id };
}

async function upsertContact(job, runtime, row, attrKey) {
  const { config, settings } = runtime;
  if (hasUnsafePhoneFormat(row.phone_number)) throw new Error(`Unsafe phone format: ${row.phone_number}`);
  const phone = String(row.phone_number || '').replace(/\s/g, '');
  if (!phone) throw new Error('phone_number is required');
  const name = row.name || phone;
  const attrVal = attrKey ? row[attrKey] : null;
  const hasAttr = Boolean(attrKey && attrVal);
  const contact = await findContactByPhone(job, config, phone);

  if (contact) {
    if (hasAttr) {
      const currentVal = contact.custom_attributes?.[attrKey];
      if (currentVal !== attrVal || settings.forceUpdate) {
        await applyCustomAttr(job, config, contact.id, attrKey, attrVal, name, contact.custom_attributes);
      }
    }
    return { id: contact.id, isNew: false, existingLabels: contact.labels || [] };
  }

  if (!settings.createNew) return null;
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts`, 'POST', { name, phone_number: phone });
  if (r.ok) {
    const id = extractId(r.data);
    if (!id) throw new Error(`Contact created but id was not found: ${JSON.stringify(r.data)}`);
    if (hasAttr) await applyCustomAttr(job, config, id, attrKey, attrVal, name);
    return { id, isNew: true, existingLabels: [] };
  }

  if (r.status === 422) {
    const existingId = extractId(r.data);
    if (existingId) {
      if (hasAttr) await applyCustomAttr(job, config, existingId, attrKey, attrVal, name);
      return { id: existingId, isNew: false, existingLabels: [] };
    }
    const fallback = await findContactByPhone(job, config, phone);
    if (fallback) {
      if (hasAttr) await applyCustomAttr(job, config, fallback.id, attrKey, attrVal, name, fallback.custom_attributes);
      return { id: fallback.id, isNew: false, existingLabels: fallback.labels || [] };
    }
  }

  throw new Error(`Failed to create contact ${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
}

async function findContactByPhone(job, config, phone) {
  const norm = normPhone(phone);
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/search?q=${encodeURIComponent(norm)}&page=1`, 'GET');
  if (r.ok) {
    const contacts = r.data.payload || [];
    const match = contacts.find((contact) => normPhone(contact.phone_number) === norm);
    if (match) return match;
  }
  if (phone && phone !== norm) {
    const r2 = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/search?q=${encodeURIComponent(phone)}&page=1`, 'GET');
    if (r2.ok) {
      const contacts = r2.data.payload || [];
      return contacts.find((contact) => normPhone(contact.phone_number) === norm) || null;
    }
  }
  return null;
}

async function applyCustomAttr(job, config, contactId, attrKey, attrVal, name, existing = null) {
  const merged = { ...(existing || {}), [attrKey]: attrVal };
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/${contactId}`, 'PATCH', { custom_attributes: merged });
  if (!r.ok) throw new Error(`Custom attribute failed for ${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return true;
}

async function assignLabel(job, config, contactId, label, name, isNew = false, existingLabels = null) {
  let existing = existingLabels || [];
  if (!isNew && existingLabels === null) {
    const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/${contactId}/labels`, 'GET');
    if (r.ok && Array.isArray(r.data.payload)) existing = r.data.payload;
  }
  if (existing.includes(label)) return true;
  const updated = [...existing, label];
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/${contactId}/labels`, 'POST', { labels: updated });
  if (!r.ok) throw new Error(`Label assignment failed for ${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return true;
}

async function sendTemplateForRowWithRetry(job, runtime, row, campaignKey) {
  try {
    return await sendTemplateForRow(job, runtime, row, campaignKey);
  } catch (err) {
    const code = extractWhatsAppErrorCode(err.message);
    if (PERMANENT_WA_ERRORS.has(code)) {
      recordFailure(job, row, code, err.message, false);
      await logJob(job, `Permanent WhatsApp error ${code}: ${row.name || row.phone_number}`, 'error');
      return { status: 'error' };
    }
    if (!RETRYABLE_WA_ERRORS.has(code)) {
      recordFailure(job, row, code, err.message, false);
      return { status: 'error' };
    }
    await logJob(job, `Retryable WhatsApp error ${code}; waiting 10s`, 'warn');
    await sleep(10000);
    try {
      return await sendTemplateForRow(job, runtime, row, campaignKey);
    } catch (retryErr) {
      const retryCode = extractWhatsAppErrorCode(retryErr.message) || code;
      recordFailure(job, row, retryCode, retryErr.message, true);
      return { status: 'error' };
    }
  }
}

async function sendTemplateForRow(job, runtime, row, campaignKey) {
  const { config, settings } = runtime;
  const result = await upsertContact(job, runtime, row, settings.attrCol);
  if (!result) throw new Error('Contact was not found/created');
  await assignLabel(job, config, result.id, settings.labelName, row.name || row.phone_number, result.isNew, result.existingLabels);

  const conv = await ensureCampaignConversation(job, runtime, result.id, row);
  const details = await getConversationDetails(job, config, conv.id);
  const attrs = details?.custom_attributes || conv.custom_attributes || {};

  if (settings.duplicateGuard && attrs[campaignKey]) {
    await logJob(job, `Skipped duplicate campaign on conversation #${conv.id}`, 'warn');
    await assignConversation(job, runtime, conv.id, row);
    return { status: 'skipped', convId: conv.id };
  }

  const payload = buildTemplatePayload(row, settings);
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/conversations/${conv.id}/messages`, 'POST', payload, 3);
  if (!r.ok) throw new Error(`Template send failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);

  const externalError = r.data?.content_attributes?.external_error || r.data?.external_error || r.data?.message_status_error;
  if (r.data?.status === 'failed' || externalError) {
    throw new Error(`Delivery failed: ${JSON.stringify(externalError || r.data)}`);
  }

  await markCampaignSent(job, config, conv.id, attrs, campaignKey, settings.labelName, settings.templateName);
  await assignConversation(job, runtime, conv.id, row);
  await applyPostSendConversationStatus(job, runtime, conv.id, details?.status || conv.status);
  await logJob(job, `Template sent and recorded in conversation #${conv.id}`, 'ok');
  return { status: 'sent', convId: conv.id, msgId: r.data?.id };
}

async function ensureCampaignConversation(job, runtime, contactId, row) {
  const { config, settings } = runtime;
  const convs = await getContactConversations(job, config, contactId);
  const sameInbox = convs
    .filter((conv) => String(getConversationInboxId(conv)) === String(settings.inboxId))
    .sort((a, b) => conversationSortTime(b) - conversationSortTime(a));
  if (sameInbox[0]) return sameInbox[0];

  const sourceId = await ensureContactInbox(job, runtime, contactId, row);
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/conversations`, 'POST', {
    source_id: sourceId,
    inbox_id: Number(settings.inboxId),
    contact_id: contactId,
    status: 'open',
    custom_attributes: {
      api_campaign_label: settings.labelName,
      api_campaign_created_at: new Date().toISOString(),
    },
  });
  if (!r.ok) throw new Error(`Conversation create failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  const conv = r.data.payload || r.data;
  await logJob(job, `Created conversation #${conv.id}`, 'ok');
  return conv;
}

async function ensureContactInbox(job, runtime, contactId, row) {
  const { config, settings } = runtime;
  let details = await getContactDetails(job, config, contactId);
  let sourceId = getInboxSourceId(details, settings.inboxId);
  if (sourceId) return sourceId;

  sourceId = buildSourceId(row, settings);
  if (!sourceId) throw new Error('Cannot determine WhatsApp source_id');
  if (!/^\d{1,15}$/.test(String(sourceId))) {
    throw new Error(`Invalid WhatsApp source_id "${sourceId}". It must be digits only, 1-15 chars.`);
  }

  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/${contactId}/contact_inboxes`, 'POST', {
    inbox_id: Number(settings.inboxId),
    source_id: sourceId,
  });
  if (r.ok) return sourceId;
  if (r.status === 422) {
    details = await getContactDetails(job, config, contactId);
    sourceId = getInboxSourceId(details, settings.inboxId);
    if (sourceId) return sourceId;
  }
  throw new Error(`contact_inbox create failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
}

async function getContactDetails(job, config, contactId) {
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/${contactId}`, 'GET');
  return r.ok ? (r.data.payload || r.data) : null;
}

async function getContactConversations(job, config, contactId) {
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/contacts/${contactId}/conversations`, 'GET');
  return r.ok ? (r.data.payload || []) : [];
}

async function getConversationDetails(job, config, conversationId) {
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/conversations/${conversationId}`, 'GET');
  return r.ok ? (r.data.payload || r.data) : null;
}

async function markCampaignSent(job, config, conversationId, attrs, campaignKey, labelName, templateName) {
  const merged = {
    ...(attrs || {}),
    [campaignKey]: new Date().toISOString(),
    last_api_campaign_label: labelName,
    last_api_template: templateName,
  };
  await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/custom_attributes`, 'POST', {
    custom_attributes: merged,
  });
}

async function applyPostSendConversationStatus(job, runtime, conversationId, currentStatus = '') {
  const { config, settings } = runtime;
  const status = settings.postSendConversationStatus || 'open';
  if (!conversationId || !status) return true;
  if (String(currentStatus || '').toLowerCase() === status) {
    await logJob(job, `Conversation #${conversationId} already ${status}`, 'info');
    return true;
  }

  const r = await cwFetch(
    job,
    config,
    `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/toggle_status`,
    'POST',
    { status },
    2
  );

  if (r.ok) {
    await logJob(job, `Conversation #${conversationId} status set to ${status}`, 'ok');
    return true;
  }

  await logJob(job, `Conversation status change failed for #${conversationId}: HTTP ${r.status} ${JSON.stringify(r.data)}`, 'warn');
  return false;
}

async function assignConversation(job, runtime, conversationId, row) {
  const { config, settings } = runtime;
  if (!settings.autoAssign) return true;
  const targetId = resolveAssignmentTarget(row, settings);
  if (!targetId) {
    await logJob(job, `No assignment target for ${row.name || row.phone_number}`, 'warn');
    return false;
  }
  const body = settings.assignmentTargetType === 'team'
    ? { team_id: Number(targetId) }
    : { assignee_id: Number(targetId) };
  const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/assignments`, 'POST', body);
  if (!r.ok) {
    await logJob(job, `Assignment failed for conversation #${conversationId}: HTTP ${r.status} ${JSON.stringify(r.data)}`, 'warn');
    return false;
  }
  return true;
}

async function checkJobDelivery(job, config) {
  const sent = Array.isArray(job.sentTrack) ? job.sentTrack : [];
  if (!sent.length) {
    return { checked: 0, confirmed: 0, failed: 0 };
  }
  await logJob(job, `Delivery check started for ${sent.length} sent messages`, 'info');
  let checked = 0;
  let confirmed = 0;
  let failed = 0;
  job.deliveryFailures = [];

  for (const item of sent) {
    checked++;
    const row = item.row || {};
    try {
      const r = await cwFetch(job, config, `/api/v1/accounts/${config.accountId}/conversations/${item.convId}/messages`, 'GET', undefined, 2);
      if (!r.ok) {
        await logJob(job, `Delivery check failed for conversation #${item.convId}: HTTP ${r.status}`, 'warn');
        continue;
      }
      const messages = r.data?.payload || [];
      const msg = item.msgId
        ? messages.find((message) => Number(message.id) === Number(item.msgId))
        : [...messages].reverse().find((message) => message.message_type === 1);
      if (!msg) {
        await logJob(job, `Delivery message not found in conversation #${item.convId}`, 'warn');
        continue;
      }
      if (msg.status === 'failed') {
        const externalErr = msg.content_attributes?.external_error || msg.external_error || msg.message_status_error || msg;
        const code = extractWhatsAppErrorCode(JSON.stringify(externalErr));
        if (!job.failedRecords.some((record) => String(record.phone) === String(row.phone_number || '') && String(record.raw_error).includes(String(item.msgId || item.convId)))) {
          recordFailure(job, row, code, `async delivery failed msg=${item.msgId || ''} conv=${item.convId}: ${JSON.stringify(externalErr)}`, false);
        }
        if (!PERMANENT_WA_ERRORS.has(code) && item.msgId) {
          job.deliveryFailures.push({
            row,
            convId: item.convId,
            msgId: item.msgId,
            code,
          });
        }
        failed++;
        await logJob(job, `Async delivery failed: ${row.name || row.phone_number || item.convId} — ${JSON.stringify(externalErr)}`, 'error');
      } else {
        confirmed++;
      }
    } catch (err) {
      await logJob(job, `Delivery check error for conversation #${item.convId}: ${err.message}`, 'warn');
    }
    if (checked < sent.length) await sleep(200);
  }

  job.deliveryCheck = {
    checked,
    confirmed,
    failed,
    checkedAt: new Date().toISOString(),
    retryable: job.deliveryFailures.length,
  };
  if (failed) job.status = job.status === 'completed' ? 'completed_with_errors' : job.status;
  job.updatedAt = new Date().toISOString();
  await logJob(job, `Delivery check finished: ${confirmed} confirmed, ${failed} failed`, failed ? 'warn' : 'ok');
  return job.deliveryCheck;
}

async function retryJobDeliveryFailures(job, config) {
  const failures = Array.isArray(job.deliveryFailures) ? job.deliveryFailures : [];
  if (!failures.length) return { retried: 0, success: 0, failed: 0 };

  const sentTotal = Array.isArray(job.sentTrack) ? job.sentTrack.length : 0;
  const failureRate = sentTotal ? failures.length / sentTotal : 0;
  if (failureRate > 0.9) {
    const err = new Error(`Failure rate is too high (${Math.round(failureRate * 100)}%). Review template/inbox before retrying.`);
    err.status = 409;
    throw err;
  }

  await logJob(job, `Retry failed delivery started for ${failures.length} messages`, 'warn');
  const remaining = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < failures.length; i++) {
    const item = failures[i];
    const row = item.row || {};
    if (i > 0) await sleep(10000);
    try {
      const r = await cwFetch(
        job,
        config,
        `/api/v1/accounts/${config.accountId}/conversations/${item.convId}/messages/${item.msgId}/retry`,
        'POST',
        undefined,
        2
      );
      if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.data)}`);
      success++;
      await logJob(job, `Retry sent: ${row.name || row.phone_number || item.convId} — message #${item.msgId}`, 'ok');
    } catch (err) {
      failed++;
      remaining.push(item);
      recordFailure(job, row, item.code, `retry failed msg=${item.msgId} conv=${item.convId}: ${err.message}`, true);
      await logJob(job, `Retry failed: ${row.name || row.phone_number || item.convId} — ${err.message}`, 'error');
    }
  }

  job.deliveryFailures = remaining;
  job.lastRetry = {
    retried: failures.length,
    success,
    failed,
    retriedAt: new Date().toISOString(),
  };
  job.updatedAt = new Date().toISOString();
  await logJob(job, `Retry finished: ${success} success, ${failed} failed`, failed ? 'warn' : 'ok');
  return job.lastRetry;
}

function resolveAssignmentTarget(row, settings) {
  if (settings.assignmentMode === 'fixed_agent') return settings.fixedTargetId;
  const value = String(row[settings.assignmentValueColumn] || row[settings.attrCol] || '').trim();
  return settings.assignmentMap[value] || '';
}

function buildTemplatePayload(row, settings) {
  const body = buildBodyParams(row, settings);
  const processed = {};
  if (Object.keys(body).length) processed.body = body;
  if (settings.headerMediaUrl && settings.headerMediaType) {
    processed.header = { media_url: settings.headerMediaUrl, media_type: settings.headerMediaType };
  }
  return {
    content: renderMessageContent(row, settings),
    message_type: 'outgoing',
    private: false,
    content_type: 'text',
    content_attributes: {},
    template_params: {
      name: settings.templateName,
      category: settings.templateCategory,
      language: settings.templateLang,
      processed_params: processed,
    },
  };
}

function parseParamMap(text) {
  const params = {};
  let lastKey = null;
  String(text || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (lastKey) params[lastKey] += '\n';
      return;
    }
    if (trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      if (lastKey) params[lastKey] += `\n${trimmed}`;
      return;
    }
    const key = normalizeTemplateVariableKey(trimmed.slice(0, eq));
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) {
      params[key] = value;
      lastKey = key;
    }
  });
  return params;
}

function buildBodyParams(row, settings) {
  const mapping = parseParamMap(settings.bodyParams);
  const body = {};
  Object.keys(mapping).forEach((key) => {
    const raw = resolveMappedValue(row, mapping[key]);
    body[key] = settings.normalizeVars ? normalizeForWhatsApp(raw) : raw;
  });
  return body;
}

function renderMessageContent(row, settings) {
  let content = String(settings.messageContent || '').trim();
  const body = buildBodyParams(row, settings);
  Object.keys(body).forEach((key) => {
    content = content.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'g'), body[key]);
  });
  return content || `WhatsApp template: ${settings.templateName}`;
}

function assertTemplateMappings(rows, settings) {
  const variables = extractTemplateVariables(settings.messageContent).map(normalizeTemplateVariableKey);
  if (!variables.length) return true;
  const mapping = parseParamMap(settings.bodyParams);
  const missingKeys = variables.filter((variable) => !Object.prototype.hasOwnProperty.call(mapping, variable));
  if (missingKeys.length) throw new Error(`Missing template variable mapping: ${missingKeys.join(', ')}`);
  const badRow = rows.find((row) => variables.some((variable) => !String(resolveMappedValue(row, mapping[variable]) || '').trim()));
  if (badRow) throw new Error(`Empty template variable value in row: ${badRow.name || badRow.phone_number}`);
  return true;
}

function extractTemplateVariables(text) {
  const matches = String(text || '').match(/\{\{\s*[^}]+\s*\}\}/g) || [];
  return [...new Set(matches.map((item) => item.replace(/[{}]/g, '').trim()))];
}

function normalizeTemplateVariableKey(value) {
  return String(value || '').trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
}

function resolveMappedValue(row, token) {
  const clean = String(token || '').trim();
  if (!clean) return '';
  if (Object.prototype.hasOwnProperty.call(row, clean)) return row[clean] || '';
  const wrapped = clean.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (wrapped && Object.prototype.hasOwnProperty.call(row, wrapped[1])) return row[wrapped[1]] || '';
  return clean;
}

function normalizeForWhatsApp(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/\n{2,}/g, ' - ');
  s = s.replace(/\n/g, ' ');
  s = s.replace(/\t/g, ' ');
  s = s.replace(/[ ]{2,}/g, ' ');
  s = s.trim();
  if (s.length > 1024) s = `${s.slice(0, 1021)}...`;
  return s;
}

function buildSourceId(row, settings) {
  const phone = String(row.phone_number || '').replace(/\s/g, '');
  let raw = phone;
  if (settings.sourceMode === 'column') {
    raw = settings.sourceColumn ? String(row[settings.sourceColumn] || '').trim() : '';
  }
  return normPhone(raw);
}

function getInboxSourceId(contact, inboxId) {
  const inboxes = contact?.contact_inboxes || [];
  const match = inboxes.find((item) => String(item.inbox?.id) === String(inboxId));
  return match?.source_id || '';
}

function getConversationInboxId(conversation) {
  return conversation?.inbox_id
      ?? conversation?.inboxId
      ?? conversation?.inbox?.id
      ?? conversation?.meta?.inbox_id
      ?? conversation?.meta?.inbox?.id
      ?? conversation?.additional_attributes?.inbox_id
      ?? null;
}

function conversationSortTime(conversation) {
  const value = conversation?.last_activity_at || conversation?.updated_at || conversation?.created_at || 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function extractWhatsAppErrorCode(errorMsg) {
  const s = String(errorMsg || '');
  const patterns = [/"code"\s*:\s*(\d{6})/, /"error_code"\s*:\s*"?(\d{6})"?/, /\b(13[0-9]{4})\b/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractHttpStatusCode(errorMsg) {
  const match = String(errorMsg || '').match(/\bHTTP\s+(\d{3})\b/i);
  return match ? `HTTP ${match[1]}` : '';
}

function recordFailure(job, row, code, rawMessage, retryAttempted) {
  job.failedRecords.push({
    phone: row.phone_number || '',
    name: row.name || '',
    error_code: code || '',
    error_description: describeFailureCode(code),
    timestamp: new Date().toISOString(),
    retry_attempted: retryAttempted ? 'yes' : 'no',
    raw_error: rawMessage || '',
  });
}

function describeFailureCode(code) {
  const value = String(code || '');
  if (!value) return 'unknown';
  if (value.startsWith('HTTP ')) return `Chatwoot API error ${value.slice(5)}`;
  return describeWhatsAppError(Number(code) || code);
}

function describeWhatsAppError(code) {
  if (!code) return 'unknown';
  if (code === 131026) return 'message undeliverable / possible temporary issue';
  if (code === 132000) return 'template params count mismatch';
  if (PERMANENT_WA_ERRORS.has(code)) return 'permanent WhatsApp/template/account error';
  return `WhatsApp error ${code}`;
}

function enqueueJob(jobId, queueKey) {
  const current = queueChains.get(queueKey) || Promise.resolve();
  const next = current
    .then(() => globalQueueLimiter(() => runJob(jobId)))
    .catch((err) => console.error('[jobs] queue error:', err))
    .finally(() => {
      if (queueChains.get(queueKey) === next) queueChains.delete(queueKey);
    });
  queueChains.set(queueKey, next);
}

function createLimiter(max) {
  let active = 0;
  const waiting = [];

  function drain() {
    if (active >= max) return;
    const next = waiting.shift();
    if (next) next();
  }

  return async function limit(fn) {
    if (active >= max) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      drain();
    }
  };
}

function getQueueInfo(type, settings, config) {
  if (settings.inboxId) {
    return {
      key: `account:${config.accountId}:inbox:${settings.inboxId}`,
      label: `Inbox #${settings.inboxId}`,
    };
  }
  return {
    key: `account:${config.accountId}:contacts`,
    label: type === 'upload' ? `Contacts queue / Account #${config.accountId}` : `Account #${config.accountId}`,
  };
}

function incrementUploadCounter(job, status) {
  if (status === 'new') job.counters.new++;
  else if (status === 'updated') job.counters.updated++;
  else job.counters.failed++;
}

function normPhone(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function hasUnsafePhoneFormat(value) {
  return /e[+-]|\./i.test(String(value || ''));
}

function extractId(data) {
  return data?.id || data?.payload?.contact?.id || data?.payload?.id || data?.contact?.id || null;
}

function ensureColumnExists(rows, column, label) {
  const headers = Object.keys(rows[0] || {});
  if (!headers.includes(column)) throw new Error(`${label} "${column}" is not in CSV. Existing columns: ${headers.join(', ')}`);
}

function safeKey(input) {
  const raw = String(input || '');
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (cleaned) return cleaned;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return `key_${Math.abs(hash)}`;
}

function normalizeLabelTitle(input) {
  const raw = String(input || '').trim();
  return raw
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.max(min, Math.min(parsed, max));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logJob(job, message, level = 'info') {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message });
  await fs.appendFile(getJobLogPath(job.id), `${line}\n`, 'utf8');
}

async function writeFailedCsv(job) {
  if (!job.failedRecords.length) return;
  const headers = ['phone', 'name', 'error_code', 'error_description', 'timestamp', 'retry_attempted', 'raw_error'];
  const rows = [headers.join(',')].concat(job.failedRecords.map((record) => headers.map((h) => csvEscape(record[h])).join(',')));
  await fs.writeFile(getJobFailedPath(job.id), rows.join('\n'), 'utf8');
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function clearJobFiles(jobId) {
  await Promise.allSettled([
    fs.rm(getJobLogPath(jobId), { force: true }),
    fs.rm(getJobFailedPath(jobId), { force: true }),
  ]);
}

async function listJobs() {
  await ensureStore();
  const files = await fs.readdir(JOBS_DIR).catch(() => []);
  const jobs = [];
  for (const file of files.filter((item) => item.endsWith('.json'))) {
    const job = await readJob(path.basename(file, '.json'));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function readJob(id) {
  try {
    const raw = await fs.readFile(getJobPath(id), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJob(job) {
  await ensureStore();
  await fs.writeFile(getJobPath(job.id), JSON.stringify(job, null, 2), 'utf8');
}

function getJobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

function getJobLogPath(id) {
  return path.join(JOBS_DIR, `${id}.log`);
}

function getJobFailedPath(id) {
  return path.join(JOBS_DIR, `${id}-failed.csv`);
}
