import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createProvider } from '../provider/server.mjs';
import { Archive } from '../src/archive.mjs';
import { HistoryCollector, RAW_SOURCE, BOUNDARY_SOURCE } from '../src/collector.mjs';

async function withProvider(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  return `http://127.0.0.1:${service.address().port}`;
}

const waitFor = async (collector, id) => {
  let job;
  do { await new Promise(resolve => setImmediate(resolve)); job = await collector.getJob(id); } while (job.status === 'running');
  return job;
};

test('完整区间采集：翻完分页、剔除边界值、保留质量与修订', async context => {
  const sourceUrl = await withProvider(context);
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = await new Archive(directory).initialize();
  const collector = await new HistoryCollector(archive, { sourceUrl }).initialize();
  const control = value => fetch(sourceUrl + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  await control({ revision: 2 });
  const started = await collector.startJob('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  const job = await waitFor(collector, started.id);
  assert.equal(job.status, 'complete');
  assert.equal(job.pagesRead, 3); // 含一个空中间页，空页带 next 仍继续
  assert.equal(job.acceptedRaw, 4); // rev1 bad、rev2 good 同时保留
  assert.equal(job.acceptedBoundary, 1);
  assert.ok(job.revisions && Array.isArray(job.revisions.replaces));
  assert.ok(job.pageBlobs.every(hash => /^[0-9a-f]{64}$/.test(hash)));

  const readings = await collector.readReadings('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  assert.equal(readings.length, 4);
  assert.ok(readings.every(row => row.kind === 'raw'));
  const atOne = readings.filter(row => row.sourceTime === '2026-11-01T00:01:00Z');
  assert.equal(atOne.length, 2);
  assert.deepEqual(atOne.map(row => row.revision).sort(), [1, 2]);
  assert.equal(atOne.find(row => row.revision === 1).quality, 'bad'); // 不合格值不静默丢弃
  assert.equal(atOne.find(row => row.revision === 1).qualityState, 'unreliable');
  assert.equal(atOne.find(row => row.revision === 2).qualityState, 'reliable');

  const boundaries = await collector.readBoundaryValues('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].kind, 'bounding');
  assert.equal(boundaries[0].sourceTime, '2026-11-01T00:00:00Z');

  const covered = await collector.coverage('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  assert.equal(covered.state, 'covered');
  assert.equal(covered.unreliable, 1);
  assert.equal(covered.reliable, 3);
  // 归档层面两个来源严格分开
  const sources = (await archive.list()).map(record => record.source);
  assert.ok(sources.includes(RAW_SOURCE) && sources.includes(BOUNDARY_SOURCE));
});

test('补采范围可拼接、重叠与扩展，交界处不漏观测', async context => {
  const sourceUrl = await withProvider(context);
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = await new Archive(directory).initialize();
  const collector = await new HistoryCollector(archive, { sourceUrl }).initialize();
  const run = async (start, end) => {
    const job = await collector.startJob('store-temperature', start, end);
    const finished = await waitFor(collector, job.id);
    assert.equal(finished.status, 'complete');
  };
  await run('2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z'); // 00:00 一条
  await run('2026-11-01T00:01:00Z', '2026-11-01T00:02:00Z'); // 左闭：00:01 一条
  const first = await collector.coverage('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:02:00Z');
  assert.equal(first.state, 'covered');
  assert.deepEqual(first.covered, [{ start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:02:00Z' }]);

  // 重叠重采：同一原文复用版本，修订依据不被抹掉
  const business = rows => rows.map(({ sourceTime, revision, value, quality, kind, versions }) => ({ sourceTime, revision, value, quality, kind, versions }));
  const before = business(await collector.readReadings('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:02:00Z'));
  await run('2026-11-01T00:00:30Z', '2026-11-01T00:01:30Z');
  const after = business(await collector.readReadings('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:02:00Z'));
  assert.deepEqual(after, before);
  const jobs = await collector.listJobs();
  const overlapJob = jobs.find(job => job.start === '2026-11-01T00:00:30Z');
  assert.equal(overlapJob.duplicateRaw, 1); // 00:01 已在第二个任务采过
  assert.equal(overlapJob.acceptedRaw, 0);
  assert.equal(overlapJob.duplicateBoundary, 0); // boundary 在 00:00，不在本次区间内
  // 扩展更大区间后整体仍可判定读完
  await run('2026-11-01T00:02:00Z', '2026-11-01T00:03:00Z');
  assert.equal((await collector.coverage('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z')).state, 'covered');
});

test('未采集与部分采集可以与已读完区分', async context => {
  const sourceUrl = await withProvider(context);
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const collector = await new HistoryCollector(await new Archive(directory).initialize(), { sourceUrl }).initialize();
  assert.equal((await collector.coverage('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z')).state, 'none');
  const job = await collector.startJob('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:02:00Z');
  await waitFor(collector, job.id);
  const partial = await collector.coverage('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.gaps, [{ start: '2026-11-01T00:02:00Z', end: '2026-11-01T00:03:00Z' }]);
});

function fakeRequester(pages, options = {}) {
  let calls = 0;
  const sentBodies = [];
  const requester = {
    calls: () => calls,
    bodies: sentBodies,
    request(url, init = {}) {
      calls += 1;
      const body = JSON.parse(init.body || '{}');
      sentBodies.push(body);
      if (options.failAt === calls) return Promise.reject(new Error('来源连接失败'));
      if (options.badContinuationAt === calls) return Promise.resolve({ status: 409, bytes: Buffer.from(JSON.stringify({ error: 'badContinuation' })) });
      if (String(url).endsWith('/history/revisions')) {
        return Promise.resolve({ status: 200, bytes: Buffer.from(JSON.stringify({ point: body.point || 'p', replaces: [] })) });
      }
      const readCalls = sentBodies.filter(item => 'start' in item).length;
      const page = pages[Math.min(readCalls - 1, pages.length - 1)];
      return Promise.resolve({ status: 200, bytes: Buffer.from(JSON.stringify(page)) });
    },
    decodeJson(reply) {
      if (reply.status < 200 || reply.status > 299) throw new Error(`来源返回 ${reply.status}`);
      return JSON.parse(reply.bytes.toString('utf8'));
    },
  };
  return requester;
}

test('来源失败或凭据失配时任务失败且区间不算读完', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const pages = [{ values: [], next: 'tok:1' }, { values: [], next: null }];
  const failing = fakeRequester(pages, { failAt: 2 });
  const collector = await new HistoryCollector(await new Archive(directory).initialize(), { requester: failing }).initialize();
  const job = await waitFor(collector, (await collector.startJob('p', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z')).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /连接失败/);
  assert.deepEqual(await collector.readCoverage('p'), []);

  const badToken = fakeRequester(pages, { badContinuationAt: 2 });
  const other = await new HistoryCollector(await new Archive(directory).initialize(), { requester: badToken }).initialize();
  const failedJob = await waitFor(other, (await other.startJob('q', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z')).id);
  assert.equal(failedJob.status, 'failed');
  assert.match(failedJob.error, /409/);
});

test('非法读数会使任务失败，未知 kind 不被当作真实测量', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const requester = fakeRequester([
    { values: [{ sourceTime: '2026-11-01T00:00:00Z', value: 1, quality: 'good', kind: 'mystery' }], next: null },
  ]);
  const collector = await new HistoryCollector(await new Archive(directory).initialize(), { requester }).initialize();
  const job = await waitFor(collector, (await collector.startJob('p', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z')).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /未知 kind/);
  assert.deepEqual(await collector.readCoverage('p'), []);
});

test('进程重启后运行中任务转为 interrupted，重新采集仍可完成且不产生重复版本', async context => {
  const sourceUrl = await withProvider(context);
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  let collector = await new HistoryCollector(await new Archive(directory).initialize(), { sourceUrl }).initialize();
  const started = await collector.startJob('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  await waitFor(collector, started.id);
  // 手工把任务改回 running 模拟进程在翻页中途退出
  const running = await collector.getJob(started.id);
  running.status = 'running'; await collector.writeJob(running);
  collector = await new HistoryCollector(await new Archive(directory).initialize(), { sourceUrl }).initialize();
  const interrupted = await collector.getJob(started.id);
  assert.equal(interrupted.status, 'interrupted');
  const retry = await waitFor(collector, (await collector.startJob('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z')).id);
  assert.equal(retry.status, 'complete');
  assert.equal(retry.duplicateRaw, 3);
  assert.equal(retry.duplicateBoundary, 1);
  const readings = await collector.readReadings('store-temperature', '2026-11-01T00:00:00Z', '2026-11-01T00:03:00Z');
  assert.equal(readings.length, 3);
});

test('分页凭据始终绑定原始查询条件回传', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const fingerprint = createHash('sha256').update(JSON.stringify(['p', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z'])).digest('hex').slice(0, 12);
  const requester = fakeRequester([
    { values: [], next: `${fingerprint}:1` },
    { values: [{ sourceTime: '2026-11-01T00:00:30Z', revision: 1, value: 1, quality: 'good', kind: 'raw' }], next: null },
  ]);
  const collector = await new HistoryCollector(await new Archive(directory).initialize(), { requester }).initialize();
  await waitFor(collector, (await collector.startJob('p', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z')).id);
  const readBodies = requester.bodies.filter(body => 'start' in body);
  assert.equal(readBodies[0].continuation, undefined);
  assert.equal(readBodies[1].continuation, `${fingerprint}:1`);
  assert.deepEqual([readBodies[1].point, readBodies[1].start, readBodies[1].end], ['p', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z']);
});
