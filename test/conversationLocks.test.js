import test from 'node:test';
import assert from 'node:assert/strict';
import { withConversationLock } from '../server/conversationLocks.js';

test('conversation work is serialized for the same account and conversation', async () => {
  const events = [];
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });

  const first = withConversationLock('2', '900', async () => {
    events.push('first:start');
    await firstCanFinish;
    events.push('first:end');
  });
  const second = withConversationLock('2', '900', async () => {
    events.push('second:start');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('a failing lock body rejects only for its caller and releases the lock', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      withConversationLock('2', '901', async () => { throw new Error('write failed'); }),
      /write failed/
    );
    const next = await withConversationLock('2', '901', async () => 'next ran');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(next, 'next ran');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
