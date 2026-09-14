import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleChatwootWebhook,
  isIncomingMessage,
  readReplyAssignmentMarker,
} from '../server/replyRouter.js';
import { createFakeChatwoot } from './helpers/fakeChatwoot.js';

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
  assert.equal(marker.targetType, 'team');
  assert.equal(marker.targetId, '77');
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

function useFakeChatwoot(t) {
  const chatwoot = createFakeChatwoot();
  const originalFetch = global.fetch;
  const originalUrl = process.env.CHATWOOT_URL;
  const originalToken = process.env.CHATWOOT_API_TOKEN;
  global.fetch = chatwoot.fetch;
  process.env.CHATWOOT_URL = 'https://chatwoot.test';
  process.env.CHATWOOT_API_TOKEN = 'test-token';

  t.after(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CHATWOOT_URL;
    else process.env.CHATWOOT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.CHATWOOT_API_TOKEN;
    else process.env.CHATWOOT_API_TOKEN = originalToken;
  });
  return chatwoot;
}

test('first incoming reply assigns the resolved Team and completes the marker', async (t) => {
  const chatwoot = useFakeChatwoot(t);
  chatwoot.addConversation({
    id: 900,
    attributes: {
      api_campaign_reply_assign_mode: 'on_reply_team',
      api_campaign_reply_team_id: '77',
      api_campaign_reply_team_name: 'Sales',
      api_campaign_reply_pending: true,
      api_campaign_reply_rule_id: 'revit',
      api_campaign_reply_rule_name: 'Revit leads',
      api_campaign_active_until: '2099-06-20T10:00:00.000Z',
      attribution_channel: 'whatsapp',
    },
  });
  // Chatwoot's Team auto-assignment picks an available agent.
  chatwoot.after((request) => request.path === '/conversations/900/assignments', () => {
    chatwoot.conversations.get('900').meta.assignee = { id: 12, name: 'Nour' };
  });

  const result = await handleChatwootWebhook({
    event: 'message_created',
    message_type: 'incoming',
    account: { id: 2 },
    conversation: { id: 900 },
  });

  assert.equal(result.status, 'assigned');
  assert.equal(result.teamId, '77');
  assert.equal(result.assigneeId, '12');
  const assignment = chatwoot.requests.find((request) => request.path === '/conversations/900/assignments');
  assert.deepEqual(assignment.body, { team_id: 77 });
  const attrs = chatwoot.attributes(900);
  assert.equal(attrs.api_campaign_reply_pending, false);
  assert.equal(attrs.api_campaign_reply_target_type, 'team');
  assert.equal(attrs.api_campaign_reply_assignee_id, '12');
  assert.equal(attrs.attribution_channel, 'whatsapp');
});

test('first incoming reply can assign one specific Agent', async (t) => {
  const chatwoot = useFakeChatwoot(t);
  chatwoot.addConversation({
    id: 901,
    attributes: {
      api_campaign_reply_assign_mode: 'on_reply_target',
      api_campaign_reply_target_type: 'agent',
      api_campaign_reply_target_id: '42',
      api_campaign_reply_target_name: 'Ahmed',
      api_campaign_reply_pending: true,
      api_campaign_reply_rule_id: 'revit-agent',
      api_campaign_active_until: '2099-06-20T10:00:00.000Z',
    },
  });

  const result = await handleChatwootWebhook({
    event: 'message_created',
    message_type: 'incoming',
    account: { id: 2 },
    conversation: { id: 901 },
  });

  assert.equal(result.status, 'assigned');
  assert.equal(result.targetType, 'agent');
  assert.equal(result.targetId, '42');
  assert.equal(result.teamId, '');
  assert.equal(result.assigneeId, '42');
  const assignment = chatwoot.requests.find((request) => request.path === '/conversations/901/assignments');
  assert.deepEqual(assignment.body, { assignee_id: 42 });
  const attrs = chatwoot.attributes(901);
  assert.equal(attrs.api_campaign_reply_target_type, 'agent');
  assert.equal(attrs.api_campaign_reply_team_id, undefined);
});
