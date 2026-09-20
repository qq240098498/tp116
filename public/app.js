// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
  mergeZones: [],
  mergeRows: [],
  lastMerge: null,
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
    failure.segmentIndex = Number.isInteger(error.segmentIndex) ? error.segmentIndex : null;
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
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.zones.some((item) => item.id === current)) select.value = current;
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

// ---------- 当地时段合并 ----------

const MERGE_FIELD_KEYS = {
  startDate: 'startDate',
  startTime: 'startTime',
  endDate: 'endDate',
  endTime: 'endTime',
  label: 'label',
};

function todayText() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function newMergeRow(preset) {
  return {
    label: (preset && preset.label) || '',
    startDate: (preset && preset.startDate) || todayText(),
    startTime: (preset && preset.startTime) || '09:00',
    endDate: (preset && preset.endDate) || todayText(),
    endTime: (preset && preset.endTime) || '10:00',
  };
}

// 合并面板的地区下拉用未筛选的全量档案，避免被档案区的筛选条件藏掉
async function loadMergeZones() {
  const payload = await request('/api/zones');
  state.mergeZones = payload.zones || [];
  renderMergeZoneOptions();
}

function renderMergeZoneOptions() {
  const select = el('merge-zone');
  const current = select.value;
  select.innerHTML = state.mergeZones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}${item.usesDst ? '（有夏令时）' : ''}</option>`)
    .join('');
  if (state.mergeZones.some((item) => item.id === current)) {
    select.value = current;
  } else {
    const dstZone = state.mergeZones.find((item) => item.usesDst);
    if (dstZone) select.value = dstZone.id;
  }
}

function renderMergeRows() {
  const body = el('merge-rows');
  body.innerHTML = state.mergeRows.map((row, index) => `<tr class="merge-row" data-merge-row="${index}">
      <td class="seg-no mono">第 ${index + 1} 段</td>
      <td><input data-merge-input="label" placeholder="例如 早班" maxlength="30" value="${escapeHtml(row.label)}"></td>
      <td><input type="date" data-merge-input="startDate" value="${escapeHtml(row.startDate)}"></td>
      <td><input type="time" data-merge-input="startTime" value="${escapeHtml(row.startTime)}"></td>
      <td><input type="date" data-merge-input="endDate" value="${escapeHtml(row.endDate)}"></td>
      <td><input type="time" data-merge-input="endTime" value="${escapeHtml(row.endTime)}"></td>
      <td class="actions"><button type="button" class="link danger" data-merge-remove="${index}">删除</button></td>
    </tr>`).join('');
}

function clearMergeMarks() {
  document.querySelectorAll('.merge-row.invalid').forEach((node) => node.classList.remove('invalid'));
  document.querySelectorAll('.merge-row [data-merge-input].field-invalid').forEach((node) => node.classList.remove('field-invalid'));
  el('merge-zone').closest('label').classList.remove('invalid');
}

function markMergeError(failure) {
  if (Number.isInteger(failure.segmentIndex)) {
    const row = document.querySelector(`[data-merge-row="${failure.segmentIndex}"]`);
    if (row) {
      row.classList.add('invalid');
      const key = MERGE_FIELD_KEYS[failure.field];
      const input = key ? row.querySelector(`[data-merge-input="${key}"]`) : null;
      if (input) {
        input.classList.add('field-invalid');
        input.focus();
      } else {
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  } else if (failure.field === 'zoneId') {
    el('merge-zone').closest('label').classList.add('invalid');
  }
}

function wallText(wall) {
  return `${wall.date} ${wall.time} ${wall.weekday}`;
}

function renderMergeResult(result) {
  el('merge-result').classList.remove('hidden');
  el('merge-empty').classList.add('hidden');

  const overlapHint = result.overlapPairCount > 0
    ? `，有 ${result.overlapPairCount} 处重叠（合计重复计入 ${result.overlapMinutes} 分钟）`
    : '，没有重叠';
  el('merge-summary').innerHTML = `
    <div class="summary-card">
      <span class="summary-label">地区</span>
      <span class="summary-value">${escapeHtml(result.zone.name)}　${escapeHtml(result.zone.displayName)}${result.zone.usesDst ? '<span class="tag on">有夏令时</span>' : ''}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">合并前</span>
      <span class="summary-value">${result.before.count} 段</span>
      <span class="summary-sub">钟面相减合计 ${escapeHtml(result.before.wallDurationText)}　实际经过 ${escapeHtml(result.before.durationText)}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">合并后</span>
      <span class="summary-value">${result.after.count} 段</span>
      <span class="summary-sub">钟面相减合计 ${escapeHtml(result.after.wallDurationText)}　实际经过 <strong>${escapeHtml(result.after.durationText)}</strong></span>
    </div>
    <div class="summary-card">
      <span class="summary-label">留白</span>
      <span class="summary-value">${result.gapCount} 处${escapeHtml(overlapHint)}</span>
    </div>`;

  const repeated = el('merge-repeated-notes');
  if (result.repeatedNotes && result.repeatedNotes.length) {
    repeated.textContent = result.repeatedNotes.join('；');
    repeated.classList.remove('hidden');
  } else {
    repeated.classList.add('hidden');
  }

  el('merged-list').innerHTML = result.merged.map((group) => `
    <div class="merged-card${group.crossesDst ? ' crosses-dst' : ''}">
      <div class="merged-head">
        <span class="merged-no">合并段 ${group.index}</span>
        <span class="mono merged-range">${escapeHtml(wallText(group.start))} ～ ${escapeHtml(wallText(group.end))}</span>
        ${group.crossesDst ? '<span class="tag warn">跨夏令时</span>' : ''}
      </div>
      <div class="merged-durations">
        实际经过 <strong>${escapeHtml(group.durationText)}</strong>
        ${group.wallDurationText !== group.durationText
          ? `<span class="wall-diff">（钟面直接相减只有 ${escapeHtml(group.wallDurationText)}，少算/多算的部分来自夏令时切换）</span>`
          : ''}
      </div>
      <ul class="source-list">
        ${group.sources.map((src) => `<li>
          <span class="src-no mono">原第 ${src.index} 段</span>
          ${escapeHtml(src.label)}
          <span class="src-range mono">${escapeHtml(wallText(src.start))} ～ ${escapeHtml(wallText(src.end))}</span>
          <span class="src-dur">实际 ${escapeHtml(src.durationText)}${src.wallDurationText !== src.durationText ? `，钟面 ${escapeHtml(src.wallDurationText)}` : ''}</span>
          ${src.fallRepeated ? '<span class="tag off">含秋季重复钟面</span>' : ''}
        </li>`).join('')}
      </ul>
      ${group.crossesDst ? `<p class="dst-events">这一段内部经历 ${group.dstEventCount} 次夏令时切换：${group.dstEvents.map((e) => `${escapeHtml(e.kind)}（${escapeHtml(wallText(e.at))}）`).join('，')}</p>` : ''}
    </div>`).join('');

  el('merge-overlap-head').textContent = `重叠明细（${result.overlaps.length} 处）`;
  el('merge-overlaps').innerHTML = result.overlaps.length
    ? `<ul class="detail-list">${result.overlaps.map((o) => `<li>原第 ${o.aIndex} 段「${escapeHtml(o.aLabel)}」与原第 ${o.bIndex} 段「${escapeHtml(o.bLabel)}」在 <span class="mono">${escapeHtml(wallText(o.startWall))} ～ ${escapeHtml(wallText(o.endWall))}</span> 重叠，重复 <strong>${escapeHtml(o.durationText)}</strong></li>`).join('')}</ul>`
    : '<p class="detail-empty">各段互不重叠</p>';

  el('merge-gap-head').textContent = `留白明细（${result.gaps.length} 处）`;
  el('merge-gaps').innerHTML = result.gaps.length
    ? `<ul class="detail-list">${result.gaps.map((g) => `<li>合并段 ${g.afterIndex} 与 ${g.beforeIndex} 之间空着 <span class="mono">${escapeHtml(wallText(g.start))} ～ ${escapeHtml(wallText(g.end))}</span>，留白 <strong>${escapeHtml(g.durationText)}</strong>${g.minutes === 1 ? '（只隔一分钟，仍按两段保留）' : ''}</li>`).join('')}</ul>`
    : '<p class="detail-empty">段与段之间没有留白</p>';
}

async function runMerge() {
  clearNotice();
  clearMergeMarks();
  el('merge-result').classList.add('hidden');
  const payload = {
    zoneId: el('merge-zone').value,
    intervals: state.mergeRows.map((row) => ({
      label: row.label,
      start: { date: row.startDate, time: row.startTime },
      end: { date: row.endDate, time: row.endTime },
    })),
  };
  try {
    const result = await request('/api/merge-intervals', { method: 'POST', body: JSON.stringify(payload) });
    state.lastMerge = result;
    renderMergeResult(result);
    notify(`合并完成：${result.before.count} 段并成 ${result.after.count} 段`, 'ok');
  } catch (err) {
    notify(err.message, 'error');
    markMergeError(err);
  }
}

// ---------- 事件绑定 ----------

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

  if (node.dataset.mergeRemove !== undefined) {
    const index = Number(node.dataset.mergeRemove);
    state.mergeRows.splice(index, 1);
    renderMergeRows();
    return;
  }
});

// 合并面板的输入框直接回填到 state，重绘时不会丢
document.addEventListener('input', (event) => {
  const inputNode = event.target.closest('[data-merge-input]');
  if (!inputNode) return;
  const rowNode = event.target.closest('[data-merge-row]');
  if (!rowNode) return;
  const index = Number(rowNode.dataset.mergeRow);
  state.mergeRows[index][inputNode.dataset.mergeInput] = inputNode.value;
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
  state.mergeRows.push(newMergeRow());
  renderMergeRows();
});
el('merge-clear').addEventListener('click', () => {
  state.mergeRows = [newMergeRow(), newMergeRow()];
  state.lastMerge = null;
  el('merge-result').classList.add('hidden');
  el('merge-empty').classList.remove('hidden');
  clearMergeMarks();
  renderMergeRows();
});
el('merge-run').addEventListener('click', runMerge);
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
loadZones().catch((err) => notify(err.message, 'error'));

// 合并面板：地区用全量档案，初始给两段方便直接试
state.mergeRows = [newMergeRow(), newMergeRow()];
renderMergeRows();
el('merge-empty').classList.remove('hidden');
loadMergeZones().catch((err) => notify(err.message, 'error'));
