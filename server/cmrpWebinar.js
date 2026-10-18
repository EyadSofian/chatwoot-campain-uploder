import fs from 'fs/promises';
import path from 'path';
import { withConversationLock } from './conversationLocks.js';

export const CMRP_WORKFLOW_ID = 'cmrp_2026_10_20';
export const CMRP_INVITE_LABEL = 'cmrp_webinar_2026_10_20_invite';
const ACCOUNT_ID = '2';
const INBOX_ID = '25';
const EVENT_END = Date.parse('2026-10-20T19:00:00+03:00');
const STORE_DIR = path.join(process.env.JOBS_DIR || path.join(process.cwd(), 'data'), 'workflows', CMRP_WORKFLOW_ID);
const JOIN_MESSAGE = 'شكراً لتأكيد اهتمامك بويبينار CMRP المجاني من Engosoft. موعدنا الثلاثاء 20 أكتوبر الساعة 7:00 مساءً بتوقيت القاهرة مع م. أحمد النمر. رابط الدخول: https://engosoft.zoom.us/j/84015784342 الرقم السري: 123';

export function normalizeWebinarReply(content) {
  const value = String(content || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[!?.،؛\s]+/g, '');
  if (['نعم', 'ايوه', 'أيوه', 'اه', 'أه', 'yes', 'y'].includes(value)) return 'yes';
  if (['لا', 'لأ', 'no', 'n'].includes(value)) return 'no';
  return null;
}

export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

export function isWebinarOptedInState(state) {
  return state?.answer === 'yes' && Boolean(state?.confirmedAt);
}

export async function isCmrpWebinarOptedIn(phone) {
  const value = normalizePhone(phone);
  if (!value) return false;
  const state = await readState(value);
  return isWebinarOptedInState(state);
}

export async function handleCmrpWebinarReply(payload, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (payload?.event !== 'message_created' || payload?.private === true ||
      !['incoming', 0].includes(payload?.message_type)) return { status: 'skipped', reason: 'not_incoming' };
  const accountId = String(payload?.account?.id || payload?.account_id || payload?.conversation?.account_id || '');
  const conversationId = payload?.conversation?.id || payload?.conversation_id;
  const inboxId = String(payload?.conversation?.inbox_id || payload?.inbox?.id || '');
  const answer = normalizeWebinarReply(payload?.content || payload?.message?.content);
  if (accountId !== ACCOUNT_ID || !conversationId || (inboxId && inboxId !== INBOX_ID) || !answer) {
    return { status: 'skipped', reason: 'not_target_reply' };
  }
  if (now >= EVENT_END) return { status: 'skipped', reason: 'event_ended' };

  const token = String(process.env.CHATWOOT_API_TOKEN || '').trim();
  if (!token) throw new Error('CHATWOOT_API_TOKEN is required for CMRP replies');
  const baseUrl = String(process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, '');
  const request = async (relative, method = 'GET', body) => {
    const response = await fetchImpl(`${baseUrl}/api/v1/accounts/${ACCOUNT_ID}${relative}`, {
      method,
      headers: { 'Content-Type': 'application/json', api_access_token: token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`CMRP Chatwoot ${method} ${relative}: HTTP ${response.status}`);
    return result.payload || result;
  };

  return withConversationLock(accountId, conversationId, async () => {
    const conversation = await request(`/conversations/${conversationId}`);
    if (String(conversation?.inbox_id || conversation?.meta?.inbox?.id || '') !== INBOX_ID) {
      return { status: 'skipped', reason: 'wrong_inbox' };
    }
    const labels = (conversation?.labels || []).map((label) => typeof label === 'string' ? label : label?.title);
    const marker = String(conversation?.custom_attributes?.api_campaign_label || '');
    if (marker !== CMRP_INVITE_LABEL && !labels.includes(CMRP_INVITE_LABEL)) {
      return { status: 'skipped', reason: 'not_invited' };
    }
    const phone = normalizePhone(
      conversation?.meta?.sender?.phone_number || conversation?.contact?.phone_number ||
      payload?.sender?.phone_number || payload?.conversation?.meta?.sender?.phone_number
    );
    if (!phone) throw new Error(`CMRP reply on conversation ${conversationId} has no valid phone`);
    const previous = await readState(phone);
    if (previous?.answer === answer) return { status: 'skipped', reason: 'same_answer' };
    if (answer === 'yes') {
      await request(`/conversations/${conversationId}/messages`, 'POST', {
        content: JOIN_MESSAGE,
        message_type: 'outgoing',
        private: false,
        content_type: 'text',
      });
    }
    await writeState(phone, {
      answer,
      confirmedAt: answer === 'yes' ? new Date(now).toISOString() : null,
      conversationId: String(conversationId),
      updatedAt: new Date(now).toISOString(),
    });
    return { status: answer === 'yes' ? 'confirmed' : 'declined', conversationId: String(conversationId) };
  });
}

async function readState(phone) {
  try { return JSON.parse(await fs.readFile(path.join(STORE_DIR, `${phone}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeState(phone, state) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const destination = path.join(STORE_DIR, `${phone}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, destination);
}
