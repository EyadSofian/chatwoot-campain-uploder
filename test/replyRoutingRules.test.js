import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReplyRoutingRules,
  resolveReplyRoutingRule,
} from '../server/replyRoutingRules.js';

const rules = [
  {
    id: 'campaign_label',
    name: 'Campaign label',
    conditionType: 'label',
    operator: 'equals',
    value: 'revit_campaign',
    teamId: '17',
    teamName: 'Revit Sales',
  },
  {
    id: 'department',
    name: 'Department',
    conditionType: 'custom_attribute',
    attributeKey: 'department',
    operator: 'equals',
    value: 'BIM',
    teamId: '22',
    teamName: 'BIM Sales',
  },
  {
    id: 'fallback',
    name: 'Fallback',
    conditionType: 'fallback',
    teamId: '30',
    teamName: 'General Sales',
  },
];

test('reply routing rules use first-match priority and match campaign labels', () => {
  const match = resolveReplyRoutingRule(rules, {
    campaignLabel: 'REVIT_CAMPAIGN',
    row: { department: 'BIM' },
  });

  assert.equal(match.id, 'campaign_label');
  assert.equal(match.teamId, '17');
});

test('reply routing rules match the existing contact custom attribute column', () => {
  const match = resolveReplyRoutingRule(rules, {
    campaignLabel: 'another_campaign',
    row: { department: 'bim' },
  });

  assert.equal(match.id, 'department');
  assert.equal(match.teamId, '22');
});

test('reply routing rules fall back when no label or custom attribute matches', () => {
  const match = resolveReplyRoutingRule(rules, {
    campaignLabel: 'another_campaign',
    row: { department: 'Architecture' },
  });

  assert.equal(match.id, 'fallback');
  assert.equal(match.teamId, '30');
});

test('invalid, disabled, or targetless rules are removed during normalization', () => {
  const normalized = normalizeReplyRoutingRules([
    { conditionType: 'label', value: 'x', teamId: '' },
    { enabled: false, conditionType: 'fallback', teamId: '2' },
    { conditionType: 'unknown', teamId: '3' },
    rules[0],
  ]);

  assert.deepEqual(normalized.map((rule) => rule.id), ['campaign_label']);
});
