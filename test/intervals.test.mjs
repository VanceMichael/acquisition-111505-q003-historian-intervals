import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRange, mergeIntervals, subtractRanges, classifyCoverage } from '../src/intervals.mjs';

const t0 = '2026-11-01T00:00:00Z';
const t1 = '2026-11-01T01:00:00Z';
const t2 = '2026-11-01T02:00:00Z';
const t3 = '2026-11-01T03:00:00Z';
const t4 = '2026-11-01T04:00:00Z';
const ms = value => Date.parse(value);

test('相邻区间在边界处拼接，重叠与扩展被合并', () => {
  assert.deepEqual(mergeIntervals([[ms(t1), ms(t2)], [ms(t0), ms(t1)]]), [[ms(t0), ms(t2)]]);
  assert.deepEqual(mergeIntervals([[ms(t0), ms(t2)], [ms(t1), ms(t3)]]), [[ms(t0), ms(t3)]]);
  assert.deepEqual(mergeIntervals([[ms(t0), ms(t1)], [ms(t2), ms(t3)]]), [[ms(t0), ms(t1)], [ms(t2), ms(t3)]]);
  // 在已有区间内部重新采集不会改变覆盖
  assert.deepEqual(mergeIntervals([[ms(t0), ms(t3)], [ms(t1), ms(t2)]]), [[ms(t0), ms(t3)]]);
});

test('缺口计算保留交界处，覆盖状态可区分 none/partial/covered', () => {
  assert.deepEqual(subtractRanges(ms(t0), ms(t3), [[ms(t1), ms(t2)]]), [[ms(t0), ms(t1)], [ms(t2), ms(t3)]]);
  // [a,b) 与 [b,c) 拼满后无缺口，边界时刻不会漏
  assert.deepEqual(subtractRanges(ms(t0), ms(t2), [[ms(t0), ms(t1)], [ms(t1), ms(t2)]]), []);
  assert.equal(classifyCoverage(ms(t0), ms(t1), []).state, 'none');
  assert.equal(classifyCoverage(ms(t0), ms(t3), [[ms(t0), ms(t1)]]).state, 'partial');
  assert.equal(classifyCoverage(ms(t0), ms(t3), [[ms(t0), ms(t2)], [ms(t1), ms(t3)]]).state, 'covered');
  const partial = classifyCoverage(ms(t0), ms(t4), [[ms(t1), ms(t3)]]);
  assert.deepEqual(partial.gaps, [[ms(t0), ms(t1)], [ms(t3), ms(t4)]]);
  // 覆盖与请求区间完全不相交时应判定为 none，而不是 partial
  assert.equal(classifyCoverage(ms(t3), ms(t4), [[ms(t0), ms(t1)]]).state, 'none');
});

test('区间参数必须合法且左闭右开', () => {
  assert.throws(() => normalizeRange('p', t1, t0), /start < end/);
  assert.throws(() => normalizeRange('p', 'not-a-time', t1), /时间无法解析/);
  assert.throws(() => normalizeRange('  ', t0, t1), /point 不能为空/);
});
