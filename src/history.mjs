import { digest } from './archive.mjs';
import { request } from './transport.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const iso = milliseconds => new Date(milliseconds).toISOString();

export class CollectionRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectionRequestError';
  }
}

export function parseInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function intervalRequest(input) {
  if (!isRecord(input)) throw new CollectionRequestError('区间领取请求应是对象');
  if (typeof input.point !== 'string' || input.point.trim() === '') throw new CollectionRequestError('缺少测点 point');
  const startMs = parseInstant(input.start);
  if (startMs === null) throw new CollectionRequestError('start 不是可解析的时间');
  const endMs = parseInstant(input.end);
  if (endMs === null) throw new CollectionRequestError('end 不是可解析的时间');
  if (!(startMs < endMs)) throw new CollectionRequestError('区间必须是 [start,end) 且 start 早于 end');
  return { point: input.point, start: iso(startMs), end: iso(endMs), startMs, endMs };
}

export function sourceOrigin(source) {
  let url;
  try { url = new URL(source); }
  catch { throw new CollectionRequestError('来源地址无效'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CollectionRequestError('来源地址必须是 http 或 https');
  if (url.username || url.password) throw new CollectionRequestError('来源地址不能包含凭据');
  if (url.pathname !== '/' || url.search || url.hash) throw new CollectionRequestError('来源地址应为源站根地址，不带路径、查询或片段');
  return url.origin;
}

function classify(item, requested) {
  if (!isRecord(item)) return { problem: '值不是对象' };
  const timeMs = parseInstant(item.sourceTime);
  if (timeMs === null) return { problem: '值的 sourceTime 无法解析' };
  if (!has(item, 'value')) return { problem: `值 ${item.sourceTime} 缺少 value` };
  if (typeof item.kind !== 'string' || item.kind === '') return { problem: `值 ${item.sourceTime} 缺少 kind` };
  const sourceTime = iso(timeMs);
  const inRequestedRange = timeMs >= requested.startMs && timeMs < requested.endMs;
  if (item.kind === 'raw') {
    if (!Number.isInteger(item.revision) || item.revision < 1) return { problem: `raw 值 ${item.sourceTime} 缺少有效 revision` };
    if (typeof item.quality !== 'string' || item.quality === '') return { problem: `raw 值 ${item.sourceTime} 缺少 quality` };
    return {
      observation: {
        point: requested.point,
        sourceTime,
        revision: item.revision,
        value: item.value,
        quality: item.quality,
        kind: 'raw',
        inRequestedRange
      }
    };
  }
  // bounding / interpolated 是来源为了绘图补出的端点或插值，不是真实测量。
  if (item.kind !== 'bounding' && item.kind !== 'interpolated') {
    return { problem: `值 ${item.sourceTime} 的 kind 不在契约内：${item.kind}` };
  }
  return {
    artifact: {
      sourceTime,
      value: item.value,
      kind: item.kind,
      quality: typeof item.quality === 'string' ? item.quality : null,
      revision: Number.isInteger(item.revision) ? item.revision : null,
      inRequestedRange,
      measurement: false
    }
  };
}

/**
 * 按来源契约读完一个 [start,end) 区间。
 * 只用 continuation 推进游标；空页只要有 next 也继续。
 * complete 为 true 当且仅当来源明确返回 next === null。
 */
export async function readInterval({ source, point, start, end, send = request, maxPages = 10000, onPage }) {
  const requested = intervalRequest({ point, start, end });
  const origin = sourceOrigin(source);
  const endpoint = `${origin}/history/read`;
  const observations = [];
  const artifacts = [];
  const anomalies = [];
  const pageHashes = [];
  const consumed = new Set();
  let continuation = null;
  let pages = 0;
  let complete = false;
  let error = null;

  while (true) {
    const body = { point: requested.point, start: requested.start, end: requested.end };
    if (continuation !== null) body.continuation = continuation;
    let reply;
    try {
      reply = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      error = `来源请求失败：${cause.message}`;
      break;
    }
    if (reply.status === 409) {
      error = '来源拒绝了分页凭据（badContinuation），所请求区间未读完';
      break;
    }
    if (!reply.status || reply.status < 200 || reply.status > 299) {
      error = `来源返回 HTTP ${reply.status}，所请求区间未读完`;
      break;
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(reply.bytes).toString('utf8'));
    } catch {
      error = '来源响应不是有效 JSON，所请求区间未读完';
      break;
    }
    if (!isRecord(payload)) { error = '来源响应不是对象，所请求区间未读完'; break; }
    if (!Array.isArray(payload.values)) { error = '来源响应缺少 values 数组，所请求区间未读完'; break; }
    if (!has(payload, 'next')) { error = '来源响应缺少 next，无法确认所请求区间是否读完'; break; }
    const next = payload.next;
    if (next !== null && (typeof next !== 'string' || next === '')) {
      error = '来源响应的 next 既不是 null 也不是非空字符串，所请求区间未读完';
      break;
    }

    const pageIndex = pages;
    const sha256 = digest(Buffer.from(reply.bytes));
    pages += 1;

    for (let index = 0; index < payload.values.length; index += 1) {
      const classified = classify(payload.values[index], requested);
      if (classified.observation) observations.push({ ...classified.observation, page: pageIndex, index });
      else if (classified.artifact) artifacts.push({ ...classified.artifact, page: pageIndex, index });
      else anomalies.push({ page: pageIndex, index, problem: classified.problem });
    }

    // 原始页字节先落盘，即使后续分页失败也能保留已经读到的依据。
    if (onPage) {
      try { await onPage({ index: pageIndex, next, sha256, bytes: Buffer.from(reply.bytes), values: payload.values }); }
      catch (cause) { error = `原始页保存失败：${cause.message}，所请求区间未读完`; break; }
    }
    pageHashes.push({ page: pageIndex, sha256, next });

    if (next === null) { complete = true; break; }
    if (consumed.has(next)) { error = '来源重复返回已使用的分页凭据，停止以避免死循环；所请求区间未读完'; break; }
    consumed.add(next);
    continuation = next;
    if (pages >= maxPages) {
      error = `超过最大分页数 ${maxPages}，所请求区间未读完`;
      break;
    }
  }

  return {
    requested: { point: requested.point, start: requested.start, end: requested.end },
    origin,
    pages,
    complete,
    continuation,
    error,
    observations,
    artifacts,
    anomalies,
    pageHashes
  };
}

/**
 * 领取一个历史区间：读取所有分页，保存原始页、raw 观测和本次领取记录。
 * 观测身份为 (origin, point, sourceTime, revision)，同一时刻的不同修订各自成档。
 */
export async function collectInterval({ archive, source, input, send = request, maxPages = 10000, now = () => new Date().toISOString() }) {
  const requested = intervalRequest(input);
  const origin = sourceOrigin(source);
  const identity = { origin, point: requested.point, start: requested.start, end: requested.end };
  const startedAt = now();

  // 先记录“进行中”，进程中断时后续用户仍能看出这次读取尚未完成。
  const running = { ...identity, status: 'running', complete: false, pages: 0, error: null, continuation: null, startedAt };
  await archive.accept('history-collection', identity, running, Buffer.from(JSON.stringify(running)));

  const result = await readInterval({
    source: origin,
    point: requested.point,
    start: requested.start,
    end: requested.end,
    send,
    maxPages,
    onPage: async page => {
      const pageIdentity = { ...identity, page: page.index, sha256: page.sha256 };
      const pageData = { ...pageIdentity, next: page.next };
      await archive.accept('history-page', pageIdentity, pageData, page.bytes);
    }
  });

  const references = [];
  for (const observation of result.observations) {
    const data = {
      origin,
      point: observation.point,
      sourceTime: observation.sourceTime,
      revision: observation.revision,
      value: observation.value,
      quality: observation.quality,
      kind: 'raw'
    };
    const accepted = await archive.accept(
      'history-observation',
      { origin, point: observation.point, sourceTime: observation.sourceTime, revision: observation.revision },
      data,
      Buffer.from(JSON.stringify(data))
    );
    references.push({
      sourceTime: observation.sourceTime,
      revision: observation.revision,
      value: observation.value,
      quality: observation.quality,
      kind: 'raw',
      reliable: observation.quality === 'good',
      inRequestedRange: observation.inRequestedRange,
      sha256: accepted.sha256,
      receipt: accepted.receipt,
      version: accepted.version,
      duplicate: accepted.duplicate
    });
  }

  const finishedAt = now();
  const record = {
    ...identity,
    requested: { point: requested.point, start: requested.start, end: requested.end },
    status: result.complete ? 'complete' : 'incomplete',
    complete: result.complete,
    pages: result.pages,
    error: result.error,
    continuation: result.continuation,
    startedAt,
    finishedAt,
    observations: references,
    // 端点/插值值单独保留，明确 measurement:false，绝不计入 raw 观测。
    artifacts: result.artifacts,
    anomalies: result.anomalies,
    pageHashes: result.pageHashes
  };
  const accepted = await archive.accept('history-collection', identity, record, Buffer.from(JSON.stringify(record)));
  return { receipt: accepted.receipt, version: accepted.version, duplicate: accepted.duplicate, ...record };
}

export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.startMs < item.endMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.startMs <= last.endMs) last.endMs = Math.max(last.endMs, item.endMs);
    else merged.push({ startMs: item.startMs, endMs: item.endMs });
  }
  return merged.map(item => ({ start: iso(item.startMs), end: iso(item.endMs), startMs: item.startMs, endMs: item.endMs }));
}

function subtract(window, covered) {
  const gaps = [];
  let cursor = window.startMs;
  for (const range of covered) {
    const start = Math.max(range.startMs, window.startMs);
    const end = Math.min(range.endMs, window.endMs);
    if (end <= cursor) continue;
    if (start > cursor) gaps.push({ start: iso(cursor), end: iso(start) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < window.endMs) gaps.push({ start: iso(cursor), end: iso(window.endMs) });
  return gaps;
}

function clip(covered, window) {
  return covered
    .map(range => ({ startMs: Math.max(range.startMs, window.startMs), endMs: Math.min(range.endMs, window.endMs) }))
    .filter(range => range.startMs < range.endMs)
    .map(range => ({ start: iso(range.startMs), end: iso(range.endMs), startMs: range.startMs, endMs: range.endMs }));
}

export async function listIntervals(archive, { point, origin } = {}) {
  const receipts = await archive.list('history-collection');
  return receipts
    .filter(receipt => !point || receipt.identity.point === point)
    .filter(receipt => !origin || receipt.identity.origin === origin)
    .map(receipt => {
      const latest = receipt.versions[receipt.versions.length - 1].data;
      const complete = receipt.versions.some(version => version.data.status === 'complete' && version.data.complete === true);
      const artifacts = new Map();
      const anomalies = new Map();
      for (const version of receipt.versions) {
        for (const artifact of version.data.artifacts ?? []) {
          artifacts.set(JSON.stringify([artifact.sourceTime, artifact.kind, artifact.value]), artifact);
        }
        for (const anomaly of version.data.anomalies ?? []) {
          anomalies.set(JSON.stringify(anomaly), anomaly);
        }
      }
      return {
        receipt: receipt.receipt,
        identity: receipt.identity,
        // 只要任一次尝试读到 next=null，该区间就已按契约读完；后续失败的尝试不撤销这一事实。
        status: complete ? 'complete' : latest.status,
        complete,
        attempts: receipt.versions.length,
        pages: latest.pages,
        error: latest.error,
        continuation: latest.continuation,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        observationCount: latest.observations?.length ?? 0,
        artifactCount: artifacts.size,
        anomalyCount: anomalies.size,
        artifacts: [...artifacts.values()],
        anomalies: [...anomalies.values()],
        latest
      };
    })
    .sort((left, right) => left.identity.start.localeCompare(right.identity.start) || left.identity.end.localeCompare(right.identity.end));
}

export async function listObservations(archive, { point, origin, start, end } = {}) {
  const startMs = start === undefined ? null : parseInstant(start);
  const endMs = end === undefined ? null : parseInstant(end);
  if (start !== undefined && startMs === null) throw new CollectionRequestError('start 不是可解析的时间');
  if (end !== undefined && endMs === null) throw new CollectionRequestError('end 不是可解析的时间');
  if (startMs !== null && endMs !== null && !(startMs < endMs)) throw new CollectionRequestError('区间必须满足 start < end');

  const receipts = await archive.list('history-observation');
  const observations = [];
  for (const receipt of receipts) {
    const identity = receipt.identity;
    if (point && identity.point !== point) continue;
    if (origin && identity.origin !== origin) continue;
    const timeMs = Date.parse(identity.sourceTime);
    if (startMs !== null && timeMs < startMs) continue;
    if (endMs !== null && timeMs >= endMs) continue;
    for (const version of receipt.versions) {
      observations.push({
        receipt: receipt.receipt,
        version: version.version,
        origin: identity.origin,
        point: identity.point,
        sourceTime: identity.sourceTime,
        revision: identity.revision,
        value: version.data.value,
        quality: version.data.quality,
        kind: version.data.kind,
        reliable: version.data.quality === 'good',
        receivedAt: version.receivedAt
      });
    }
  }

  const highest = new Map();
  for (const item of observations) {
    const key = JSON.stringify([item.origin, item.point, item.sourceTime]);
    highest.set(key, Math.max(highest.get(key) ?? 0, item.revision));
  }
  for (const item of observations) {
    const key = JSON.stringify([item.origin, item.point, item.sourceTime]);
    item.latestRevision = item.revision === highest.get(key);
  }
  observations.sort((left, right) =>
    left.sourceTime.localeCompare(right.sourceTime) || left.revision - right.revision || left.version - right.version
  );
  return observations;
}

/**
 * 面向使用者的三态报告：
 * - gaps 非空：所请求区间仍有部分“读取尚未完成”；
 * - 已读部分没有任何 raw：该部分“没有测量”；
 * - raw 的 quality 不是 good：该读数“质量不可靠”。
 */
export async function acquisitionReport({ archive, point, origin, start, end }) {
  const window = intervalRequest({ point, start, end });
  if (!origin) throw new CollectionRequestError('缺少来源 origin，不能跨来源汇总领取状态');
  const resolvedOrigin = sourceOrigin(origin);
  const intervals = await listIntervals(archive, { point: window.point, origin: resolvedOrigin });
  const completeRanges = [];
  const pending = [];
  for (const interval of intervals) {
    const startMs = Date.parse(interval.identity.start);
    const endMs = Date.parse(interval.identity.end);
    if (interval.complete) completeRanges.push({ startMs, endMs });
    else if (interval.status === 'running' || interval.status === 'incomplete') {
      if (endMs <= window.startMs || startMs >= window.endMs) continue;
      pending.push({
        start: interval.identity.start,
        end: interval.identity.end,
        status: interval.status,
        error: interval.error,
        continuation: interval.continuation
      });
    }
  }
  const complete = clip(mergeIntervals(completeRanges), window);
  const gaps = subtract(window, complete);
  const artifacts = new Map();
  const anomalies = new Map();
  for (const interval of intervals) {
    for (const artifact of interval.artifacts) {
      const timeMs = Date.parse(artifact.sourceTime);
      if (!(timeMs >= window.startMs && timeMs < window.endMs)) continue;
      artifacts.set(JSON.stringify([artifact.sourceTime, artifact.kind, artifact.value]), artifact);
    }
    for (const anomaly of interval.anomalies) anomalies.set(JSON.stringify(anomaly), anomaly);
  }
  const observations = await listObservations(archive, {
    point: window.point,
    origin: resolvedOrigin,
    start: window.start,
    end: window.end
  });
  const latest = observations.filter(item => item.latestRevision);
  const reliable = observations.filter(item => item.reliable);
  const unreliable = observations.filter(item => !item.reliable);
  return {
    point: window.point,
    origin: resolvedOrigin,
    start: window.start,
    end: window.end,
    readComplete: gaps.length === 0,
    complete,
    gaps,
    pending,
    observations,
    // 绘图端点/插值单列，measurement=false，供核对但不计为测量。
    artifacts: [...artifacts.values()],
    anomalies: [...anomalies.values()],
    summary: {
      raw: observations.length,
      reliable: reliable.length,
      unreliable: unreliable.length,
      latest: latest.length,
      latestReliable: latest.filter(item => item.reliable).length,
      latestUnreliable: latest.filter(item => !item.reliable).length,
      artifacts: artifacts.size,
      anomalies: anomalies.size,
      noMeasurement: gaps.length === 0 && observations.length === 0
    },
    definitions: {
      noMeasurement: '所请求区间已读完，但其中没有任何 kind=raw 的观测',
      unreliable: 'kind=raw 但 quality 不是 good；端点与插值值不是测量',
      readIncomplete: 'gaps 非空，所请求区间尚未按来源契约读到 next=null'
    }
  };
}
