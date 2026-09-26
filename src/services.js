'use strict';
// 领域服务：排期互斥、工序顺序、增项确认、验收权限、结算幂等
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STEP_FLOW = ['remove', 'clean', 'dry', 'reassemble', 'test_run'];
const SEG_STEP_RANK = { pending: 0, removed: 1, cleaned: 2, dried: 3, reassembled: 4, tested: 5 };
const AIRFLOW_THRESHOLD = 1200;   // m3/h
const NOISE_LIMIT = 80;           // dB
const PRICE_PER_SEGMENT = 38000;  // 分/段（¥380）
const FILTER_UNIT_PRICE = 15000;  // 分/片（滤网损坏补装）

class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400; }
}
const fail = (code, msg) => { throw new DomainError(code, msg); };

function nowIso() { return new Date().toISOString(); }
function overlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

function createServices(ctx) {
  const { db, photoDir, adapter, notify } = ctx;
  const emit = notify || (() => {});

  // ---------- 基础查询 ----------
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const userOf = (userId) => {
    const u = get('SELECT * FROM users WHERE id=?', userId);
    if (!u) fail('no_user', '用户不存在');
    return u;
  };
  const requireRole = (userId, roles) => {
    const u = userOf(userId);
    if (!roles.includes(u.role)) fail('forbidden', `角色 ${u.role} 无权执行该操作（需要 ${roles.join('/')}）`);
    return u;
  };

  function jobDetail(jobId) {
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (!job) fail('no_job', '施工单不存在');
    const store = get('SELECT * FROM stores WHERE id=?', job.store_id);
    const team = get('SELECT * FROM teams WHERE id=?', job.team_id);
    const segments = all(
      `SELECT js.*, hs.code, hs.name, hs.length_m, hs.filters_expected, hs.duct_points
       FROM job_segments js JOIN hood_segments hs ON hs.id=js.segment_id
       WHERE js.job_id=? ORDER BY js.seq`, jobId);
    segments.forEach(s => { s.duct_points = JSON.parse(s.duct_points); });
    return {
      ...job,
      store, team,
      segments,
      photos: all('SELECT * FROM photos WHERE job_id=? ORDER BY phase, id', jobId),
      air_tests: all('SELECT * FROM air_tests WHERE job_id=? ORDER BY id', jobId),
      addons: all('SELECT * FROM addons WHERE job_id=? ORDER BY id', jobId),
      acceptance: get('SELECT * FROM acceptances WHERE job_id=?', jobId) || null,
      invoice: get('SELECT * FROM invoices WHERE job_id=?', jobId) || null,
      steps: all('SELECT * FROM work_steps WHERE job_id=? ORDER BY id', jobId),
    };
  }

  // ---------- 周期计划 ----------
  function listPlans() {
    return all(`SELECT cp.*, s.name AS store_name FROM cycle_plans cp
                JOIN stores s ON s.id=cp.store_id WHERE cp.active=1 ORDER BY cp.next_due_date`);
  }
  function upsertPlan({ store_id, period_days, next_due_date, heavy_oil }) {
    const exist = get('SELECT id FROM cycle_plans WHERE store_id=? AND active=1', store_id);
    if (exist) {
      db.prepare('UPDATE cycle_plans SET period_days=?, next_due_date=?, heavy_oil=? WHERE id=?')
        .run(period_days, next_due_date, heavy_oil ? 1 : 0, exist.id);
      return get('SELECT * FROM cycle_plans WHERE id=?', exist.id);
    }
    const r = db.prepare('INSERT INTO cycle_plans(store_id,period_days,next_due_date,heavy_oil) VALUES(?,?,?,?)')
      .run(store_id, period_days, next_due_date, heavy_oil ? 1 : 0);
    return get('SELECT * FROM cycle_plans WHERE id=?', r.lastInsertRowid);
  }

  // ---------- 停灶窗口 ----------
  function listWindows() {
    return all(`SELECT w.*, s.name AS store_name, u.display_name AS confirmer_name
                FROM shutdown_windows w JOIN stores s ON s.id=w.store_id
                LEFT JOIN users u ON u.id=w.confirmed_by ORDER BY w.start_at`);
  }
  function proposeWindow({ store_id, start_at, end_at, note }) {
    if (new Date(end_at) <= new Date(start_at)) fail('bad_window', '结束时间必须晚于开始时间');
    const r = db.prepare('INSERT INTO shutdown_windows(store_id,start_at,end_at,note) VALUES(?,?,?,?)')
      .run(store_id, start_at, end_at, note || null);
    emit('window', '停灶窗口待确认', `门店已提交新的停灶窗口申请`, 'window', r.lastInsertRowid);
    return get('SELECT * FROM shutdown_windows WHERE id=?', r.lastInsertRowid);
  }
  // 门店确认 / 临时营业 / 取消
  function setWindowStatus(windowId, userId, status, note) {
    const u = userOf(userId);
    const w = get('SELECT * FROM shutdown_windows WHERE id=?', windowId);
    if (!w) fail('no_window', '停灶窗口不存在');
    if (status === 'confirmed') {
      if (u.role !== 'store' && u.role !== 'planner') fail('forbidden', '只有门店可以确认停灶窗口');
      db.prepare('UPDATE shutdown_windows SET status=?, confirmed_at=?, confirmed_by=?, note=COALESCE(?,note) WHERE id=?')
        .run(status, nowIso(), userId, note || null, windowId);
      emit('window', '停灶窗口已确认', `门店确认了 ${w.start_at} 的停灶窗口，可以排班`, 'window', windowId);
    } else if (status === 'temporary_business') {
      if (u.role !== 'store') fail('forbidden', '只有门店可以登记临时营业');
      db.prepare("UPDATE shutdown_windows SET status='temporary_business', note=COALESCE(?,note) WHERE id=?")
        .run(note || '门店临时营业', windowId);
      const jobs = all("SELECT * FROM jobs WHERE window_id=? AND status IN ('scheduled','in_progress')", windowId);
      jobs.forEach(j => emit('schedule', '门店临时营业，施工需改期',
        `施工单 ${j.code} 受影响：门店临时营业`, 'job', j.id));
    } else if (status === 'cancelled') {
      db.prepare("UPDATE shutdown_windows SET status='cancelled', note=COALESCE(?,note) WHERE id=?")
        .run(note || null, windowId);
    } else fail('bad_status', '不支持的窗口状态');
    return get('SELECT * FROM shutdown_windows WHERE id=?', windowId);
  }

  // ---------- 排班（互斥） ----------
  function scheduleJob({ store_id, team_id, window_id, start_at, end_at, userId }) {
    requireRole(userId, ['planner', 'crew']);
    const win = get('SELECT * FROM shutdown_windows WHERE id=?', window_id);
    if (!win) fail('no_window', '停灶窗口不存在');
    if (win.store_id !== store_id) fail('bad_window', '窗口与门店不匹配');
    if (win.status !== 'confirmed') fail('window_not_confirmed', '门店确认停灶窗口后才能排班');
    if (win.status === 'temporary_business') fail('window_temp_business', '门店临时营业，窗口不可用');
    if (new Date(start_at) < new Date(win.start_at) || new Date(end_at) > new Date(win.end_at))
      fail('out_of_window', '排班必须落在已确认的停灶窗口内');

    // 同一厨房时段互斥：两个班组不能占用同一厨房时段
    const clash = get(
      `SELECT j.*, t.name AS team_name FROM jobs j JOIN teams t ON t.id=j.team_id
       WHERE j.store_id=? AND j.status NOT IN ('rejected_sign')
         AND NOT (j.scheduled_end <= ? OR j.scheduled_start >= ?)
       LIMIT 1`,
      store_id, start_at, end_at);
    if (clash) fail('kitchen_busy',
      `厨房时段冲突：${clash.team_name} 已在该时段施工（${clash.code}），两个班组不能占用同一厨房时段`);

    const team = get('SELECT * FROM teams WHERE id=?', team_id);
    if (!team) fail('no_team', '班组不存在');

    const segs = all('SELECT * FROM hood_segments WHERE store_id=? ORDER BY id', store_id);
    if (!segs.length) fail('no_segment', '该门店尚未建立罩体分段');

    const code = 'SG' + String(Date.now()).slice(-8) + crypto.randomInt(10, 99);
    const r = db.prepare(
      `INSERT INTO jobs(code,store_id,team_id,window_id,scheduled_start,scheduled_end,created_by,created_at,plan_segment_count)
       VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(code, store_id, team_id, window_id, start_at, end_at, userId, nowIso(), segs.length);
    const jobId = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO job_segments(job_id,segment_id,seq) VALUES(?,?,?)');
    segs.forEach((s, i) => ins.run(jobId, s.id, i + 1));
    emit('schedule', '新施工单已排班', `${team.name} → ${code}，共 ${segs.length} 段`, 'job', jobId);
    return jobDetail(jobId);
  }

  // ---------- 开工 / 逐段拆卸登记滤网 ----------
  function startJob(jobId, userId) {
    requireRole(userId, ['crew']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (job.status !== 'scheduled') fail('bad_state', `当前状态 ${job.status} 不能开工`);
    const win = job.window_id && get('SELECT * FROM shutdown_windows WHERE id=?', job.window_id);
    if (win && win.status === 'temporary_business')
      fail('window_temp_business', '门店临时营业中，不能开工，请先协调改期');
    db.prepare("UPDATE jobs SET status='in_progress', started_at=? WHERE id=?").run(nowIso(), jobId);
    db.prepare("INSERT INTO work_steps(job_id,step,operator_id,at) VALUES(?, 'remove', ?, ?)")
      .run(jobId, userId, nowIso());
    emit('job', '施工开工', `${job.code} 已开工，开始逐段拆卸`, 'job', jobId);
    return jobDetail(jobId);
  }

  function registerFilters(jobId, jobSegmentId, { filters_removed, damaged_filters, damage_note }, userId) {
    requireRole(userId, ['crew']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (!['in_progress', 'cleaning'].includes(job.status)) fail('bad_state', '请先开工再逐段拆卸');
    const js = get('SELECT * FROM job_segments WHERE id=? AND job_id=?', jobSegmentId, jobId);
    if (!js) fail('no_segment', '分段不存在');
    if (js.filters_removed != null) fail('already_registered', '该段滤网数量已登记，不可重复登记');
    if (!Number.isInteger(filters_removed) || filters_removed < 0) fail('bad_count', '滤网数量无效');
    if (damaged_filters > filters_removed) fail('bad_count', '损坏数量不能超过拆卸数量');
    db.prepare(
      `UPDATE job_segments SET filters_removed=?, damaged_filters=?, damage_note=?,
       step='removed', registered_by=?, registered_at=? WHERE id=?`)
      .run(filters_removed, damaged_filters || 0, damage_note || null, userId, nowIso(), js.id);
    db.prepare("INSERT INTO work_steps(job_id,job_segment_id,step,operator_id,at,payload) VALUES(?,?,'remove',?,?,?)")
      .run(jobId, js.id, userId, nowIso(), JSON.stringify({ filters_removed, damaged_filters: damaged_filters || 0 }));
    if (damaged_filters > 0) {
      const amount = damaged_filters * FILTER_UNIT_PRICE;
      db.prepare(
        `INSERT INTO addons(job_id,kind,description,amount,requested_by,requested_at)
         VALUES(?,'filter_damage', ?, ?, ?, ?)`)
        .run(jobId, `滤网损坏 ${damaged_filters} 片，需补装`, amount, userId, nowIso());
      emit('addon', '滤网损坏，待门店确认增项', `施工单 ${job.code}：损坏 ${damaged_filters} 片`, 'job', jobId);
    }
    // 全部段拆卸登记完成 → 进入清洗阶段
    const pending = get('SELECT COUNT(*) c FROM job_segments WHERE job_id=? AND filters_removed IS NULL', jobId).c;
    if (pending === 0) {
      db.prepare("UPDATE jobs SET status='cleaning' WHERE id=?").run(jobId);
      emit('job', '拆卸完成，进入清洗阶段', `${job.code} 全部段滤网登记完成`, 'job', jobId);
    }
    return jobDetail(jobId);
  }

  // ---------- 工序推进：清洗→干燥→复装→试运行（严格顺序） ----------
  function advanceSegment(jobId, jobSegmentId, step, userId) {
    requireRole(userId, ['crew']);
    if (!STEP_FLOW.includes(step) || step === 'remove') fail('bad_step', '非法工序');
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    const js = get('SELECT * FROM job_segments WHERE id=? AND job_id=?', jobSegmentId, jobId);
    if (!js) fail('no_segment', '分段不存在');

    const targetStep = { clean: 'cleaned', dry: 'dried', reassemble: 'reassembled', test_run: 'tested' }[step];
    const targetRank = SEG_STEP_RANK[targetStep];
    if (SEG_STEP_RANK[js.step] !== targetRank - 1)
      fail('step_order', `工序顺序错误：当前「${js.step}」，不能直接执行「${step}」`);

    // 全局阶段闸门：保证 清洗→干燥→复装→试运行 整体按顺序完成
    const gate = {
      dry: { min: 'cleaned', label: '清洗' },
      reassemble: { min: 'dried', label: '干燥' },
      test_run: { min: 'reassembled', label: '复装' },
    }[step];
    if (gate) {
      const behind = all('SELECT * FROM job_segments WHERE job_id=?', jobId)
        .filter(s => SEG_STEP_RANK[s.step] < SEG_STEP_RANK[gate.min]);
      if (behind.length) fail('step_order', `所有分段必须先完成「${gate.label}」，才能进入下一工序（还差 ${behind.length} 段）`);
    }

    db.prepare('UPDATE job_segments SET step=? WHERE id=?').run(targetStep, js.id);
    db.prepare("INSERT INTO work_steps(job_id,job_segment_id,step,operator_id,at) VALUES(?,?,?,?,?)")
      .run(jobId, js.id, step, userId, nowIso());

    const ranks = all('SELECT step FROM job_segments WHERE job_id=?', jobId).map(s => SEG_STEP_RANK[s.step]);
    const minRank = Math.min(...ranks);
    const statusMap = { 2: 'drying', 3: 'reassembling', 4: 'testing', 5: 'testing' };
    const newStatus = statusMap[minRank] || job.status;
    if (newStatus !== job.status) {
      db.prepare('UPDATE jobs SET status=? WHERE id=?').run(newStatus, jobId);
      const label = { cleaning: '清洗', drying: '干燥', reassembling: '复装', testing: '试运行' }[newStatus];
      if (label) emit('job', `进入${label}阶段`, `${job.code} 全部段进入${label}`, 'job', jobId);
    }
    return jobDetail(jobId);
  }

  // ---------- 照片（本地目录存储） ----------
  function savePhotoFile(jobId, dataUrl) {
    const m = /^data:(image\/(png|jpeg|jpg|webp|svg\+xml));base64,(.*)$/s.exec(dataUrl || '');
    if (!m) fail('bad_photo', '照片格式无效');
    const ext = m[2] === 'jpeg' ? 'jpg' : (m[2] === 'svg+xml' ? 'svg' : m[2]);
    const buf = Buffer.from(m[3], 'base64');
    const dir = path.join(photoDir, String(jobId));
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return name;
  }
  function addPhoto(jobId, { job_segment_id, phase, dataUrl, angle_ok, note }, userId) {
    requireRole(userId, ['crew', 'inspector']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (!['in_progress','cleaning','drying','reassembling','testing','rework','completed'].includes(job.status))
      fail('bad_state', '当前状态不能上传照片');
    if (!['before', 'after'].includes(phase)) fail('bad_photo', '照片阶段无效');
    const fileName = savePhotoFile(jobId, dataUrl);
    const r = db.prepare(
      `INSERT INTO photos(job_id,job_segment_id,phase,file_name,angle_ok,note,uploaded_by,created_at)
       VALUES(?,?,?,?,?,?,?,?)`)
      .run(jobId, job_segment_id || null, phase, fileName, angle_ok ? 1 : 0, note || null, userId, nowIso());
    if (!angle_ok) emit('photo', '照片角度不合格', `${job.code}：${phase === 'before' ? '清洗前' : '清洗后'}照片需重拍`, 'job', jobId);
    return get('SELECT * FROM photos WHERE id=?', r.lastInsertRowid);
  }
  function reviewPhoto(photoId, { angle_ok, note }, userId) {
    requireRole(userId, ['inspector']);
    const p = get('SELECT * FROM photos WHERE id=?', photoId);
    if (!p) fail('no_photo', '照片不存在');
    db.prepare('UPDATE photos SET angle_ok=?, note=COALESCE(?,note) WHERE id=?')
      .run(angle_ok ? 1 : 0, note || null, photoId);
    if (!angle_ok) emit('photo', '照片角度不合格，需重拍', `照片 #${photoId} 被判定角度不合格`, 'job', p.job_id);
    return get('SELECT * FROM photos WHERE id=?', photoId);
  }

  // ---------- 复装核验（漏装检查） ----------
  function reassemblyCheck(jobId, items, userId) {
    requireRole(userId, ['crew', 'inspector']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    const segs = all('SELECT * FROM job_segments WHERE job_id=?', jobId);
    if (segs.some(s => SEG_STEP_RANK[s.step] < SEG_STEP_RANK.reassembled))
      fail('not_reassembled', '存在尚未完成复装的分段');
    let missing = [];
    for (const it of items) {
      const js = segs.find(s => s.id === it.job_segment_id);
      if (!js) continue;
      if (it.reinstalled !== js.filters_removed)
        missing.push({ code: js.id, expected: js.filters_removed, actual: it.reinstalled });
    }
    const passed = missing.length === 0;
    db.prepare(`INSERT INTO acceptances(job_id,reassembly_passed) VALUES(?,?)
                ON CONFLICT(job_id) DO UPDATE SET reassembly_passed=excluded.reassembly_passed`)
      .run(jobId, passed ? 1 : 0);
    db.prepare("INSERT INTO work_steps(job_id,step,operator_id,at,payload) VALUES(?,'reassemble',?,?,?)")
      .run(jobId, userId, nowIso(), JSON.stringify({ check: true, missing, passed }));
    if (!passed) emit('reassembly', '复装核验发现漏装',
      `${job.code}：${missing.length} 个分段滤网数量不符，漏装不能提交验收`, 'job', jobId);
    return { passed, missing };
  }

  // ---------- 风量/噪声复测（模拟适配器） ----------
  function runAirTest(jobId, userId, { is_retest = false } = {}) {
    requireRole(userId, ['crew', 'inspector']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (['scheduled','in_progress'].includes(job.status)) fail('bad_state', '试运行阶段才能进行风量测试');
    const segs = all(
      `SELECT js.id, hs.duct_points FROM job_segments js
       JOIN hood_segments hs ON hs.id=js.segment_id WHERE js.job_id=?`, jobId);
    const at = nowIso();
    const results = [];
    for (const s of segs) {
      for (const point of JSON.parse(s.duct_points)) {
        const reading = adapter.measure(job, point, { is_retest });
        const passed = reading.airflow >= AIRFLOW_THRESHOLD && !reading.noise_abnormal;
        db.prepare(
          `INSERT INTO air_tests(job_id,point_name,airflow,threshold,passed,is_retest,noise_db,noise_abnormal,at)
           VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(jobId, point, reading.airflow, AIRFLOW_THRESHOLD, passed ? 1 : 0,
               is_retest ? 1 : 0, reading.noise_db, reading.noise_abnormal ? 1 : 0, at);
        results.push({ point, ...reading, passed });
      }
    }
    const anyNoise = results.some(r => r.noise_abnormal);
    const allPass = results.every(r => r.passed);
    db.prepare(`INSERT INTO acceptances(job_id,air_retest_passed) VALUES(?,?)
                ON CONFLICT(job_id) DO UPDATE SET air_retest_passed=excluded.air_retest_passed`)
      .run(jobId, allPass ? 1 : 0);
    db.prepare("INSERT INTO work_steps(job_id,step,operator_id,at,payload) VALUES(?,'test_run',?,?,?)")
      .run(jobId, userId, at, JSON.stringify({ is_retest, results }));
    if (anyNoise) emit('air', '复测噪声异常', `${job.code}：测点噪声超过 ${NOISE_LIMIT}dB，需停机排查后复测`, 'job', jobId);
    else if (!allPass) emit('air', '风量复测未通过', `${job.code}：存在风量低于 ${AIRFLOW_THRESHOLD}m³/h 的测点`, 'job', jobId);
    else emit('air', is_retest ? '风量复测通过' : '风量测试通过', `${job.code}：全部测点达标`, 'job', jobId);
    return { passed: allPass, noise_abnormal: anyNoise, results };
  }

  // ---------- 现场增项（必须门店确认） ----------
  function requestAddon(jobId, { kind, description, amount }, userId) {
    requireRole(userId, ['crew', 'planner']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    const valid = ['heavy_oil','temporary_business','filter_damage','overtime','other'];
    if (!valid.includes(kind)) fail('bad_addon', '增项类型无效');
    const r = db.prepare(
      `INSERT INTO addons(job_id,kind,description,amount,requested_by,requested_at) VALUES(?,?,?,?,?,?)`)
      .run(jobId, kind, description, amount || 0, userId, nowIso());
    emit('addon', '现场增项待门店确认', `${job.code}：${description}`, 'job', jobId);
    return get('SELECT * FROM addons WHERE id=?', r.lastInsertRowid);
  }
  const confirmAddon = (addonId, userId, approved, reason) => {
    const u = userOf(userId);
    if (u.role !== 'store') fail('forbidden', '现场增项必须由门店确认');
    const a = get('SELECT * FROM addons WHERE id=?', addonId);
    if (!a) fail('no_addon', '增项不存在');
    if (a.status !== 'pending') fail('addon_decided', '增项已处理，不能重复确认');
    db.prepare('UPDATE addons SET status=?, confirmed_at=?, confirmed_by=?, reject_reason=? WHERE id=?')
      .run(approved ? 'confirmed' : 'rejected', nowIso(), userId, reason || null, addonId);
    emit('addon', approved ? '门店已确认增项' : '门店驳回增项',
      `${a.description}（${approved ? '计入结算' : '不计费'}）`, 'job', a.job_id);
    return get('SELECT * FROM addons WHERE id=?', addonId);
  };

  // ---------- 超时 ----------
  function finishTiming(jobId, userId) {
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (!job.started_at) return null;
    const plannedEnd = new Date(job.scheduled_end);
    const now = new Date();
    let overMin = Math.max(0, Math.round((now - plannedEnd) / 60000));
    // 已确认临时营业/重油污导致的延时不在此重复计；仅统计实际超时
    db.prepare('UPDATE jobs SET overtime_minutes=?, finished_at=? WHERE id=?').run(overMin, nowIso(), jobId);
    if (overMin > 0 && !get('SELECT id FROM addons WHERE job_id=? AND kind=?', jobId, 'overtime')) {
      db.prepare(`INSERT INTO addons(job_id,kind,description,amount,requested_by,requested_at)
                  VALUES(?,'overtime', ?, ?, ?, ?)`)
        .run(jobId, `施工超时 ${overMin} 分钟`, 0, userId, nowIso());
      emit('overtime', '施工超时', `${job.code} 已超出停灶窗口 ${overMin} 分钟，超时费待门店确认`, 'job', jobId);
    }
    return overMin;
  }

  // ---------- 验收（施工人员不可修改结论） ----------
  function acceptanceReadiness(jobId) {
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    const segs = all('SELECT * FROM job_segments WHERE job_id=?', jobId);
    const reasons = [];
    if (segs.some(s => s.step !== 'tested')) reasons.push('存在未完成试运行的分段');
    const acc = get('SELECT * FROM acceptances WHERE job_id=?', jobId);
    if (!acc || !acc.reassembly_passed) reasons.push('复装核验未通过（存在漏装）');
    // 风量：取每个测点最新一次结果，必须全部通过且无噪声异常
    const tests = all('SELECT * FROM air_tests WHERE job_id=? ORDER BY point_name, id', jobId);
    const latest = new Map();
    tests.forEach(t => latest.set(t.point_name, t));
    if (!latest.size) reasons.push('尚未进行风量复测');
    else {
      const bad = [...latest.values()].filter(t => !t.passed);
      if (bad.length) reasons.push('风量复测未通过');
      if ([...latest.values()].some(t => t.noise_abnormal)) reasons.push('复测噪声异常');
    }
    const photos = all('SELECT * FROM photos WHERE job_id=?', jobId);
    for (const s of segs) {
      for (const ph of ['before', 'after']) {
        const list = photos.filter(p => (p.job_segment_id === s.id) && p.phase === ph);
        const latest = list[list.length - 1];
        if (!latest) reasons.push(`分段 #${s.seq} 缺少${ph === 'before' ? '清洗前' : '清洗后'}照片`);
        else if (!latest.angle_ok) reasons.push(`分段 #${s.seq} ${ph === 'before' ? '清洗前' : '清洗后'}照片角度不合格`);
      }
    }
    if (acc && acc.photos_angle_passed === 0 && !reasons.some(r => r.includes('照片'))) { /* 保留人工标记 */ }
    return { ready: reasons.length === 0, reasons };
  }

  function decideAcceptance(jobId, conclusion, userId) {
    const u = userOf(userId);
    if (u.role !== 'inspector') fail('forbidden', '只有验收员可以出具验收结论；施工人员不能修改验收结论');
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (['completed','rejected_sign','settled'].includes(job.status)) fail('bad_state', '该单已结束验收');
    const { ready, reasons } = acceptanceReadiness(jobId);
    if (!ready && conclusion === 'pass') fail('not_ready', '不能提交合格验收：' + reasons.join('；'));
    if (!['pass','rework','rejected_sign'].includes(conclusion)) fail('bad_conclusion', '验收结论无效');
    let status = 'completed';
    if (conclusion === 'rework') status = 'rework';
    if (conclusion === 'rejected_sign') status = 'rejected_sign';
    db.prepare(
      `INSERT INTO acceptances(job_id,conclusion,inspector_id,decided_at,photos_angle_passed)
       VALUES(?,?,?,?,1)
       ON CONFLICT(job_id) DO UPDATE SET conclusion=excluded.conclusion,
         inspector_id=excluded.inspector_id, decided_at=excluded.decided_at, photos_angle_passed=1`)
      .run(jobId, conclusion, userId, nowIso());
    db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, jobId);
    finishTiming(jobId, userId);
    emit('acceptance',
      conclusion === 'pass' ? '验收合格' : conclusion === 'rework' ? '验收返工' : '门店拒签',
      `${job.code}：${conclusion}`, 'job', jobId);
    return jobDetail(jobId);
  }

  // 返工后重新进入试运行
  function reworkRedo(jobId, userId) {
    requireRole(userId, ['crew']);
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    if (job.status !== 'rework') fail('bad_state', '仅返工状态的施工单可以返工重做');
    db.prepare("UPDATE jobs SET status='testing' WHERE id=?").run(jobId);
    emit('job', '返工处理中', `${job.code} 重新整改`, 'job', jobId);
    return jobDetail(jobId);
  }

  // ---------- 门店签字 / 拒签 ----------
  function storeSign(jobId, { signature, name, note }, userId) {
    const u = userOf(userId);
    if (u.role !== 'store') fail('forbidden', '只有门店可以签字确认');
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    const acc = get('SELECT * FROM acceptances WHERE job_id=? AND conclusion IS NOT NULL', jobId);
    if (!acc) fail('no_acceptance', '验收尚未出具结论');
    if (acc.conclusion === 'rework') fail('need_rework', '返工单整改复验合格后才能签字');
    let signFile = null;
    if (signature) {
      const m = /^data:(image\/(png|jpeg|jpg|webp|svg\+xml));base64,(.*)$/s.exec(signature);
      if (!m) fail('bad_photo', '签名图片格式无效');
      const ext = m[2] === 'jpeg' ? 'jpg' : (m[2] === 'svg+xml' ? 'svg' : m[2]);
      const dir = path.join(photoDir, String(jobId));
      fs.mkdirSync(dir, { recursive: true });
      signFile = `sign-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(dir, signFile), Buffer.from(m[3], 'base64'));
    }
    db.prepare(`UPDATE acceptances SET store_signed=1, store_rejected=0, signed_by_name=?, signed_at=?, sign_file=?, sign_note=? WHERE job_id=?`)
      .run(name || u.display_name, nowIso(), signFile, note || null, jobId);
    if (job.status === 'rejected_sign') db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
    emit('sign', '门店已签字', `${name || u.display_name} 完成签字确认`, 'job', jobId);
    return jobDetail(jobId);
  }
  function storeRejectSign(jobId, { name, note }, userId) {
    const u = userOf(userId);
    if (u.role !== 'store') fail('forbidden', '只有门店可以拒签');
    const acc = get('SELECT * FROM acceptances WHERE job_id=?', jobId);
    if (!acc || !acc.conclusion) fail('no_acceptance', '验收尚未出具结论');
    // 保留验收员结论，仅标记门店拒签
    db.prepare(`UPDATE acceptances SET store_signed=0, store_rejected=1,
                  signed_by_name=?, sign_note=? WHERE job_id=?`)
      .run(name || u.display_name, `门店拒签：${note || ''}`, jobId);
    db.prepare("UPDATE jobs SET status='rejected_sign' WHERE id=?").run(jobId);
    emit('sign', '门店拒签', `${get('SELECT code FROM jobs WHERE id=?', jobId).code}：${note || '门店拒绝签字'}`, 'job', jobId);
    return jobDetail(jobId);
  }

  // ---------- 结算单（幂等快照） ----------
  function createInvoice(jobId, userId) {
    const u = userOf(userId);
    if (u.role !== 'finance') fail('forbidden', '只有财务可以生成结算单；财务不可改动工序记录');
    const job = get('SELECT * FROM jobs WHERE id=?', jobId);
    const acc = get('SELECT * FROM acceptances WHERE job_id=?', jobId);
    if (!acc || acc.conclusion !== 'pass') fail('not_passed', '只有验收合格的施工单才能结算');
    if (!acc.store_signed) fail('not_signed', '门店未签字，不能结算（拒签单需先处理争议）');

    // 幂等：同一施工单只生成一次结算快照
    const exist = get('SELECT * FROM invoices WHERE job_id=?', jobId);
    if (exist) { emit('invoice', '结算单已存在（幂等返回）', `${exist.invoice_no} 内容不变`, 'job', jobId); return JSON.parse(exist.snapshot); }

    const segs = all(
      `SELECT js.*, hs.code, hs.name FROM job_segments js
       JOIN hood_segments hs ON hs.id=js.segment_id WHERE js.job_id=? ORDER BY js.seq`, jobId);
    const addons = all("SELECT * FROM addons WHERE job_id=? AND status='confirmed'", jobId);
    // 实际清洗段数 = 完成清洗（含）以上的分段
    const cleanedSegs = segs.filter(s => SEG_STEP_RANK[s.step] >= SEG_STEP_RANK.cleaned);
    const segmentCount = cleanedSegs.length;
    const base = segmentCount * PRICE_PER_SEGMENT;
    const addonAmount = addons.reduce((n, a) => n + a.amount, 0);
    const damageDeduction = 0; // 滤网补装已以增项计费，不另扣
    const total = base + addonAmount - damageDeduction;
    const store = get('SELECT * FROM stores WHERE id=?', job.store_id);
    const snapshot = {
      invoice_no: `JS-${job.code}`,
      job_code: job.code,
      store: { id: store.id, name: store.name, address: store.address },
      team: get('SELECT name FROM teams WHERE id=?', job.team_id).name,
      generated_at: nowIso(),
      price_per_segment: PRICE_PER_SEGMENT,
      segment_count: segmentCount,
      segments: cleanedSegs.map(s => ({
        seq: s.seq, code: s.code, name: s.name,
        filters_removed: s.filters_removed, damaged_filters: s.damaged_filters, step: s.step,
      })),
      base_amount: base,
      addons: addons.map(a => ({ id: a.id, kind: a.kind, description: a.description, amount: a.amount })),
      addon_amount: addonAmount,
      damage_deduction: damageDeduction,
      total_amount: total,
    };
    db.prepare(
      `INSERT INTO invoices(job_id,invoice_no,segment_count,base_amount,addon_amount,damage_deduction,total_amount,snapshot,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(jobId, snapshot.invoice_no, segmentCount, base, addonAmount, damageDeduction, total,
           JSON.stringify(snapshot), userId, nowIso());
    db.prepare("UPDATE jobs SET status='settled' WHERE id=? AND status='completed'").run(jobId);
    emit('invoice', '结算单已生成', `${snapshot.invoice_no}：¥${(total/100).toFixed(2)}`, 'job', jobId);
    return snapshot;
  }

  return {
    listPlans, upsertPlan, listWindows, proposeWindow, setWindowStatus,
    scheduleJob, startJob, registerFilters, advanceSegment,
    addPhoto, reviewPhoto, reassemblyCheck, runAirTest,
    requestAddon, confirmAddon, finishTiming,
    acceptanceReadiness, decideAcceptance, reworkRedo,
    storeSign, storeRejectSign, createInvoice, jobDetail,
  };
}

module.exports = { createServices, DomainError, STEP_FLOW, AIRFLOW_THRESHOLD, NOISE_LIMIT, PRICE_PER_SEGMENT };
