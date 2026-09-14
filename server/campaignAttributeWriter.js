import { withConversationLock } from './conversationLocks.js';
import { assertCampaignOwnedChanges, isCampaignOwnedAttributeKey } from './campaignMarkers.js';

export const MAX_ATTRIBUTE_WRITE_ATTEMPTS = 3;

// The only way the uploader writes conversation custom attributes. Chatwoot
// replaces the whole hash on every POST, so each attempt re-reads the
// conversation, merges only campaign-owned changes onto that fresh copy, writes
// it, and reads it back to confirm our values landed and nothing unrelated was
// dropped. A failed check (another integration raced the write) retries the
// whole read-merge-write, up to maxAttempts.
export function updateCampaignAttributes(options) {
  return withConversationLock(
    options.accountId,
    options.conversationId,
    () => updateCampaignAttributesLocked(options)
  );
}

// Same as updateCampaignAttributes for callers that already hold
// withConversationLock for this conversation (the lock is not re-entrant).
export async function updateCampaignAttributesLocked({
  conversationId,
  readConversation,
  writeAttributes,
  buildChanges,
  maxAttempts = MAX_ATTRIBUTE_WRITE_ATTEMPTS,
  retryDelayMs = 250,
  onRetry = async () => {},
}) {
  let problems = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const conversation = await readConversation();
    if (!conversation) {
      throw new Error(`Conversation #${conversationId} could not be read before updating campaign attributes`);
    }
    const before = { ...(conversation.custom_attributes || {}) };
    const changes = assertCampaignOwnedChanges(buildChanges(before, conversation));
    try {
      await writeAttributes(mergeCampaignOwnedChanges(before, changes));
      const verified = await readConversation();
      problems = findVerificationProblems(before, verified?.custom_attributes, changes);
      if (!problems.length) {
        return { attempts: attempt, before, after: verified.custom_attributes, changes };
      }
    } catch (err) {
      // A transient write failure may or may not have landed; start over from
      // a fresh read rather than resending the same hash.
      if (!err.retryable || attempt === maxAttempts) throw err;
      problems = [err.message];
    }

    if (attempt < maxAttempts) {
      await onRetry({ attempt, problems });
      if (retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw new Error(
    `Campaign attributes on conversation #${conversationId} did not verify after ${maxAttempts} attempts: ${problems.join('; ')}`
  );
}

export function mergeCampaignOwnedChanges(current, { set = {}, remove = [] }) {
  const merged = { ...(current || {}) };
  for (const key of remove) delete merged[key];
  return Object.assign(merged, set);
}

export function findVerificationProblems(before, after, { set = {}, remove = [] }) {
  const problems = [];
  if (!after || typeof after !== 'object') return ['conversation could not be re-read'];
  for (const [key, value] of Object.entries(set)) {
    if (!sameValue(after[key], value)) problems.push(`${key} is ${JSON.stringify(after[key])}, expected ${JSON.stringify(value)}`);
  }
  for (const key of remove) {
    if (Object.prototype.hasOwnProperty.call(after, key)) problems.push(`${key} should have been removed`);
  }
  for (const key of Object.keys(before || {})) {
    if (!isCampaignOwnedAttributeKey(key) && !Object.prototype.hasOwnProperty.call(after, key)) {
      problems.push(`unrelated attribute ${key} disappeared`);
    }
  }
  return problems;
}

function sameValue(actual, expected) {
  if (actual === expected) return true;
  if (actual == null || expected == null) return false;
  return String(actual) === String(expected);
}
