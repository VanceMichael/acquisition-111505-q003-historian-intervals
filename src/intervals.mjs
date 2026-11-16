// 区间一律采用 [start, end)，时间以毫秒时间戳比较。
// 这里的函数都是纯函数，便于单独验证拼接、重叠与覆盖语义。

export function parseTime(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} 应为 ISO 时间字符串`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} 时间无法解析`);
  return ms;
}

export function normalizeRange(point, start, end) {
  if (typeof point !== 'string' || point.trim() === '') throw new Error('point 不能为空');
  const startMs = parseTime(start, 'start');
  const endMs = parseTime(end, 'end');
  if (endMs <= startMs) throw new Error('区间需满足 start < end，按 [start,end) 解释');
  // 保留来源/调用方给出的原始时间字符串，数值比较才用毫秒形式。
  return { point, startMs, endMs, start, end };
}

// 合并相互接触或重叠的区间；[a,b) 与 [b,c) 视为可拼接，交界处不漏观测。
export function mergeIntervals(intervals) {
  const sorted = intervals
    .map(([startMs, endMs]) => [startMs, endMs])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [startMs, endMs] of sorted) {
    const last = merged[merged.length - 1];
    if (last && startMs <= last[1]) last[1] = Math.max(last[1], endMs);
    else merged.push([startMs, endMs]);
  }
  return merged;
}

// 从请求区间中扣掉已覆盖区间，返回仍未读完的缺口（同样是左闭右开）。
export function subtractRanges(requestStart, requestEnd, covered) {
  let remaining = [[requestStart, requestEnd]];
  for (const [coverStart, coverEnd] of mergeIntervals(covered)) {
    const next = [];
    for (const [startMs, endMs] of remaining) {
      if (coverEnd <= startMs || coverStart >= endMs) next.push([startMs, endMs]);
      else {
        if (coverStart > startMs) next.push([startMs, Math.min(coverStart, endMs)]);
        if (coverEnd < endMs) next.push([Math.max(coverEnd, startMs), endMs]);
      }
    }
    remaining = next;
  }
  return remaining;
}

// 请求区间的覆盖状态：
// - covered：已按来源契约读完（含完整覆盖或零缺口）
// - partial：读了一部分，仍有缺口
// - none：从未采集（或已有覆盖与本请求区间完全不相交）
export function classifyCoverage(requestStart, requestEnd, covered) {
  const intersects = covered.some(([startMs, endMs]) => endMs > requestStart && startMs < requestEnd);
  const gaps = subtractRanges(requestStart, requestEnd, covered);
  if (gaps.length === 0) return { state: 'covered', gaps: [] };
  if (!intersects) return { state: 'none', gaps: [[requestStart, requestEnd]] };
  return { state: 'partial', gaps };
}

// 统一用秒级 UTC 字符串输出，避免不同输入写法（带/不带毫秒）造成表面差异。
export function toIso([startMs, endMs]) {
  const format = ms => new Date(ms - (ms % 1000)).toISOString().replace('.000Z', 'Z');
  return { start: format(startMs), end: format(endMs) };
}
