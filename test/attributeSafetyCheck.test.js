import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConversationAttributeSafety } from '../server/attributeSafetyCheck.js';

const realisticHash = {
  attribution_method: 'unknown',
  attribution_confidence: 'unknown',
  attribution_unknown_reason: 'referral_evidence_missing',
  attribution_channel: 'whatsapp',
  customer_source: 'whatsapp',
  customer_type: 'unknown',
  meta_campaign_id: '',
  odoo_lead_id: '145254',
  odoo_stage: 'Won',
  odoo_salesperson: 'Sales Team',
  bp_user_id: 'user_1',
  bp_conv_id: 'conv_1',
  majed_welcome_sent: 'true',
  api_campaign_label: 'older_campaign',
  api_campaign_status: 'sent',
  api_campaign_active_until: '2099-01-01T00:00:00.000Z',
  api_sent_older_campaign_tpl: '2026-09-01T00:00:00.000Z',
  department: 'CFM',
};

test('every attribution, odoo, bot and unrelated attribute survives pending, sent and failed markers', () => {
  const result = checkConversationAttributeSafety({
    attrs: realisticHash,
    labels: ['vip', 'src:meta', 'older_campaign'],
    now: new Date('2026-09-15T00:00:00Z'),
  });
  assert.equal(result.passed, true, result.violations.join('\n'));
  assert.deepEqual(result.families, { attribution: 7, odoo: 3, bot: 3, api_campaign: 4, other: 1 });
  assert.equal(result.labels, 3);
});

test('an empty conversation is safe too', () => {
  assert.equal(checkConversationAttributeSafety({ attrs: {}, labels: [] }).passed, true);
});
