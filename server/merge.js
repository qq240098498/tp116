// 当地时段合并：先把每一段当地钟面起止按该时区的夏令时规则折算成实际经过的时间轴，
// 再在时间轴上合并重叠与首尾相接的段。时长一律按实际经过的时长算，不能拿墙上钟面直接相减。
const { load, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTE_MS = 60000;

const pad = (num) => String(num).padStart(2, '0');

// 规则里的“第几个星期几几点几分”落到这一年的墙上钟面毫秒（Date.UTC 口径，只借它做日历推算）
function nthWeekdayWallMs(rule, year) {
  const first = Date.UTC(year, rule.month - 1, 1);
  const firstWeekday = new Date(first).getUTCDay();
  let dayOfMonth;
  if (rule.week !== 'last') {
    dayOfMonth = (rule.weekday - firstWeekday + 7) % 7 + 1 + (Number(rule.week) - 1) * 7;
  } else {
    const daysInMonth = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
    const lastWeekday = new Date(Date.UTC(year, rule.month - 1, daysInMonth)).getUTCDay();
    dayOfMonth = daysInMonth - (lastWeekday - rule.weekday + 7) % 7;
  }
  return Date.UTC(year, rule.month - 1, dayOfMonth, rule.hour, rule.minute);
}

// 造一批覆盖目标年份的夏令时切换点（实际时刻毫秒）。
// 春跳那一刻规则钟面按标准偏移读：钟到点向前拨；秋回那一刻规则钟面按夏令时偏移读：钟到点向后拨，
// 这与档案里几条规则（纽约两点、伦敦一点/两点、悉尼三点、查塔姆三点四十五）的实际口径一致。
// 档案的生效年份区间要算数：已经停止实行夏令时的地区（toYear 之后）不再产生新的切换
function buildTransitions(zone, centerYears) {
  if (!zone.usesDst) return [];
  const minYear = Math.min(...centerYears) - 3;
  const maxYear = Math.max(...centerYears) + 3;
  const points = [];
  for (let year = minYear; year <= maxYear; year += 1) {
    // 结束月份号不小于开始月份号是北半球同年；更小则是南半球跨年，结束段落在下一年
    const endYear = zone.dstEnd.month >= zone.dstStart.month ? year : year + 1;
    // 一整段夏令时区间的开始年与结束年都要落在生效年份内，缺一边说明那一年已经不实行了
    if (year < zone.fromYear) continue;
    if (zone.toYear !== null && endYear > zone.toYear) continue;
    const springWall = nthWeekdayWallMs(zone.dstStart, year);
    points.push({ ms: springWall - zone.offsetMinutes * MINUTE_MS, enterDst: true });
    const fallWall = nthWeekdayWallMs(zone.dstEnd, endYear);
    points.push({ ms: fallWall - zone.dstOffsetMinutes * MINUTE_MS, enterDst: false });
  }
  points.sort((a, b) => a.ms - b.ms);
  return points;
}

// 某实际时刻该时区用的偏移：从标准偏移起，按时间顺序每过一个切换点翻一次
function offsetAt(ms, zone, transitions) {
  if (!zone.usesDst) return zone.offsetMinutes;
  let offset = zone.offsetMinutes;
  for (const point of transitions) {
    if (point.ms > ms) break;
    offset = point.enterDst ? zone.dstOffsetMinutes : zone.offsetMinutes;
  }
  return offset;
}

// 在春跳空洞里找包住该钟面的那次春跳：春跳规则钟面 w 之后 shift 毫秒内的钟面都不存在
function findSpringGap(wallMs, zone, transitions) {
  if (!zone.usesDst) return null;
  const shift = (zone.dstOffsetMinutes - zone.offsetMinutes) * MINUTE_MS;
  for (const point of transitions) {
    if (!point.enterDst) continue;
    const gapStart = point.ms + zone.offsetMinutes * MINUTE_MS;
    if (wallMs >= gapStart && wallMs < gapStart + shift) {
      return { gapStart, shift };
    }
  }
  return null;
}

// 把当地墙上钟面（YYYY-MM-DD HH:MM）解析成候选实际时刻。
// 春跳丢掉的钟面在当地不存在，当场拒绝；秋回重复的钟面出现两次，返回按发生先后排好的两个候选，
// 由调用端按“起点取第一次、终点取不早于起点的最早一次”来定，让短区间不至于被拉成跨回拨的长区间
function resolveWallTime(zone, wallText, datePart, timePart, index, edge, transitions) {
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);

  if (!zone.usesDst) {
    return [{ ms: wallMs - zone.offsetMinutes * MINUTE_MS, offset: zone.offsetMinutes }];
  }

  const stdCandidate = wallMs - zone.offsetMinutes * MINUTE_MS;
  const dstCandidate = wallMs - zone.dstOffsetMinutes * MINUTE_MS;
  const stdValid = offsetAt(stdCandidate, zone, transitions) === zone.offsetMinutes;
  const dstValid = offsetAt(dstCandidate, zone, transitions) === zone.dstOffsetMinutes;

  const candidates = [];
  if (dstValid) candidates.push({ ms: dstCandidate, offset: zone.dstOffsetMinutes });
  if (stdValid) candidates.push({ ms: stdCandidate, offset: zone.offsetMinutes });
  candidates.sort((a, b) => a.ms - b.ms);

  if (candidates.length > 0) {
    return candidates.map((item, i) => (i > 0 ? { ...item, ambiguous: true } : item));
  }

  // 两种读法都不成立：这个钟面落在春跳空洞里，报清楚跳到了哪里
  const gap = findSpringGap(wallMs, zone, transitions);
  const shift = (zone.dstOffsetMinutes - zone.offsetMinutes) * MINUTE_MS;
  const jumpFrom = gap ? formatWall(gap.gapStart) : '';
  const jumpTo = gap ? formatWall(gap.gapStart + shift) : '';
  throw new ApiError(
    400,
    'INTERVAL_WALLTIME_SKIPPED',
    `第 ${index + 1} 段的${edge === 'start' ? '开始' : '结束'}时刻 ${wallText} 在当地不存在：夏令时开始时钟面从 ${jumpFrom} 直接跳到 ${jumpTo}，请改用跳时之后的时刻`,
    `segments[${index}].${edge === 'start' ? 'startTime' : 'endTime'}`,
  );
}

function formatWall(wallMs) {
  const d = new Date(wallMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function validateLocalDate(value, index, edge) {
  const text = pickText(value);
  const field = `segments[${index}].${edge === 'start' ? 'startDate' : 'endDate'}`;
  const label = edge === 'start' ? '开始' : '结束';
  if (!text) throw new ApiError(400, 'INTERVAL_DATE_REQUIRED', `第 ${index + 1} 段要填写${label}日期`, field);
  if (!DATE_PATTERN.test(text)) {
    throw new ApiError(400, 'INTERVAL_DATE_INVALID', `第 ${index + 1} 段的${label}日期要写成 2026-09-20 这样`, field);
  }
  const [year, month, day] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'INTERVAL_DATE_INVALID', `第 ${index + 1} 段的${label}日期不存在，请检查月份与日`, field);
  }
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'INTERVAL_YEAR_OUT_OF_RANGE', `第 ${index + 1} 段的年份要在 ${MIN_YEAR} 到 ${MAX_YEAR} 之间`, field);
  }
  return text;
}

function validateLocalTime(value, index, edge) {
  const text = pickText(value);
  const field = `segments[${index}].${edge === 'start' ? 'startTime' : 'endTime'}`;
  const label = edge === 'start' ? '开始' : '结束';
  if (!text) throw new ApiError(400, 'INTERVAL_TIME_REQUIRED', `第 ${index + 1} 段要填写${label}时刻`, field);
  if (!TIME_PATTERN.test(text)) {
    throw new ApiError(400, 'INTERVAL_TIME_INVALID', `第 ${index + 1} 段的${label}时刻要写成 09:30 这样`, field);
  }
  return text;
}

// 时长按实际分钟排印成天、小时、分
function durationText(totalMinutes) {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const pieces = [];
  if (days) pieces.push(`${days} 天`);
  if (hours) pieces.push(`${hours} 小时`);
  if (minutes) pieces.push(`${minutes} 分`);
  return pieces.length ? pieces.join(' ') : '0 分';
}

// 实际时刻按该时区当前偏移排印成当地钟面
function localStamp(ms, zone, transitions) {
  const offset = offsetAt(ms, zone, transitions);
  const local = new Date(ms + offset * MINUTE_MS);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

function merge(options) {
  const input = options && typeof options === 'object' ? options : {};
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择这些时段所属的时区', 'zoneId');

  const data = load();
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  if (!Array.isArray(input.segments)) {
    throw new ApiError(400, 'SEGMENTS_REQUIRED', '请至少给出一段当地时段', 'segments');
  }
  if (input.segments.length === 0) {
    throw new ApiError(400, 'SEGMENTS_EMPTY', '请至少给出一段当地时段', 'segments');
  }
  if (input.segments.length > 100) {
    throw new ApiError(400, 'SEGMENTS_TOO_MANY', '一次最多合并 100 段时段', 'segments');
  }

  // 先把日期都验一遍，拿到年份范围再造切换点，保证任何端点附近的春跳秋回都在表里
  const parsed = input.segments.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      index,
      label: pickText(source.label),
      startDate: validateLocalDate(source.startDate, index, 'start'),
      startTime: validateLocalTime(source.startTime, index, 'start'),
      endDate: validateLocalDate(source.endDate, index, 'end'),
      endTime: validateLocalTime(source.endTime, index, 'end'),
    };
  });
  const years = parsed.map((item) => Number(item.startDate.slice(0, 4))).concat(
    parsed.map((item) => Number(item.endDate.slice(0, 4))),
  );
  const transitions = buildTransitions(zone, years);

  const segments = parsed.map((item) => {
    const startChoices = resolveWallTime(zone, `${item.startDate} ${item.startTime}`, item.startDate, item.startTime, item.index, 'start', transitions);
    const endChoices = resolveWallTime(zone, `${item.endDate} ${item.endTime}`, item.endDate, item.endTime, item.index, 'end', transitions);

    // 起点取第一次出现；终点取不早于起点的最早一次，保证段内时间单调向前、短区间不被拉成长区间
    const start = startChoices[0];
    let end = endChoices.find((choice) => choice.ms >= start.ms);
    let endTriedLater = false;
    if (!end) {
      end = endChoices[endChoices.length - 1];
      endTriedLater = true;
    }

    if (end.ms === start.ms) {
      throw new ApiError(
        400,
        'INTERVAL_ZERO_LENGTH',
        `第 ${item.index + 1} 段是零长度时段（开始与结束是同一个实际时刻），没有可合并的时长，请删掉或改长这一段`,
        `segments[${item.index}]`,
      );
    }
    if (endTriedLater || end.ms < start.ms) {
      throw new ApiError(
        400,
        'INTERVAL_REVERSED',
        `第 ${item.index + 1} 段的结束早于开始（${item.startDate} ${item.startTime} 之后才到 ${item.endDate} ${item.endTime}），起止写反了，请对调这一段的开始与结束`,
        `segments[${item.index}]`,
      );
    }

    const actualMinutes = Math.round((end.ms - start.ms) / MINUTE_MS);
    const wallMinutes = (() => {
      const s = Date.UTC(...dateParts(item.startDate), ...timeParts(item.startTime));
      const e = Date.UTC(...dateParts(item.endDate), ...timeParts(item.endTime));
      return Math.round((e - s) / MINUTE_MS);
    })();
    const crossesDst = start.offset !== end.offset || actualMinutes !== wallMinutes;

    return {
      index: item.index,
      label: item.label,
      startMs: start.ms,
      endMs: end.ms,
      startText: `${item.startDate} ${item.startTime}`,
      endText: `${item.endDate} ${item.endTime}`,
      ambiguous: Boolean(start.ambiguous || end.ambiguous),
      durationMinutes: actualMinutes,
      durationText: durationText(actualMinutes),
      wallDurationMinutes: wallMinutes,
      crossesDst,
    };
  });

  // 时间轴上按开始时刻排序；同时开始的结束晚的排前面，保证短段被长段整个吞进去
  const ordered = segments.slice().sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);

  // 开始时刻正好等于当前段结束（首尾相接）也算接上；严格晚于才留成真实空白
  const groups = [];
  let current = null;
  for (const seg of ordered) {
    if (current && seg.startMs <= current.endMs) {
      current.members.push(seg);
      if (seg.endMs > current.endMs) current.endMs = seg.endMs;
    } else {
      if (current) groups.push(current);
      current = { startMs: seg.startMs, endMs: seg.endMs, members: [seg] };
    }
  }
  if (current) groups.push(current);

  const merged = groups.map((group, groupIndex) => {
    const groupMinutes = Math.round((group.endMs - group.startMs) / MINUTE_MS);
    return {
      index: groupIndex + 1,
      startText: localStamp(group.startMs, zone, transitions),
      endText: localStamp(group.endMs, zone, transitions),
      startUtc: new Date(group.startMs).toISOString(),
      endUtc: new Date(group.endMs).toISOString(),
      durationMinutes: groupMinutes,
      durationText: durationText(groupMinutes),
      sourceCount: group.members.length,
      joined: group.members.length > 1,
      sources: group.members
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((member) => ({
          index: member.index + 1,
          label: member.label,
          startText: member.startText,
          endText: member.endText,
          durationText: member.durationText,
          crossesDst: member.crossesDst,
        })),
    };
  });

  // 合并段之间真实留白的间隙（只隔一分钟也保留，页面要能看到）
  const gaps = [];
  for (let i = 1; i < groups.length; i += 1) {
    const gapMinutes = Math.round((groups[i].startMs - groups[i - 1].endMs) / MINUTE_MS);
    gaps.push({
      index: i,
      afterMergedIndex: i,
      startText: localStamp(groups[i - 1].endMs, zone, transitions),
      endText: localStamp(groups[i].startMs, zone, transitions),
      durationMinutes: gapMinutes,
      durationText: durationText(gapMinutes),
    });
  }

  const beforeCount = segments.length;
  const afterCount = merged.length;
  const sumBefore = segments.reduce((acc, item) => acc + item.durationMinutes, 0);
  const sumAfter = merged.reduce((acc, item) => acc + item.durationMinutes, 0);
  const overlapMinutes = sumBefore - sumAfter;
  const dstCrossCount = segments.filter((item) => item.crossesDst).length;

  return {
    zone: {
      id: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetText: offsetText(zone.offsetMinutes),
      usesDst: zone.usesDst,
      dstOffsetText: zone.usesDst ? offsetText(zone.dstOffsetMinutes) : '',
    },
    beforeCount,
    afterCount,
    mergedCount: afterCount,
    joinedAwayCount: beforeCount - afterCount,
    totalDurationMinutes: sumAfter,
    totalDurationText: durationText(sumAfter),
    rawTotalDurationMinutes: sumBefore,
    rawTotalDurationText: durationText(sumBefore),
    overlapDurationMinutes: overlapMinutes,
    overlapDurationText: durationText(Math.max(overlapMinutes, 0)),
    gapCount: gaps.length,
    dstCrossCount,
    ambiguousCount: segments.filter((item) => item.ambiguous).length,
    note: zone.usesDst
      ? '该时区登记了夏令时规则：所有时长均按实际经过的时长计算，跨春跳、秋回的段会与墙上钟面差不一致；落在秋回重复钟面的端点，起点按第一次出现、终点按不早于起点的最早一次折算；已过结束年份的时段不再按夏令时处理'
      : '该时区不实行夏令时，实际时长与墙上钟面一致',
    merged,
    gaps,
    segments: segments
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => ({
        index: item.index + 1,
        label: item.label,
        startText: item.startText,
        endText: item.endText,
        durationText: item.durationText,
        wallDurationText: durationText(item.wallDurationMinutes),
        crossesDst: item.crossesDst,
        ambiguous: item.ambiguous,
      })),
  };
}

function dateParts(date) {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m - 1, d];
}

function timeParts(time) {
  const [h, min] = time.split(':').map(Number);
  return [h, min];
}

module.exports = { merge };
