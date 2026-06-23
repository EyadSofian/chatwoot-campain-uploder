import fs from 'fs/promises';
import path from 'path';

// Reply-triggered assignment router.
//
// A broadcast can mark each conversation with a deferred-assignment marker
// (api_campaign_assign_mode = "on_reply") instead of assigning an agent at
// send time. The conversation then stays unassigned until the customer takes
// an action (sends an incoming message). Chatwoot fires a `message_created`
// webhook at that point; this router picks the next agent from the campaign's
// team using a persisted round-robin counter, so replies are distributed
// equally across the team members the user designated for the campaign.

const CHATWOOT_URL = (process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, '');
const CHATWOOT_API_TOKEN = (process.env.CHATWOOT_API_TOKEN || '').trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
const DATA_DIR = process.env.JOBS_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'reply-router-state.json');

let stateCache = null;
let stateWriteChain = Promise.resolve();
const locks = new Map();

export function registerReplyRouterRoutes(app, express) {
  app.post('/api/webhooks/chatwoot', express.json({ limit: '1mb' }), async (req, res) => {
    if (WEBHOOK_SECRET) {
      const provided = req.query.token || req.get('x-webhook-token') || '';
      if (provided !== WEBHOOK_SECRET) return res.status(401).json({ ok: false, error: 'invalid webhook token' });
    }
    try {
      const result = await processWebhook(req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Reply router webhook error:', err.message);
      // Respond 200 so Chatwoot does not retry-storm on transient issues.
      res.status(200).json({ ok: false, error: err.message });
    }
  });
}

async function processWebhook(body) {
  const event = body.event || '';
  if (event && event !== 'message_created') return { skipped: 'event', event };

  const messageType = body.message_type ?? body.messageType;
  const isIncoming = messageType === 'incoming' || messageType === 0;
  if (!isIncoming) return { skipped: 'not_incoming' };
  if (body.private) return { skipped: 'private' };

  const conversation = body.conversation || {};
  const accountId = body.account?.id || conversation.account_id || conversation.inbox?.account_id;
  const conversationId = conversation.id || body.conversation_id;
  if (!accountId || !conversationId) return { skipped: 'missing_ids' };

  // Trust the payload to cheaply skip non-campaign traffic when attributes are
  // present; only the campaign path pays for a confirming re-fetch.
  const payloadAttrs = conversation.custom_attributes;
  if (payloadAttrs && payloadAttrs.api_campaign_assign_mode !== 'on_reply') {
    return { skipped: 'not_on_reply' };
  }

  if (!CHATWOOT_API_TOKEN) throw new Error('CHATWOOT_API_TOKEN is not configured on the server');

  // Serialize per conversation so two fast replies cannot double-assign.
  return withLock(`conv:${accountId}:${conversationId}`, async () => {
    const fresh = await cw(`/api/v1/accounts/${accountId}/conversations/${conversationId}`, 'GET');
    const conv = fresh.ok ? (fresh.data?.payload || fresh.data || {}) : conversation;
    const attrs = conv.custom_attributes || payloadAttrs || {};

    if (attrs.api_campaign_assign_mode !== 'on_reply') return { skipped: 'not_on_reply' };
    if (attrs.api_campaign_assign_status === 'done') return { skipped: 'already_done' };

    const assignee = conv.meta?.assignee || conv.assignee;
    if (assignee && assignee.id) {
      // Someone (or another rule) already owns it; record and stop.
      await setCampaignAttrs(accountId, conversationId, attrs, {
        api_campaign_assign_status: 'done',
        api_campaign_assigned_to: String(assignee.id)
      });
      return { skipped: 'already_assigned', assignee: assignee.id };
    }

    const teamId = attrs.api_campaign_assign_team;
    if (!teamId) return { skipped: 'no_team' };

    const members = await getTeamMembers(accountId, teamId);
    if (!members.length) return { skipped: 'no_team_members', teamId };

    const agentId = await pickRoundRobin(accountId, teamId, members);
    const assign = await cw(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/assignments`,
      'POST',
      { assignee_id: Number(agentId) }
    );
    if (!assign.ok) {
      return { error: `assignment failed: HTTP ${assign.status} ${JSON.stringify(assign.data)}` };
    }

    await setCampaignAttrs(accountId, conversationId, attrs, {
      api_campaign_assign_status: 'done',
      api_campaign_assigned_to: String(agentId)
    });
    return { assigned: Number(agentId), conversationId, teamId: String(teamId) };
  });
}

async function getTeamMembers(accountId, teamId) {
  const r = await cw(`/api/v1/accounts/${accountId}/teams/${teamId}/team_members`, 'GET');
  if (!r.ok) return [];
  const list = Array.isArray(r.data) ? r.data : (r.data?.payload || r.data?.team_members || []);
  return list
    .map((member) => ({ id: member.id ?? member.user_id ?? member.user?.id }))
    .filter((member) => member.id != null)
    // Stable ordering so the round-robin counter stays consistent across calls.
    .sort((a, b) => Number(a.id) - Number(b.id));
}

// Pure round-robin step: given the previously used index (or anything not a
// non-negative integer for "never used") return the next index for a team of
// `length` members. Exported for testing.
export function nextRoundRobinIndex(prev, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const base = Number.isInteger(prev) && prev >= 0 ? prev : -1;
  return (base + 1) % length;
}

async function pickRoundRobin(accountId, teamId, members) {
  return withLock(`team:${accountId}:${teamId}`, async () => {
    const state = await loadState();
    const key = `${accountId}:${teamId}`;
    const next = nextRoundRobinIndex(state[key], members.length);
    state[key] = next;
    await saveState(state);
    return members[next].id;
  });
}

async function setCampaignAttrs(accountId, conversationId, currentAttrs, updates) {
  const merged = { ...currentAttrs, ...updates };
  await cw(
    `/api/v1/accounts/${accountId}/conversations/${conversationId}/custom_attributes`,
    'POST',
    { custom_attributes: merged }
  );
}

async function cw(pathName, method = 'GET', body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${CHATWOOT_URL}${pathName}`, {
      method,
      headers: { 'Content-Type': 'application/json', api_access_token: CHATWOOT_API_TOKEN },
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : JSON.stringify(body || {}),
      signal: controller.signal
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function loadState() {
  if (stateCache) return stateCache;
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    stateCache = JSON.parse(raw) || {};
  } catch {
    stateCache = {};
  }
  return stateCache;
}

function saveState(state) {
  stateCache = state;
  stateWriteChain = stateWriteChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state), 'utf8');
  }).catch((err) => console.error('Reply router state write failed:', err.message));
  return stateWriteChain;
}

// Minimal promise-chain lock so concurrent webhooks for the same conversation
// or team run sequentially.
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  locks.set(key, run.then(() => {}, () => {}));
  return run;
}
