import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCmrpReplies } from '../server/cmrpReconcile.js';

test('reconciles the latest yes/no answer in an invited conversation', async (t) => {
  const old = process.env.CHATWOOT_API_TOKEN;
  process.env.CHATWOOT_API_TOKEN = 'test';
  t.after(() => { if (old === undefined) delete process.env.CHATWOOT_API_TOKEN; else process.env.CHATWOOT_API_TOKEN = old; });
  const now = Date.parse('2026-10-19T12:00:00Z');
  const handled = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const data = path.endsWith('/conversations')
      ? { data: { payload: [{ id: 55, inbox_id: 25, labels: ['cmrp_webinar_2026_10_20_invite'], last_activity_at: now / 1000, custom_attributes: { api_campaign_marked_at: '2026-10-19T11:00:00Z' } }] } }
      : { payload: [
        { id: 10, message_type: 0, content: 'نعم', created_at: now / 1000 - 60 },
        { id: 11, message_type: 0, content: 'لا', created_at: now / 1000 },
      ] };
    return { ok: true, json: async () => data };
  };
  const result = await reconcileCmrpReplies({ now, fetchImpl, handleMessage: async (payload) => handled.push(payload) });
  assert.deepEqual(result, { inspected: 1, replies: 1 });
  assert.equal(handled[0].content, 'لا');
  assert.equal(handled[0].conversation.id, 55);
});
