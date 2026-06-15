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
