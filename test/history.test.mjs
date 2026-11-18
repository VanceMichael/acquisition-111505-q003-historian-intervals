import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Archive } from '../src/archive.mjs';
import { createProvider } from '../provider/server.mjs';
import {
  acquisitionReport,
  collectInterval,
  CollectionRequestError,
  intervalRequest,
  listIntervals,
  listObservations,
  mergeIntervals,
  sourceOrigin
} from '../src/history.mjs';

async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control };
}

async function withArchive(context) {
  const directory = await mkdtemp(join(tmpdir(), 'history-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return new Archive(directory).initialize();
}

const range = (start, end) => ({ point: 'store-temperature', start, end });
const october = { point: 'store-temperature', start: '2026-10-31T23:59:00Z', end: '2026-11-01T00:03:00Z' };
const day = { point: 'store-temperature', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' };

test('按 continuation 读完分页：空页继续、边界值不算测量、修订与不合格值并存', async context => {
  const source = await withSource(context); const archive = await withArchive(context);
  await source.control({ revision: 2 });
  const collected = await collectInterval({ archive, source: source.base, input: october });
  assert.equal(collected.pages, 3);
  assert.equal(collected.complete, true);
  assert.equal(collected.error, null);
  assert.equal(collected.status, 'complete');

  // 来源在窗口起点补出的 bounding 即使落在区间内也只是绘图端点，绝不进入 raw 观测。
  assert.equal(collected.artifacts.length, 1);
  assert.equal(collected.artifacts[0].kind, 'bounding');
  assert.equal(collected.artifacts[0].measurement, false);
  assert.equal(collected.artifacts[0].inRequestedRange, true);
  assert.equal(collected.observations.every(item => item.kind === 'raw'), true);
  assert.deepEqual(
    collected.observations.map(item => [item.sourceTime, item.revision]),
    [
      ['2026-11-01T00:00:00.000Z', 1],
      ['2026-11-01T00:01:00.000Z', 1],
      ['2026-11-01T00:01:00.000Z', 2],
      ['2026-11-01T00:02:00.000Z', 1]
    ]
  );
  assert.equal(collected.observations.find(item => item.revision === 1 && item.sourceTime.includes('00:01')).reliable, false);
  assert.equal(collected.observations.find(item => item.revision === 2 && item.sourceTime.includes('00:01')).reliable, true);

  // 原始页字节按摘要保管，可用于复核。
  for (const page of collected.pageHashes) {
    const bytes = await archive.bytes(page.sha256);
    assert.equal(JSON.parse(bytes.toString()).next, page.next);
  }
  const [record] = await archive.list('history-collection');
  assert.equal(record.versions.length, 2);
  assert.equal(record.versions[0].data.status, 'running');
  assert.equal(record.versions[1].data.status, 'complete');
});

test('分页凭据失效时保留已读页并明确标记区间未读完', async context => {
  const source = await withSource(context); const archive = await withArchive(context);
  let calls = 0;
  const send = async (url, options) => {
    calls += 1;
    if (calls === 2) {
      const body = JSON.parse(options.body);
      const stale = await fetch(source.base + '/history/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, continuation: `${body.continuation}ff` })
      });
      return { status: stale.status, headers: Object.fromEntries(stale.headers), bytes: Buffer.from(await stale.arrayBuffer()) };
    }
    const reply = await fetch(url, options);
    return { status: reply.status, headers: Object.fromEntries(reply.headers), bytes: Buffer.from(await reply.arrayBuffer()) };
  };
  const collected = await collectInterval({ archive, source: source.base, input: day, send });
  assert.equal(collected.complete, false);
  assert.equal(collected.status, 'incomplete');
  assert.match(collected.error, /badContinuation/);
  assert.equal(collected.pageHashes.length, 1);
  assert.equal(collected.observations.length, 1);
  assert.equal((await archive.bytes(collected.pageHashes[0].sha256)).length > 0, true);

  const report = await acquisitionReport({ archive, origin: source.base, ...range(day.start, day.end) });
  assert.equal(report.readComplete, false);
  assert.deepEqual(report.gaps, [{ start: '2026-11-01T00:00:00.000Z', end: '2026-11-01T00:03:00.000Z' }]);
  assert.equal(report.pending[0].status, 'incomplete');
});

test('补采区间可拼接与重叠，交界处不漏测且缺口单独暴露', async context => {
  const source = await withSource(context); const archive = await withArchive(context);
  await collectInterval({ archive, source: source.base, input: range('2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z') });
  await collectInterval({ archive, source: source.base, input: range('2026-11-01T00:02:00Z', '2026-11-01T00:03:00Z') });

  let report = await acquisitionReport({ archive, origin: source.base, ...range(day.start, day.end) });
  assert.equal(report.readComplete, false);
  assert.deepEqual(report.gaps, [{ start: '2026-11-01T00:01:00.000Z', end: '2026-11-01T00:02:00.000Z' }]);

  await collectInterval({ archive, source: source.base, input: range('2026-11-01T00:01:00Z', '2026-11-01T00:02:00Z') });
  await collectInterval({ archive, source: source.base, input: range('2026-11-01T00:00:00Z', '2026-11-01T00:02:30Z') });

  report = await acquisitionReport({ archive, origin: source.base, ...range(day.start, day.end) });
  assert.equal(report.readComplete, true);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.complete.map(item => [item.start, item.end]), [['2026-11-01T00:00:00.000Z', '2026-11-01T00:03:00.000Z']]);
  const interfaces = report.observations.filter(item => ['00:00:00.000Z', '00:01:00.000Z', '00:02:00.000Z'].some(time => item.sourceTime.includes(time)));
  assert.equal(interfaces.length, 3);

  assert.deepEqual(
    mergeIntervals([
      { startMs: 0, endMs: 10 }, { startMs: 5, endMs: 20 }, { startMs: 20, endMs: 30 }, { startMs: 40, endMs: 50 }
    ]).map(item => [item.startMs, item.endMs]),
    [[0, 30], [40, 50]]
  );
});

test('重复领取不抹掉修订依据，外部扩展窗口覆盖旧读数且不经图线推断', async context => {
  const source = await withSource(context); const archive = await withArchive(context);
  await collectInterval({ archive, source: source.base, input: day });
  await source.control({ revision: 2 });
  const again = await collectInterval({ archive, source: source.base, input: day });
  assert.equal(again.duplicate, false);

  const atOne = (await listObservations(archive, { point: 'store-temperature' })).filter(item => item.sourceTime.includes('00:01:00'));
  assert.deepEqual(atOne.map(item => [item.revision, item.quality, item.latestRevision]), [[1, 'bad', false], [2, 'good', true]]);
  assert.equal((await listObservations(archive, { start: '2026-11-01T00:01:00Z', end: '2026-11-01T00:02:00Z' })).length, 2);

  await collectInterval({ archive, source: source.base, input: october });
  const report = await acquisitionReport({ archive, origin: source.base, ...range(october.start, october.end) });
  assert.equal(report.readComplete, true);
  assert.equal(report.gaps.length, 0);
  assert.equal(report.observations.length, 4);
  assert.equal(report.summary.unreliable, 1);
  assert.equal(report.summary.latestUnreliable, 0);

  const intervals = await listIntervals(archive, { point: 'store-temperature' });
  assert.equal(intervals.length, 2);
  assert.equal(intervals.every(item => item.complete), true);
});

test('没有测量、质量不可靠与读取未完成是三种不同结论', async context => {
  const source = await withSource(context); const archive = await withArchive(context);
  await collectInterval({ archive, source: source.base, input: range('2026-11-02T00:00:00Z', '2026-11-02T00:03:00Z') });
  const quiet = await acquisitionReport({ archive, origin: source.base, ...range('2026-11-02T00:00:00Z', '2026-11-02T00:03:00Z') });
  assert.equal(quiet.readComplete, true);
  assert.equal(quiet.summary.noMeasurement, true);
  assert.equal(quiet.observations.length, 0);
  // 来源给空区间也补了起点端点；它不是测量，所以结论仍是“没有测量”。
  assert.equal(quiet.artifacts.length, 1);
  assert.equal(quiet.artifacts[0].measurement, false);
  assert.equal(quiet.summary.artifacts, 1);
  assert.equal(quiet.summary.raw, 0);

  const uncollected = await acquisitionReport({ archive, origin: source.base, ...range('2026-11-03T00:00:00Z', '2026-11-03T00:03:00Z') });
  assert.equal(uncollected.readComplete, false);
  assert.equal(uncollected.summary.noMeasurement, false);
  assert.deepEqual(uncollected.gaps, [{ start: '2026-11-03T00:00:00.000Z', end: '2026-11-03T00:03:00.000Z' }]);

  await collectInterval({ archive, source: source.base, input: range('2026-11-03T00:00:00Z', '2026-11-03T00:03:00Z') });
  const onlyBad = await acquisitionReport({ archive, origin: source.base, ...range('2026-11-01T00:01:00Z', '2026-11-01T00:02:00Z') });
  assert.equal(onlyBad.readComplete, false); // 该点尚未落入任何完整领取
  await collectInterval({ archive, source: source.base, input: range('2026-11-01T00:01:00Z', '2026-11-01T00:02:00Z') });
  const revised = await acquisitionReport({ archive, origin: source.base, ...range('2026-11-01T00:01:00Z', '2026-11-01T00:02:00Z') });
  assert.equal(revised.readComplete, true);
  assert.equal(revised.summary.unreliable, 1);
  assert.equal(revised.observations.every(item => item.reliable === false), true);
});

test('来源给出契约外的 kind 时记为异常，不当作测量也不中断领取', async context => {
  const archive = await withArchive(context);
  const pages = [
    { values: [{ sourceTime: '2026-11-01T00:00:30Z', kind: 'guessed', value: 1 }], next: 'a:1' },
    { values: [{ sourceTime: '2026-11-01T00:01:00Z', revision: 1, quality: 'good', kind: 'raw', value: 21.5 }], next: null }
  ];
  let call = 0;
  const send = async () => ({
    status: 200,
    headers: {},
    bytes: Buffer.from(JSON.stringify(pages[call++]))
  });
  const collected = await collectInterval({ archive, source: 'http://source.local', input: day, send });
  assert.equal(collected.complete, true);
  assert.equal(collected.observations.length, 1);
  assert.deepEqual(collected.artifacts, []);
  assert.equal(collected.anomalies.length, 1);
  assert.match(collected.anomalies[0].problem, /kind/);
  const report = await acquisitionReport({ archive, origin: 'http://source.local', ...range(day.start, day.end) });
  assert.equal(report.summary.anomalies, 1);
  assert.equal(report.summary.raw, 1);
});

test('拒绝无效区间与来源地址，且不发出请求', async () => {
  assert.throws(() => intervalRequest({ point: 'p', start: 'later', end: '2026-11-01T00:00:00Z' }), CollectionRequestError);
  assert.throws(() => intervalRequest({ point: 'p', start: '2026-11-01T00:03:00Z', end: '2026-11-01T00:00:00Z' }), /start 早于 end/);
  assert.throws(() => intervalRequest({ point: '', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' }), /缺少测点/);
  assert.throws(() => sourceOrigin('file:///tmp/source'), /http/);
  assert.throws(() => sourceOrigin('http://user:pass@localhost:4200'), /凭据/);
  assert.throws(() => sourceOrigin('http://localhost:4200/history/read'), /根地址/);
  assert.equal(sourceOrigin('http://localhost:4200/'), 'http://localhost:4200');
});
