import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const observed = await fetch(source + project.probe, project.probeBody ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.probeBody) } : {}); const raw = Buffer.from(await observed.arrayBuffer());
  console.log(JSON.stringify({ 来源状态: observed.status, 原始字节: raw.length, 来源类型: observed.headers.get('content-type') }));
  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));
  const collected = await fetch(base + '/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, ...project.probeBody })
  });
  const result = await collected.json();
  console.log(JSON.stringify({
    区间领取: collected.status,
    请求区间: result.requested,
    读完: result.complete,
    分页数: result.pages,
    原始观测: result.observations.map(item => [item.sourceTime, item.revision, item.quality]),
    绘图端点: result.artifacts.map(item => [item.sourceTime, item.kind, item.measurement])
  }));
  const report = await fetch(base + '/api/acquisition?' + new URLSearchParams({ ...project.probeBody, origin: source }));
  const state = await report.json();
  console.log(JSON.stringify({ 领取报告: { 已读完: state.readComplete, 缺口: state.gaps, 汇总: state.summary } }));
  console.log(JSON.stringify({ 已存人工记录: await (await fetch(base + '/api/records')).json() }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]); await rm(directory, { recursive: true, force: true }); }
