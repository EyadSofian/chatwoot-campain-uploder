const locks = new Map();

export function withConversationLock(accountId, conversationId, fn) {
  const key = `${String(accountId)}:${String(conversationId)}`;
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.then(fn);
  // The caller handles current's rejection; the queue entry must never reject,
  // or a failed write becomes an unhandled rejection that kills the process.
  const tracked = current.catch(() => {}).finally(() => {
    if (locks.get(key) === tracked) locks.delete(key);
  });
  locks.set(key, tracked);
  return current;
}
