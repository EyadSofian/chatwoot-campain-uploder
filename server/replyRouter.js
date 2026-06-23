import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.JOBS_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = process.env.REPLY_ROUTER_STATE_FILE || path.join(DATA_DIR, 'reply-router-state.json');
const locks = new Map();

export function registerReplyRouter(app) {
  app.post('/api/webhooks/chatwoot', async (req, res) => {
    try {
      const secret = String(process.env.WEBHOOK_SECRET || '').trim();
      if (secret) {
        const provided = String(req.query.token || req.get('x-webhook-secret') || '').trim();
        if (provided !== secret) return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
      }

      const result = await handleChatwootWebhook(req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[reply-router]', err.message);
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  });
}

export async function handleChatwootWebhook(payload) {
  if (!isIncomingMessage(payload)) {
    return { status: 'skipped', reason: 'not_incoming_message' };
  }

  const accountId = extractAccountId(payload);
  const conversationId = extractConversationId(payload);
  if (!accountId || !conversationId) {
    return { status: 'skipped', reason: 'missing_account_or_conversation' };
  }

  const config = buildConfig(accountId);
  if (!config.token) {
    const err = new Error('CHATWOOT_API_TOKEN is required for reply routing');
    err.status = 500;
    throw err;
  }

  return withLock(`conversation:${accountId}:${conversationId}`, async () => {
    const conversation = await fetchConversation(config, conversationId);
    const attrs = conversation?.custom_attributes || payload.conversation?.custom_attributes || {};
    const marker = readReplyAssignmentMarker(attrs);

    if (!marker.active) {
      return { status: 'skipped', reason: marker.reason };
    }

    return withLock(`reply-router-state:${accountId}:${marker.teamId}`, async () => {
      const state = await readState();
      const assignmentKey = marker.assignmentKey || `${accountId}:${conversationId}:${marker.markedAt}`;
      if (state.assignments?.[assignmentKey]) {
        return { status: 'skipped', reason: 'already_assigned_in_router_state' };
      }

      const members = await loadAssignableTeamMembers(config, marker.teamId, marker.inboxId);
      const assignee = pickRoundRobinMember(members, state, `account:${accountId}:team:${marker.teamId}`);

      await assignConversation(config, conversationId, assignee.id);
      await markConversationAssigned(config, conversationId, attrs, marker, assignee);
      await openConversationIfNeeded(config, conversationId, conversation?.status);

      state.assignments = state.assignments || {};
      state.assignments[assignmentKey] = {
        accountId: String(accountId),
        conversationId: String(conversationId),
        teamId: String(marker.teamId),
        assigneeId: String(assignee.id),
        assignedAt: new Date().toISOString(),
      };
      await writeState(state);

      return {
        status: 'assigned',
        conversationId: String(conversationId),
        teamId: String(marker.teamId),
        assigneeId: String(assignee.id),
        assigneeName: agentName(assignee),
      };
    });
  });
}

export function pickRoundRobinMember(members, state, key) {
  const list = normalizeMembers(members);
  if (!list.length) throw new Error('No assignable team members found');

  state.teams = state.teams || {};
  const current = Number(state.teams[key]?.nextIndex || 0);
  const index = Number.isFinite(current) ? current % list.length : 0;
  const member = list[index];
  state.teams[key] = {
    nextIndex: (index + 1) % list.length,
    lastAssigneeId: String(member.id),
    updatedAt: new Date().toISOString(),
  };
  return member;
}

function isIncomingMessage(payload) {
  if (payload?.event && payload.event !== 'message_created') return false;
  if (payload?.private === true) return false;
  return payload?.message_type === 'incoming' || payload?.message_type === 0;
}

function extractAccountId(payload) {
  return payload?.account?.id
    || payload?.account_id
    || payload?.conversation?.account_id
    || process.env.CHATWOOT_ACCOUNT_ID
    || '2';
}

function extractConversationId(payload) {
  return payload?.conversation?.id
    || payload?.conversation_id
    || null;
}

function buildConfig(accountId) {
  return {
    baseUrl: String(process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, ''),
    accountId: String(accountId),
    token: String(process.env.CHATWOOT_API_TOKEN || '').trim(),
  };
}

function readReplyAssignmentMarker(attrs) {
  const mode = String(attrs?.api_campaign_reply_assign_mode || '').trim();
  if (mode !== 'on_reply_team') return { active: false, reason: 'not_reply_team_campaign' };

  const teamId = String(attrs?.api_campaign_reply_team_id || '').trim();
  if (!teamId) return { active: false, reason: 'missing_reply_team_id' };

  const assignedAt = String(attrs?.api_campaign_reply_assigned_at || '').trim();
  if (assignedAt) return { active: false, reason: 'already_assigned' };

  const pending = attrs?.api_campaign_reply_pending;
  if (pending === false || String(pending).toLowerCase() === 'false') {
    return { active: false, reason: 'reply_assignment_not_pending' };
  }

  const activeUntil = Date.parse(attrs?.api_campaign_active_until || '');
  if (Number.isFinite(activeUntil) && activeUntil < Date.now()) {
    return { active: false, reason: 'campaign_marker_expired' };
  }

  return {
    active: true,
    teamId,
    inboxId: String(attrs?.api_campaign_reply_inbox_id || '').trim(),
    markedAt: String(attrs?.api_campaign_marked_at || attrs?.api_campaign_created_at || '').trim(),
    assignmentKey: String(attrs?.api_campaign_reply_assignment_key || '').trim(),
  };
}

async function loadAssignableTeamMembers(config, teamId, inboxId) {
  const teamMembers = await fetchTeamMembers(config, teamId);
  if (!inboxId) return teamMembers;

  try {
    const inboxMembers = await fetchInboxMembers(config, inboxId);
    const inboxMemberIds = new Set(normalizeMembers(inboxMembers).map((member) => String(member.id)));
    const filtered = teamMembers.filter((member) => inboxMemberIds.has(String(member.id)));
    return filtered.length ? filtered : teamMembers;
  } catch (err) {
    console.warn(`[reply-router] Could not filter team members by inbox #${inboxId}: ${err.message}`);
    return teamMembers;
  }
}

async function fetchConversation(config, conversationId) {
  const r = await chatwootFetch(config, `/api/v1/accounts/${config.accountId}/conversations/${conversationId}`);
  return r.payload || r;
}

async function fetchTeamMembers(config, teamId) {
  const r = await chatwootFetch(config, `/api/v1/accounts/${config.accountId}/teams/${teamId}/team_members`);
  return Array.isArray(r) ? r : (r.payload || []);
}

async function fetchInboxMembers(config, inboxId) {
  const r = await chatwootFetch(config, `/api/v1/accounts/${config.accountId}/inbox_members/${inboxId}`);
  return Array.isArray(r) ? r : (r.payload || []);
}

async function assignConversation(config, conversationId, assigneeId) {
  await chatwootFetch(
    config,
    `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/assignments`,
    'POST',
    { assignee_id: Number(assigneeId) }
  );
}

async function markConversationAssigned(config, conversationId, attrs, marker, assignee) {
  const merged = {
    ...(attrs || {}),
    api_campaign_reply_pending: false,
    api_campaign_reply_assigned_at: new Date().toISOString(),
    api_campaign_reply_assignee_id: String(assignee.id),
    api_campaign_reply_assignee_name: agentName(assignee),
    api_campaign_reply_team_id: String(marker.teamId),
  };
  await chatwootFetch(
    config,
    `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/custom_attributes`,
    'POST',
    { custom_attributes: merged }
  );
}

async function openConversationIfNeeded(config, conversationId, currentStatus) {
  if (String(currentStatus || '').toLowerCase() === 'open') return;
  await chatwootFetch(
    config,
    `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/toggle_status`,
    'POST',
    { status: 'open' }
  ).catch((err) => {
    console.warn(`[reply-router] Could not open conversation #${conversationId}: ${err.message}`);
  });
}

async function chatwootFetch(config, pathName, method = 'GET', body) {
  const res = await fetch(`${config.baseUrl}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      api_access_token: config.token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? tryJson(text) : {};
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function normalizeMembers(members) {
  return (Array.isArray(members) ? members : [])
    .filter((member) => member?.id && member.confirmed !== false)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function agentName(agent) {
  return agent?.available_name || agent?.name || agent?.email || `Agent #${agent?.id || '-'}`;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { teams: {}, assignments: {} };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  const tracked = current.finally(() => {
    if (locks.get(key) === tracked) locks.delete(key);
  });
  locks.set(key, tracked);
  return current;
}
