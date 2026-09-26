'use strict';
/* 净厨 HoodCare 前端（零依赖原生 JS） */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = (f) => `¥${(f / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const dtd = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

const state = { boot: null, jobs: [], view: 'dashboard', currentJob: null, unread: 0 };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': $('#user-select')?.value || '' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || '请求失败'), { code: data.error, data });
  return data;
}
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}
const roleLabel = { crew: '施工', inspector: '验收', finance: '财务', store: '门店', planner: '调度' };
const statusLabel = {
  scheduled: '已排班', in_progress: '施工中', cleaning: '清洗中', drying: '干燥中',
  reassembling: '复装中', testing: '试运行', acceptance: '待验收', completed: '验收完成',
  rework: '返工', rejected_sign: '门店拒签', settled: '已结算',
};
const statusTag = (s) => ({
  scheduled: 'gray', in_progress: 'blue', cleaning: 'blue', drying: 'blue', reassembling: 'blue',
  testing: 'amber', completed: 'green', rework: 'red', rejected_sign: 'red', settled: 'dark',
}[s] || 'gray');
const segStepLabel = { pending: '待拆卸', removed: '已拆卸', cleaned: '已清洗', dried: '已干燥', reassembled: '已复装', tested: '试运行✓' };
const segStepRank = { pending: 0, removed: 1, cleaned: 2, dried: 3, reassembled: 4, tested: 5 };
const STEPS = [['remove', '拆卸'], ['clean', '清洗'], ['dry', '干燥'], ['reassemble', '复装'], ['test_run', '试运行']];

async function refreshBoot() { state.boot = await api('/api/bootstrap'); }
async function refreshJobs() { state.jobs = await api('/api/jobs'); }

/* ---------------- 启动 ---------------- */
async function init() {
  await refreshBoot();
  renderUserSelect();
  bindChrome();
  connectSSE();
  await go('dashboard');
}
function renderUserSelect() {
  $('#user-select').innerHTML = state.boot.users
    .map(u => `<option value="${u.id}">${esc(u.display_name)}（${roleLabel[u.role]}）</option>`).join('');
  const saved = localStorage.getItem('hc_uid');
  if (saved && state.boot.users.some(u => String(u.id) === saved)) $('#user-select').value = saved;
  $('#user-select').onchange = () => { localStorage.setItem('hc_uid', $('#user-select').value); render(); };
}
function bindChrome() {
  $('#nav').addEventListener('click', e => { const a = e.target.closest('a'); if (a) go(a.dataset.view); });
  $('#bell').onclick = openNotif;
  $('#drawer-close').onclick = $('#drawer-mask').onclick = () => { $('#notif-drawer').classList.add('hidden'); $('#drawer-mask').classList.add('hidden'); };
  $('#modal-close').onclick = $('#modal-mask').onclick = closeModal;
  $('#sign-cancel').onclick = () => $('#sign-modal').classList.add('hidden');
}
async function go(view, arg) {
  state.view = view; state.currentJob = arg || null;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  $('#view-title').textContent = { dashboard: '工作台', plans: '周期计划', windows: '停灶协调', jobs: '分段施工单', finance: '费用复核' }[view];
  await render();
}
async function render() {
  await refreshJobs();
  const c = $('#content');
  if (state.view === 'dashboard') c.innerHTML = viewDashboard();
  if (state.view === 'plans') c.innerHTML = viewPlans();
  if (state.view === 'windows') c.innerHTML = viewWindows();
  if (state.view === 'jobs') c.innerHTML = state.currentJob ? viewJob(await api(`/api/jobs/${state.currentJob}`)) : viewJobs();
  if (state.view === 'finance') c.innerHTML = viewFinance();
  bindView();
}

/* ---------------- 工作台 ---------------- */
function viewDashboard() {
  const j = state.jobs;
  const active = j.filter(x => ['in_progress','cleaning','drying','reassembling','testing'].includes(x.status));
  const dueSoon = state.boot.segments; // placeholder
  const plans = state.boot; // bootstrap 未带 plans，工作台只统计
  return `
  <div class="grid cols-4 mb">
    <div class="stat"><div class="n">${j.length}</div><div class="l">施工单总数</div></div>
    <div class="stat"><div class="n green">${j.filter(x => x.status === 'settled').length}</div><div class="l">已结算</div></div>
    <div class="stat"><div class="n amber">${active.length}</div><div class="l">进行中</div></div>
    <div class="stat"><div class="n red">${j.filter(x => ['rework','rejected_sign'].includes(x.status)).length}</div><div class="l">返工 / 拒签待处理</div></div>
  </div>
  <div class="card">
    <div class="card-title">进行中的施工单 <span class="sub">点击进入分段施工单</span></div>
    ${active.length ? `<table><thead><tr><th>单号</th><th>门店</th><th>班组</th><th>状态</th><th>停灶时段</th><th>超时</th></tr></thead><tbody>
      ${active.map(x => `<tr class="clickable" data-job="${x.id}">
        <td><b>${x.code}</b></td><td>${esc(x.store_name)}</td><td>${esc(x.team_name)}</td>
        <td><span class="tag ${statusTag(x.status)}">${statusLabel[x.status]}</span></td>
        <td class="small">${dtd(x.scheduled_start)} → ${dt(x.scheduled_end)}</td>
        <td>${x.overtime_minutes ? `<span class="tag red">${x.overtime_minutes} 分钟</span>` : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无进行中的施工单</div>'}
  </div>
  <div class="card">
    <div class="card-title">异常与待办 <span class="sub">返工 · 拒签 · 待确认增项</span></div>
    <div id="dash-alerts">${dashboardAlerts()}</div>
  </div>`;
}
function dashboardAlerts() {
  const alerts = [];
  state.jobs.filter(x => ['rework','rejected_sign'].includes(x.status)).forEach(x =>
    alerts.push(`<div class="row mb"><span class="tag ${x.status === 'rework' ? 'red' : 'amber'}">${statusLabel[x.status]}</span>
      <b>${x.code}</b><span class="muted">${esc(x.store_name)} · ${esc(x.team_name)}</span>
      <button class="btn dark" data-job="${x.id}">处理</button></div>`));
  return alerts.join('') || '<div class="empty">全部正常 🎉</div>';
}

/* ---------------- 周期计划 ---------------- */
function viewPlans() {
  // plans 通过接口单独拉（render 中填充）
  setTimeout(loadPlans, 0);
  return `
  <div class="card">
    <div class="card-title">清洗周期计划
      <span class="sub">按门店设定周期，到期自动推送协调提醒</span>
      <button class="btn primary" id="add-plan" style="margin-left:auto">＋ 新建/调整计划</button>
    </div>
    <div id="plans-body"><div class="empty">加载中…</div></div>
  </div>`;
}
async function loadPlans() {
  const plans = await api('/api/plans');
  const today = new Date();
  $('#plans-body').innerHTML = `<table><thead><tr><th>门店</th><th>周期</th><th>下次到期</th><th>油污</th><th>剩余</th></tr></thead><tbody>
    ${plans.map(p => {
      const days = Math.ceil((new Date(p.next_due_date) - today) / 86400e3);
      const tag = days < 0 ? `<span class="tag red">已逾期 ${-days} 天</span>` :
        days <= 3 ? `<span class="tag red">${days} 天后到期</span>` :
        days <= 10 ? `<span class="tag amber">${days} 天后</span>` : `<span class="tag green">${days} 天</span>`;
      return `<tr><td><b>${esc(p.store_name)}</b></td><td>${p.period_days} 天</td>
        <td>${p.next_due_date}</td><td>${p.heavy_oil ? '<span class="tag red">重油污门店</span>' : '<span class="tag gray">常规</span>'}</td><td>${tag}</td></tr>`;
    }).join('')}</tbody></table>`;
  $('#add-plan').onclick = () => planModal();
}
function planModal() {
  const stores = state.boot.stores;
  openModal('新建 / 调整清洗计划', `
    <div class="form-grid">
      <div class="field full"><label>门店</label><select id="f-store">${stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>清洗周期（天）</label><input id="f-period" type="number" value="60" min="7"></div>
      <div class="field"><label>下次到期日</label><input id="f-due" type="date" value="${new Date(Date.now() + 30 * 86400e3).toISOString().slice(0,10)}"></div>
      <div class="field full"><label><input id="f-heavy" type="checkbox"> 重油污门店（周期内可能触发重油污加项）</label></div>
    </div>
    <div class="right mt"><button class="btn primary big" id="f-save">保存计划</button></div>`);
  $('#f-save').onclick = async () => {
    try {
      await api('/api/plans', { method: 'POST', body: {
        store_id: Number($('#f-store').value), period_days: Number($('#f-period').value),
        next_due_date: $('#f-due').value, heavy_oil: $('#f-heavy').checked } });
      closeModal(); toast('计划已保存'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------------- 停灶协调 ---------------- */
function viewWindows() {
  setTimeout(loadWindows, 0);
  return `
  <div class="card">
    <div class="card-title">停灶窗口协调 <span class="sub">门店确认窗口后才能排班；临时营业需登记并触发改期</span>
      <button class="btn primary" id="add-win" style="margin-left:auto">＋ 发起停灶申请</button></div>
    <div id="win-body"><div class="empty">加载中…</div></div>
  </div>`;
}
async function loadWindows() {
  const wins = await api('/api/windows');
  const tag = { proposed: ['amber', '待门店确认'], confirmed: ['green', '门店已确认'], temporary_business: ['red', '临时营业'], cancelled: ['gray', '已取消'] };
  $('#win-body').innerHTML = wins.map(w => {
    const [cls, lab] = tag[w.status];
    return `<div class="card" style="box-shadow:none;margin-bottom:12px">
      <div class="row">
        <span class="tag ${cls}">${lab}</span><b>${esc(w.store_name)}</b>
        <span class="muted small">${dtd(w.start)} → ${dt(w.end)}</span>
        <span style="margin-left:auto"></span>
        ${w.status === 'proposed' ? `<button class="btn primary" data-win-confirm="${w.id}">门店确认窗口</button>` : ''}
        ${['proposed','confirmed'].includes(w.status) ? `<button class="btn warn" data-win-temp="${w.id}">登记临时营业</button>` : ''}
        ${['proposed'].includes(w.status) ? `<button class="ghost-btn" data-win-cancel="${w.id}">撤销</button>` : ''}
      </div>
      ${w.note ? `<div class="small muted mt">${esc(w.note)}${w.confirmer_name ? ' · 确认人：' + esc(w.confirmer_name) : ''}</div>` : ''}
    </div>`;
  }).join('') || '<div class="empty">暂无停灶申请</div>';
  $$('[data-win-confirm]').forEach(b => b.onclick = async () => {
    try { await api(`/api/windows/${b.dataset.winConfirm}/status`, { method: 'POST', body: { status: 'confirmed' } }); toast('窗口已确认，可以排班'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-win-temp]').forEach(b => b.onclick = async () => {
    const note = prompt('临时营业原因（将通知相关班组改期）：', '门店接到临时包场，无法停灶');
    if (note === null) return;
    try { await api(`/api/windows/${b.dataset.winTemp}/status`, { method: 'POST', body: { status: 'temporary_business', note } }); toast('已登记临时营业，相关施工单需改期', 'warn'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-win-cancel]').forEach(b => b.onclick = async () => {
    await api(`/api/windows/${b.dataset.winCancel}/status`, { method: 'POST', body: { status: 'cancelled' } }); render();
  });
  $('#add-win').onclick = windowModal;
}
function windowModal() {
  openModal('发起停灶申请', `
    <div class="form-grid">
      <div class="field full"><label>门店</label><select id="w-store">${state.boot.stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>停灶开始</label><input id="w-start" type="datetime-local"></div>
      <div class="field"><label>停灶结束</label><input id="w-end" type="datetime-local"></div>
      <div class="field full"><label>备注</label><input id="w-note" placeholder="如：商场夜间施工 / 月度清洗"></div>
    </div>
    <div class="right mt"><button class="btn primary big" id="w-save">提交（待门店确认）</button></div>`);
  $('#w-save').onclick = async () => {
    try {
      await api('/api/windows', { method: 'POST', body: {
        store_id: Number($('#w-store').value),
        start_at: new Date($('#w-start').value).toISOString(), end_at: new Date($('#w-end').value).toISOString(),
        note: $('#w-note').value } });
      closeModal(); toast('已发起，等待门店确认'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------------- 施工单列表（含甘特互斥视图） ---------------- */
function viewJobs() {
  setTimeout(loadGantt, 0);
  return `
  <div class="card">
    <div class="card-title">厨房时段占用 <span class="sub">两个班组不能占用同一厨房同一时段（冲突会以红框标出）</span>
      <button class="btn primary" id="schedule" style="margin-left:auto">＋ 排班施工单</button></div>
    <div id="gantt"></div>
  </div>
  <div class="card">
    <div class="card-title">全部施工单</div>
    <table><thead><tr><th>单号</th><th>门店</th><th>班组</th><th>段数</th><th>状态</th><th>验收/签字</th><th>计划时段</th></tr></thead>
    <tbody>${state.jobs.map(j => `<tr class="clickable" data-job="${j.id}">
      <td><b>${j.code}</b></td><td>${esc(j.store_name)}</td><td>${esc(j.team_name)}</td>
      <td>${j.plan_segment_count} 段</td>
      <td><span class="tag ${statusTag(j.status)}">${statusLabel[j.status]}</span></td>
      <td>${j.status === 'rejected_sign' ? '<span class="tag red">拒签</span>' : j.status === 'settled' ? '<span class="tag green">已签已结</span>' : j.status === 'rework' ? '<span class="tag amber">返工</span>' : '<span class="muted">—</span>'}</td>
      <td class="small">${dtd(j.scheduled_start)} → ${dt(j.scheduled_end)}</td></tr>`).join('')}</tbody></table>
  </div>`;
}
function loadGantt() {
  // 以"今天"为中心 24 小时轨道，简化展示当日附近单据
  const jobs = state.jobs.filter(j => Math.abs(new Date(j.scheduled_start) - new Date()) < 36 * 3600e3);
  if (!jobs.length) { $('#gantt').innerHTML = '<div class="empty">近 36 小时内无排班</div>'; $('#schedule').onclick = scheduleModal; return; }
  const stores = [...new Map(state.boot.stores.map(s => [s.id, s])).values()];
  const minT = Math.min(...jobs.map(j => +new Date(j.scheduled_start))) - 1800e3;
  const maxT = Math.max(...jobs.map(j => +new Date(j.scheduled_end))) + 1800e3;
  const span = maxT - minT;
  // 检测同店同时段冲突
  const clashIds = new Set();
  jobs.forEach(a => jobs.forEach(b => { if (a.id < b.id && a.store_id === b.store_id &&
    new Date(a.scheduled_start) < new Date(b.scheduled_end) && new Date(b.scheduled_start) < new Date(a.scheduled_end)) { clashIds.add(a.id); clashIds.add(b.id); } }));
  $('#gantt').innerHTML = stores.map(s => {
    const rows = jobs.filter(j => j.store_id === s.id).map(j => {
      const left = ((+new Date(j.scheduled_start) - minT) / span) * 100;
      const w = Math.max(6, ((+new Date(j.scheduled_end) - +new Date(j.scheduled_start)) / span) * 100);
      return `<div class="gantt-bar ${j.team_id === 1 ? 'teamA' : 'teamB'} ${clashIds.has(j.id) ? 'clash' : ''}"
        style="left:${left}%;width:${w}%" data-job="${j.id}" title="${j.code} ${esc(j.team_name)}">
        ${esc(j.team_name)} · ${j.code}</div>`;
    }).join('');
    return rows ? `<div class="gantt-row"><div><b>${esc(s.name)}</b></div><div class="gantt-track">${rows}</div></div>` : '';
  }).join('');
  $$('#gantt [data-job]').forEach(el => el.onclick = () => go('jobs', Number(el.dataset.job)));
  $('#schedule').onclick = scheduleModal;
}
async function scheduleModal() {
  await refreshBoot();
  const wins = await api('/api/windows');
  const confirmed = wins.filter(w => w.status === 'confirmed');
  openModal('排班施工单', `
    <p class="small muted mb">仅可在「门店已确认」的停灶窗口内排班；同一厨房时段已有班组时将被系统拒绝。</p>
    <div class="form-grid">
      <div class="field"><label>门店</label><select id="s-store">${state.boot.stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>班组</label><select id="s-team">${state.boot.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>已确认停灶窗口</label><select id="s-win"><option value="">请选择</option>
        ${confirmed.map(w => `<option value="${w.id}" data-store="${w.store_id}">${esc(w.store_name)}｜${dtd(w.start)} → ${dt(w.end)}</option>`).join('')}</select></div>
    </div>
    <div class="right mt"><button class="btn primary big" id="s-go">生成施工单</button></div>`);
  $('#s-go').onclick = async () => {
    const w = confirmed.find(x => x.id === Number($('#s-win').value));
    if (!w) return toast('请选择已确认的停灶窗口', 'err');
    try {
      const job = await api('/api/jobs/schedule', { method: 'POST', body: {
        store_id: w.store_id, team_id: Number($('#s-team').value), window_id: w.id,
        start_at: w.start_at, end_at: w.end_at } });
      closeModal(); toast(`施工单 ${job.code} 已排班（互斥校验通过）`); go('jobs', job.id);
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------------- 施工单详情 ---------------- */
function viewJob(j) {
  const store = state.boot.stores.find(s => s.id === j.store_id);
  const me = state.boot.users.find(u => u.id === Number($('#user-select').value));
  const isCrew = me?.role === 'crew', isInsp = me?.role === 'inspector', isStore = me?.role === 'store', isFin = me?.role === 'finance';
  const ranks = j.segments.map(s => segStepRank[s.step]);
  const flowIdx = Math.min(...ranks); // 0..5
  return `
  <button class="ghost-btn" id="back-jobs">← 返回施工单列表</button>
  <div class="card mt">
    <div class="row">
      <h2 style="font-size:20px">${j.code}</h2>
      <span class="tag ${statusTag(j.status)}">${statusLabel[j.status]}</span>
      <span class="muted small">${esc(store?.name)} · ${esc(j.team.name)} · 停灶 ${dtd(j.scheduled_start)} → ${dt(j.scheduled_end)}${j.overtime_minutes ? ` · <b style="color:var(--red)">超时 ${j.overtime_minutes} 分钟</b>` : ''}</span>
    </div>

    <!-- 工序总流程 -->
    <div class="flow mt">
      ${['拆卸','清洗','干燥','复装','试运行'].map((label, i) => {
        const done = flowIdx > i, active = flowIdx === i;
        return `<div class="flow-step ${done ? 'done' : active ? 'active' : ''}">
          <div class="flow-dot">${done ? '✓' : i + 1}</div><div class="flow-label">${label}</div></div>
          ${i < 4 ? `<div class="flow-line ${flowIdx > i ? 'done' : ''}"></div>` : ''}`;
      }).join('')}
    </div>
    <div class="hood-arrow">完成度从左到右推进 <b>→</b></div>
  </div>

  <!-- 罩体分段示意条 -->
  <div class="card">
    <div class="card-title">罩体分段施工 <span class="sub">点击分段条登记滤网 / 推进工序（清洗 → 干燥 → 复装 → 试运行 严格按序）</span></div>
    <div class="hood-strip">
      ${j.segments.map(s => {
        const pct = segStepRank[s.step] / 5 * 100;
        return `<div class="hood-seg" data-state="${s.step}" data-seg="${s.id}">
          <div class="seg-top"></div><div class="seg-fill" style="width:${pct}%"></div>
          <div class="seg-state"><span class="tag ${s.step === 'tested' ? 'green' : s.step === 'removed' ? 'amber' : 'gray'}">${segStepLabel[s.step]}</span></div>
          <div class="seg-body">
            <div class="seg-code">${esc(s.code)} 段</div>
            <div class="seg-name">${esc(s.name)}</div>
            <div class="seg-meta">滤网 ${s.filters_removed == null ? `待登记（标准 ${s.filters_expected} 位）` : `${s.filters_removed} 片${s.damaged_filters ? ` · 损坏 ${s.damaged_filters}` : ''}`}</div>
          </div></div>`;
      }).join('')}
    </div>
    <div class="mini-strip mt">${j.segments.map(s => `<i style="width:${100 / j.segments.length}%;background:${s.step === 'tested' ? 'var(--green)' : segStepRank[s.step] >= 2 ? '#7fc4ec' : segStepRank[s.step] === 1 ? 'var(--amber)' : 'var(--steel-300)'}"></i>`).join('')}</div>
    <div class="row mt">
      ${j.status === 'scheduled' && isCrew ? '<button class="btn primary big" id="btn-start">▶ 开工（开始逐段拆卸）</button>' : ''}
      ${j.status === 'rework' && isCrew ? '<button class="btn warn big" id="btn-redo">♻ 返工整改（重新进入试运行）</button>' : ''}
      <span class="muted small">施工人员只能推进工序，不能修改验收结论</span>
    </div>
  </div>

  <div class="grid cols-2">
    <!-- 复装核验 -->
    <div class="card">
      <div class="card-title">复装核验 <span class="sub">逐段比对滤网数量，漏装不能提交验收</span></div>
      <div id="reassembly">${reassemblyHtml(j)}</div>
    </div>
    <!-- 风量复测 -->
    <div class="card">
      <div class="card-title">风量 / 噪声复测 <span class="sub">模拟适配器给出测试值；阈值 1200 m³/h · 噪声 80dB</span></div>
      <div id="airtests">${airHtml(j)}</div>
    </div>
  </div>

  <!-- 照片对照 -->
  <div class="card">
    <div class="card-title">照片对照（统一拍摄角度参考线） <span class="sub">每段需有清洗前 / 清洗后各一张，角度不合格需重拍</span></div>
    <div id="photos">${photosHtml(j)}</div>
  </div>

  <!-- 现场增项 -->
  <div class="card">
    <div class="card-title">现场增项 <span class="sub">重油污加项 / 滤网损坏 / 超时等，必须先获得门店确认才计入结算</span></div>
    <div id="addons">${addonsHtml(j)}</div>
    ${isCrew || me?.role === 'planner' ? '<button class="btn warn mt" id="btn-addon">＋ 申报现场增项</button>' : ''}
  </div>

  <!-- 验收 + 签字 -->
  <div class="card">
    <div class="card-title">验收与门店签字</div>
    <div id="acceptance">${acceptanceHtml(j, me)}</div>
  </div>`;
}

function reassemblyHtml(j) {
  const done = j.segments.every(s => ['reassembled','tested'].includes(s.step));
  const rows = j.segments.map(s => `
    <div class="row mb" style="justify-content:space-between">
      <span><b>${esc(s.code)}</b> ${esc(s.name)} <span class="muted small">拆卸 ${s.filters_removed ?? '—'} 片</span></span>
      <span class="row">复装
        <input class="input" type="number" min="0" style="width:90px" data-rein="${s.id}" value="${s.filters_removed ?? 0}" ${!done ? 'disabled' : ''}>
        <span class="small muted">片</span></span>
    </div>`).join('');
  const passed = j.acceptance?.reassembly_passed;
  return `${rows}
    <div class="row mt">
      <button class="btn dark big" id="btn-recheck" ${done ? '' : 'disabled'}>执行复装核验</button>
      ${passed === 1 ? '<span class="tag green">✓ 复装核验通过，无漏装</span>' : passed === 0 ? '<span class="tag red">✗ 发现漏装，不能提交验收</span>' : '<span class="tag gray">尚未核验</span>'}
    </div>`;
}
function airHtml(j) {
  const table = !j.air_tests.length ? '<div class="empty">尚未测试（复装完成后执行）</div>' : `<table><thead><tr><th>测点</th><th>风量 m³/h</th><th>噪声 dB</th><th>轮次</th><th>结果</th></tr></thead><tbody>
    ${Object.values(Object.fromEntries(j.air_tests.map(t => [t.point_name, t]))).map(t => `<tr>
      <td>${esc(t.point_name)}</td><td><b>${Math.round(t.airflow)}</b></td>
      <td style="color:${t.noise_abnormal ? 'var(--red)' : ''}"><b>${t.noise_db ?? '—'}</b>${t.noise_abnormal ? ' ⚠异常' : ''}</td>
      <td>${t.is_retest ? '复测' : '首测'}</td>
      <td>${t.passed ? '<span class="tag green">达标</span>' : '<span class="tag red">未通过</span>'}</td></tr>`).join('')}
  </tbody></table>`;
  return `${table}
  <div class="row mt">
    <button class="btn dark big" id="btn-air">▶ 风量测试（模拟）</button>
    <button class="btn warn big" id="btn-air-retest">↻ 整改后复测</button>
  </div>`;
}
function photoCell(j, seg, phase) {
  const list = j.photos.filter(p => p.job_segment_id === seg.id && p.phase === phase);
  const p = list[list.length - 1];
  if (!p) return `<div class="photo-frame"><div class="ref-h"></div><div class="photo-placeholder">${phase === 'before' ? '清洗前' : '清洗后'}照片<br>请按参考线角度拍摄</div>
    <span class="phase-tag tag ${phase === 'before' ? 'amber' : 'green'}">${phase === 'before' ? 'BEFORE' : 'AFTER'}</span></div>`;
  return `<div class="photo-frame ${p.angle_ok ? '' : 'photo-bad'}">
    <div class="ref-h"></div>
    <img src="/photos/${j.id}/${esc(p.file_name)}" alt="">
    <span class="phase-tag tag ${phase === 'before' ? 'amber' : 'green'}">${phase === 'before' ? 'BEFORE' : 'AFTER'}</span>
    <span class="ref-tag">统一角度 · 罩体正面 45°</span>
    ${p.angle_ok ? '' : '<span class="tag red" style="position:absolute;top:12px;right:12px;z-index:4">角度不合格·重拍</span>'}
  </div>`;
}
function photosHtml(j) {
  return j.segments.map(s => `
    <div class="mb">
      <div class="row mb"><b>${esc(s.code)} 段 · ${esc(s.name)}</b>
        <button class="btn" data-photo="${s.id}" data-phase="before">📷 拍清洗前</button>
        <button class="btn" data-photo="${s.id}" data-phase="after">📷 拍清洗后</button>
        <label class="small row" style="gap:5px"><input type="checkbox" data-badangle="${s.id}"> 本张模拟角度不合格</label>
      </div>
      <div class="photo-grid">${photoCell(j, s, 'before')}${photoCell(j, s, 'after')}</div>
    </div>`).join('');
}
function addonsHtml(j) {
  if (!j.addons.length) return '<div class="empty">暂无增项</div>';
  const kindMap = { heavy_oil: '重油污加项', temporary_business: '临时营业', filter_damage: '滤网损坏补装', overtime: '施工超时', other: '其他' };
  const stMap = { pending: ['amber', '待门店确认'], confirmed: ['green', '门店已确认'], rejected: ['gray', '门店已驳回'] };
  return `<table><thead><tr><th>类型</th><th>说明</th><th>金额</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${j.addons.map(a => {
      const [cls, lab] = stMap[a.status]; const me = state.boot.users.find(u => u.id === Number($('#user-select').value));
      return `<tr><td><span class="tag dark">${kindMap[a.kind]}</span></td><td>${esc(a.description)}</td>
      <td><b>${a.amount ? yuan(a.amount) : '待报价'}</b></td>
      <td><span class="tag ${cls}">${lab}</span></td>
      <td>${a.status === 'pending' && me?.role === 'store'
        ? `<button class="btn primary" data-addon-ok="${a.id}">确认计入</button> <button class="btn danger" data-addon-no="${a.id}">驳回</button>`
        : a.reject_reason ? `<span class="small muted">${esc(a.reject_reason)}</span>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
}
function acceptanceHtml(j, me) {
  const isInsp = me?.role === 'inspector', isStore = me?.role === 'store', isFin = me?.role === 'finance';
  const acc = j.acceptance;
  let ready = { ready: false, reasons: [] };
  setTimeout(() => api(`/api/jobs/${j.id}/readiness`).then(r => {
    const box = $('#ready-box'); if (box) box.innerHTML = readinessHtml(r);
  }), 0);
  const concl = acc?.conclusion;
  return `
  <div id="ready-box">${readinessHtml(ready)}</div>
  <div class="row mt">
    ${isInsp ? `
      <button class="btn primary big" data-decide="pass">✓ 验收合格</button>
      <button class="btn warn big" data-decide="rework">↻ 判定返工</button>` : '<span class="tag gray">验收员登录后可出具结论（施工人员不可修改）</span>'}
  </div>
  <div class="mt sign-wrap">
    ${concl ? `<div class="row mb">
      <span class="tag ${concl === 'pass' ? 'green' : concl === 'rework' ? 'red' : 'amber'}">
        验收结论：${concl === 'pass' ? '合格' : concl === 'rework' ? '返工' : '拒签'}</span>
      ${acc.store_rejected ? '<span class="tag red">门店拒签（验收合格，门店对费用有异议）</span>'
        : acc.store_signed ? `<span class="tag green">门店已签字：${esc(acc.signed_by_name || '')} · ${dt(acc.signed_at)}</span>` : '<span class="tag gray">门店尚未签字</span>'}
      ${acc.sign_note ? `<span class="small muted">${esc(acc.sign_note)}</span>` : ''}
    </div>` : ''}
    ${concl === 'pass' && !acc.store_signed && !acc.store_rejected && isStore ? `
      <div class="sign-actions">
        <button class="btn primary" id="btn-sign">✍️ 门店签字确认（大按钮 · 手套可点）</button>
        <button class="btn danger" id="btn-reject">门店拒签</button>
      </div>` : ''}
    ${j.status === 'rejected_sign' && isStore ? `
      <div class="sign-actions"><button class="btn primary big" id="btn-sign">异议解除，补签确认</button></div>` : ''}
    ${isFin && concl === 'pass' && acc?.store_signed ? `
      <div class="sign-actions"><button class="btn dark big" id="btn-invoice">${j.invoice ? '查看结算单（幂等）' : '财务生成结算单'}</button></div>` : ''}
  </div>`;
}
function readinessHtml(r) {
  if (r.ready) return '<div class="tag green" style="font-size:14px;padding:8px 14px">✓ 已满足验收条件：工序齐全 · 复装无漏装 · 风量复测通过 · 照片齐全且角度合格</div>';
  return `<div style="background:var(--red-soft);border:1px solid #f0b8b6;border-radius:10px;padding:12px 14px">
    <b style="color:var(--red)">不满足验收提交条件：</b>
    <ul style="margin:6px 0 0 20px">${(r.reasons || ['加载中…']).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

/* 详情页事件绑定 */
function bindView() {
  $$('[data-job]').forEach(el => { if (!el.onclick) el.onclick = () => go('jobs', Number(el.dataset.job)); });
  const back = $('#back-jobs'); if (back) back.onclick = () => go('jobs');
  const jobId = state.currentJob;
  if (!jobId) return;

  const btnStart = $('#btn-start');
  if (btnStart) btnStart.onclick = wrap(() => api(`/api/jobs/${jobId}/start`, { method: 'POST' }), '已开工，请逐段拆卸并登记滤网数量');
  const btnRedo = $('#btn-redo');
  if (btnRedo) btnRedo.onclick = wrap(() => api(`/api/jobs/${jobId}/rework-redo`, { method: 'POST' }), '已进入返工整改');

  $$('.hood-seg').forEach(el => el.onclick = () => segModal(jobId, Number(el.dataset.seg)));
  $$('[data-photo]').forEach(b => b.onclick = () => uploadPhoto(jobId, Number(b.dataset.photo), b.dataset.phase,
    $(`[data-badangle="${b.dataset.photo}"]`)?.checked));

  const recheck = $('#btn-recheck');
  if (recheck) recheck.onclick = async () => {
    const items = $$('[data-rein]').map(i => ({ job_segment_id: Number(i.dataset.rein), reinstalled: Number(i.value) }));
    try { const r = await api(`/api/jobs/${jobId}/reassembly`, { method: 'POST', body: { items } });
      toast(r.passed ? '复装核验通过，无漏装' : `发现 ${r.missing.length} 处漏装，不能提交验收`, r.passed ? '' : 'err'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const air = $('#btn-air'); if (air) air.onclick = () => runAir(jobId, false);
  const air2 = $('#btn-air-retest'); if (air2) air2.onclick = () => runAir(jobId, true);

  $$('[data-addon-ok]').forEach(b => b.onclick = () => addonDecide(b.dataset.addonOk, true));
  $$('[data-addon-no]').forEach(b => b.onclick = () => addonDecide(b.dataset.addonNo, false));
  const addAddon = $('#btn-addon'); if (addAddon) addAddon.onclick = () => addonModal(jobId);

  $$('[data-decide]').forEach(b => b.onclick = () => decide(jobId, b.dataset.decide));
  const sign = $('#btn-sign'); if (sign) sign.onclick = () => openSign(jobId);
  const rej = $('#btn-reject'); if (rej) rej.onclick = () => rejectSign(jobId);
  const inv = $('#btn-invoice'); if (inv) inv.onclick = () => invoiceModal(jobId);
}
function wrap(fn, okMsg) {
  return async () => { try { await fn(); toast(okMsg); render(); } catch (e) { toast(e.message, 'err'); } };
}
async function runAir(jobId, retest) {
  try {
    const r = await api(`/api/jobs/${jobId}/air-test`, { method: 'POST', body: { is_retest: retest } });
    if (r.noise_abnormal) toast('复测噪声异常（>80dB），需停机排查后再次复测', 'err');
    else if (!r.passed) toast('风量复测未通过：存在低于 1200 m³/h 的测点，需返工', 'err');
    else toast(retest ? '复测通过 ✓' : '风量测试全部达标 ✓');
    render();
  } catch (e) { toast(e.message, 'err'); }
}
async function addonDecide(id, ok) {
  let reason = '';
  if (!ok) { reason = prompt('驳回原因：', '门店不认可该增项'); if (reason === null) return; }
  try { await api(`/api/addons/${id}/confirm`, { method: 'POST', body: { approved: ok, reason } });
    toast(ok ? '增项已确认，将计入结算' : '增项已驳回，不计费'); render();
  } catch (e) { toast(e.message, 'err'); }
}

/* 分段操作弹窗 */
async function segModal(jobId, segId) {
  const j = await api(`/api/jobs/${jobId}`);
  const s = j.segments.find(x => x.id === segId);
  const me = state.boot.users.find(u => u.id === Number($('#user-select').value));
  const crew = me?.role === 'crew';
  let body = '';
  if (s.filters_removed == null) {
    body = `
      <dl class="kv">
        <dt>分段</dt><dd>${esc(s.code)} · ${esc(s.name)}</dd>
        <dt>罩体长度</dt><dd>${s.length_m} m｜标准滤网位 ${s.filters_expected}</dd>
        <dt>风管测点</dt><dd>${s.duct_points.join('、')}</dd>
      </dl>
      <div class="form-grid mt">
        <div class="field"><label>拆卸滤网数量（逐段登记）</label><input id="seg-filters" type="number" min="0" value="${s.filters_expected}"></div>
        <div class="field"><label>其中损坏数量</label><input id="seg-damaged" type="number" min="0" value="0"></div>
        <div class="field full"><label>损坏备注</label><input id="seg-note" placeholder="如：边框锈蚀变形"></div>
      </div>
      <div class="right mt"><button class="btn primary big" id="seg-reg">确认拆卸登记</button></div>`;
  } else {
    const next = { removed: ['clean', '开始清洗'], cleaned: ['dry', '完成清洗 → 干燥'], dried: ['reassemble', '干燥完成 → 复装'], reassembled: ['test_run', '复装完成 → 试运行'] }[s.step];
    body = `
      <dl class="kv">
        <dt>当前工序</dt><dd><span class="tag ${s.step === 'tested' ? 'green' : 'amber'}">${segStepLabel[s.step]}</span></dd>
        <dt>滤网</dt><dd>拆卸 ${s.filters_removed} 片${s.damaged_filters ? `，损坏 ${s.damaged_filters} 片` : ''}</dd>
      </dl>
      ${next && crew ? `<div class="right mt"><button class="btn primary big" id="seg-next" data-step="${next[0]}">${next[1]}（按顺序）</button></div>`
        : s.step === 'tested' ? '<p class="mt" style="color:var(--green-dark)"><b>本段全部工序已完成 ✓</b></p>'
        : '<p class="muted mt">施工人员登录后可推进工序</p>'}`;
  }
  openModal(`${s.code} 段 · ${s.name}`, body);
  const reg = $('#seg-reg');
  if (reg) reg.onclick = async () => {
    try {
      await api(`/api/jobs/${jobId}/segments/${segId}/filters`, { method: 'POST', body: {
        filters_removed: Number($('#seg-filters').value), damaged_filters: Number($('#seg-damaged').value),
        damage_note: $('#seg-note').value } });
      closeModal(); toast('滤网数量已登记' + ($('#seg-damaged').value > 0 ? '，损坏已自动生成增项待门店确认' : '')); render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const next = $('#seg-next');
  if (next) next.onclick = async () => {
    try {
      await api(`/api/jobs/${jobId}/segments/${segId}/advance`, { method: 'POST', body: { step: next.dataset.step } });
      closeModal(); toast('工序已推进'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* 拍照（本地生成带角度参考线的 SVG，可勾选角度不合格） */
function uploadPhoto(jobId, segId, phase, badAngle) {
  const label = phase === 'before' ? '清洗前' : '清洗后';
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const bg = phase === 'before' ? '#3a2a1c' : '#1d2a24', ac = badAngle ? '#e0524f' : (phase === 'before' ? '#c98a3d' : '#35c46a');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="${bg}"/>
<rect x="40" y="60" width="560" height="200" rx="10" fill="none" stroke="${ac}" stroke-width="2" stroke-dasharray="10 8"/>
<line x1="320" y1="60" x2="320" y2="260" stroke="${ac}" stroke-width="1" stroke-dasharray="4 8" opacity=".5"/>
<line x1="40" y1="160" x2="600" y2="160" stroke="${ac}" stroke-width="1" stroke-dasharray="4 8" opacity=".5"/>
<text x="320" y="150" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#eef2f5" font-weight="700">${label} · 现场实拍</text>
<text x="320" y="195" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#aab4bd">${ts}</text>
<text x="600" y="330" text-anchor="end" font-family="monospace" font-size="14" fill="#7d8892">角度参考线 · 罩体正面 45°</text></svg>`;
  const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  wrap(() => api(`/api/jobs/${jobId}/photos`, { method: 'POST', body: {
    job_segment_id: segId, phase, dataUrl, angle_ok: !badAngle } }),
    badAngle ? '照片已上传并标记为角度不合格，需重拍' : `${label}照片已上传` )();
}

function addonModal(jobId) {
  openModal('申报现场增项', `
    <div class="form-grid">
      <div class="field"><label>类型</label><select id="a-kind">
        <option value="heavy_oil">重油污加项</option><option value="temporary_business">临时营业配合</option>
        <option value="filter_damage">滤网损坏补装</option><option value="overtime">施工超时</option>
        <option value="other">其他</option></select></div>
      <div class="field"><label>金额（元）</label><input id="a-amount" type="number" min="0" value="200"></div>
      <div class="field full"><label>说明</label><textarea id="a-desc" placeholder="如：C 段油垢超常规厚度，需二次药剂清洗"></textarea></div>
    </div>
    <div class="right mt"><button class="btn warn big" id="a-go">提交门店确认</button></div>
    <p class="small muted mt">提交后状态为「待门店确认」，未经确认不会计入结算。</p>`);
  $('#a-go').onclick = wrap(async () => {
    await api(`/api/jobs/${jobId}/addons`, { method: 'POST', body: {
      kind: $('#a-kind').value, description: $('#a-desc').value || $('#a-kind option:selected').textContent,
      amount: Math.round(Number($('#a-amount').value) * 100) } });
    closeModal();
  }, '增项已提交，等待门店确认');
}

async function decide(jobId, conclusion) {
  try { await api(`/api/jobs/${jobId}/acceptance`, { method: 'POST', body: { conclusion } });
    toast(conclusion === 'pass' ? '验收合格，等待门店签字' : conclusion === 'rework' ? '已判定返工' : '已登记拒签'); render();
  } catch (e) { toast(e.message, 'err'); }
}
async function rejectSign(jobId) {
  const note = prompt('门店拒签原因（将记录在验收单上）：', '对超时费有异议，需区域经理复核');
  if (note === null) return;
  try { await api(`/api/jobs/${jobId}/reject-sign`, { method: 'POST', body: { name: '', note } });
    toast('已登记门店拒签', 'warn'); render();
  } catch (e) { toast(e.message, 'err'); }
}

/* 签字画布（大线宽、touch-action:none，适配戴手套） */
let drawing = false, hasInk = false;
function openSign(jobId) {
  const modal = $('#sign-modal'); modal.classList.remove('hidden');
  const cv = $('#sign-canvas'); const ctx = cv.getContext('2d');
  const fit = () => { const r = cv.getBoundingClientRect(); cv.width = r.width; cv.height = 300; };
  fit();
  ctx.clearRect(0, 0, cv.width, cv.height); hasInk = false;
  ctx.strokeStyle = '#1d2329'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const pos = e => { const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return [p.clientX - r.left, p.clientY - r.top]; };
  const down = e => { e.preventDefault(); drawing = true; ctx.beginPath(); ctx.moveTo(...pos(e)); };
  const move = e => { if (!drawing) return; e.preventDefault(); ctx.lineTo(...pos(e)); ctx.stroke(); hasInk = true; };
  const up = () => drawing = false;
  cv.onpointerdown = down; cv.onpointermove = move; window.onpointerup = up;
  $('#sign-clear').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); hasInk = false; };
  $('#sign-confirm').onclick = async () => {
    if (!hasInk) return toast('请先签名', 'err');
    const dataUrl = cv.toDataURL('image/png');
    try {
      await api(`/api/jobs/${jobId}/sign`, { method: 'POST', body: { signature: dataUrl, name: $('#sign-name').value } });
      modal.classList.add('hidden'); toast('门店签字完成 ✓'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* 结算单 */
async function invoiceModal(jobId) {
  try {
    const snap = await api(`/api/jobs/${jobId}/invoice`, { method: 'POST' });
    const kindMap = { heavy_oil: '重油污加项', temporary_business: '临时营业', filter_damage: '滤网损坏补装', overtime: '施工超时', other: '其他' };
    openModal(`结算单 ${snap.invoice_no}`, `
      <dl class="kv mb">
        <dt>门店</dt><dd>${esc(snap.store.name)}（${esc(snap.store.address)}）</dd>
        <dt>班组</dt><dd>${esc(snap.team)}</dd>
        <dt>计价口径</dt><dd>按实际清洗段数 ${snap.segment_count} 段 × ${yuan(snap.price_per_segment)}（快照生成时固化）</dd>
        <dt>生成时间</dt><dd>${dt(snap.generated_at)}</dd>
      </dl>
      <table><thead><tr><th>#</th><th>分段</th><th>滤网</th><th>状态</th></tr></thead><tbody>
      ${snap.segments.map(s => `<tr><td>${s.seq}</td><td>${esc(s.code)} · ${esc(s.name)}</td>
        <td>${s.filters_removed} 片${s.damaged_filters ? `（损 ${s.damaged_filters}）` : ''}</td><td>${segStepLabel[s.step]}</td></tr>`).join('')}
      </tbody></table>
      <table class="mt"><thead><tr><th>已确认增项</th><th class="right">金额</th></tr></thead><tbody>
      ${snap.addons.length ? snap.addons.map(a => `<tr><td><span class="tag dark">${kindMap[a.kind]}</span> ${esc(a.description)}</td><td class="right">${yuan(a.amount)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="muted">无</td></tr>'}
      </tbody></table>
      <div class="mt" style="background:var(--steel-50);border-radius:10px;padding:16px">
        <div class="row" style="justify-content:space-between"><span>分段清洗费</span><b>${yuan(snap.base_amount)}</b></div>
        <div class="row" style="justify-content:space-between"><span>确认增项合计</span><b>${yuan(snap.addon_amount)}</b></div>
        <div class="row" style="justify-content:space-between;font-size:19px;margin-top:6px"><span><b>应收合计</b></span>
          <b style="color:var(--green-dark)">${yuan(snap.total_amount)}</b></div>
      </div>
      <p class="small muted mt">结算单按施工单唯一保存快照，重复提交幂等返回，金额与明细不会变化。</p>`);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 费用复核 ---------------- */
function viewFinance() {
  const rows = state.jobs.filter(j => ['completed','rejected_sign','rework','settled'].includes(j.status));
  return `
  <div class="card">
    <div class="card-title">费用复核 <span class="sub">仅「验收合格 + 门店签字」的单据可由财务生成结算；工序记录财务不可改动</span></div>
    <table><thead><tr><th>单号</th><th>门店</th><th>班组</th><th>状态</th><th>验收/签字</th><th>结算</th><th></th></tr></thead><tbody>
    ${rows.map(j => `<tr class="clickable" data-job="${j.id}">
      <td><b>${j.code}</b></td><td>${esc(j.store_name)}</td><td>${esc(j.team_name)}</td>
      <td><span class="tag ${statusTag(j.status)}">${statusLabel[j.status]}</span></td>
      <td>${j.status === 'rejected_sign' ? '<span class="tag red">门店拒签</span>' : j.status === 'rework' ? '<span class="tag amber">返工中</span>' : '<span class="tag green">合格已签</span>'}</td>
      <td>${j.status === 'settled' ? '<span class="tag dark">已生成快照</span>' : '<span class="muted">—</span>'}</td>
      <td><button class="btn ${j.status === 'settled' ? '' : 'dark'}" data-job="${j.id}">${j.status === 'settled' ? '查看' : '进入'}</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无待复核单据</td></tr>'}</tbody></table>
  </div>`;
}

/* ---------------- 弹窗 / 通知 / SSE ---------------- */
function openModal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); $('#modal-mask').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-mask').classList.add('hidden'); }

async function openNotif() {
  $('#notif-drawer').classList.remove('hidden'); $('#drawer-mask').classList.remove('hidden');
  const list = await api('/api/notifications');
  state.unread = 0; $('#bell-badge').classList.add('hidden');
  $('#notif-list').innerHTML = list.map(n => `<div class="notif">
    <div class="t">${esc(n.title)}</div><div class="b">${esc(n.body || '')}</div>
    <div class="time">${n.type} · ${dt(n.created_at)}</div></div>`).join('') || '<div class="empty">暂无提醒</div>';
}
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#sse-dot').classList.add('on');
  es.onmessage = (e) => {
    const n = JSON.parse(e.data);
    if (n.id) { state.unread++; const b = $('#bell-badge'); b.textContent = state.unread; b.classList.remove('hidden'); toast(`🔔 ${n.title}`); }
  };
  es.onerror = () => $('#sse-dot').classList.remove('on');
}

init();
