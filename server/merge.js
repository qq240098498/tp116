// 当地时段合并。
// 输入同一地区的若干段当地钟面时段，先逐段折算成真实基准时刻（跨夏令时也按实际经过时长），
// 再排序合并成互不重叠的几段：首尾相接算一段，中间只要有真实留白（哪怕一分钟）就保留成两段。
// 零长度、起止写反、落在春季跳点里的钟面当场拒绝，并指出是提交的第几段、哪一端。

const { load } = require('./store');
const { ApiError, pickText } = require('./errors');
const { validateDate, validateTime } = require('./convert');
const { intervalsForYears, wallToUtc, formatWall, MINUTE_MS } = require('./transitions');

const MAX_LABEL_LENGTH = 30;

function durationText(minutes) {
  const value = Math.round(minutes);
  if (value === 0) return '0 分';
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return parts.join(' ');
}

// 把已经格式化好的当地钟面再装回毫秒，只用于算「钟面直接相减」有多长，好跟实际经过时长对照
function parseWallMs(wall) {
  return Date.UTC(
    Number(wall.date.slice(0, 4)),
    Number(wall.date.slice(5, 7)) - 1,
    Number(wall.date.slice(8, 10)),
    Number(wall.time.slice(0, 2)),
    Number(wall.time.slice(3, 5)),
  );
}

function segmentError(index, code, message, field) {
  const err = new ApiError(400, code, `第 ${index + 1} 段：${message}`, field);
  err.segmentIndex = index;
  return err;
}

// 每段的端点写成 { date: 'YYYY-MM-DD', time: 'HH:MM' }，逐段标好是第几段的哪一端
function validateEndpoint(segment, index, side, weekdayNames) {
  const source = segment && typeof segment === 'object' ? segment[side] : null;
  const fieldPrefix = side === 'start' ? 'start' : 'end';
  let date;
  let time;
  try {
    date = validateDate(source && source.date);
  } catch (err) {
    throw segmentError(index, 'SEGMENT_DATE_INVALID', err.message, `${fieldPrefix}Date`);
  }
  try {
    time = validateTime(source && source.time);
  } catch (err) {
    throw segmentError(index, 'SEGMENT_TIME_INVALID', err.message, `${fieldPrefix}Time`);
  }
  const wallMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  let resolved;
  try {
    resolved = wallToUtc(segment.__zone, wallMs);
  } catch (err) {
    if (err.code === 'LOCAL_TIME_SKIPPED') {
      throw segmentError(index, 'LOCAL_TIME_SKIPPED', err.message, `${fieldPrefix}Date`);
    }
    throw err;
  }
  return {
    wallMs,
    utcMs: resolved.ms,
    dst: resolved.dst,
    repeated: resolved.repeated,
    wall: formatWall(segment.__zone, resolved.ms, weekdayNames),
  };
}

// 找出落在开区间 [start, end) 里的夏令时切换，供页面说明这段时间为什么跟钟面相减对不上
function transitionsInside(zone, startMs, endMs) {
  if (!zone.usesDst || zone.dstOffsetMinutes === null) return [];
  const startYear = new Date(startMs).getUTCFullYear();
  const endYear = new Date(endMs).getUTCFullYear();
  const years = [];
  for (let y = startYear - 1; y <= endYear + 1; y += 1) years.push(y);
  const events = [];
  intervalsForYears(zone, years).forEach((item) => {
    if (item.start > startMs && item.start < endMs) {
      events.push({ at: item.start, kind: 'dstStart' });
    }
    if (item.end > startMs && item.end < endMs) {
      events.push({ at: item.end, kind: 'dstEnd' });
    }
  });
  return events.sort((a, b) => a.at - b.at);
}

function mergeIntervals(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择时段所在的地区', 'zoneId');

  const data = load();
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的地区没有登记过', 'zoneId');

  const rawList = input.intervals;
  if (!Array.isArray(rawList)) {
    throw new ApiError(400, 'INTERVALS_REQUIRED', '请至少填写一段当地时段', 'intervals');
  }
  if (rawList.length === 0) {
    throw new ApiError(400, 'INTERVALS_EMPTY', '请至少填写一段当地时段', 'intervals');
  }

  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const prepared = rawList.map((raw, index) => {
    const segment = raw && typeof raw === 'object' ? raw : {};
    const label = pickText(segment.label) || `第 ${index + 1} 段`;
    if (label.length > MAX_LABEL_LENGTH) {
      throw segmentError(index, 'SEGMENT_LABEL_TOO_LONG', `标注不能超过 ${MAX_LABEL_LENGTH} 个字符`, 'label');
    }
    const withZone = { ...segment, __zone: zone };
    const start = validateEndpoint(withZone, index, 'start', weekdayNames);
    const end = validateEndpoint(withZone, index, 'end', weekdayNames);
    if (start.utcMs === end.utcMs) {
      throw segmentError(index, 'SEGMENT_ZERO_LENGTH', '这是零长度时段，起止时刻相同', 'startDate');
    }
    if (start.utcMs > end.utcMs) {
      throw segmentError(index, 'SEGMENT_REVERSED', '起止写反了，开始时刻晚于结束时刻', 'startDate');
    }
    return {
      index,
      label,
      startMs: start.utcMs,
      endMs: end.utcMs,
      startWall: start.wall,
      endWall: end.wall,
      startRepeated: start.repeated,
      endRepeated: end.repeated,
      durationMinutes: Math.round((end.utcMs - start.utcMs) / MINUTE_MS),
      wallDurationMinutes: Math.round((end.wallMs - start.wallMs) / MINUTE_MS),
    };
  });

  // 两两重叠明细：列出究竟是原来的哪几段压在了一起、压了多久（按真实时刻相交）
  const overlaps = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i];
      const b = prepared[j];
      const lo = Math.max(a.startMs, b.startMs);
      const hi = Math.min(a.endMs, b.endMs);
      if (lo < hi) {
        overlaps.push({
          aIndex: a.index + 1,
          bIndex: b.index + 1,
          aLabel: a.label,
          bLabel: b.label,
          startWall: formatWall(zone, lo, weekdayNames),
          endWall: formatWall(zone, hi, weekdayNames),
          minutes: Math.round((hi - lo) / MINUTE_MS),
          durationText: durationText((hi - lo) / MINUTE_MS),
        });
      }
    }
  }

  // 相接（下一段开始正好等于上一段结束）并进同一段；严格大于才是留白，一分钟也算两段
  const sorted = prepared.slice().sort((a, b) => (a.startMs - b.startMs) || (a.index - b.index));
  const groups = [];
  sorted.forEach((segment) => {
    const current = groups[groups.length - 1];
    if (current && segment.startMs <= current.endMs) {
      current.members.push(segment);
      if (segment.endMs > current.endMs) current.endMs = segment.endMs;
    } else {
      groups.push({ startMs: segment.startMs, endMs: segment.endMs, members: [segment] });
    }
  });

  const merged = groups.map((group, gi) => {
    const members = group.members.slice().sort((a, b) => (a.startMs - b.startMs) || (a.index - b.index));
    const events = transitionsInside(zone, group.startMs, group.endMs);
    const wallMinutes = Math.round((parseWallMs(formatWall(zone, group.endMs, weekdayNames))
      - parseWallMs(formatWall(zone, group.startMs, weekdayNames))) / MINUTE_MS);
    return {
      index: gi + 1,
      start: formatWall(zone, group.startMs, weekdayNames),
      end: formatWall(zone, group.endMs, weekdayNames),
      durationMinutes: Math.round((group.endMs - group.startMs) / MINUTE_MS),
      durationText: durationText((group.endMs - group.startMs) / MINUTE_MS),
      wallDurationMinutes: wallMinutes,
      wallDurationText: durationText(wallMinutes),
      crossesDst: events.length > 0,
      dstEventCount: events.length,
      dstEvents: events.map((event) => ({
        kind: event.kind === 'dstStart' ? '进入夏令时' : '退出夏令时',
        at: formatWall(zone, event.at, weekdayNames),
      })),
      sourceCount: members.length,
      sources: members.map((member) => ({
        index: member.index + 1,
        label: member.label,
        start: member.startWall,
        end: member.endWall,
        durationMinutes: member.durationMinutes,
        durationText: durationText(member.durationMinutes),
        wallDurationText: durationText(member.wallDurationMinutes),
        fallRepeated: member.startRepeated || member.endRepeated,
      })),
    };
  });

  // 留白明细：相邻两个合并段之间空了多久（一分钟的空隙也要在页面上看得到）
  const gaps = [];
  for (let i = 0; i < merged.length - 1; i += 1) {
    const gapMs = groups[i + 1].startMs - groups[i].endMs;
    if (gapMs > 0) {
      gaps.push({
        afterIndex: merged[i].index,
        beforeIndex: merged[i + 1].index,
        start: formatWall(zone, groups[i].endMs, weekdayNames),
        end: formatWall(zone, groups[i + 1].startMs, weekdayNames),
        minutes: Math.round(gapMs / MINUTE_MS),
        durationText: durationText(gapMs / MINUTE_MS),
      });
    }
  }

  const beforeMinutes = prepared.reduce((sum, item) => sum + item.durationMinutes, 0);
  const beforeWallMinutes = prepared.reduce((sum, item) => sum + item.wallDurationMinutes, 0);
  const afterMinutes = merged.reduce((sum, item) => sum + item.durationMinutes, 0);
  const afterWallMinutes = merged.reduce((sum, item) => sum + item.wallDurationMinutes, 0);
  const repeatedNotes = prepared
    .filter((item) => item.startRepeated || item.endRepeated)
    .map((item) => `第 ${item.index + 1} 段的端点落在秋季回拨的重复钟面里，按这一钟面第一次出现（夏令时）的时刻计算`);

  return {
    zone: {
      id: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      usesDst: zone.usesDst,
    },
    before: {
      count: prepared.length,
      durationMinutes: beforeMinutes,
      durationText: durationText(beforeMinutes),
      wallDurationText: durationText(beforeWallMinutes),
    },
    after: {
      count: merged.length,
      durationMinutes: afterMinutes,
      durationText: durationText(afterMinutes),
      wallDurationText: durationText(afterWallMinutes),
    },
    overlapPairCount: overlaps.length,
    overlapMinutes: overlaps.reduce((sum, item) => sum + item.minutes, 0),
    overlaps,
    gapCount: gaps.length,
    gaps,
    merged,
    repeatedNotes,
  };
}

module.exports = { mergeIntervals, durationText };
