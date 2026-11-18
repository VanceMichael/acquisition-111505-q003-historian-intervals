import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import {
  acquisitionReport,
  collectInterval,
  CollectionRequestError,
  listIntervals,
  listObservations,
  sourceOrigin
} from './history.mjs';

async function body(readable, limit = 1048576) {
  const chunks = []; let length = 0;
  for await (const chunk of readable) {
    length += chunk.length;
    if (length > limit) { const error = new Error('请求体过大'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  if (!length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createIntake(directory, { source } = {}) {
  const archive = await new Archive(directory).initialize();
  // 配置后请求只能使用同一来源，避免收件端被当作任意转发器；未配置时由每次领取显式给出。
  const configured = source !== undefined ? source : process.env.SOURCE_URL;
  const configuredSource = configured ? sourceOrigin(configured) : null;
  const chosenSource = value => {
    if (value === undefined || value === null || value === '') {
      if (!configuredSource) throw new CollectionRequestError('缺少来源地址：请配置 SOURCE_URL 或在请求中给出 source');
      return configuredSource;
    }
    const requested = sourceOrigin(value);
    if (configuredSource && requested !== configuredSource) throw new CollectionRequestError('请求的来源地址与收件端配置不符');
    return requested;
  };
  return createServer(async (incoming, outgoing) => {
    const reply = (status, payload) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(payload)); };
    const url = new URL(incoming.url, 'http://localhost');
    const query = url.searchParams;
    try {
      if (incoming.method === 'GET' && url.pathname === '/health') {
        return reply(200, { status: 'ok', acquisition: 'manual+history-interval' });
      }
      if (incoming.method === 'GET' && url.pathname === '/api/records') return reply(200, await archive.list('manual'));
      if (incoming.method === 'GET' && url.pathname === '/api/intervals') {
        try {
          return reply(200, await listIntervals(archive, {
            point: query.get('point') ?? undefined,
            origin: query.get('origin') === null ? undefined : sourceOrigin(query.get('origin'))
          }));
        } catch (error) {
          if (error instanceof CollectionRequestError) return reply(422, { error: error.message });
          throw error;
        }
      }
      if (incoming.method === 'GET' && url.pathname === '/api/acquisition') {
        const point = query.get('point');
        const start = query.get('start');
        const end = query.get('end');
        if (!point || !start || !end) return reply(422, { error: '需要 point、start、end' });
        try {
          const report = await acquisitionReport({
            archive,
            point,
            start,
            end,
            origin: chosenSource(query.get('origin'))
          });
          return reply(200, report);
        } catch (error) {
          if (error instanceof CollectionRequestError) return reply(422, { error: error.message });
          throw error;
        }
      }
      if (incoming.method === 'GET' && url.pathname === '/api/observations') {
        try {
          return reply(200, await listObservations(archive, {
            point: query.get('point') ?? undefined,
            origin: query.get('origin') === null ? undefined : sourceOrigin(query.get('origin')),
            start: query.get('start') ?? undefined,
            end: query.get('end') ?? undefined
          }));
        } catch (error) {
          if (error instanceof CollectionRequestError) return reply(422, { error: error.message });
          throw error;
        }
      }
      if (incoming.method === 'POST' && url.pathname === '/api/collect') {
        let payload;
        try { payload = await body(incoming); }
        catch (error) { return reply(error.status || 400, { error: error.status ? error.message : 'JSON 无效' }); }
        try {
          const result = await collectInterval({
            archive,
            source: chosenSource(payload?.source),
            input: payload
          });
          return reply(result.complete ? 200 : 502, result);
        } catch (error) {
          if (error instanceof CollectionRequestError) return reply(422, { error: error.message });
          throw error;
        }
      }
      if (incoming.method === 'POST' && url.pathname === '/api/manual') {
        let payload;
        try { payload = await body(incoming); }
        catch (error) { return reply(error.status || 400, { error: error.status ? error.message : 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive', {
    source: process.env.SOURCE_URL || `http://127.0.0.1:${process.env.SOURCE_PORT || 4200}`
  });
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
