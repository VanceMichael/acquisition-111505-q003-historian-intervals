import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('空中间页仍带延续凭据且凭据绑定查询', async context => {
  const { post } = await withSource(context); const query = { point: 'store-temperature', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' };
  const first = await (await post('/history/read', query)).json(); assert.equal(first.values[0].kind, 'bounding');
  const second = await (await post('/history/read', { ...query, continuation: first.next })).json(); assert.deepEqual(second.values, []); assert.ok(second.next);
  const final = await (await post('/history/read', { ...query, continuation: second.next })).json(); assert.equal(final.values.length, 2); assert.equal(final.next, null);
  assert.equal((await post('/history/read', { ...query, point: 'another', continuation: first.next })).status, 409);
});
test('同一来源时刻可保留不合格值和后续修订', async context => {
  const { post, control } = await withSource(context); await control({ revision: 2 }); const query = { point: 'store-temperature', start: '2026-11-01T00:00:00Z', end: '2026-11-01T00:03:00Z' };
  const first = await (await post('/history/read', query)).json(); const middle = await (await post('/history/read', { ...query, continuation: first.next })).json();
  const final = await (await post('/history/read', { ...query, continuation: middle.next })).json(); assert.equal(final.values.filter(value => value.sourceTime.includes('00:01:00')).length, 2);
});
