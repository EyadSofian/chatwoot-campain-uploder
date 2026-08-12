import { timingSafeEqual } from 'crypto';
import { withConversationLock } from './conversationLocks.js';

export function registerReplyRouter(app) {
  app.post('/api/webhooks/chatwoot', async (req, res) => {
    try {
      const secret = String(process.env.WEBHOOK_SECRET || '').trim();
      if (secret) {
        const provided = String(req.query.token || req.get('x-webhook-secret') || '').trim();
        if (!secretsMatch(provided, secret)) {
          return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
        }
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

  return withConversationLock(accountId, conversationId, async () => {
    const conversation = await fetchConversation(config, conversationId);
    const attrs = conversation?.custom_attributes || payload.conversation?.custom_attributes || {};
    const marker = readReplyAssignmentMarker(attrs);

    if (!marker.active) {
      return { status: 'skipped', reason: marker.reason };
    }

    // Team targets keep Chatwoot's own Auto Assign policy. Agent targets go
    // straight to the selected inbox member.
    await assignConversationToTarget(config, conversationId, marker.targetType, marker.targetId);
    await openConversationIfNeeded(config, conversationId, conversation?.status);

    const updated = await fetchConversation(config, conversationId);
    const assignee = extractAssignee(updated);
    await markConversationAssigned(
      config,
      conversationId,
      updated?.custom_attributes || attrs,
      marker,
      assignee
    );

    return {
      status: 'assigned',
      conversationId: String(conversationId),
      targetType: marker.targetType,
      targetId: String(marker.targetId),
      targetName: marker.targetName,
      teamId: marker.targetType === 'team' ? String(marker.targetId) : '',
      teamName: marker.targetType === 'team' ? marker.targetName : '',
      assigneeId: assignee?.id ? String(assignee.id) : '',
      assigneeName: assignee ? agentName(assignee) : '',
      ruleId: marker.ruleId,
      ruleName: marker.ruleName,
      condition: marker.condition,
    };
  });
}

export function isIncomingMessage(payload) {
  if (payload?.event !== 'message_created') return false;
  if (payload?.private === true) return false;
  return payload?.message_type === 'incoming' || payload?.message_type === 0;
}

export function readReplyAssignmentMarker(attrs, now = new Date()) {
  const mode = String(attrs?.api_campaign_reply_assign_mode || '').trim();
  if (!['on_reply_target', 'on_reply_team'].includes(mode)) {
    return { active: false, reason: 'not_reply_target_campaign' };
  }

  const targetType = String(attrs?.api_campaign_reply_target_type || '').trim() === 'agent'
    ? 'agent'
    : 'team';
  const targetId = String(
    attrs?.api_campaign_reply_target_id || attrs?.api_campaign_reply_team_id || ''
  ).trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return { active: false, reason: 'missing_reply_target_id' };
  }
  const targetName = String(
    attrs?.api_campaign_reply_target_name || attrs?.api_campaign_reply_team_name || ''
  ).trim();

  const assignedAt = String(attrs?.api_campaign_reply_assigned_at || '').trim();
  if (assignedAt) return { active: false, reason: 'already_assigned' };

  const pending = attrs?.api_campaign_reply_pending;
  if (!(pending === true || String(pending).trim().toLowerCase() === 'true')) {
    return { active: false, reason: 'reply_assignment_not_pending' };
  }

  const activeUntil = Date.parse(attrs?.api_campaign_active_until || '');
  if (!Number.isFinite(activeUntil)) {
    return { active: false, reason: 'missing_campaign_expiry' };
  }
  if (activeUntil < now.getTime()) {
    return { active: false, reason: 'campaign_marker_expired' };
  }

  return {
    active: true,
    targetType,
    targetId,
    targetName,
    teamId: targetType === 'team' ? targetId : '',
    teamName: targetType === 'team' ? targetName : '',
    inboxId: String(attrs?.api_campaign_reply_inbox_id || '').trim(),
    markedAt: String(attrs?.api_campaign_marked_at || attrs?.api_campaign_created_at || '').trim(),
    assignmentKey: String(attrs?.api_campaign_reply_assignment_key || '').trim(),
    ruleId: String(attrs?.api_campaign_reply_rule_id || '').trim(),
    ruleName: String(attrs?.api_campaign_reply_rule_name || '').trim(),
    condition: String(attrs?.api_campaign_reply_condition || '').trim(),
  };
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

async function fetchConversation(config, conversationId) {
  const r = await chatwootFetch(config, `/api/v1/accounts/${config.accountId}/conversations/${conversationId}`);
  return r.payload || r;
}

async function assignConversationToTarget(config, conversationId, targetType, targetId) {
  const body = targetType === 'agent'
    ? { assignee_id: Number(targetId) }
    : { team_id: Number(targetId) };
  await chatwootFetch(
    config,
    `/api/v1/accounts/${config.accountId}/conversations/${conversationId}/assignments`,
    'POST',
    body
  );
}

async function markConversationAssigned(config, conversationId, attrs, marker, assignee) {
  const merged = {
    ...(attrs || {}),
    api_campaign_reply_pending: false,
    api_campaign_reply_assigned_at: new Date().toISOString(),
    api_campaign_reply_target_type: marker.targetType,
    api_campaign_reply_target_id: String(marker.targetId),
    api_campaign_reply_target_name: marker.targetName,
  };

  if (marker.targetType === 'team') {
    merged.api_campaign_reply_team_id = String(marker.targetId);
    merged.api_campaign_reply_team_name = marker.targetName;
  } else {
    delete merged.api_campaign_reply_team_id;
    delete merged.api_campaign_reply_team_name;
  }

  if (assignee?.id) {
    merged.api_campaign_reply_assignee_id = String(assignee.id);
    merged.api_campaign_reply_assignee_name = agentName(assignee);
  } else {
    delete merged.api_campaign_reply_assignee_id;
    delete merged.api_campaign_reply_assignee_name;
  }

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${config.baseUrl}${pathName}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: config.token,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? tryJson(text) : {};
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function extractAssignee(conversation) {
  return conversation?.meta?.assignee
    || conversation?.assignee
    || null;
}

function agentName(agent) {
  return agent?.available_name || agent?.name || agent?.email || `Agent #${agent?.id || '-'}`;
}

function secretsMatch(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
