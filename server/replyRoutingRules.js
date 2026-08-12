const MAX_REPLY_ROUTING_RULES = 50;
const CONDITION_TYPES = new Set(['label', 'custom_attribute', 'fallback']);
const OPERATORS = new Set(['equals', 'not_equals', 'contains']);

export function normalizeReplyRoutingRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .slice(0, MAX_REPLY_ROUTING_RULES)
    .map((rule, index) => normalizeRule(rule, index))
    .filter(Boolean);
}

export function resolveReplyRoutingRule(rules, context = {}) {
  const normalized = normalizeReplyRoutingRules(rules);
  return normalized.find((rule) => replyRoutingRuleMatches(rule, context)) || null;
}

export function replyRoutingRuleMatches(rule, context = {}) {
  if (!rule?.enabled || !rule.targetId) return false;
  if (rule.conditionType === 'fallback') return true;

  if (rule.conditionType === 'label') {
    const labels = uniqueStrings([
      context.campaignLabel,
      ...(Array.isArray(context.labels) ? context.labels : []),
    ]);
    return compareCollection(labels, rule.value, rule.operator);
  }

  if (rule.conditionType === 'custom_attribute') {
    const key = rule.attributeKey;
    const customAttributes = context.customAttributes && typeof context.customAttributes === 'object'
      ? context.customAttributes
      : {};
    const row = context.row && typeof context.row === 'object' ? context.row : {};
    const actual = customAttributes[key] ?? row[key] ?? '';
    return compareValue(actual, rule.value, rule.operator);
  }

  return false;
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== 'object' || rule.enabled === false) return null;

  const conditionType = CONDITION_TYPES.has(String(rule.conditionType || ''))
    ? String(rule.conditionType)
    : '';
  // Rules created before Agent targets existed only contain teamId/teamName.
  // Treat those as Team targets so saved campaigns keep working unchanged.
  const targetType = String(rule.targetType || '').trim().toLowerCase() === 'agent'
    ? 'agent'
    : 'team';
  const targetId = String(
    rule.targetId || (targetType === 'agent' ? rule.agentId : rule.teamId) || ''
  ).trim();
  if (!conditionType || !targetId || !/^\d+$/.test(targetId)) return null;

  const attributeKey = conditionType === 'custom_attribute'
    ? String(rule.attributeKey || '').trim().slice(0, 120)
    : '';
  const value = conditionType === 'fallback' ? '' : String(rule.value ?? '').trim().slice(0, 500);
  if (conditionType === 'custom_attribute' && !attributeKey) return null;
  if (conditionType !== 'fallback' && !value) return null;

  const operator = OPERATORS.has(String(rule.operator || ''))
    ? String(rule.operator)
    : 'equals';
  const id = String(rule.id || `route_${index + 1}`).trim().slice(0, 80);
  const targetName = String(
    rule.targetName || (targetType === 'agent' ? rule.agentName : rule.teamName) || ''
  ).trim().slice(0, 120);

  return {
    id,
    name: String(rule.name || `Route ${index + 1}`).trim().slice(0, 120),
    enabled: true,
    conditionType,
    attributeKey,
    operator: conditionType === 'fallback' ? 'equals' : operator,
    value,
    targetType,
    targetId,
    targetName,
    // Keep Team aliases in the normalized result for older stored jobs and
    // callers that still inspect these fields.
    teamId: targetType === 'team' ? targetId : '',
    teamName: targetType === 'team' ? targetName : '',
  };
}

function compareCollection(values, expected, operator) {
  if (operator === 'not_equals') {
    return values.every((value) => normalizeComparable(value) !== normalizeComparable(expected));
  }
  if (operator === 'contains') {
    const needle = normalizeComparable(expected);
    return Boolean(needle) && values.some((value) => normalizeComparable(value).includes(needle));
  }
  return values.some((value) => normalizeComparable(value) === normalizeComparable(expected));
}

function compareValue(actual, expected, operator) {
  const left = normalizeComparable(actual);
  const right = normalizeComparable(expected);
  if (operator === 'not_equals') return left !== right;
  if (operator === 'contains') return Boolean(right) && left.includes(right);
  return left === right;
}

function normalizeComparable(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}
