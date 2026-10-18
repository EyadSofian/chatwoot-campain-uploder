import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cmrp-webinar-test-'));
process.env.JOBS_DIR = directory;
process.env.CHATWOOT_API_TOKEN = 'test-token';
const { handleCmrpWebinarReply, isCmrpWebinarOptedIn, normalizeWebinarReply } = await import('../server/cmrpWebinar.js');

test('recognizes clear yes and no answers only', () => {
  assert.equal(normalizeWebinarReply(' نعم! '), 'yes');
  assert.equal(normalizeWebinarReply('لأ'), 'no');
  assert.equal(normalizeWebinarReply('ممكن التفاصيل؟'), null);
});

test('invited reply receives join details once and controls reminder eligibility', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === 'GET') return {
      ok: true,
      json: async () => ({ id: 123, inbox_id: 25,
        labels: ['cmrp_webinar_2026_10_20_invite'],
        meta: { sender: { phone_number: '+966500000001' } },
      }),
    };
    return { ok: true, json: async () => ({ id: 456 }) };
  };
  const payload = { event: 'message_created', message_type: 'incoming', content: 'نعم',
    account: { id: 2 }, conversation: { id: 123, inbox_id: 25 } };
  const now = Date.parse('2026-10-18T18:00:00+03:00');
  assert.equal((await handleCmrpWebinarReply(payload, { now, fetchImpl })).status, 'confirmed');
  assert.equal(await isCmrpWebinarOptedIn('966500000001'), true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(calls.find((call) => call.method === 'POST').body.content, /84015784342/);
  assert.equal((await handleCmrpWebinarReply(payload, { now, fetchImpl })).reason, 'same_answer');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal((await handleCmrpWebinarReply({ ...payload, content: 'لا' }, { now, fetchImpl })).status, 'declined');
  assert.equal(await isCmrpWebinarOptedIn('966500000001'), false);
});

test('does not process a reply outside the campaign inbox', async () => {
  const result = await handleCmrpWebinarReply({ event: 'message_created', message_type: 'incoming',
    content: 'نعم', account: { id: 2 }, conversation: { id: 124, inbox_id: 27 } },
  { now: Date.parse('2026-10-18T18:00:00+03:00'), fetchImpl: () => { throw new Error('unexpected'); } });
  assert.equal(result.reason, 'not_target_reply');
});

test.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
