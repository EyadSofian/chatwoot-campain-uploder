import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRoundRobinIndex } from '../server/replyRouter.js';

test('round-robin starts at the first member when never used', () => {
  assert.equal(nextRoundRobinIndex(undefined, 3), 0);
  assert.equal(nextRoundRobinIndex(-1, 3), 0);
  assert.equal(nextRoundRobinIndex('x', 3), 0);
});

test('round-robin advances and wraps around the team evenly', () => {
  const length = 3;
  const seen = [];
  let prev;
  for (let i = 0; i < 7; i++) {
    prev = nextRoundRobinIndex(prev, length);
    seen.push(prev);
  }
  assert.deepEqual(seen, [0, 1, 2, 0, 1, 2, 0]);
});

test('round-robin tolerates empty or invalid team sizes', () => {
  assert.equal(nextRoundRobinIndex(2, 0), 0);
  assert.equal(nextRoundRobinIndex(2, -1), 0);
  assert.equal(nextRoundRobinIndex(2, NaN), 0);
});
