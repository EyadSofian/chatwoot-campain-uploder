import { findApprovedTemplateDefinition } from './templateParams.js';

// Chatwoot syncs approved Meta templates in a low-priority background job.
// Check Meta directly when that cache has not caught up yet; messages still go
// through the configured Chatwoot inbox.
export async function findApprovedMetaTemplate(inbox, name, language, fetcher = fetch) {
  const config = inbox?.provider_config || inbox?.payload?.provider_config || {};
  if (inbox?.provider !== 'whatsapp_cloud' || !config.business_account_id || !config.api_key) return null;

  const url = new URL(`https://graph.facebook.com/v24.0/${encodeURIComponent(config.business_account_id)}/message_templates`);
  url.searchParams.set('limit', '100');
  url.searchParams.set('name', name);
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${config.api_key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Meta template lookup failed: HTTP ${response.status}`);
  const result = await response.json();
  return findApprovedTemplateDefinition({ message_templates: result.data }, name, language);
}
