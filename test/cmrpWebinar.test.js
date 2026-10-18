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
    if (url.endsWith('/messages') && options.method === 'GET') return {
      ok: true, json: async () => ({ payload: [] }),
    };
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

test('a delivered join message prevents another send when local state is missing', async () => {
  let writes = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') { writes++; return { ok: true, json: async () => ({ id: 456 }) }; }
    if (url.endsWith('/messages')) return { ok: true, json: async () => ({ payload: [{
      message_type: 1, status: 'delivered',
      content: 'شكراً لتأكيد اهتمامك بويبينار CMRP المجاني من Engosoft. موعدنا الثلاثاء 20 أكتوبر الساعة 7:00 مساءً بتوقيت القاهرة مع م. أحمد النمر. رابط الدخول: https://engosoft.zoom.us/j/84015784342 الرقم السري: 123',
    }] }) };
    return { ok: true, json: async () => ({
      id: 125, inbox_id: 25, labels: ['cmrp_webinar_2026_10_20_invite'],
      meta: { sender: { phone_number: '+966500000002' } },
    }) };
  };
  const result = await handleCmrpWebinarReply({
    event: 'message_created', message_type: 'incoming', content: 'نعم',
    account: { id: 2 }, conversation: { id: 125, inbox_id: 25 },
  }, { now: Date.parse('2026-10-18T18:00:00+03:00'), fetchImpl });
  assert.equal(result.status, 'confirmed');
  assert.equal(writes, 0);
  assert.equal(await isCmrpWebinarOptedIn('966500000002'), true);
});

test('does not process a reply outside the campaign inbox', async () => {
  const result = await handleCmrpWebinarReply({ event: 'message_created', message_type: 'incoming',
    content: 'نعم', account: { id: 2 }, conversation: { id: 124, inbox_id: 27 } },
  { now: Date.parse('2026-10-18T18:00:00+03:00'), fetchImpl: () => { throw new Error('unexpected'); } });
  assert.equal(result.reason, 'not_target_reply');
});

test.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
