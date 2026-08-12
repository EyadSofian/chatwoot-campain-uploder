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
    targetType: 'agent',
    targetId: '22',
    targetName: 'Ahmed',
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
  assert.equal(match.targetType, 'team');
  assert.equal(match.targetId, '17');
  assert.equal(match.teamId, '17');
});

test('reply routing rules match the existing contact custom attribute column', () => {
  const match = resolveReplyRoutingRule(rules, {
    campaignLabel: 'another_campaign',
    row: { department: 'bim' },
  });

  assert.equal(match.id, 'department');
  assert.equal(match.targetType, 'agent');
  assert.equal(match.targetId, '22');
  assert.equal(match.targetName, 'Ahmed');
  assert.equal(match.teamId, '');
});

test('reply routing rules fall back when no label or custom attribute matches', () => {
  const match = resolveReplyRoutingRule(rules, {
    campaignLabel: 'another_campaign',
    row: { department: 'Architecture' },
  });

  assert.equal(match.id, 'fallback');
  assert.equal(match.targetType, 'team');
  assert.equal(match.teamId, '30');
});

test('invalid, disabled, or targetless rules are removed during normalization', () => {
  const normalized = normalizeReplyRoutingRules([
    { conditionType: 'label', value: 'x', teamId: '' },
    { conditionType: 'label', value: 'x', targetType: 'agent', targetId: 'not-a-number' },
    { enabled: false, conditionType: 'fallback', teamId: '2' },
    { conditionType: 'unknown', teamId: '3' },
    rules[0],
  ]);

  assert.deepEqual(normalized.map((rule) => rule.id), ['campaign_label']);
});
