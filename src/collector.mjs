import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as defaultRequest, decodeJson as defaultDecodeJson } from './transport.mjs';
import { normalizeRange, mergeIntervals, classifyCoverage, toIso } from './intervals.mjs';

// 自动来源的真实测量与来源自行补出的边界/插值值分属不同 source，
// 业务查询永远不会把绘图端点当成真实测量。
export const RAW_SOURCE = 'history-raw';
export const BOUNDARY_SOURCE = 'history-boundary';

export class HistoryCollector {
  constructor(archive, options = {}) {
    this.archive = archive;
    this.sourceUrl = options.sourceUrl || process.env.SOURCE_URL || 'http://127.0.0.1:4200';
    const requester = options.requester || {};
    this.request = requester.request ? requester.request.bind(requester) : defaultRequest;
    this.decodeJson = requester.decodeJson ? requester.decodeJson.bind(requester) : defaultDecodeJson;
    this.maxPages = options.maxPages || 10000;
  }

  async initialize() {
    await mkdir(join(this.archive.directory, 'jobs'), { recursive: true });
    await mkdir(join(this.archive.directory, 'coverage'), { recursive: true });
    await this.recoverInterrupted();
    return this;
  }

  jobPath(id) { return join(this.archive.directory, 'jobs', `${id}.json`); }
  coveragePath(point) { return join(this.archive.directory, 'coverage', `${encodeURIComponent(point)}.json`); }

  async writeJob(job) {
    job.updatedAt = new Date().toISOString();
    await this.archive.atomic(this.jobPath(job.id), Buffer.from(JSON.stringify(job, null, 2)));
  }

  async listJobs() {
    const names = (await readdir(join(this.archive.directory, 'jobs'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(this.archive.directory, 'jobs', name), 'utf8'))));
  }

  async getJob(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('任务 id 格式无效');
    return JSON.parse(await readFile(this.jobPath(id), 'utf8'));
  }

  // 进程重启后，上次仍在 running 的任务不可能再续跑（continuation 只在来源会话中有效），
  // 标记为 interrupted：区间不算读完，用户可重新发起同一区间，归档去重保证不产生重复版本。
  async recoverInterrupted() {
    const jobs = await this.listJobs().catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    await Promise.all(jobs.filter(job => job.status === 'running').map(job => {
      job.status = 'interrupted';
      job.error = job.error || '进程在采集完成前退出，区间尚未按来源契约读完';
      return this.writeJob(job);
    }));
  }

  async readCoverage(point) {
    try {
      const document = JSON.parse(await readFile(this.coveragePath(point), 'utf8'));
      return Array.isArray(document.intervals) ? document.intervals : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeCoverage(point, intervals) {
    await this.archive.locked(async () => {
      const merged = mergeIntervals(intervals.map(([startMs, endMs]) => [startMs, endMs]));
      await this.archive.atomic(this.coveragePath(point), Buffer.from(JSON.stringify({ point, intervals: merged }, null, 2)));
    });
  }

  // 立即返回 running 任务，分页在后台继续；任务状态逐页落盘，进程退出也可追溯。
  startJob(point, start, end) {
    const range = normalizeRange(point, start, end);
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      point: range.point,
      start: range.start,
      end: range.end,
      status: 'running',
      pagesRead: 0,
      acceptedRaw: 0,
      duplicateRaw: 0,
      acceptedBoundary: 0,
      duplicateBoundary: 0,
      continuation: null,
      pageBlobs: [],
      revisions: null,
      revisionsError: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    return this.writeJob(job).then(() => { this.run(job); return job; });
  }

  async run(job) {
    try {
      await this.fetchRevisions(job);
      let continuation = null;
      do {
        const body = { point: job.point, start: job.start, end: job.end };
        // 分页凭据与 point/start/end 完整绑定，始终随原查询条件回传，绝不跨任务复用。
        if (continuation) body.continuation = continuation;
        const reply = await this.request(new URL('/history/read', this.sourceUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const page = this.decodeJson(reply);
        if (!page || !Array.isArray(page.values) || !(page.next === null || typeof page.next === 'string')) {
          throw new Error('来源分页响应不符合契约');
        }
        const pageSha256 = await this.archive.storeBlob(reply.bytes);
        for (const value of page.values) await this.acceptValue(job, value);
        job.pageBlobs.push(pageSha256);
        job.pagesRead += 1;
        job.continuation = page.next;
        await this.writeJob(job);
        continuation = page.next;
        if (job.pagesRead > this.maxPages) throw new Error('来源页数超过上限，疑似分页不终止');
      } while (continuation);
      // 只有 next=null 完整读完后才登记覆盖；失败或中断的区间保持未覆盖，避免把缺口伪装成已采集。
      const intervals = await this.readCoverage(job.point);
      await this.writeCoverage(job.point, [...intervals, [Date.parse(job.start), Date.parse(job.end)]]);
      job.status = 'complete';
      job.continuation = null;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date().toISOString();
    } finally {
      await this.writeJob(job);
    }
  }

  async fetchRevisions(job) {
    try {
      const reply = await this.request(new URL('/history/revisions', this.sourceUrl));
      job.revisions = this.decodeJson(reply);
    } catch (error) {
      // 修订说明是辅助探查材料，取不到不阻断读数采集，但必须留下痕迹。
      job.revisionsError = error.message;
    }
  }

  async acceptValue(job, value) {
    if (!value || typeof value !== 'object' || typeof value.sourceTime !== 'string' || !Number.isFinite(Date.parse(value.sourceTime))) {
      throw new Error('来源读数缺少有效的 sourceTime');
    }
    if (typeof value.kind !== 'string') throw new Error('来源读数缺少 kind');
    // data 只保留来源稳定业务字段；任务与分页溯源由 jobs 文档的 pageBlobs 承担，
    // 这样重叠重采时同一原文才能正确复用版本，而不是产生“新修订”。
    const data = { point: job.point, ...value };
    if (value.kind === 'raw') {
      if (!Number.isInteger(value.revision)) throw new Error('raw 读数缺少整数 revision，无法确定业务身份');
      const identity = { point: job.point, sourceTime: value.sourceTime, revision: value.revision };
      const receipt = await this.archive.accept(RAW_SOURCE, identity, data, Buffer.from(JSON.stringify(value)));
      if (receipt.duplicate) job.duplicateRaw += 1; else job.acceptedRaw += 1;
      return;
    }
    if (value.kind === 'bounding' || value.kind === 'interpolated') {
      // 边界/插值值不参与真实测量身份，单独存档并保留来源原 kind。
      const identity = { point: job.point, sourceTime: value.sourceTime, revision: value.revision ?? null, kind: value.kind };
      const receipt = await this.archive.accept(BOUNDARY_SOURCE, identity, data, Buffer.from(JSON.stringify(value)));
      if (receipt.duplicate) job.duplicateBoundary += 1; else job.acceptedBoundary += 1;
      return;
    }
    throw new Error(`来源读数出现未知 kind: ${value.kind}`);
  }

  async readReceipts(source) {
    const records = await this.archive.list();
    return records.filter(record => record.source === source);
  }

  // 返回请求区间内的真实测量；同一业务身份若存在多版本，以最新版本为准并保留版本数。
  // 质量标记原样保留（如 bad），不做静默丢弃，由调用方区分可靠与不可靠。
  async readReadings(point, start, end) {
    const range = normalizeRange(point, start, end);
    const rows = [];
    for (const record of await this.readReceipts(RAW_SOURCE)) {
      if (record.identity.point !== range.point) continue;
      const timeMs = Date.parse(record.identity.sourceTime);
      if (!(timeMs >= range.startMs && timeMs < range.endMs)) continue;
      const latest = record.versions[record.versions.length - 1];
      rows.push({
        ...latest.data,
        // 质量判定：reliable 可用于业务；unreliable 是真实测量但来源标记不合格，不能与“没有测量”混淆。
        qualityState: latest.data.quality === 'good' ? 'reliable' : 'unreliable',
        versions: record.versions.length,
        receivedAt: latest.receivedAt,
      });
    }
    rows.sort((a, b) => Date.parse(a.sourceTime) - Date.parse(b.sourceTime) || a.revision - b.revision);
    return rows;
  }

  async readBoundaryValues(point, start, end) {
    const range = normalizeRange(point, start, end);
    const rows = [];
    for (const record of await this.readReceipts(BOUNDARY_SOURCE)) {
      if (record.identity.point !== range.point) continue;
      const timeMs = Date.parse(record.identity.sourceTime);
      if (!(timeMs >= range.startMs && timeMs < range.endMs)) continue;
      const latest = record.versions[record.versions.length - 1];
      rows.push({ ...latest.data, versions: record.versions.length, receivedAt: latest.receivedAt });
    }
    rows.sort((a, b) => Date.parse(a.sourceTime) - Date.parse(b.sourceTime));
    return rows;
  }

  async coverage(point, start, end) {
    const range = normalizeRange(point, start, end);
    const coveredMs = await this.readCoverage(range.point);
    const judgement = classifyCoverage(range.startMs, range.endMs, coveredMs);
    const readings = await this.readReadings(range.point, range.start, range.end);
    return {
      point: range.point,
      start: range.start,
      end: range.end,
      state: judgement.state, // covered：按契约读完；partial：读了一部分；none：尚未采集
      gaps: judgement.gaps.map(toIso),
      covered: mergeIntervals(coveredMs)
        .filter(([startMs, endMs]) => endMs > range.startMs && startMs < range.endMs)
        .map(toIso),
      observations: readings.length,
      unreliable: readings.filter(row => row.quality !== 'good').length,
      reliable: readings.filter(row => row.quality === 'good').length,
    };
  }
}
