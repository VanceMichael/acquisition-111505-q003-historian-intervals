import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

async function setup(context) {
  const directory = await mkdtemp(join(tmpdir(), 'http-'));
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const service = await createIntake(directory, { collectorOptions: { sourceUrl: `http://127.0.0.1:${provider.address().port}` } });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${service.address().port}` };
}

const waitJob = async (base, id) => {
  let job;
  do { await new Promise(resolve => setImmediate(resolve)); job = await (await fetch(`${base}/api/jobs/${id}`)).json(); } while (job.status === 'running');
  return job;
};

test('历史区间采集任务从受理到覆盖判定的完整 HTTP 流程', async context => {
  const { base } = await setup(context);
  const health = await (await fetch(base + '/health')).json();
  assert.deepEqual(health.acquisition, ['manual', 'history-interval']);
  const response = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ point: 'store-temperature', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' }),
  });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  const job = await waitJob(base, accepted.job);
  assert.equal(job.status, 'complete');

  const coverage = await (await fetch(base + '/api/coverage?point=store-temperature&start=2026-11-01T00:00:00Z&end=2026-11-01T00:03:00Z')).json();
  assert.equal(coverage.state, 'covered');
  assert.equal(coverage.observations, 3);
  assert.equal(coverage.unreliable, 1);

  const readings = await (await fetch(base + '/api/readings?point=store-temperature&start=2026-11-01T00:00:00Z&end=2026-11-01T00:03:00Z')).json();
  assert.ok(readings.readings.every(row => row.kind === 'raw'));
  const boundaries = await (await fetch(base + '/api/boundaries?point=store-temperature&start=2026-11-01T00:00:00Z&end=2026-11-01T00:03:00Z')).json();
  assert.ok(boundaries.values.every(row => row.kind !== 'raw'));
  assert.equal((await (await fetch(base + '/api/jobs')).json()).length, 1);
});

test('非法区间与坏请求返回 4xx，不创建任务', async context => {
  const { base } = await setup(context);
  const bad = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ point: 'p', start: '2026-11-01T01:00:00Z', end: '2026-11-01T00:00:00Z' }),
  });
  assert.equal(bad.status, 422);
  const invalid = await fetch(base + '/api/collect', { method: 'POST', body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await (await fetch(base + '/api/jobs')).json(), []);
});
