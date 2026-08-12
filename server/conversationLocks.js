const locks = new Map();

export function withConversationLock(accountId, conversationId, fn) {
  const key = `${String(accountId)}:${String(conversationId)}`;
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  const tracked = current.finally(() => {
    if (locks.get(key) === tracked) locks.delete(key);
  });
  locks.set(key, tracked);
  return current;
}
