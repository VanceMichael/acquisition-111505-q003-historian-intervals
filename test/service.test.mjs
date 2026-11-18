import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
test('真实 HTTP 人工入口与查询使用同一归档', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-')); const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const response = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  assert.equal(response.status, 201); assert.equal((await response.json()).version, 1);
  assert.equal((await (await fetch(base + '/api/records')).json()).length, 1);
  const invalid = await fetch(base + '/api/manual', { method: 'POST', body: '{' }); assert.equal(invalid.status, 400);
});

test('HTTP 区间领取、查询与三态报告', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-history-'));
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const source = `http://127.0.0.1:${provider.address().port}`;
  const service = await createIntake(directory, { source }); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const request = { point: 'store-temperature', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' };
  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(collected.status, 200);
  const result = await collected.json();
  assert.equal(result.complete, true); assert.equal(result.pages, 3);
  assert.equal(result.artifacts[0].measurement, false);
  assert.equal(result.requested.point, 'store-temperature');

  // /api/records 仍只返回人工收件；来源接入有独立查询。
  assert.equal((await (await fetch(base + '/api/records')).json()).length, 0);
  assert.equal((await (await fetch(base + '/api/intervals?point=store-temperature')).json()).length, 1);
  assert.equal((await (await fetch(base + '/api/observations?point=store-temperature')).json()).length, 3);

  const report = await (await fetch(base + '/api/acquisition?' + new URLSearchParams(request))).json();
  assert.equal(report.readComplete, true);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.summary.noMeasurement, false);

  const later = await fetch(base + '/api/acquisition?' + new URLSearchParams({ ...request, start: '2026-11-02T00:00:00Z', end: '2026-11-02T00:03:00Z' }));
  const pending = await later.json();
  assert.equal(pending.readComplete, false);
  assert.equal(pending.summary.noMeasurement, false);

  const badRequest = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, start: request.end, end: request.start }) });
  assert.equal(badRequest.status, 422);
  const badOrigin = await fetch(base + '/api/intervals?origin=' + encodeURIComponent('file:///etc/passwd'));
  assert.equal(badOrigin.status, 422);
});
