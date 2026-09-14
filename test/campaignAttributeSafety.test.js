import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createFakeChatwoot, isAttributeWrite, isConversationRead } from './helpers/fakeChatwoot.js';
import { isCampaignOwnedAttributeKey } from '../server/campaignMarkers.js';
import { MAX_ATTRIBUTE_WRITE_ATTEMPTS } from '../server/campaignAttributeWriter.js';

// jobs.js resolves its log directory at import time.
const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uploader-jobs-'));
await fs.mkdir(path.join(jobsDir, 'jobs'), { recursive: true });
process.env.JOBS_DIR = jobsDir;
const { sendTemplateForRow } = await import('../server/jobs.js');
const { handleChatwootWebhook } = await import('../server/replyRouter.js');

const CAMPAIGN_KEY = 'api_sent_sept_campaign_confirm_step';
const PHONE = '+966500000001';

function setup(t, { attributes = {}, newConversation = false } = {}) {
  const chatwoot = createFakeChatwoot();
  const originalFetch = global.fetch;
  global.fetch = chatwoot.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const contact = chatwoot.addContact({ phone: PHONE, labels: ['sept_campaign'], inboxSourceIds: { 24: '966500000001' } });
  const conversation = newConversation
    ? null
    : chatwoot.addConversation({ contactId: contact.id, inboxId: 24, labels: ['existing_label'], attributes });
  return { chatwoot, contact, conversation };
}

function runtimeFor(settings = {}) {
  return {
    config: { baseUrl: 'https://chatwoot.test', accountId: '2', token: 'test-token' },
    settings: {
      labelName: 'sept_campaign',
      templateName: 'confirm_step',
      templateLang: 'ar',
      templateCategory: 'UTILITY',
      inboxId: '24',
      attrCol: '',
      createNew: true,
      forceUpdate: false,
      duplicateGuard: true,
      autoAssign: false,
      assignmentMode: 'by_csv',
      assignmentTargetType: 'agent',
      assignmentValueColumn: '',
      fixedTargetId: '',
      fixedTargetName: '',
      assignmentMap: {},
      replyRoutingRules: [],
      postSendConversationStatus: 'open',
      bodyParams: '',
      messageContent: 'hello',
      normalizeVars: true,
      headerMediaUrl: '',
      headerMediaType: '',
      sourceMode: 'phone',
      ...settings,
    },
    templateDefinition: { name: 'confirm_step', language: 'ar', category: 'UTILITY', body: 'hello', bodyVariables: [] },
  };
}

let jobCounter = 0;
function newJob() {
  return { id: `safety-test-${++jobCounter}`, failedRecords: [], sentTrack: [] };
}

function send(runtime = runtimeFor()) {
  return sendTemplateForRow(newJob(), runtime, { name: 'Test', phone_number: PHONE }, CAMPAIGN_KEY);
}

function assertEveryWriteUsesTheReadJustBeforeIt(chatwoot, conversationId) {
  const writes = chatwoot.requests
    .map((request, index) => ({ request, index }))
    .filter(({ request }) => isAttributeWrite(request, conversationId));
  assert.ok(writes.length > 0, 'expected at least one attribute write');
  for (const { request, index } of writes) {
    const previous = chatwoot.requests[index - 1];
    assert.ok(isConversationRead(previous, conversationId), `write #${index} must directly follow a conversation read`);
    const readAttributes = previous.response.custom_attributes || {};
    for (const [key, value] of Object.entries(readAttributes)) {
      if (!isCampaignOwnedAttributeKey(key)) assert.deepEqual(request.body.custom_attributes[key], value, `write #${index} dropped ${key}`);
    }
    for (const key of Object.keys(request.body.custom_attributes)) {
      if (!isCampaignOwnedAttributeKey(key)) assert.ok(key in readAttributes, `write #${index} added foreign key ${key}`);
    }
  }
}

test('A: marking sent preserves attribution fields', async (t) => {
  const attribution = {
    attribution_channel: 'whatsapp',
    attribution_method: 'unknown',
    attribution_unknown_reason: 'referral_evidence_missing',
    customer_source: 'whatsapp',
  };
  const { chatwoot, conversation } = setup(t, { attributes: attribution });

  const result = await send();

  assert.equal(result.status, 'sent');
  const final = chatwoot.attributes(conversation.id);
  for (const [key, value] of Object.entries(attribution)) assert.equal(final[key], value);
  assert.equal(final.api_campaign_status, 'sent');
  assert.equal(final.last_api_campaign_label, 'sept_campaign');
  assert.equal(final.last_api_template, 'confirm_step');
  assert.ok(final[CAMPAIGN_KEY]);
  assert.deepEqual(chatwoot.conversations.get(String(conversation.id)).labels, ['existing_label', 'sept_campaign']);
});

test('B: Majed/Botpress keys survive a campaign write', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { majed_welcome_sent: 'true', bp_state: 'abc' } });

  await send();

  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.majed_welcome_sent, 'true');
  assert.equal(final.bp_state, 'abc');
  assert.equal(final.api_campaign_status, 'sent');
});

test('C: Odoo keys survive a campaign write', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { odoo_lead_id: '123', odoo_stage: 'Qualified' } });

  await send();

  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.odoo_lead_id, '123');
  assert.equal(final.odoo_stage, 'Qualified');
  assert.equal(final.api_campaign_status, 'sent');
});

test('D: older campaign-owned values are updated, other campaigns keep their duplicate keys', async (t) => {
  const { chatwoot, conversation } = setup(t, {
    attributes: {
      api_campaign_label: 'august_campaign',
      api_campaign_created_at: '2026-08-01T10:00:00.000Z',
      api_campaign_status: 'failed',
      api_campaign_last_error: 'old failure',
      api_campaign_active_until: '2026-08-01T10:00:00.000Z',
      api_campaign_reply_assign_mode: 'on_reply_target',
      api_campaign_reply_target_id: '77',
      api_campaign_reply_pending: false,
      api_sent_august_campaign_welcome: '2026-08-01T10:00:00.000Z',
      last_api_campaign_label: 'august_campaign',
      last_api_template: 'welcome',
      attribution_channel: 'whatsapp',
    },
  });

  await send();

  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.api_campaign_label, 'sept_campaign');
  assert.equal(final.api_campaign_created_at, '2026-08-01T10:00:00.000Z');
  assert.equal(final.api_campaign_status, 'sent');
  assert.equal(final.last_api_campaign_label, 'sept_campaign');
  assert.equal(final.last_api_template, 'confirm_step');
  assert.equal('api_campaign_last_error' in final, false);
  assert.equal('api_campaign_reply_assign_mode' in final, false);
  assert.equal('api_campaign_reply_target_id' in final, false);
  assert.equal(final.api_campaign_reply_pending, false);
  assert.equal(final.api_sent_august_campaign_welcome, '2026-08-01T10:00:00.000Z');
  assert.ok(final[CAMPAIGN_KEY]);
  assert.equal(final.attribution_channel, 'whatsapp');
});

test('E: keys written by another integration after the uploader read the conversation are kept', async (t) => {
  const { chatwoot, contact } = setup(t, { newConversation: true });
  let conversationId = null;
  let snapshotRead = false;

  chatwoot.after((request) => request.method === 'POST' && request.path === '/conversations', (request) => {
    conversationId = request.response.id;
  });
  // 1. uploader reads the new conversation's attributes (duplicate-guard snapshot)
  // 2. Insights Hub writes attribution on conversation_created
  chatwoot.after((request) => conversationId && !snapshotRead && isConversationRead(request, conversationId), () => {
    snapshotRead = true;
    chatwoot.otherWriterMerge(conversationId, { attribution_channel: 'whatsapp' });
  });
  // 3. the template send triggers the Odoo Bridge on the same conversation
  chatwoot.after((request) => conversationId && request.method === 'POST' && request.path === `/conversations/${conversationId}/messages`, () => {
    chatwoot.otherWriterMerge(conversationId, { odoo_lead_id: '555' });
  });

  const result = await send();

  assert.equal(result.status, 'sent');
  assert.ok(snapshotRead);
  assert.equal(chatwoot.conversations.get(String(conversationId)).contact_id, contact.id);
  const final = chatwoot.attributes(conversationId);
  assert.equal(final.attribution_channel, 'whatsapp');
  assert.equal(final.odoo_lead_id, '555');
  assert.equal(final.api_campaign_status, 'sent');
  assert.ok(final[CAMPAIGN_KEY]);
});

test('F: without a reply assignment every marker write is built from a fresh read', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { attribution_channel: 'whatsapp' } });
  // Another writer changes the conversation between each of the uploader's
  // requests; only a fresh read right before each write can keep all of them.
  let counter = 0;
  chatwoot.after((request) => !isConversationRead(request, conversation.id) && !isAttributeWrite(request, conversation.id), () => {
    chatwoot.otherWriterMerge(conversation.id, { [`other_integration_${++counter}`]: 'value' });
  });

  const runtime = runtimeFor({ autoAssign: false });
  const result = await send(runtime);

  assert.equal(result.status, 'sent');
  const markerWrites = chatwoot.requests.filter((request) => isAttributeWrite(request, conversation.id));
  assert.equal(markerWrites.length, 2, 'pending + sent');
  assert.equal(markerWrites[0].body.custom_attributes.api_campaign_status, 'pending');
  assert.equal(markerWrites[1].body.custom_attributes.api_campaign_status, 'sent');
  assertEveryWriteUsesTheReadJustBeforeIt(chatwoot, conversation.id);
  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.attribution_channel, 'whatsapp');
  for (let i = 1; i <= counter; i++) assert.equal(final[`other_integration_${i}`], 'value');
});

test('G: a reply assignment still arms first-reply routing and keeps unrelated keys', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { attribution_channel: 'whatsapp', majed_welcome_sent: 'true' } });
  const runtime = runtimeFor({
    autoAssign: true,
    assignmentMode: 'on_reply_team',
    assignmentTargetType: 'team',
    fixedTargetId: '77',
    fixedTargetName: 'Sales',
  });

  const result = await send(runtime);

  assert.equal(result.status, 'sent');
  assertEveryWriteUsesTheReadJustBeforeIt(chatwoot, conversation.id);
  let final = chatwoot.attributes(conversation.id);
  assert.equal(final.api_campaign_reply_assign_mode, 'on_reply_target');
  assert.equal(final.api_campaign_reply_target_type, 'team');
  assert.equal(final.api_campaign_reply_target_id, '77');
  assert.equal(final.api_campaign_reply_team_id, '77');
  assert.equal(final.api_campaign_reply_pending, true);
  assert.equal(final.attribution_channel, 'whatsapp');
  assert.equal(final.majed_welcome_sent, 'true');

  // The customer replies; meanwhile the Odoo Bridge writes its own key.
  process.env.CHATWOOT_URL = 'https://chatwoot.test';
  process.env.CHATWOOT_API_TOKEN = 'test-token';
  t.after(() => { delete process.env.CHATWOOT_URL; delete process.env.CHATWOOT_API_TOKEN; });
  chatwoot.after((request) => request.method === 'POST' && request.path === `/conversations/${conversation.id}/assignments`, () => {
    chatwoot.otherWriterMerge(conversation.id, { odoo_lead_id: '901' });
  });
  const reply = await handleChatwootWebhook({
    event: 'message_created',
    message_type: 'incoming',
    account: { id: 2 },
    conversation: { id: conversation.id },
  });

  assert.equal(reply.status, 'assigned');
  assertEveryWriteUsesTheReadJustBeforeIt(chatwoot, conversation.id);
  final = chatwoot.attributes(conversation.id);
  assert.equal(final.api_campaign_reply_pending, false);
  assert.ok(final.api_campaign_reply_assigned_at);
  assert.equal(final.attribution_channel, 'whatsapp');
  assert.equal(final.majed_welcome_sent, 'true');
  assert.equal(final.odoo_lead_id, '901');
});

test('H: a failed send marks failure without dropping unrelated keys', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { attribution_channel: 'whatsapp', odoo_stage: 'New' } });
  chatwoot.nextMessageStatus = 'failed';
  chatwoot.after((request) => request.method === 'POST' && request.path === `/conversations/${conversation.id}/messages`, () => {
    chatwoot.otherWriterMerge(conversation.id, { bp_state: 'after-send' });
  });

  await assert.rejects(send(), /Delivery failed/);

  assertEveryWriteUsesTheReadJustBeforeIt(chatwoot, conversation.id);
  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.api_campaign_status, 'failed');
  assert.match(final.api_campaign_last_error, /Delivery failed/);
  assert.equal(final[CAMPAIGN_KEY], undefined);
  assert.equal(final.attribution_channel, 'whatsapp');
  assert.equal(final.odoo_stage, 'New');
  assert.equal(final.bp_state, 'after-send');
});

test('I: a write raced once is retried and verified', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { attribution_channel: 'whatsapp' } });
  let raced = false;
  // Right after the uploader's first write, a stale writer puts back the hash
  // it read earlier (without the campaign marker) plus its own new key.
  chatwoot.after((request) => !raced && isAttributeWrite(request, conversation.id), () => {
    raced = true;
    chatwoot.otherWriterReplace(conversation.id, { attribution_channel: 'whatsapp', attribution_method: 'ctwa' });
  });

  const result = await send();

  assert.equal(result.status, 'sent');
  const writes = chatwoot.requests.filter((request) => isAttributeWrite(request, conversation.id));
  assert.equal(writes.length, 3, 'pending retried once, then sent');
  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.attribution_method, 'ctwa');
  assert.equal(final.api_campaign_status, 'sent');
});

test('I: a write that never verifies stops after the maximum attempts and nothing is sent', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { attribution_channel: 'whatsapp' } });
  chatwoot.after((request) => isAttributeWrite(request, conversation.id), () => {
    chatwoot.otherWriterReplace(conversation.id, { attribution_channel: 'whatsapp' });
  });

  await assert.rejects(send(), new RegExp(`did not verify after ${MAX_ATTRIBUTE_WRITE_ATTEMPTS} attempts`));

  const writes = chatwoot.requests.filter((request) => isAttributeWrite(request, conversation.id));
  assert.equal(MAX_ATTRIBUTE_WRITE_ATTEMPTS, 3);
  assert.equal(writes.length, 3);
  assert.equal(chatwoot.requests.some((request) => request.path.endsWith('/messages')), false);
  assert.equal(chatwoot.attributes(conversation.id).attribution_channel, 'whatsapp');
});

test('a transient write failure starts over from a fresh read instead of resending the old hash', async (t) => {
  const { chatwoot, conversation } = setup(t, { attributes: { attribution_channel: 'whatsapp' } });
  chatwoot.failOnce((request) => isAttributeWrite(request, conversation.id), 502);
  chatwoot.after((request) => isAttributeWrite(request, conversation.id) && request.response.error, () => {
    chatwoot.otherWriterMerge(conversation.id, { odoo_lead_id: '777' });
  });

  const result = await send();

  assert.equal(result.status, 'sent');
  assertEveryWriteUsesTheReadJustBeforeIt(chatwoot, conversation.id);
  const final = chatwoot.attributes(conversation.id);
  assert.equal(final.odoo_lead_id, '777');
  assert.equal(final.attribution_channel, 'whatsapp');
  assert.equal(final.api_campaign_status, 'sent');
});
