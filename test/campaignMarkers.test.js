import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCampaignMarkerAttributes,
  DEFAULT_CAMPAIGN_PENDING_MARKER_TTL_SECONDS,
  DEFAULT_CAMPAIGN_MARKER_TTL_SECONDS,
  getCampaignPendingMarkerTtlSeconds,
  getCampaignMarkerTtlSeconds
} from '../server/campaignMarkers.js';

test('pending campaign markers protect the conversation before the template is sent', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const attrs = buildCampaignMarkerAttributes({
    campaignKey: 'api_sent_june_welcome',
    labelName: 'june',
    templateName: 'welcome',
    status: 'pending',
    now,
    ttlSeconds: 7200,
    pendingTtlSeconds: 3600
  });

  assert.equal(attrs.api_campaign_status, 'pending');
  assert.equal(attrs.api_campaign_marked_at, now.toISOString());
  assert.equal(attrs.api_campaign_active_until, '2026-06-15T11:00:00.000Z');
  assert.equal(attrs.api_sent_june_welcome, undefined);
});

test('sent campaign markers retain the active window and add the duplicate key', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const attrs = buildCampaignMarkerAttributes({
    attrs: { existing: 'value' },
    campaignKey: 'api_sent_june_welcome',
    labelName: 'june',
    templateName: 'welcome',
    status: 'sent',
    now,
    ttlSeconds: 3600
  });

  assert.equal(attrs.existing, 'value');
  assert.equal(attrs.api_campaign_status, 'sent');
  assert.equal(attrs.api_sent_june_welcome, now.toISOString());
  assert.equal(attrs.api_campaign_active_until, '2026-06-15T11:00:00.000Z');
});

test('legacy Team assignments are upgraded to generic target markers', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const attrs = buildCampaignMarkerAttributes({
    campaignKey: 'api_sent_june_welcome',
    labelName: 'june',
    templateName: 'welcome',
    status: 'sent',
    now,
    ttlSeconds: 3600,
    replyAssignment: {
      mode: 'on_reply_team',
      teamId: '77',
      teamName: 'Sales',
      inboxId: '24',
      assignmentKey: 'api_sent_june_welcome:24:123',
      ruleId: 'revit',
      ruleName: 'Revit leads',
      condition: 'department equals Revit'
    }
  });

  assert.equal(attrs.api_campaign_reply_assign_mode, 'on_reply_target');
  assert.equal(attrs.api_campaign_reply_target_type, 'team');
  assert.equal(attrs.api_campaign_reply_target_id, '77');
  assert.equal(attrs.api_campaign_reply_target_name, 'Sales');
  assert.equal(attrs.api_campaign_reply_team_id, '77');
  assert.equal(attrs.api_campaign_reply_team_name, 'Sales');
  assert.equal(attrs.api_campaign_reply_inbox_id, '24');
  assert.equal(attrs.api_campaign_reply_assignment_key, 'api_sent_june_welcome:24:123');
  assert.equal(attrs.api_campaign_reply_rule_id, 'revit');
  assert.equal(attrs.api_campaign_reply_rule_name, 'Revit leads');
  assert.equal(attrs.api_campaign_reply_condition, 'department equals Revit');
  assert.equal(attrs.api_campaign_reply_pending, true);
  assert.equal(attrs.api_campaign_reply_assigned_at, undefined);
});

test('reply assignment markers can route the first reply to one Agent', () => {
  const attrs = buildCampaignMarkerAttributes({
    campaignKey: 'api_sent_agent_campaign',
    labelName: 'agent_campaign',
    templateName: 'welcome',
    status: 'sent',
    now: new Date('2026-06-15T10:00:00.000Z'),
    ttlSeconds: 3600,
    replyAssignment: {
      mode: 'on_reply_target',
      targetType: 'agent',
      targetId: '42',
      targetName: 'Ahmed',
      inboxId: '24',
      assignmentKey: 'api_sent_agent_campaign:24:123',
    }
  });

  assert.equal(attrs.api_campaign_reply_assign_mode, 'on_reply_target');
  assert.equal(attrs.api_campaign_reply_target_type, 'agent');
  assert.equal(attrs.api_campaign_reply_target_id, '42');
  assert.equal(attrs.api_campaign_reply_target_name, 'Ahmed');
  assert.equal(attrs.api_campaign_reply_team_id, undefined);
  assert.equal(attrs.api_campaign_reply_pending, true);
});

test('failed markers expire immediately so an unsent campaign does not block normal routing', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const attrs = buildCampaignMarkerAttributes({
    labelName: 'june',
    templateName: 'welcome',
    status: 'failed',
    now,
    ttlSeconds: 3600,
    error: 'delivery failed'
  });

  assert.equal(attrs.api_campaign_status, 'failed');
  assert.equal(attrs.api_campaign_active_until, now.toISOString());
  assert.equal(attrs.api_campaign_last_error, 'delivery failed');
});

test('a failed new send does not shorten an already active successful campaign marker', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const attrs = buildCampaignMarkerAttributes({
    attrs: {
      api_campaign_status: 'sent',
      api_campaign_active_until: '2026-06-20T10:00:00.000Z'
    },
    labelName: 'june',
    templateName: 'welcome',
    status: 'failed',
    now,
    ttlSeconds: 3600,
    error: 'delivery failed'
  });

  assert.equal(attrs.api_campaign_status, 'failed');
  assert.equal(attrs.api_campaign_active_until, '2026-06-20T10:00:00.000Z');
});

test('a failed new send preserves a previous active reply route', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const attrs = buildCampaignMarkerAttributes({
    attrs: {
      api_campaign_status: 'sent',
      api_campaign_active_until: '2026-06-20T10:00:00.000Z',
      api_campaign_reply_assign_mode: 'on_reply_team',
      api_campaign_reply_team_id: '77',
      api_campaign_reply_team_name: 'Sales',
      api_campaign_reply_pending: true,
      api_campaign_reply_rule_id: 'old-route'
    },
    labelName: 'new-campaign',
    templateName: 'new-template',
    status: 'failed',
    now,
    error: 'delivery failed',
    replyAssignment: {
      mode: 'on_reply_team',
      teamId: '88',
      teamName: 'Another team'
    }
  });

  assert.equal(attrs.api_campaign_reply_pending, true);
  assert.equal(attrs.api_campaign_reply_team_id, '77');
  assert.equal(attrs.api_campaign_reply_rule_id, 'old-route');
});

test('finalizing the same route does not reactivate it after a fast customer reply', () => {
  const attrs = buildCampaignMarkerAttributes({
    attrs: {
      api_campaign_reply_assignment_key: 'campaign:24:123',
      api_campaign_reply_pending: false,
      api_campaign_reply_assigned_at: '2026-06-15T10:00:01.000Z',
      api_campaign_reply_assignee_id: '9',
      api_campaign_reply_assignee_name: 'Nour'
    },
    campaignKey: 'api_sent_june_welcome',
    labelName: 'june_welcome',
    templateName: 'welcome',
    status: 'sent',
    now: new Date('2026-06-15T10:00:02.000Z'),
    replyAssignment: {
      mode: 'on_reply_team',
      teamId: '77',
      teamName: 'Sales',
      assignmentKey: 'campaign:24:123'
    }
  });

  assert.equal(attrs.api_campaign_reply_pending, false);
  assert.equal(attrs.api_campaign_reply_assigned_at, '2026-06-15T10:00:01.000Z');
  assert.equal(attrs.api_campaign_reply_assignee_id, '9');
});

test('campaign marker TTL defaults to thirty days and rejects invalid values', () => {
  assert.equal(getCampaignMarkerTtlSeconds(undefined), DEFAULT_CAMPAIGN_MARKER_TTL_SECONDS);
  assert.equal(getCampaignMarkerTtlSeconds('3600'), 3600);
  assert.equal(getCampaignMarkerTtlSeconds('-1'), 0);
  assert.equal(getCampaignMarkerTtlSeconds('invalid'), DEFAULT_CAMPAIGN_MARKER_TTL_SECONDS);
});

test('pending marker TTL defaults to one hour and can be configured separately', () => {
  assert.equal(
    getCampaignPendingMarkerTtlSeconds(undefined),
    DEFAULT_CAMPAIGN_PENDING_MARKER_TTL_SECONDS
  );
  assert.equal(getCampaignPendingMarkerTtlSeconds('900'), 900);
  assert.equal(getCampaignPendingMarkerTtlSeconds('invalid'), DEFAULT_CAMPAIGN_PENDING_MARKER_TTL_SECONDS);
});
