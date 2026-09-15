import { buildCampaignMarkerChanges, isCampaignOwnedAttributeKey } from './campaignMarkers.js';
import { mergeCampaignOwnedChanges } from './campaignAttributeWriter.js';

// Families of conversation attributes other integrations own. The uploader must
// carry every one of them over unchanged on every marker write.
export const PROTECTED_FAMILIES = Object.freeze({
  attribution: (key) => /^(attribution_|meta_|utm_|customer_source$|customer_type$|engosoft_branch$|marketer_name$)/.test(key),
  odoo: (key) => key.startsWith('odoo_'),
  bot: (key) => /^(bp_|majed_|botpress_|bot_)/.test(key),
});

function family(key) {
  if (isCampaignOwnedAttributeKey(key)) return 'api_campaign';
  for (const [name, test] of Object.entries(PROTECTED_FAMILIES)) if (test(key)) return name;
  return 'other';
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Non-delivering attribute-safety check for one conversation. It runs the real
 * marker builder and merge the uploader uses for a pending, sent and failed
 * send against the conversation's current attributes and labels, and reports
 * any attribute or label that would not survive. Nothing is sent or written.
 */
export function checkConversationAttributeSafety({
  attrs = {},
  labels = [],
  campaignLabel = 'qa_attribute_safety',
  templateName = 'qa_template',
  now = new Date(),
}) {
  const campaignKey = `api_sent_${campaignLabel}_${templateName}`;
  const violations = [];
  let state = { ...attrs };
  for (const status of ['pending', 'sent', 'failed']) {
    const changes = buildCampaignMarkerChanges({
      attrs: state,
      previousAttrs: status === 'failed' ? attrs : null,
      campaignKey,
      labelName: campaignLabel,
      templateName,
      status,
      now,
      error: status === 'failed' ? 'qa simulated failure' : '',
    });
    const merged = mergeCampaignOwnedChanges(state, changes);
    for (const [key, value] of Object.entries(state)) {
      if (isCampaignOwnedAttributeKey(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(merged, key)) violations.push(`${status}: ${key} (${family(key)}) would be dropped`);
      else if (!sameValue(merged[key], value)) violations.push(`${status}: ${key} (${family(key)}) would change`);
    }
    state = merged;
  }
  // Conversation labels: the uploader reads the current labels and adds its own.
  const nextLabels = [...new Set([...labels, campaignLabel])];
  for (const label of labels) if (!nextLabels.includes(label)) violations.push(`label ${label} would be dropped`);

  const families = { attribution: 0, odoo: 0, bot: 0, api_campaign: 0, other: 0 };
  for (const key of Object.keys(attrs)) families[family(key)] += 1;
  return { passed: violations.length === 0, violations, families, labels: labels.length };
}
