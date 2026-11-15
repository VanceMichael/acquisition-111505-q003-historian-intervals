export const initialState = () => ({ name: '设备历史读取', revision: 1 });

import { createHash } from 'node:crypto';
export async function handle({ url, body, state, json }) {
  if (url.pathname === '/history/revisions') { json(200, { point: 'store-temperature', replaces: [{ sourceTime: '2026-11-01T00:01:00Z', revision: 2, previous: 1 }] }); return true; }
  if (url.pathname !== '/history/read') return false;
  if (!body?.point || !body.start || !body.end) { json(400, { error: '区间条件不完整' }); return true; }
  const fingerprint = createHash('sha256').update(JSON.stringify([body.point, body.start, body.end])).digest('hex').slice(0, 12);
  let page = 0;
  if (body.continuation) {
    const match = /^([0-9a-f]+):(\d+)$/.exec(body.continuation);
    if (!match || match[1] !== fingerprint) { json(409, { error: 'badContinuation' }); return true; }
    page = Number(match[2]);
  }
  const raw = [
    { sourceTime: '2026-11-01T00:00:00Z', revision: 1, value: 21.4, quality: 'good', kind: 'raw' },
    { sourceTime: '2026-11-01T00:01:00Z', revision: 1, value: 0, quality: 'bad', kind: 'raw' },
    ...(state.revision > 1 ? [{ sourceTime: '2026-11-01T00:01:00Z', revision: 2, value: 21.5, quality: 'good', kind: 'raw' }] : []),
    { sourceTime: '2026-11-01T00:02:00Z', revision: 1, value: 21.6, quality: 'good', kind: 'raw' }
  ].filter(item => Date.parse(item.sourceTime) >= Date.parse(body.start) && Date.parse(item.sourceTime) < Date.parse(body.end));
  const pages = [[{ sourceTime: body.start, value: 21.3, quality: 'estimated', kind: 'bounding' }, ...raw.slice(0, 1)], [], raw.slice(1)];
  json(200, { values: pages[page] || [], next: page < 2 ? `${fingerprint}:${page + 1}` : null }); return true;
}
