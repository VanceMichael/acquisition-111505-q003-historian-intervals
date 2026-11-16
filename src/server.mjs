import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { HistoryCollector } from './collector.mjs';

async function readJsonBody(incoming, reply, limit = 1048576) {
  const chunks = []; let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > limit) return reply(413, { error: '请求体过大' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return reply(400, { error: 'JSON 无效' }); }
}

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const collector = options.collector || await new HistoryCollector(archive, options.collectorOptions || {}).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok', acquisition: ['manual', 'history-interval'] });
      if (incoming.method === 'GET' && url.pathname === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && url.pathname === '/api/collect') {
        const payload = await readJsonBody(incoming, reply);
        if (payload === undefined) return;
        const { point, start, end } = payload;
        try {
          // 立即受理，后台按来源契约翻页；任务状态可在 /api/jobs 追踪。
          const job = await collector.startJob(point, start, end);
          return reply(202, { job: job.id, status: job.status, point: job.point, start: job.start, end: job.end });
        } catch (error) { return reply(422, { error: error.message }); }
      }
      if (incoming.method === 'GET' && url.pathname === '/api/jobs') return reply(200, await collector.listJobs());
      const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (incoming.method === 'GET' && jobMatch) {
        try { return reply(200, await collector.getJob(jobMatch[1])); }
        catch (error) { return reply(error.code === 'ENOENT' ? 404 : 400, { error: error.message }); }
      }
      if (incoming.method === 'GET' && (url.pathname === '/api/coverage' || url.pathname === '/api/readings' || url.pathname === '/api/boundaries')) {
        const point = url.searchParams.get('point');
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        try {
          if (url.pathname === '/api/coverage') return reply(200, await collector.coverage(point, start, end));
          if (url.pathname === '/api/readings') return reply(200, { readings: await collector.readReadings(point, start, end) });
          return reply(200, { values: await collector.readBoundaryValues(point, start, end) });
        } catch (error) { return reply(422, { error: error.message }); }
      }
      if (incoming.method === 'POST' && url.pathname === '/api/manual') {
        const payload = await readJsonBody(incoming, reply);
        if (payload === undefined) return;
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
