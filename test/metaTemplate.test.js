import test from 'node:test';
import assert from 'node:assert/strict';
import { findApprovedMetaTemplate } from '../server/metaTemplate.js';

test('finds approved Meta template when Chatwoot cache is stale', async () => {
  let request;
  const result = await findApprovedMetaTemplate({
    provider: 'whatsapp_cloud',
    provider_config: { business_account_id: '123', api_key: 'secret' },
  }, 'cmrp_invite', 'ar', async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, json: async () => ({ data: [
      { name: 'cmrp_invite', language: 'ar', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'أهلاً بك' }] },
    ] }) };
  });
  assert.equal(result?.name, 'cmrp_invite');
  assert.equal(result?.body, 'أهلاً بك');
  assert.match(request.url, /^https:\/\/graph\.facebook\.com\/v24\.0\/123\/message_templates\?/);
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
});

test('rejects an unapproved Meta template', async () => {
  const result = await findApprovedMetaTemplate({
    provider: 'whatsapp_cloud',
    provider_config: { business_account_id: '123', api_key: 'secret' },
  }, 'cmrp_invite', 'ar', async () => ({ ok: true, json: async () => ({ data: [
    { name: 'cmrp_invite', language: 'ar', status: 'PENDING', components: [{ type: 'BODY', text: 'أهلاً بك' }] },
  ] }) }));
  assert.equal(result, null);
});
