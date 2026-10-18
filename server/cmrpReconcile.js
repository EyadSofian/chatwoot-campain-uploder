import { CMRP_INVITE_LABEL, handleCmrpWebinarReply, normalizeWebinarReply } from './cmrpWebinar.js';
import { handleChatwootWebhook } from './replyRouter.js';

const ACCOUNT_ID = '2';
const INBOX_ID = '25';
const EVENT_START = Date.parse('2026-10-20T19:00:00+03:00');
const LOOKBACK_MS = 5 * 60 * 1000;
const MAX_PAGES = 20;

export async function reconcileCmrpReplies({
  now = Date.now(),
  fetchImpl = fetch,
  handleMessage = async (payload) => {
    await handleCmrpWebinarReply(payload);
    await handleChatwootWebhook(payload);
  },
} = {}) {
  const token = String(process.env.CHATWOOT_API_TOKEN || '').trim();
  if (!token || now >= EVENT_START) return { inspected: 0, replies: 0 };
  const base = String(process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, '');
  const get = async (path) => {
    const response = await fetchImpl(`${base}/api/v1/accounts/${ACCOUNT_ID}${path}`, {
      headers: { api_access_token: token }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`CMRP reconciliation GET ${path}: HTTP ${response.status}`);
    return response.json();
  };
  let inspected = 0;
  let replies = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ status: 'all', labels: CMRP_INVITE_LABEL, page: String(page) });
    const result = await get(`/conversations?${query}`);
    const conversations = result?.data?.payload || [];
    if (!conversations.length) break;
    let reachedOlder = false;
    for (const conversation of conversations) {
      if (Number(conversation.last_activity_at || 0) * 1000 < now - LOOKBACK_MS) {
        reachedOlder = true;
        continue;
      }
      if (String(conversation.inbox_id) !== INBOX_ID || !conversation.labels?.includes(CMRP_INVITE_LABEL)) continue;
      inspected++;
      try {
        const messages = (await get(`/conversations/${conversation.id}/messages`))?.payload || [];
        const invitationAt = Date.parse(conversation.custom_attributes?.api_campaign_marked_at || '');
        const latestAnswer = messages.filter((message) => (
          (message.message_type === 0 || message.message_type === 'incoming') &&
          !message.private && normalizeWebinarReply(message.content) &&
          (!Number.isFinite(invitationAt) || Number(message.created_at || 0) * 1000 >= invitationAt)
        )).sort((a, b) => Number(b.id) - Number(a.id))[0];
        if (!latestAnswer) continue;
        const payload = {
          event: 'message_created', account: { id: Number(ACCOUNT_ID) },
          conversation: { id: conversation.id, inbox_id: Number(INBOX_ID) },
          id: latestAnswer.id, message_type: 'incoming', private: false,
          content: latestAnswer.content,
        };
        await handleMessage(payload);
        replies++;
      } catch (error) {
        console.error(`[cmrp-reconcile] Conversation #${conversation.id}: ${error.message}`);
      }
    }
    if (reachedOlder || conversations.length < 25) break;
  }
  return { inspected, replies };
}

export function startCmrpReplyReconciler() {
  if (!process.env.CHATWOOT_API_TOKEN) return;
  const tick = () => reconcileCmrpReplies().catch((error) => console.error(`[cmrp-reconcile] ${error.message}`));
  setTimeout(tick, 15000).unref();
  setInterval(tick, 60000).unref();
}
