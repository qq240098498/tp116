// 夏令时切换与当地钟面时刻的换算。
// 档案里只登记了规则（第几个星期几的几点几分），这里把规则落到具体年份，
// 得到每一档夏令时区间的真实起止时刻，再做「当地钟面 → 实际经过的基准时刻」互转。
// 关键口径：钟面直接相减在跨夏令时的一天里不成立，一律换成基准时刻再算时长。

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

const pad = (num) => String(num).padStart(2, '0');

// 某年某月「第 n 个星期几」（或最后一个）那天的 hh:mm，按 UTC 坐标拼出来。
// 这里只负责拼出规则所说的那一天那一刻是几月几号，还没扣偏移。
function nthWeekdayMs(year, month, week, weekday, hour, minute) {
  const firstDayMs = Date.UTC(year, month - 1, 1);
  const firstWeekday = new Date(firstDayMs).getUTCDay();
  const offsetToFirst = (weekday - firstWeekday + 7) % 7;
  let day;
  if (week === 'last') {
    const daysInMonth = new Date(Date.UTC(year, month, 1) - DAY_MS).getUTCDate();
    const lastWeekday = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
    day = daysInMonth - (lastWeekday - weekday + 7) % 7;
  } else {
    day = 1 + offsetToFirst + (Number(week) - 1) * 7;
  }
  return Date.UTC(year, month - 1, day, hour, minute);
}

// 把档案在某几个年份里的夏令时区间逐档算出，区间一律左闭右开 [start, end)。
// 开始规则按标准钟面读（钟往前拨的那一下），结束规则按夏令时钟面读（钟往回拨的那一下）：
//   春季：标准钟面到点瞬间，offset 由标准换成夏令时
//   秋季：夏令时钟面到点瞬间，offset 由夏令时换回标准
// 开始月份晚于结束月份的是南半球跨年档，结束那一档落在下一年。
// 档案的生效年份之外不排夏令时，例如二〇一九年停掉的圣保罗在二〇二六年按标准偏移走。
function intervalsForYears(zone, years) {
  const stdMs = zone.offsetMinutes * MINUTE_MS;
  const dstMs = zone.dstOffsetMinutes * MINUTE_MS;
  const list = [];
  years.forEach((year) => {
    if (year < zone.fromYear) return;
    if (zone.toYear !== null && year > zone.toYear) return;
    const start = nthWeekdayMs(
      year,
      zone.dstStart.month,
      zone.dstStart.week,
      zone.dstStart.weekday,
      zone.dstStart.hour,
      zone.dstStart.minute,
    ) - stdMs;
    let endYear = year;
    if (zone.dstEnd.month < zone.dstStart.month) endYear = year + 1;
    const end = nthWeekdayMs(
      endYear,
      zone.dstEnd.month,
      zone.dstEnd.week,
      zone.dstEnd.weekday,
      zone.dstEnd.hour,
      zone.dstEnd.minute,
    ) - dstMs;
    list.push({ start, end });
  });
  list.sort((a, b) => a.start - b.start);
  return list;
}

function inAnyInterval(intervals, utcMs) {
  return intervals.some((item) => utcMs >= item.start && utcMs < item.end);
}

// 某个真实基准时刻适用的偏移（分钟）。不实行夏令时的档案永远给标准偏移。
function offsetAt(zone, utcMs) {
  if (!zone.usesDst || zone.dstOffsetMinutes === null) return zone.offsetMinutes;
  const year = new Date(utcMs).getUTCFullYear();
  const years = [];
  for (let y = year - 1; y <= year + 1; y += 1) years.push(y);
  const intervals = intervalsForYears(zone, years);
  return inAnyInterval(intervals, utcMs) ? zone.dstOffsetMinutes : zone.offsetMinutes;
}

// 当地钟面（用 UTC 坐标装着的「墙上看到的年月日时分」）换成真实基准时刻。
// 春季跳点：钟面被整段跳过（例如纽约 02:00–03:00 不存在），两个候选时刻都对不上，报错。
// 秋季重复：钟面会走两遍（例如纽约 01:30 先后属于夏令时与标准时），取第一次出现，
// 并在返回值里标出 repeated，让页面提醒这一小时的口径。
function wallToUtc(zone, wallMs) {
  const stdMs = zone.offsetMinutes * MINUTE_MS;
  if (!zone.usesDst || zone.dstOffsetMinutes === null) {
    return { ms: wallMs - stdMs, repeated: false, dst: false };
  }
  const dstMs = zone.dstOffsetMinutes * MINUTE_MS;
  const wallYear = new Date(wallMs).getUTCFullYear();
  const years = [];
  for (let y = wallYear - 1; y <= wallYear + 1; y += 1) years.push(y);
  const intervals = intervalsForYears(zone, years);

  const candidateStd = wallMs - stdMs;
  const candidateDst = wallMs - dstMs;
  const stdOk = !inAnyInterval(intervals, candidateStd);
  const dstOk = inAnyInterval(intervals, candidateDst);

  if (dstOk && stdOk) return { ms: candidateDst, repeated: true, dst: true };
  if (dstOk) return { ms: candidateDst, repeated: false, dst: true };
  if (stdOk) return { ms: candidateStd, repeated: false, dst: false };
  const err = new Error('这个钟面时刻在当地不存在：正逢春季开始夏令时，时钟直接跳过了这一段，请改填跳点之后的时刻');
  err.code = 'LOCAL_TIME_SKIPPED';
  throw err;
}

// 真实基准时刻换回当地钟面，并带上此刻是否处于夏令时
function formatWall(zone, utcMs, weekdayNames) {
  const offsetMinutes = offsetAt(zone, utcMs);
  const wall = new Date(utcMs + offsetMinutes * MINUTE_MS);
  return {
    date: `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
    time: `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`,
    weekday: weekdayNames[wall.getUTCDay()],
    dst: zone.usesDst && offsetMinutes === zone.dstOffsetMinutes,
  };
}

module.exports = {
  nthWeekdayMs,
  intervalsForYears,
  offsetAt,
  wallToUtc,
  formatWall,
  MINUTE_MS,
};
