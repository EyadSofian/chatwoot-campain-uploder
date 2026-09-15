#!/usr/bin/env node
// Non-delivering attribute-safety dry run against real Chatwoot conversations.
// Reads conversations and labels (GET only), simulates the uploader's pending,
// sent and failed marker writes in memory, and reports whether any attribution,
// odoo_*, bot, api_campaign_* attribute or label would be lost. It never sends
// a message and never writes to Chatwoot. Output: conversation IDs and key
// family counts only — no names, phone numbers or attribute values.
//
//   CHATWOOT_BASE_URL=… CHATWOOT_API_TOKEN=… CHATWOOT_ACCOUNT_ID=… \
//   node scripts/attribute-safety-dryrun.js [--limit 60] [--inboxes 24,25,27] [--ids 156866,70257]
import { checkConversationAttributeSafety } from '../server/attributeSafetyCheck.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const base = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.CHATWOOT_API_TOKEN || process.env.CHATWOOT_TOKEN || '';
const account = process.env.CHATWOOT_ACCOUNT_ID || process.env.ACCOUNT_ID || '';
const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 500);
const inboxes = new Set(String(args.inboxes || '').split(',').map((id) => id.trim()).filter(Boolean));
if (!base || !token || !account) {
  console.error('CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN and CHATWOOT_ACCOUNT_ID are required.');
  process.exit(2);
}

async function get(path) {
  const response = await fetch(`${base}/api/v1/accounts/${account}${path}`, {
    headers: { api_access_token: token, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`GET ${path.split('?')[0]} → HTTP ${response.status}`);
  return response.json();
}

const checked = [];
const totals = { attribution: 0, odoo: 0, bot: 0, api_campaign: 0, other: 0, labels: 0 };
const ids = String(args.ids || '').split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id));
for (const id of ids) {
  const row = await get(`/conversations/${id}`);
  const attrs = row.custom_attributes || {};
  const labels = Array.isArray(row.labels) ? row.labels : (await get(`/conversations/${id}/labels`)).payload || [];
  const result = checkConversationAttributeSafety({ attrs, labels });
  checked.push({ id: Number(id), inbox: row.inbox_id, ...result });
  for (const key of Object.keys(result.families)) totals[key] += result.families[key] > 0 ? 1 : 0;
  totals.labels += labels.length > 0 ? 1 : 0;
}
for (let page = 1; !ids.length && checked.length < limit && page <= 40; page += 1) {
  const list = await get(`/conversations?status=all&assignee_type=all&page=${page}`);
  const rows = list?.data?.payload || [];
  if (!rows.length) break;
  for (const row of rows) {
    if (checked.length >= limit) break;
    if (inboxes.size && !inboxes.has(String(row.inbox_id))) continue;
    const attrs = row.custom_attributes || {};
    if (!Object.keys(attrs).length) continue;
    const labels = Array.isArray(row.labels) ? row.labels : (await get(`/conversations/${row.id}/labels`)).payload || [];
    const result = checkConversationAttributeSafety({ attrs, labels });
    checked.push({ id: row.id, inbox: row.inbox_id, ...result });
    for (const key of Object.keys(result.families)) totals[key] += result.families[key] > 0 ? 1 : 0;
    totals.labels += labels.length > 0 ? 1 : 0;
  }
}
const failed = checked.filter((row) => !row.passed);
console.log(JSON.stringify({
  mode: 'dry-run (no messages, no writes)',
  conversationsChecked: checked.length,
  conversationsWith: {
    attribution: totals.attribution,
    odoo: totals.odoo,
    bot: totals.bot,
    api_campaign: totals.api_campaign,
    labels: totals.labels,
  },
  passed: checked.length - failed.length,
  failed: failed.length,
  failures: failed.slice(0, 20).map((row) => ({ conversation: row.id, inbox: row.inbox, violations: row.violations })),
}, null, 2));
process.exit(failed.length ? 1 : 0);
