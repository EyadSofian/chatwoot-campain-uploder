import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleChatwootWebhook,
  isIncomingMessage,
  readReplyAssignmentMarker,
} from '../server/replyRouter.js';

test('reply router accepts only public incoming message-created events', () => {
  assert.equal(isIncomingMessage({ event: 'message_created', message_type: 'incoming' }), true);
  assert.equal(isIncomingMessage({ event: 'message_created', message_type: 0 }), true);
  assert.equal(isIncomingMessage({ event: 'message_created', message_type: 'outgoing' }), false);
  assert.equal(isIncomingMessage({ event: 'message_created', message_type: 'incoming', private: true }), false);
  assert.equal(isIncomingMessage({ event: 'conversation_updated', message_type: 'incoming' }), false);
  assert.equal(isIncomingMessage({ message_type: 'incoming' }), false);
});

test('reply router reads the resolved Team and routing-rule audit fields', () => {
  const marker = readReplyAssignmentMarker({
    api_campaign_reply_assign_mode: 'on_reply_team',
    api_campaign_reply_team_id: '77',
    api_campaign_reply_team_name: 'Sales',
    api_campaign_reply_pending: true,
    api_campaign_reply_rule_id: 'revit',
    api_campaign_reply_rule_name: 'Revit leads',
    api_campaign_reply_condition: 'course equals revit',
    api_campaign_active_until: '2026-06-20T10:00:00.000Z',
  }, new Date('2026-06-15T10:00:00.000Z'));

  assert.equal(marker.active, true);
  assert.equal(marker.teamId, '77');
  assert.equal(marker.teamName, 'Sales');
  assert.equal(marker.ruleId, 'revit');
  assert.equal(marker.condition, 'course equals revit');
});

test('reply router rejects completed and expired reply markers', () => {
  assert.equal(readReplyAssignmentMarker({
    api_campaign_reply_assign_mode: 'on_reply_team',
    api_campaign_reply_team_id: '77',
    api_campaign_reply_pending: false,
  }).reason, 'reply_assignment_not_pending');

  assert.equal(readReplyAssignmentMarker({
    api_campaign_reply_assign_mode: 'on_reply_team',
    api_campaign_reply_team_id: '77',
    api_campaign_reply_pending: true,
    api_campaign_active_until: '2026-06-14T10:00:00.000Z',
  }, new Date('2026-06-15T10:00:00.000Z')).reason, 'campaign_marker_expired');

  assert.equal(readReplyAssignmentMarker({
    api_campaign_reply_assign_mode: 'on_reply_team',
    api_campaign_reply_team_id: '77',
    api_campaign_reply_pending: true,
  }).reason, 'missing_campaign_expiry');
});

test('first incoming reply assigns the resolved Team and completes the marker', async (t) => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.CHATWOOT_URL;
  const originalToken = process.env.CHATWOOT_API_TOKEN;
  process.env.CHATWOOT_URL = 'https://chatwoot.test';
  process.env.CHATWOOT_API_TOKEN = 'test-token';

  t.after(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CHATWOOT_URL;
    else process.env.CHATWOOT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.CHATWOOT_API_TOKEN;
    else process.env.CHATWOOT_API_TOKEN = originalToken;
  });

  const markerAttributes = {
    api_campaign_reply_assign_mode: 'on_reply_team',
    api_campaign_reply_team_id: '77',
    api_campaign_reply_team_name: 'Sales',
    api_campaign_reply_pending: true,
    api_campaign_reply_rule_id: 'revit',
    api_campaign_reply_rule_name: 'Revit leads',
    api_campaign_active_until: '2099-06-20T10:00:00.000Z',
  };
  const requests = [];
  let conversationReads = 0;

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: String(url), method, body });

    if (method === 'GET' && String(url).endsWith('/conversations/900')) {
      conversationReads++;
      return new Response(JSON.stringify({
        id: 900,
        status: 'open',
        custom_attributes: markerAttributes,
        meta: conversationReads > 1 ? { assignee: { id: 12, name: 'Nour' } } : {},
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  const result = await handleChatwootWebhook({
    event: 'message_created',
    message_type: 'incoming',
    account: { id: 2 },
    conversation: { id: 900 },
  });

  assert.equal(result.status, 'assigned');
  assert.equal(result.teamId, '77');
  assert.equal(result.assigneeId, '12');
  assert.equal(requests[1].method, 'POST');
  assert.deepEqual(requests[1].body, { team_id: 77 });
  assert.match(requests[1].url, /\/conversations\/900\/assignments$/);
  assert.equal(requests[3].body.custom_attributes.api_campaign_reply_pending, false);
  assert.equal(requests[3].body.custom_attributes.api_campaign_reply_assignee_id, '12');
});
