'use strict';
/* 净罩平台前端 SPA */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];

const state = {
  user: null, staff: [], meta: null,
  route: 'dashboard', params: {},
  jobs: [], notifications: [],
};

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.user ? { 'X-Staff-Id': String(state.user.id) } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `请求失败 ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.code = data?.error?.code;
    throw err;
  }
  return data;
}
const fmtMoney = c => '¥' + (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
const fmtT = t => t ? t.slice(0, 16).replace('T', ' ') : '—';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.classList.toggle('err', !!isErr);
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2600);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}

const ROLE_NAME = {
  admin: '系统', worker: '施工员', crew_lead: '班组长',
  inspector: '验收员', finance: '财务', store_manager: '门店经理',
};
const JOB_STATUS = {
  scheduled: ['已排班', 'steel'], in_progress: ['施工中', 'cyan'],
  acceptance_review: ['待门店签字', 'amber'], accepted: ['验收通过', 'green'],
  refused: ['门店拒签', 'red'], settled: ['已结算', 'green'], cancelled: ['已取消', 'steel'],
};
const EX_TYPE = {
  temp_open: '临时营业', heavy_grease: '重油污', filter_damage: '滤网损坏',
  photo_angle: '照片角度', overtime: '施工超时', noise_abnormal: '噪声异常', refuse_sign: '门店拒签',
};
const ADDON_TYPE = { heavy_grease: '重油污加项', filter_replace: '滤网更换', temp_open: '临时营业配合', other: '其他增项' };
const STEP_LABEL = { disassemble: '拆卸', wash: '清洗', dry: '干燥', reassemble: '复装', trial: '试运行' };
const STEP_ORDER = ['disassemble', 'wash', 'dry', 'reassemble', 'trial'];
const GREASE_LABEL = { 1: 'Ⅰ 轻度', 2: 'Ⅱ 中度', 3: 'Ⅲ 较重', 4: 'Ⅳ 重度', 5: 'Ⅴ 极重' };

function can(...roles) { return state.user && (state.user.role === 'admin' || roles.includes(state.user.role)); }

/* ---------------- 路由 ---------------- */
const ROUTES = [
  ['dashboard', '工作台'], ['plans', '周期计划'], ['windows', '停灶协调'],
  ['jobs', '施工工单'], ['sign', '门店签字'], ['settle', '费用复核'],
];
function nav() {
  location.hash = '#/' + state.route + (state.params.id ? '/' + state.params.id : '');
}
function parseHash() {
  const m = location.hash.match(/^#\/(\w+)(?:\/(\d+))?/);
  state.route = m ? m[1] : 'dashboard';
  state.params = m && m[2] ? { id: Number(m[2]) } : {};
  render();
}
function renderNav() {
  $('#nav').innerHTML = ROUTES.map(([r, label]) =>
    `<a href="#/${r}" class="${state.route === r ? 'active' : ''}">${label}</a>`).join('');
}

/* ---------------- 身份 ---------------- */
async function loadStaff() {
  state.staff = await api('/api/staff');
  const sel = $('#userSel');
  sel.innerHTML = state.staff.map(s =>
    `<option value="${s.id}">${esc(s.name)} · ${ROLE_NAME[s.role]}${s.crew_name ? ' · ' + esc(s.crew_name) : ''}${s.store_id ? ' · 门店#' + s.store_id : ''}</option>`).join('');
  const saved = Number(localStorage.getItem('hc_user')) || 7;
  sel.value = String(saved);
  state.user = state.staff.find(s => s.id === Number(sel.value)) || state.staff[0];
  sel.onchange = () => {
    localStorage.setItem('hc_user', sel.value);
    state.user = state.staff.find(s => s.id === Number(sel.value));
    render();
  };
}

/* ============================================================
   视图：工作台
   ============================================================ */
async function viewDashboard(app) {
  const [jobs, notifs, plans] = await Promise.all([
    api('/api/jobs'), api('/api/notifications'), api('/api/plans'),
  ]);
  state.jobs = jobs;
  const cnt = k => jobs.filter(j => j.status === k).length;
  const dueSoon = plans.filter(p => !p.has_active_job && p.days_to_due <= 7);
  const unread = notifs.filter(n => !n.is_read);

  app.innerHTML = `
    <h2 class="page">工作台</h2>
    <div class="grid cols-3">
      <div class="stat"><div class="num">${cnt('in_progress')}</div><div class="lbl">施工中工单</div></div>
      <div class="stat"><div class="num amber">${cnt('acceptance_review') + cnt('refused')}</div><div class="lbl">待签字 / 拒签</div></div>
      <div class="stat"><div class="num green">${cnt('settled')}</div><div class="lbl">已结算</div></div>
      <div class="stat"><div class="num ${dueSoon.length ? 'amber' : ''}">${dueSoon.length}</div><div class="lbl">7 天内到期计划</div></div>
      <div class="stat"><div class="num ${unread.length ? 'red' : 'green'}">${unread.length}</div><div class="lbl">未读提醒</div></div>
      <div class="stat"><div class="num">${jobs.length}</div><div class="lbl">工单总数</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="panel accent">
        <h3 style="margin-top:0">到期与超时提醒</h3>
        <div id="notifList">${notifs.length ? notifs.slice(0, 12).map(n => `
          <div class="notif ${n.is_read ? '' : 'unread'} ${n.level}">
            <span class="dot"></span>
            <div class="grow"><div>${esc(n.message)}</div><div class="t">${fmtT(n.created_at)}</div></div>
            ${n.is_read ? '' : `<button class="btn ghost" data-read="${n.id}" style="min-height:36px;padding:4px 10px">已读</button>`}
          </div>`).join('') : '<div class="empty-tip">暂无提醒</div>'}
        </div>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">最近工单</h3>
        ${jobs.slice(0, 6).map(jobRow).join('') || '<div class="empty-tip">暂无工单</div>'}
      </div>
    </div>`;
  $$('#notifList [data-read]').forEach(b => b.onclick = async () => {
    await api(`/api/notifications/${b.dataset.read}/read`, { method: 'POST' });
    render();
  });
  bindJobRows(app);
}

function jobRow(j) {
  const [label, color] = JOB_STATUS[j.status] || [j.status, 'steel'];
  return `<div class="jobrow" data-job="${j.id}" style="cursor:pointer">
    <span class="no">${esc(j.job_no)}</span>
    <span class="badge ${color}">${label}</span>
    ${j.on_hold ? '<span class="badge amber">临时营业挂起</span>' : ''}
    <div class="grow">
      <div>${esc(j.store_name)} · ${esc(j.hood_name)}</div>
      <div class="mini">${esc(j.crew_name)} · 窗口 ${fmtT(j.sched_start)} ~ ${fmtT(j.sched_end).slice(11)}</div>
    </div>
    <span class="mini">›</span>
  </div>`;
}
function bindJobRows(app) {
  $$('.jobrow[data-job]', app).forEach(el => el.onclick = () => {
    state.route = 'jobs'; state.params = { id: Number(el.dataset.job) }; nav();
  });
}

/* ============================================================
   视图：周期计划
   ============================================================ */
async function viewPlans(app) {
  const plans = await api('/api/plans');
  app.innerHTML = `
    <h2 class="page">周期计划</h2>
    <div class="panel">
      <table class="tbl"><thead><tr>
        <th>门店</th><th>周期</th><th>上次清洗</th><th>下次到期</th><th>倒计时</th><th>状态</th>
      </tr></thead><tbody>
      ${plans.map(p => {
        const overdue = p.days_to_due < 0, soon = p.days_to_due <= 7;
        return `<tr>
          <td>${esc(p.store_name)}</td><td>${esc(p.cycle_label)}（${p.interval_days}天）</td>
          <td>${fmtT(p.last_done)}</td><td>${fmtT(p.next_due)}</td>
          <td>${overdue ? `<span class="badge red">已逾期 ${-p.days_to_due} 天</span>`
            : soon ? `<span class="badge amber">${p.days_to_due} 天后到期</span>`
            : `<span class="badge steel">${p.days_to_due} 天</span>`}</td>
          <td>${p.has_active_job ? '<span class="badge green">已安排工单</span>'
            : '<span class="badge amber">待协调停灶</span>'}</td>
        </tr>`; }).join('')}
      </tbody></table>
      <p class="muted">到期前 7 天且未安排工单时，系统每 5 秒扫描并推送提醒至工作台。</p>
    </div>`;
}

/* ============================================================
   视图：停灶协调（窗口确认 → 排班）
   ============================================================ */
async function viewWindows(app) {
  const [windows, stores, staff, jobs] = await Promise.all([
    api('/api/windows'), api('/api/stores'), api('/api/staff'), api('/api/jobs'),
  ]);
  const crews = [...new Map(staff.filter(s => s.crew_id).map(s => [s.crew_id, s.crew_name])).entries()];
  const storeOpts = stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const winBadge = { proposed: ['待门店确认', 'amber'], confirmed: ['已确认', 'green'], rejected: ['已驳回', 'red'] };

  app.innerHTML = `
    <h2 class="page">停灶协调</h2>
    <div class="grid cols-2">
      <div class="panel accent">
        <h3 style="margin-top:0">申请停灶窗口</h3>
        <div class="field"><label>门店</label><select id="wStore">${storeOpts}</select></div>
        <div class="formrow">
          <div class="field"><label>开始（停灶）</label><input id="wStart" type="datetime-local"></div>
          <div class="field"><label>结束（恢复）</label><input id="wEnd" type="datetime-local"></div>
        </div>
        <div class="field"><label>备注</label><input id="wNote" placeholder="如：商场凌晨停业时段"></div>
        <button class="btn primary big" id="wSubmit">提交窗口申请</button>
        <p class="muted">窗口须经门店确认后才能排班；两个班组不能占用同一厨房时段。</p>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">排班（仅限已确认窗口）</h3>
        <div class="field"><label>已确认窗口</label><select id="jWindow">
          ${windows.filter(w => w.status === 'confirmed').map(w =>
            `<option value="${w.id}" data-store="${w.store_id}" data-s="${w.start_ts}" data-e="${w.end_ts}">#${w.id} ${esc(w.store_name)} ${fmtT(w.start_ts)}~${fmtT(w.end_ts).slice(11)}</option>`).join('') || '<option value="">（暂无已确认窗口）</option>'}
        </select></div>
        <div class="field"><label>施工班组</label><select id="jCrew">
          ${crews.map(([id, nm]) => `<option value="${id}">${esc(nm)}</option>`).join('')}
        </select></div>
        <div class="formrow">
          <div class="field"><label>施工开始</label><input id="jStart" type="datetime-local"></div>
          <div class="field"><label>施工结束</label><input id="jEnd" type="datetime-local"></div>
        </div>
        <button class="btn primary big" id="jSubmit" ${can('inspector') ? '' : 'disabled'}>生成施工工单</button>
        ${can('inspector') ? '' : '<p class="muted">排班由验收员/调度执行，当前身份不可操作。</p>'}
      </div>
    </div>
    <h3>窗口列表</h3>
    <div class="panel">
      <table class="tbl"><thead><tr>
        <th>#</th><th>门店</th><th>停灶时段</th><th>状态</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>
      ${windows.map(w => {
        const [lb, cl] = winBadge[w.status];
        return `<tr>
          <td>${w.id}</td><td>${esc(w.store_name)}</td>
          <td>${fmtT(w.start_ts)} ~ ${fmtT(w.end_ts).slice(11)}</td>
          <td><span class="badge ${cl}">${lb}</span>${w.job_count ? ` <span class="badge cyan">${w.job_count} 单</span>` : ''}</td>
          <td class="muted">${esc(w.note || '')}</td>
          <td>${w.status === 'proposed' && can('store_manager', 'inspector') ? `
            <button class="btn primary" data-cfm="${w.id}" style="min-height:38px;padding:5px 14px">确认</button>
            <button class="btn danger" data-rej="${w.id}" style="min-height:38px;padding:5px 14px">驳回</button>` : ''}</td>
        </tr>`; }).join('')}
      </tbody></table>
    </div>`;

  $('#wSubmit').onclick = () => act(async () => {
    await api('/api/windows', { method: 'POST', body: {
      store_id: Number($('#wStore').value),
      start_ts: new Date($('#wStart').value).toISOString(),
      end_ts: new Date($('#wEnd').value).toISOString(),
      note: $('#wNote').value,
    } });
    render();
  }, '窗口申请已提交，等待门店确认');

  const jw = $('#jWindow');
  const syncRange = () => {
    const o = jw.selectedOptions[0];
    if (o && o.dataset.s) { $('#jStart').value = o.dataset.s.slice(0, 16); $('#jEnd').value = o.dataset.e.slice(0, 16); }
  };
  jw.onchange = syncRange; syncRange();
  $('#jSubmit').onclick = () => act(async () => {
    const o = jw.selectedOptions[0];
    if (!o || !o.value) throw new Error('请先选择已确认的停灶窗口');
    const storeId = Number(o.dataset.store);
    const detail = await api(`/api/stores/${storeId}`);
    await api('/api/jobs', { method: 'POST', body: {
      store_id: storeId, hood_id: detail.hoods[0].id,
      crew_id: Number($('#jCrew').value), window_id: Number(o.value),
      sched_start: new Date($('#jStart').value).toISOString(),
      sched_end: new Date($('#jEnd').value).toISOString(),
    } });
    state.route = 'jobs'; nav();
  }, '排班成功');

  $$('[data-cfm]', app).forEach(b => b.onclick = () =>
    act(() => api(`/api/windows/${b.dataset.cfm}/confirm`, { method: 'POST' }), '窗口已确认').then(render));
  $$('[data-rej]', app).forEach(b => b.onclick = () =>
    act(() => api(`/api/windows/${b.dataset.rej}/reject`, { method: 'POST', body: { note: '门店该时段不便停灶' } }), '已驳回').then(render));
}

/* ============================================================
   视图：施工工单（列表 + 详情）
   ============================================================ */
async function viewJobs(app) {
  if (state.params.id) return viewJobDetail(app, state.params.id);
  const jobs = await api('/api/jobs');
  app.innerHTML = `
    <h2 class="page">施工工单</h2>
    <div class="panel">
      ${jobs.map(jobRow).join('') || '<div class="empty-tip">暂无工单，请先在「停灶协调」排班</div>'}
    </div>`;
  bindJobRows(app);
}

const SEG_PROGRESS = { pending: 0, disassembled: 20, washed: 45, dried: 65, reassembled: 85, done: 100 };

function hoodBar(job, selectedJs) {
  const segs = job.segments;
  return `<div class="hoodbar">
    <div class="duct"></div>
    <div class="hoodsegs">
      ${segs.map(js => {
        const pct = SEG_PROGRESS[js.status] ?? 0;
        const doneSteps = new Set(js.steps.map(s => s.step));
        return `<div class="hseg ${js.status === 'done' ? 'done' : ''} ${selectedJs === js.id ? 'selected' : ''}" data-js="${js.id}">
          <div class="fill" style="width:${pct}%"></div>
          ${js.grease_level ? `<span class="grease badge ${js.grease_level >= 4 ? 'red' : js.grease_level >= 3 ? 'amber' : 'steel'}">油污 ${js.grease_level} 级</span>` : ''}
          <span class="rivet" style="left:6px;top:6px"></span><span class="rivet" style="right:6px;bottom:6px"></span>
          <div class="inner">
            <div class="nm">${esc(js.seg_name)}</div>
            <div class="meta">${js.length_m}m · 滤网 ${js.filters_reinstalled ?? '—'}/${js.filter_count}</div>
            <div class="meta">${pct}% ${js.status === 'done' ? '✓ 完成' : ''}</div>
            <div class="steps">${STEP_ORDER.map(s =>
              `<span class="stp ${doneSteps.has(s) ? 'on' : ''}" title="${STEP_LABEL[s]}"></span>`).join('')}</div>
          </div>
        </div>`; }).join('')}
    </div>
    <div class="hoodscale"><span>← 完成度自左向右推进</span><span>罩体分段示意 · 第 ${job.current_round} 轮施工</span></div>
  </div>`;
}

async function viewJobDetail(app, jobId) {
  const [job, gate] = await Promise.all([
    api(`/api/jobs/${jobId}`),
    api(`/api/jobs/${jobId}/gate`).catch(() => null),
  ]);
  const [stLabel, stColor] = JOB_STATUS[job.status] || [job.status, 'steel'];
  const selJs = Number(sessionStorage.getItem('hc_js')) || (job.segments[0] && job.segments[0].id);
  const js = job.segments.find(s => s.id === selJs) || job.segments[0];
  const openEx = job.exceptions.filter(e => e.status === 'open');

  app.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 class="page" style="margin:0">${esc(job.job_no)}</h2>
      <span class="badge ${stColor}">${stLabel}</span>
      ${job.on_hold ? '<span class="badge amber">临时营业挂起中</span>' : ''}
      <span class="muted">${esc(job.store_name)} · ${esc(job.hood_name)} · ${esc(job.crew_name)}</span>
      <span style="flex:1"></span>
      <button class="btn ghost" id="backBtn">‹ 返回列表</button>
    </div>
    <dl class="kv" style="margin:12px 0">
      <dt>停灶窗口</dt><dd>${fmtT(job.sched_start)} ~ ${fmtT(job.sched_end)}</dd>
      <dt>施工轮次</dt><dd>第 ${job.current_round} 轮${job.current_round > 1 ? '（返工）' : ''}</dd>
      <dt>单价</dt><dd class="money">${fmtMoney(job.segment_price)} / 段</dd>
    </dl>

    ${hoodBar(job, js && js.id)}

    <div class="grid cols-2" style="margin-top:22px">
      <div>
        <div class="panel accent" id="segPanel"></div>
        <div class="panel" id="airPanel"></div>
      </div>
      <div>
        <div class="panel" id="photoPanel"></div>
        <div class="panel" id="exPanel"></div>
      </div>
    </div>

    <div class="panel" id="actPanel"></div>`;

  $('#backBtn').onclick = () => { state.params = {}; nav(); };
  $$('.hseg', app).forEach(el => el.onclick = () => {
    sessionStorage.setItem('hc_js', el.dataset.js); render();
  });

  renderSegPanel(job, js);
  renderAirPanel(job);
  renderPhotoPanel(job, js);
  renderExPanel(job, openEx);
  renderActPanel(job, gate);
}

/* ---- 分段施工面板 ---- */
function renderSegPanel(job, js) {
  if (!js) { $('#segPanel').innerHTML = '<div class="empty-tip">无分段</div>'; return; }
  const doneSteps = new Set(js.steps.map(s => s.step));
  const nextStep = STEP_ORDER.find(s => !doneSteps.has(s));
  const inProgress = job.status === 'in_progress' && !job.on_hold;
  const canWork = inProgress && can('worker', 'crew_lead');
  const el = $('#segPanel');
  el.innerHTML = `
    <h3 style="margin-top:0">分段施工单 · ${esc(js.seg_name)}</h3>
    <div class="stepflow">${STEP_ORDER.map(s =>
      `<div class="sf ${doneSteps.has(s) ? 'on' : s === nextStep && inProgress ? 'cur' : ''}">${STEP_LABEL[s]}</div>`).join('')}
    </div>
    <dl class="kv">
      <dt>油污等级</dt><dd>${js.grease_level ? GREASE_LABEL[js.grease_level] : '拆卸时登记'}</dd>
      <dt>滤网拆卸</dt><dd>${js.filters_removed ?? '—'} 片${js.filters_damaged ? `（损坏 ${js.filters_damaged}）` : ''}</dd>
      <dt>滤网复装</dt><dd>${js.filters_reinstalled ?? '—'} / 应装 ${js.filter_count} 片
        ${js.filters_reinstalled != null && js.filters_reinstalled < js.filter_count ? '<span class="badge red">漏装!</span>' : ''}</dd>
    </dl>
    ${js.steps.length ? `<table class="tbl"><thead><tr><th>工序</th><th>操作人</th><th>完成时间</th></tr></thead>
      <tbody>${js.steps.map(s => `<tr><td>${STEP_LABEL[s.step]}</td><td>#${s.operator_id}</td><td>${fmtT(s.completed_at)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${canWork && nextStep ? `<hr class="sep"><div id="stepForm"></div>` : ''}
    ${job.on_hold ? '<p class="muted">门店临时营业，施工挂起中，待复工后继续。</p>' : ''}`;

  if (!canWork || !nextStep) return;
  const form = $('#stepForm');
  const btn = (label, extra) => `<button class="btn primary big" id="doStep">${label}</button>${extra || ''}`;
  if (nextStep === 'disassemble') {
    form.innerHTML = `
      <div class="formrow">
        <div class="field"><label>拆卸滤网数量（片）</label><input id="fRemoved" type="number" min="0" value="${js.filter_count}"></div>
        <div class="field"><label>其中损坏（片）</label><input id="fDamaged" type="number" min="0" value="0"></div>
        <div class="field"><label>油污等级</label><select id="fGrease">
          ${Object.entries(GREASE_LABEL).map(([k, v]) => `<option value="${k}" ${k === '3' ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      </div>${btn('① 完成拆卸登记')}`;
  } else if (nextStep === 'reassemble') {
    form.innerHTML = `
      <div class="formrow">
        <div class="field"><label>复装滤网数量（应装 ${js.filter_count} 片）</label>
          <input id="fReinstalled" type="number" min="0" value="${js.filter_count}"></div>
      </div>${btn('④ 完成复装登记')}`;
  } else {
    const labels = { wash: '② 完成清洗', dry: '③ 完成干燥', trial: '⑤ 试运行通过' };
    form.innerHTML = btn(labels[nextStep]);
  }
  $('#doStep').onclick = () => act(async () => {
    const body = {};
    if (nextStep === 'disassemble') {
      body.filters_removed = Number($('#fRemoved').value);
      body.filters_damaged = Number($('#fDamaged').value);
      body.grease_level = Number($('#fGrease').value);
    }
    if (nextStep === 'reassemble') body.filters_reinstalled = Number($('#fReinstalled').value);
    await api(`/api/jobs/${job.id}/segments/${js.id}/steps/${nextStep}`, { method: 'POST', body });
    render();
  }, `「${STEP_LABEL[nextStep]}」已登记`);
}

/* ---- 风量复测面板 ---- */
function renderAirPanel(job) {
  const el = $('#airPanel');
  const canMeasure = job.status === 'in_progress' && !job.on_hold && can('worker', 'crew_lead', 'inspector');
  el.innerHTML = `
    <h3 style="margin-top:0">风量复测（模拟适配器）</h3>
    ${job.duct_points.map(p => `
      <div class="checkline ${p.last_passed && p.last_noise_ok ? 'ok' : p.attempts ? 'bad' : ''}">
        <span class="ic">${p.last_passed && p.last_noise_ok ? '✓' : p.attempts ? '✗' : '·'}</span>
        <div class="grow">
          <div>${esc(p.name)} <span class="muted">${esc(p.position || '')}</span></div>
          <div class="sub">${p.attempts
            ? `第 ${p.attempts} 次：${p.last_velocity.toFixed(1)} m/s · ${p.last_noise.toFixed(0)} dB
               ${p.last_passed ? '' : '（风量不足）'}${p.last_noise_ok ? '' : '（噪声异常）'}`
            : '尚未复测'}</div>
        </div>
        ${canMeasure ? `<button class="btn" data-air="${p.id}" style="min-height:40px">复测</button>` : ''}
      </div>`).join('')}
    <p class="muted">阈值：风量 ≥ ${state.meta?.constants?.AIRFLOW_MIN ?? 9} m/s，噪声 ≤ ${state.meta?.constants?.NOISE_MAX_DB ?? 72} dB。</p>`;
  $$('[data-air]', el).forEach(b => b.onclick = () => act(async () => {
    const r = await api(`/api/jobs/${job.id}/airflow/${b.dataset.air}`, { method: 'POST' });
    toast(`复测结果：${r.velocity.toFixed(1)} m/s · ${r.noise_db.toFixed(0)} dB ${r.passed && r.noise_ok ? '✓ 通过' : '✗ 未通过'}`, !(r.passed && r.noise_ok));
    render();
  }));
}

/* ---- 照片对照面板 ---- */
function renderPhotoPanel(job, js) {
  const el = $('#photoPanel');
  if (!js) { el.innerHTML = ''; return; }
  const before = js.photos.filter(p => p.phase === 'before').pop();
  const after = js.photos.filter(p => p.phase === 'after').pop();
  const canUpload = job.status === 'in_progress' && !job.on_hold && can('worker', 'crew_lead');
  const frame = (photo, phase, label) => `
    <div>
      <div class="photoframe ${photo && !photo.angle_ok ? 'bad' : ''}">
        ${photo ? `<img src="/${photo.file_path}" alt="${label}">` : '<div class="empty">尚未拍摄<span>按统一机位与参考线拍摄</span></div>'}
        ${document.querySelector('#tpl-reflines').innerHTML}
        <div class="cap"><span>${label}</span>
          ${photo ? `<span class="badge ${photo.angle_ok ? 'green' : 'red'}">${photo.angle_ok ? '角度合格' : `偏差 ${Math.abs(photo.angle_deg)}°`}</span>` : ''}
        </div>
      </div>
      ${canUpload ? `<div class="btnrow" style="margin-top:8px">
        <input type="file" accept="image/*" capture="environment" id="up_${phase}" hidden>
        <button class="btn" data-up="${phase}" style="min-height:44px;flex:1">📷 上传${label}</button>
        <input type="number" id="ang_${phase}" placeholder="角度°" title="与统一机位的角度偏差"
          style="width:84px;min-height:44px;background:var(--char-800);border:1px solid var(--steel-600);color:var(--steel-100);border-radius:8px;padding:0 8px" value="0">
      </div>` : ''}
    </div>`;
  el.innerHTML = `
    <h3 style="margin-top:0">照片对照 · ${esc(js.seg_name)}</h3>
    <div class="photocmp">${frame(before, 'before', '清洗前')}${frame(after, 'after', '清洗后')}</div>
    <p class="muted">青色线为统一拍摄角度参考线，偏差超过 ±${state.meta?.constants?.ANGLE_TOLERANCE_DEG ?? 10}° 判定不合格，需重拍。</p>`;

  $$('[data-up]', el).forEach(b => b.onclick = () => {
    const phase = b.dataset.up;
    const input = $(`#up_${phase}`);
    input.onchange = () => act(async () => {
      const file = input.files[0];
      if (!file) return;
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      await api(`/api/jobs/${job.id}/segments/${js.id}/photos/${phase}`, {
        method: 'POST', body: { data_url: dataUrl, angle_deg: Number($(`#ang_${phase}`).value || 0) },
      });
      render();
    }, '照片已上传');
    input.click();
  });
}

/* ---- 异常与增项面板 ---- */
function renderExPanel(job, openEx) {
  const el = $('#exPanel');
  const canConfirmAddon = can('store_manager');
  const canResolve = can('store_manager', 'inspector');
  el.innerHTML = `
    <h3 style="margin-top:0">异常与现场增项</h3>
    ${job.exceptions.length ? job.exceptions.map(e => `
      <div class="checkline ${e.status === 'resolved' ? 'ok' : 'bad'}">
        <span class="ic">${e.status === 'resolved' ? '✓' : '!'}</span>
        <div class="grow">
          <div><span class="badge ${e.status === 'resolved' ? 'steel' : 'red'}">${EX_TYPE[e.type] || e.type}</span> ${esc(e.detail || '')}</div>
          <div class="sub">${fmtT(e.created_at)}${e.resolution ? ' · 处理：' + esc(e.resolution) : ''}</div>
        </div>
        ${e.status === 'open' && canResolve && !['temp_open', 'refuse_sign'].includes(e.type) ?
          `<button class="btn warn" data-res="${e.id}" style="min-height:38px;padding:4px 12px">闭环</button>` : ''}
      </div>`).join('') : '<div class="empty-tip">暂无异常</div>'}
    <h3>增项（须门店确认后计入结算）</h3>
    ${job.addons.length ? `<table class="tbl"><thead><tr><th>类型</th><th>说明</th><th>金额</th><th>状态</th><th></th></tr></thead><tbody>
      ${job.addons.map(a => `<tr>
        <td>${ADDON_TYPE[a.type]}</td><td class="muted">${esc(a.description || '')}</td>
        <td class="money">${fmtMoney(a.amount)}</td>
        <td><span class="badge ${a.status === 'confirmed' ? 'green' : a.status === 'rejected' ? 'red' : 'amber'}">
          ${{ confirmed: '已确认', rejected: '已拒绝', pending: '待确认' }[a.status]}</span></td>
        <td>${a.status === 'pending' && canConfirmAddon ? `
          <button class="btn primary" data-ok="${a.id}" style="min-height:36px;padding:3px 12px">确认</button>
          <button class="btn danger" data-no="${a.id}" style="min-height:36px;padding:3px 12px">拒绝</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty-tip">暂无增项</div>'}`;

  $$('[data-res]', el).forEach(b => b.onclick = () =>
    act(() => api(`/api/exceptions/${b.dataset.res}/resolve`, { method: 'POST', body: { resolution: '现场已处理完毕' } }), '异常已闭环').then(render));
  $$('[data-ok]', el).forEach(b => b.onclick = () =>
    act(() => api(`/api/addons/${b.dataset.ok}/confirm`, { method: 'POST', body: { approve: true } }), '增项已确认，计入结算').then(render));
  $$('[data-no]', el).forEach(b => b.onclick = () =>
    act(() => api(`/api/addons/${b.dataset.no}/confirm`, { method: 'POST', body: { approve: false } }), '增项已拒绝').then(render));
}

/* ---- 操作面板（开工/挂起/验收/签字/结算入口） ---- */
function renderActPanel(job, gate) {
  const el = $('#actPanel');
  const rows = [];
  if (job.status === 'scheduled' && can('worker', 'crew_lead'))
    rows.push(`<button class="btn primary big" id="btnStart">开工（开始分段拆卸）</button>`);
  if (job.status === 'in_progress') {
    if (!job.on_hold && can('store_manager', 'crew_lead', 'inspector'))
      rows.push(`<button class="btn warn big" id="btnHold">门店临时营业 · 挂起</button>`);
    if (job.on_hold && can('store_manager', 'crew_lead', 'inspector'))
      rows.push(`<button class="btn primary big" id="btnResume">恢复施工</button>`);
    if (can('inspector')) {
      rows.push(`<button class="btn primary big" id="btnAccept">提交验收结论</button>`);
      rows.push(`<button class="btn danger big" id="btnRework">判定返工</button>`);
    }
  }
  if (job.status === 'acceptance_review' && can('store_manager'))
    rows.push(`<button class="btn primary big" id="btnGoSign">前往门店签字</button>`);
  if (job.status === 'refused' && can('store_manager', 'inspector'))
    rows.push(`<button class="btn warn big" id="btnResolveRefuse">拒签争议已协商 · 重新签字</button>`);
  if (job.status === 'accepted' && can('finance'))
    rows.push(`<button class="btn primary big" id="btnSettle">生成结算快照</button>`);
  if (job.settlement)
    rows.push(`<button class="btn big" id="btnViewSettle">查看结算快照（${fmtMoney(job.settlement.total_amount)}）</button>`);

  el.innerHTML = `
    <h3 style="margin-top:0">工单操作</h3>
    ${gate && job.status === 'in_progress' ? `
      <div style="margin-bottom:12px">
        ${gate.problems.length === 0
          ? '<div class="checkline ok"><span class="ic">✓</span><div class="grow">验收前置检查全部通过，可提交验收。</div></div>'
          : gate.problems.map(p => `<div class="checkline bad"><span class="ic">✗</span><div class="grow">${esc(p)}</div></div>`).join('')}
      </div>` : ''}
    <div class="btnrow">${rows.join('') || '<span class="muted">当前身份/状态下无可执行操作</span>'}</div>`;

  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#btnStart', () => act(() => api(`/api/jobs/${job.id}/start`, { method: 'POST' }), '已开工').then(render));
  on('#btnHold', () => act(() => api(`/api/jobs/${job.id}/hold`, { method: 'POST', body: { detail: '门店临时营业，暂停施工' } }), '已挂起').then(render));
  on('#btnResume', () => act(() => api(`/api/jobs/${job.id}/resume`, { method: 'POST' }), '已复工').then(render));
  on('#btnAccept', () => act(() =>
    api(`/api/jobs/${job.id}/acceptance`, { method: 'POST', body: { conclusion: '复装齐全、风量复测达标，同意验收' } }),
    '验收结论已提交，待门店签字').then(render));
  on('#btnRework', () => {
    const reason = prompt('返工原因：', '风量复测不达标，需返工');
    if (reason) act(() => api(`/api/jobs/${job.id}/rework`, { method: 'POST', body: { reason } }), '已判定返工，进入新一轮施工').then(render);
  });
  on('#btnGoSign', () => { state.route = 'sign'; state.params = { id: job.id }; nav(); });
  on('#btnResolveRefuse', () => act(() =>
    api(`/api/jobs/${job.id}/resolve-refusal`, { method: 'POST', body: { resolution: '已免费补洗 C 段，门店同意重新验收签字' } }),
    '已恢复待签字状态').then(render));
  on('#btnSettle', () => act(async () => {
    const s = await api(`/api/jobs/${job.id}/settlement`, { method: 'POST' });
    toast(`结算快照已生成：${fmtMoney(s.total_amount)}`);
    state.route = 'settle'; nav();
  }));
  on('#btnViewSettle', () => { state.route = 'settle'; state.params = {}; nav(); });
}

/* ============================================================
   视图：门店签字（大触控区，适配戴手套）
   ============================================================ */
async function viewSign(app, jobId) {
  const jobs = await api('/api/jobs');
  const candidates = jobs.filter(j => ['acceptance_review', 'refused'].includes(j.status));
  const job = jobId ? await api(`/api/jobs/${jobId}`).catch(() => null) : null;

  if (!job) {
    app.innerHTML = `
      <h2 class="page">门店签字</h2>
      <div class="panel">
        ${candidates.length ? candidates.map(j => `
          <div class="jobrow" data-sign="${j.id}" style="cursor:pointer">
            <span class="no">${esc(j.job_no)}</span>
            <span class="badge ${j.status === 'refused' ? 'red' : 'amber'}">${JOB_STATUS[j.status][0]}</span>
            <div class="grow">${esc(j.store_name)} · ${esc(j.hood_name)}</div><span class="mini">›</span>
          </div>`).join('') : '<div class="empty-tip">暂无待签字工单</div>'}
      </div>`;
    $$('[data-sign]', app).forEach(el => el.onclick = () => {
      state.params = { id: Number(el.dataset.sign) }; nav();
    });
    return;
  }

  const acc = job.acceptance;
  app.innerHTML = `
    <h2 class="page">门店签字 · ${esc(job.job_no)}</h2>
    <div class="signwrap">
      <div class="panel accent">
        <dl class="kv">
          <dt>门店</dt><dd>${esc(job.store_name)}</dd>
          <dt>罩体</dt><dd>${esc(job.hood_name)}（${job.segments.length} 段）</dd>
          <dt>施工班组</dt><dd>${esc(job.crew_name)}</dd>
          <dt>验收结论</dt><dd>${acc ? esc(acc.conclusion || '') : '—'}</dd>
          <dt>验收时间</dt><dd>${acc ? fmtT(acc.created_at) : '—'}</dd>
        </dl>
        ${job.status === 'refused' ? `<p><span class="badge red">已拒签</span> ${esc(acc?.refuse_reason || '')}</p>` : ''}
      </div>
      ${job.status === 'acceptance_review' && can('store_manager') ? `
      <div class="panel">
        <h3 style="margin-top:0">手写签名区</h3>
        <canvas class="signpad" id="pad" width="720" height="300"></canvas>
        <p class="signhint">请在上方区域签名（支持戴手套粗笔触控，笔迹已加粗）</p>
        <div class="signactions">
          <button class="btn ghost" id="padClear">清除重写</button>
          <button class="btn primary" id="padSign">确认签字 · 验收通过</button>
        </div>
        <hr class="sep">
        <div class="field"><label>拒签原因（如施工质量不达标）</label>
          <textarea id="refuseReason" placeholder="拒签将退回验收并生成异常记录"></textarea></div>
        <button class="btn danger big" id="btnRefuse" style="width:100%">拒绝签字</button>
      </div>` : `
      <div class="panel"><p class="muted">
        ${job.status === 'acceptance_review' ? '请切换为门店经理身份进行签字。' : '该工单当前不在待签字状态。'}
      </p></div>`}
      <div class="btnrow"><button class="btn ghost" id="signBack">‹ 返回</button></div>
    </div>`;

  $('#signBack').onclick = () => { state.params = {}; nav(); };
  const pad = $('#pad');
  if (!pad) return;

  // 签名画布：pointer 事件 + 粗笔迹（戴手套）
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1f6f4a';
  let drawing = false, dirty = false;
  const pos = e => {
    const r = pad.getBoundingClientRect();
    return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)];
  };
  pad.addEventListener('pointerdown', e => { drawing = true; dirty = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  pad.addEventListener('pointermove', e => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
  pad.addEventListener('pointerup', () => { drawing = false; });
  $('#padClear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); dirty = false; };
  $('#padSign').onclick = () => act(async () => {
    if (!dirty) throw new Error('请先签名');
    await api(`/api/jobs/${job.id}/sign`, { method: 'POST', body: { sign_image: pad.toDataURL('image/png') } });
    toast('签字完成，验收通过');
    state.route = 'jobs'; state.params = { id: job.id }; nav();
  });
  $('#btnRefuse').onclick = () => act(async () => {
    const reason = $('#refuseReason').value.trim();
    if (!reason) throw new Error('拒签必须填写原因');
    await api(`/api/jobs/${job.id}/refuse`, { method: 'POST', body: { reason } });
    toast('已拒签，工单退回处理');
    state.route = 'jobs'; state.params = { id: job.id }; nav();
  });
}

/* ============================================================
   视图：费用复核
   ============================================================ */
async function viewSettle(app) {
  const settlements = await api('/api/settlements');
  const accepted = (await api('/api/jobs')).filter(j => j.status === 'accepted');
  app.innerHTML = `
    <h2 class="page">费用复核</h2>
    ${accepted.length && can('finance') ? `<div class="panel accent">
      <h3 style="margin-top:0">待结算工单</h3>
      ${accepted.map(j => `<div class="jobrow"><span class="no">${esc(j.job_no)}</span>
        <div class="grow">${esc(j.store_name)}</div>
        <button class="btn primary" data-settle="${j.id}">生成结算快照</button></div>`).join('')}
    </div>` : ''}
    <div class="panel">
      <h3 style="margin-top:0">结算快照（按实际清洗段数形成，幂等不可重复）</h3>
      ${settlements.length ? settlements.map(s => {
        const snap = typeof s.snapshot_json === 'string' ? JSON.parse(s.snapshot_json) : s.snapshot_json;
        return `<div class="panel" style="background:var(--char-800)">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <strong>${esc(s.job_no)}</strong>
            <span class="badge ${s.status === 'reviewed' ? 'green' : 'amber'}">${s.status === 'reviewed' ? '已复核' : '待复核'}</span>
            <span class="muted">${esc(s.store_name)}</span><span style="flex:1"></span>
            <span class="money big">${fmtMoney(s.total_amount)}</span>
          </div>
          <dl class="kv" style="margin-top:10px">
            <dt>实际清洗段数</dt><dd>${snap.actual_washed_segments} 段 × ${fmtMoney(snap.pricing.segment_price)} = <span class="money">${fmtMoney(snap.base_amount)}</span></dd>
            <dt>已确认增项</dt><dd>${snap.addons_confirmed.length
              ? snap.addons_confirmed.map(a => `${ADDON_TYPE[a.type]} ${fmtMoney(a.amount)}`).join('；')
              : '无'}（合计 <span class="money">${fmtMoney(snap.addon_amount)}</span>）</dd>
            <dt>未计入增项</dt><dd class="muted">${snap.addons_excluded.length
              ? snap.addons_excluded.map(a => `${ADDON_TYPE[a.type]}（${{ pending: '未确认', rejected: '已拒绝' }[a.status]}）`).join('；') : '无'}</dd>
            <dt>快照时间</dt><dd>${fmtT(snap.generated_at)} · 第 ${snap.job.final_round} 轮施工</dd>
          </dl>
          ${s.status !== 'reviewed' && can('finance') ?
            `<button class="btn primary" data-review="${s.id}">复核通过</button>` : ''}
        </div>`; }).join('') : '<div class="empty-tip">暂无结算快照</div>'}
    </div>`;
  $$('[data-settle]', app).forEach(b => b.onclick = () =>
    act(() => api(`/api/jobs/${b.dataset.settle}/settlement`, { method: 'POST' }), '结算快照已生成').then(render));
  $$('[data-review]', app).forEach(b => b.onclick = () =>
    act(() => api(`/api/settlements/${b.dataset.review}/review`, { method: 'POST' }), '复核完成').then(render));
}

/* ---------------- 渲染入口 ---------------- */
async function render() {
  renderNav();
  const app = $('#app');
  try {
    if (state.route === 'dashboard') await viewDashboard(app);
    else if (state.route === 'plans') await viewPlans(app);
    else if (state.route === 'windows') await viewWindows(app);
    else if (state.route === 'jobs') await viewJobs(app);
    else if (state.route === 'sign') await viewSign(app, state.params.id);
    else if (state.route === 'settle') await viewSettle(app);
  } catch (e) {
    app.innerHTML = `<div class="panel"><p style="color:var(--red)">${esc(e.message)}</p>
      <button class="btn" onclick="location.hash='#/dashboard';location.reload()">返回工作台</button></div>`;
  }
}

(async function boot() {
  state.meta = await api('/api/meta');
  await loadStaff();
  window.addEventListener('hashchange', parseHash);
  parseHash();
  // 进程内提醒轮询：有未读时角标提示
  setInterval(async () => {
    if (state.route === 'dashboard') return; // 工作台自身会刷新
    try {
      const ns = await api('/api/notifications');
      const unread = ns.filter(n => !n.is_read).length;
      document.title = (unread ? `(${unread}) ` : '') + '净罩 · 排烟罩清洗与验收平台';
    } catch { /* 忽略轮询错误 */ }
  }, 5000);
})();
