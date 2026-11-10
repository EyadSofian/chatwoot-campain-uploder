import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedReport, projectJob } from '../server/broadcastReporting.js';

test('report requires exact server credential', () => {
  assert.equal(authorizedReport('Bearer abc', 'abc'), true);
  assert.equal(authorizedReport('Bearer abcd', 'abc'), false);
  assert.equal(authorizedReport('', ''), false);
});
test('recipient projection is dated, deduplicated, and contains no settings or message content', () => {
  const item = { convId: 7, msgId: 8, row: { phone_number: '+201000000000', name: 'Private', secret: 'never-export' } };
  const job = { id: 'job', type: 'send', createdAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-03T00:00:00Z',
    settings: { apiToken: 'never-export', bodyParams: 'never-export', labelName: 'cfm', templateCategory: 'MARKETING' }, sentTrack: [item, item] };
  const logs = JSON.stringify({ ts: '2026-10-02T12:00:00Z', message: 'Template sent and recorded in conversation #7' });
  const r = projectJob(job, logs, '2026-10-01', '2026-10-31');
  assert.equal(r.accepted, 1);
  assert.equal(r.events[0].acceptedAt, '2026-10-02T12:00:00Z');
  assert.equal(r.events[0].timeBasis, 'send_log');
  assert.ok(!JSON.stringify(r).includes('never-export'));
  assert.ok(!JSON.stringify(r).includes('Private'));
  assert.equal(projectJob(job, logs, '2026-11-01', '2026-11-30'), null);
  assert.equal(projectJob({ ...job, type: 'upload' }, logs, '2026-10-01', '2026-10-31'), null);
});
test('old jobs use a labelled upper bound; queued/running undated rows are not invented', () => {
  const job = { id: 'j', type: 'send', createdAt: '2026-10-01T00:00:00Z', sentTrack: [{ convId: 1, row: { phone_number: '+966500000000' } }] };
  assert.equal(projectJob(job, '', '2026-10-01', '2026-10-31').accepted, 0);
  const r = projectJob({ ...job, finishedAt: '2026-10-03T00:00:00Z' }, '', '2026-10-01', '2026-10-31');
  assert.equal(r.events[0].timeBasis, 'job_finished_upper_bound');
});
