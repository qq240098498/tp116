// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
  mergeRows: [],
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.matches('input, select, textarea') ? target : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTH_LABEL = Object.fromEntries(MONTHS);
const WEEK_LABEL = Object.fromEntries(WEEKS);
const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);

function ruleText(part) {
  if (!part) return '—';
  const hour = String(part.hour).padStart(2, '0');
  const minute = String(part.minute).padStart(2, '0');
  return `${MONTH_LABEL[String(part.month)] || part.month}${WEEK_LABEL[part.week] || part.week}${WEEKDAY_LABEL[String(part.weekday)] || part.weekday} ${hour}:${minute}`;
}

const OPERATOR_KEY = 'zone-clock-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

function fillOptions() {
  const monthOptions = MONTHS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekOptions = WEEKS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekdayOptions = WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['zone-start-month', 'zone-end-month'].forEach((id) => { el(id).innerHTML = monthOptions; });
  ['zone-start-week', 'zone-end-week'].forEach((id) => { el(id).innerHTML = weekOptions; });
  ['zone-start-weekday', 'zone-end-weekday'].forEach((id) => { el(id).innerHTML = weekdayOptions; });
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
  renderConvertZoneOptions();
}

function renderZones() {
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；当前筛选出 ${state.zones.length} 条`;
  const body = el('zone-body');
  body.innerHTML = state.zones.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const options = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  ['convert-zone', 'merge-zone'].forEach((id) => {
    const select = el(id);
    const current = select.value;
    select.innerHTML = options;
    if (state.zones.some((item) => item.id === current)) select.value = current;
  });
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  el('zone-offset').value = zone ? String(zone.offsetMinutes) : '';
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null ? String(zone.dstOffsetMinutes) : '';
  const start = zone && zone.dstStart ? zone.dstStart : { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 };
  const end = zone && zone.dstEnd ? zone.dstEnd : { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 };
  el('zone-start-month').value = String(start.month);
  el('zone-start-week').value = start.week;
  el('zone-start-weekday').value = String(start.weekday);
  el('zone-start-hour').value = String(start.hour);
  el('zone-start-minute').value = String(start.minute);
  el('zone-end-month').value = String(end.month);
  el('zone-end-week').value = end.week;
  el('zone-end-weekday').value = String(end.weekday);
  el('zone-end-hour').value = String(end.hour);
  el('zone-end-minute').value = String(end.minute);
  el('zone-from-year').value = zone ? String(zone.fromYear) : '';
  el('zone-to-year').value = zone && zone.toYear !== null ? String(zone.toYear) : '';
  el('zone-note').value = zone ? zone.note : '';
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  el('zone-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('zone-name').value,
    displayName: el('zone-display').value,
    offsetMinutes: el('zone-offset').value,
    usesDst: el('zone-uses-dst').checked,
    dstOffsetMinutes: el('zone-dst-offset').value === '' ? null : el('zone-dst-offset').value,
    dstStart: {
      month: el('zone-start-month').value,
      week: el('zone-start-week').value,
      weekday: el('zone-start-weekday').value,
      hour: el('zone-start-hour').value,
      minute: el('zone-start-minute').value,
    },
    dstEnd: {
      month: el('zone-end-month').value,
      week: el('zone-end-week').value,
      weekday: el('zone-end-weekday').value,
      hour: el('zone-end-hour').value,
      minute: el('zone-end-minute').value,
    },
    fromYear: el('zone-from-year').value,
    toYear: el('zone-to-year').value === '' ? null : el('zone-to-year').value,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
  }
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/zones/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('时区档案已保存', 'ok');
    } else {
      await request('/api/zones', { method: 'POST', body: JSON.stringify(payload) });
      notify('时区档案已新增', 'ok');
    }
    closeZoneForm();
    await loadZones();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function runConvert() {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = result;
    renderConvert(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function renderConvert(result) {
  el('convert-meta').textContent = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.offsetText}）的 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// ---------- 时段合并 ----------

let mergeSeq = 0;

function addMergeRow(preset) {
  state.mergeRows.push({
    uid: `merge-row-${mergeSeq++}`,
    startDate: preset && preset.startDate ? preset.startDate : '',
    startTime: preset && preset.startTime ? preset.startTime : '',
    endDate: preset && preset.endDate ? preset.endDate : '',
    endTime: preset && preset.endTime ? preset.endTime : '',
    label: preset && preset.label ? preset.label : '',
  });
  renderMergeRows();
}

function renderMergeRows() {
  const body = el('merge-rows');
  body.innerHTML = state.mergeRows.map((row, index) => `<tr data-merge-uid="${escapeHtml(row.uid)}" data-merge-index="${index}">
      <td class="merge-idx mono">第 ${index + 1} 段</td>
      <td><input type="date" data-merge-field="startDate" value="${escapeHtml(row.startDate)}"></td>
      <td><input type="time" data-merge-field="startTime" value="${escapeHtml(row.startTime)}" placeholder="09:00"></td>
      <td><input type="date" data-merge-field="endDate" value="${escapeHtml(row.endDate)}"></td>
      <td><input type="time" data-merge-field="endTime" value="${escapeHtml(row.endTime)}" placeholder="10:00"></td>
      <td class="merge-label"><input type="text" data-merge-field="label" value="${escapeHtml(row.label)}" maxlength="40" placeholder="例如 上午班"></td>
      <td class="merge-act"><button type="button" class="link danger" data-merge-remove="${escapeHtml(row.uid)}">删除</button></td>
    </tr>`).join('');
}

function collectMergePayload() {
  return {
    zoneId: el('merge-zone').value,
    segments: state.mergeRows.map((row) => ({
      startDate: row.startDate,
      startTime: row.startTime,
      endDate: row.endDate,
      endTime: row.endTime,
      label: row.label,
    })),
  };
}

// 输入改动即时同步回状态，重绘不会把用户正在填的内容清掉
function syncMergeRow(uid, field, value) {
  const row = state.mergeRows.find((item) => item.uid === uid);
  if (row) row[field] = value;
}

// 服务端 field 形如 segments[2].startTime，把问题标到第 3 段对应的格子上
function markMergeField(field) {
  const match = /^segments\[(\d+)\](?:\.([a-zA-Z]+))?$/.exec(field || '');
  if (!match) return;
  const index = Number(match[1]);
  const part = match[2] || '';
  const row = el('merge-rows').children[index];
  if (!row) return;
  row.classList.add('invalid');
  const selector = part ? `[data-merge-field="${part}"]` : 'input';
  const input = row.querySelector(selector);
  if (input) {
    input.classList.add('invalid');
    input.focus();
  }
}

function clearMergeMarks() {
  document.querySelectorAll('#merge-rows .invalid').forEach((node) => node.classList.remove('invalid'));
}

async function runMerge() {
  clearNotice();
  clearMergeMarks();
  el('merge-result').classList.add('hidden');
  if (state.mergeRows.length === 0) {
    notify('请先添加至少一段当地时段', 'error');
    return;
  }
  try {
    const result = await request('/api/merge', { method: 'POST', body: JSON.stringify(collectMergePayload()) });
    renderMergeResult(result);
  } catch (err) {
    notify(err.message, 'error');
    if (err.field && err.field.startsWith('segments')) markMergeField(err.field);
    if (err.field === 'zoneId') markField('mergeZone');
  }
}

function sourceTags(sources) {
  return sources.map((source) => {
    const label = source.label ? `（${escapeHtml(source.label)}）` : '';
    return `<span class="src-tag" title="${escapeHtml(source.startText)} ~ ${escapeHtml(source.endText)}，实际 ${escapeHtml(source.durationText)}${source.crossesDst ? '，跨夏令时' : ''}">第 ${source.index} 段${label}</span>`;
  }).join('');
}

function renderMergeResult(result) {
  el('merge-result').classList.remove('hidden');
  el('merge-summary').textContent =
    `${result.zone.name}（${result.zone.displayName}，${result.zone.offsetText}${result.zone.usesDst ? `，夏令时 ${result.zone.dstOffsetText}` : ''}）：`
    + `合并前 ${result.beforeCount} 段，合并后 ${result.afterCount} 段，少了 ${result.joinedAwayCount} 段；`
    + `原段钟面累加 ${result.rawTotalDurationText}，扣除重叠 ${result.overlapDurationText} 后，`
    + `合并后总实际时长 ${result.totalDurationText}；段间留白 ${result.gapCount} 处，跨夏令时的原段 ${result.dstCrossCount} 段`;

  el('merge-out-body').innerHTML = result.merged.map((item) => `<tr>
      <td class="mono">第 ${item.index} 段${item.joined ? '<span class="tag on">已合并</span>' : '<span class="tag off">原样</span>'}</td>
      <td class="mono">${escapeHtml(item.startText)}</td>
      <td class="mono">${escapeHtml(item.endText)}</td>
      <td class="mono"><strong>${escapeHtml(item.durationText)}</strong></td>
      <td class="src-cell">${sourceTags(item.sources)}</td>
    </tr>`).join('');

  const gapWrap = el('merge-gap-wrap');
  if (result.gaps.length > 0) {
    gapWrap.classList.remove('hidden');
    el('merge-gap-body').innerHTML = result.gaps.map((gap) => `<tr>
        <td>第 ${gap.afterMergedIndex} 段结束到第 ${gap.afterMergedIndex + 1} 段开始（第 ${gap.afterMergedIndex + 1} 段之前）</td>
        <td class="mono">${escapeHtml(gap.startText)}</td>
        <td class="mono">${escapeHtml(gap.endText)}</td>
        <td class="mono">${escapeHtml(gap.durationText)}</td>
      </tr>`).join('');
  } else {
    gapWrap.classList.add('hidden');
  }
  el('merge-gap-empty').classList.toggle('hidden', result.gaps.length > 0);

  el('merge-seg-body').innerHTML = result.segments.map((item) => `<tr>
      <td class="mono">第 ${item.index} 段</td>
      <td>${item.label ? escapeHtml(item.label) : '—'}</td>
      <td class="mono">${escapeHtml(item.startText)}</td>
      <td class="mono">${escapeHtml(item.endText)}</td>
      <td class="mono">${escapeHtml(item.wallDurationText)}</td>
      <td class="mono"><strong>${escapeHtml(item.durationText)}</strong>${item.crossesDst ? '<span class="tag warn">钟面与实际不一致</span>' : ''}</td>
      <td>${item.crossesDst ? '<span class="tag warn">跨夏令时</span>' : '—'}</td>
    </tr>`).join('');

  el('merge-note').textContent = result.note;
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      notify('时区档案已删除', 'ok');
      await loadZones();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.mergeRemove) {
    clearNotice();
    const index = state.mergeRows.findIndex((item) => item.uid === node.dataset.mergeRemove);
    if (index !== -1) {
      state.mergeRows.splice(index, 1);
      renderMergeRows();
    }
  }
});

// 时段行里的输入改动即时存回状态，避免重绘清空
el('merge-rows').addEventListener('input', (event) => {
  const input = event.target.closest('[data-merge-field]');
  if (!input) return;
  const rowNode = event.target.closest('tr[data-merge-uid]');
  if (!rowNode) return;
  syncMergeRow(rowNode.dataset.mergeUid, input.dataset.mergeField, input.value);
});
el('merge-rows').addEventListener('change', (event) => {
  const input = event.target.closest('[data-merge-field]');
  if (!input) return;
  const rowNode = event.target.closest('tr[data-merge-uid]');
  if (!rowNode) return;
  syncMergeRow(rowNode.dataset.mergeUid, input.dataset.mergeField, input.value);
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('zone-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-reset').addEventListener('click', () => {
  el('zone-filter-dst').value = '';
  el('zone-filter-keyword').value = '';
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-refresh').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('merge-add').addEventListener('click', () => {
  clearNotice();
  addMergeRow();
});
el('merge-run').addEventListener('click', () => {
  runMerge().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把档案拉一遍，换算台的来源时区下拉按这份清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
// 时段合并默认给出两行，日期预填今天，时刻留空由使用者填
{
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  addMergeRow({ startDate: today, endDate: today });
  addMergeRow({ startDate: today, endDate: today });
}
loadZones().catch((err) => notify(err.message, 'error'));
