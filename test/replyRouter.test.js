import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRoundRobinMember } from '../server/replyRouter.js';

test('reply router distributes assignments round-robin across confirmed team members', () => {
  const state = {};
  const members = [
    { id: 9, name: 'Third' },
    { id: 3, name: 'First' },
    { id: 7, name: 'Second' },
    { id: 4, name: 'Unconfirmed', confirmed: false },
  ];

  assert.equal(pickRoundRobinMember(members, state, 'team:1').id, 3);
  assert.equal(pickRoundRobinMember(members, state, 'team:1').id, 7);
  assert.equal(pickRoundRobinMember(members, state, 'team:1').id, 9);
  assert.equal(pickRoundRobinMember(members, state, 'team:1').id, 3);
  assert.equal(state.teams['team:1'].nextIndex, 1);
});
