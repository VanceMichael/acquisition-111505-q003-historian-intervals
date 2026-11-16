import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = createProvider();
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const source = `http://127.0.0.1:${provider.address().port}`;
const intake = await createIntake(directory, { collectorOptions: { sourceUrl: source } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise(resolve => intake.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${intake.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const observed = await fetch(source + project.probe, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.probeBody) });
  console.log(JSON.stringify({ 来源状态: observed.status, 原始字节: Buffer.byteLength(await observed.arrayBuffer()) }));

  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));

  // 让来源进入带修订版的情景，演示同一时刻同时保留不合格原值与修订值
  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 2 }) });
  const query = { point: 'store-temperature', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' };
  const started = await (await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) })).json();
  let job; do { await wait(50); job = await (await fetch(`${base}/api/jobs/${started.job}`)).json(); } while (job.status === 'running');
  console.log(JSON.stringify({ 采集任务: { 状态: job.status, 页数: job.pagesRead, 真实测量: job.acceptedRaw, 边界值: job.acceptedBoundary, 修订说明: job.revisions?.replaces } }));

  const coverage = await (await fetch(`${base}/api/coverage?point=${query.point}&start=${query.start}&end=${query.end}`)).json();
  console.log(JSON.stringify({ 覆盖判定: { 状态: coverage.state, 观测数: coverage.observations, 可靠: coverage.reliable, 不可靠: coverage.unreliable, 缺口: coverage.gaps } }));
  const readings = await (await fetch(`${base}/api/readings?point=${query.point}&start=${query.start}&end=${query.end}`)).json();
  console.log(JSON.stringify({ 真实测量: readings.readings.map(({ sourceTime, revision, quality, kind }) => ({ sourceTime, revision, quality, kind })) }));
  const boundaries = await (await fetch(`${base}/api/boundaries?point=${query.point}&start=${query.start}&end=${query.end}`)).json();
  console.log(JSON.stringify({ 边界与插值: boundaries.values.map(({ sourceTime, quality, kind }) => ({ sourceTime, quality, kind })) }));

  // 未发起采集的窗口应明确显示 none，而不是被当作“没有测量”
  const untouched = await (await fetch(`${base}/api/coverage?point=${query.point}&start=2026-11-02T00:00:00Z&end=2026-11-02T01:00:00Z`)).json();
  console.log(JSON.stringify({ 未采集窗口: { 状态: untouched.state, 缺口: untouched.gaps } }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
