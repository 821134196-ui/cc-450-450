'use strict';
// 业务规则层：排期互斥、步骤顺序、增项确认、验收权限、结算幂等
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run } = require('./db');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status; this.code = code;
  }
}

const STEP_ORDER = ['disassemble', 'wash', 'dry', 'reassemble', 'trial'];
const STEP_LABEL = {
  disassemble: '拆卸', wash: '清洗', dry: '干燥',
  reassemble: '复装', trial: '试运行',
};
const STATUS_AFTER_STEP = {
  disassemble: 'disassembled', wash: 'washed', dry: 'dried',
  reassemble: 'reassembled', trial: 'done',
};
// 角色
const ROLES = ['worker', 'crew_lead', 'inspector', 'finance', 'store_manager', 'admin'];
// 金额（分）
const HEAVY_GREASE_FEE = 8000;   // 重油污每段加项
const FILTER_UNIT_FEE = 1500;    // 单片滤网赔偿/更换
const ANGLE_TOLERANCE_DEG = 10;  // 统一拍摄角度容差
// 风量/噪声阈值（模拟适配器判定线）
const AIRFLOW_MIN = 9.0;         // m/s
const NOISE_MAX_DB = 72;

function overlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

function createServices(db, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  const photoDir = opts.photoDir || path.join(process.cwd(), 'data', 'photos');
  fs.mkdirSync(photoDir, { recursive: true });

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function requireUser(user) {
    if (!user || !user.id) throw new ApiError(401, 'unauthorized', '未登录');
    return user;
  }
  function requireRole(user, roles) {
    requireUser(user);
    if (user.role === 'admin') return user;
    if (!roles.includes(user.role))
      throw new ApiError(403, 'forbidden', `该操作需要角色：${roles.join('/')}`);
    return user;
  }

  function notify(type, level, message, ref) {
    const o = ref || {};
    if (o.refKey) {
      const dup = get(db, `SELECT id FROM notifications WHERE ref_key = ?`, o.refKey);
      if (dup) return null;
    }
    const r = run(db,
      `INSERT INTO notifications(type, level, message, job_id, ref_key, created_at)
       VALUES(?,?,?,?,?,?)`,
      type, level, message, o.jobId ?? null, o.refKey ?? null, now());
    return r.lastId;
  }

  // ---------- 基础档案 ----------
  function listStores() {
    return all(db, `SELECT * FROM stores ORDER BY id`);
  }
  function storeDetail(storeId) {
    const store = get(db, `SELECT * FROM stores WHERE id=?`, storeId);
    if (!store) throw new ApiError(404, 'not_found', '门店不存在');
    store.hoods = all(db, `SELECT * FROM hoods WHERE store_id=? ORDER BY id`, storeId);
    for (const h of store.hoods) {
      h.segments = all(db, `SELECT * FROM segments WHERE hood_id=? ORDER BY seq`, h.id);
      h.duct_points = all(db, `SELECT * FROM duct_points WHERE hood_id=? ORDER BY id`, h.id);
    }
    store.plans = all(db, `SELECT * FROM plans WHERE store_id=? ORDER BY next_due`, storeId);
    return store;
  }
  function listStaff() {
    return all(db,
      `SELECT s.*, c.name AS crew_name FROM staff s LEFT JOIN crews c ON c.id=s.crew_id ORDER BY s.id`);
  }
  function listPlans() {
    const plans = all(db,
      `SELECT p.*, s.name AS store_name FROM plans p JOIN stores s ON s.id=p.store_id ORDER BY p.next_due`);
    for (const p of plans) {
      const active = get(db,
        `SELECT id FROM jobs WHERE store_id=? AND status IN ('scheduled','in_progress','acceptance_review') LIMIT 1`,
        p.store_id);
      p.has_active_job = !!active;
      const due = new Date(p.next_due).getTime();
      p.days_to_due = Math.round((due - Date.now()) / 86400000);
    }
    return plans;
  }

  // ---------- 停灶窗口 ----------
  function listWindows(storeId) {
    const sql = `SELECT w.*, s.name AS store_name,
      (SELECT COUNT(*) FROM jobs j WHERE j.window_id=w.id AND j.status!='cancelled') AS job_count
      FROM windows w JOIN stores s ON s.id=w.store_id
      ${storeId ? 'WHERE w.store_id=?' : ''} ORDER BY w.start_ts DESC`;
    return storeId ? all(db, sql, storeId) : all(db, sql);
  }
  function proposeWindow(user, body) {
    requireRole(user, ['inspector', 'store_manager', 'crew_lead']);
    const { store_id, start_ts, end_ts, note } = body;
    if (!store_id || !start_ts || !end_ts)
      throw new ApiError(400, 'bad_request', '门店与起止时间必填');
    if (new Date(end_ts) <= new Date(start_ts))
      throw new ApiError(400, 'bad_window', '停灶结束时间必须晚于开始时间');
    const r = run(db,
      `INSERT INTO windows(store_id,start_ts,end_ts,status,proposed_by,note) VALUES(?,?,?,'proposed',?,?)`,
      store_id, start_ts, end_ts, user.id, note || null);
    notify('window_pending', 'warn',
      `门店 #${store_id} 新停灶窗口待确认`, { refKey: `window_pending:${r.lastId}` });
    return get(db, `SELECT * FROM windows WHERE id=?`, r.lastId);
  }
  function confirmWindow(user, windowId) {
    requireRole(user, ['store_manager', 'inspector']);
    const w = get(db, `SELECT * FROM windows WHERE id=?`, windowId);
    if (!w) throw new ApiError(404, 'not_found', '窗口不存在');
    if (w.status !== 'proposed')
      throw new ApiError(409, 'window_state', `窗口当前状态 ${w.status}，不可确认`);
    run(db,
      `UPDATE windows SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=?`,
      user.id, now(), windowId);
    notify('window_pending', 'info', `停灶窗口 #${windowId} 已获门店确认，可以排班`,
      { jobId: null, refKey: `window_confirmed:${windowId}` });
    return get(db, `SELECT * FROM windows WHERE id=?`, windowId);
  }
  function rejectWindow(user, windowId, note) {
    requireRole(user, ['store_manager', 'inspector']);
    const w = get(db, `SELECT * FROM windows WHERE id=?`, windowId);
    if (!w) throw new ApiError(404, 'not_found', '窗口不存在');
    if (w.status !== 'proposed')
      throw new ApiError(409, 'window_state', '仅待确认窗口可驳回');
    run(db, `UPDATE windows SET status='rejected', note=? WHERE id=?`,
      (w.note ? w.note + ' | ' : '') + `驳回：${note || '门店不便'}`, windowId);
    return get(db, `SELECT * FROM windows WHERE id=?`, windowId);
  }

  // ---------- 排班（门店确认窗口后才能排班；同一厨房时段互斥） ----------
  function scheduleJob(user, body) {
    requireRole(user, ['inspector']);
    const { store_id, hood_id, crew_id, window_id, sched_start, sched_end } = body;
    for (const [k, v] of Object.entries({ store_id, hood_id, crew_id, window_id, sched_start, sched_end }))
      if (v == null) throw new ApiError(400, 'bad_request', `缺少字段 ${k}`);
    if (new Date(sched_end) <= new Date(sched_start))
      throw new ApiError(400, 'bad_window', '排班结束时间必须晚于开始时间');

    const win = get(db, `SELECT * FROM windows WHERE id=?`, window_id);
    if (!win || win.store_id !== store_id)
      throw new ApiError(404, 'not_found', '停灶窗口不存在或不属于该门店');
    if (win.status !== 'confirmed')
      throw new ApiError(409, 'window_not_confirmed', '门店尚未确认停灶窗口，不能排班');
    if (new Date(sched_start) < new Date(win.start_ts) || new Date(sched_end) > new Date(win.end_ts))
      throw new ApiError(409, 'out_of_window', '排班时段必须落在门店确认的停灶窗口内');

    const hood = get(db, `SELECT * FROM hoods WHERE id=? AND store_id=?`, hood_id, store_id);
    if (!hood) throw new ApiError(404, 'not_found', '罩体不存在');
    const crew = get(db, `SELECT * FROM crews WHERE id=?`, crew_id);
    if (!crew) throw new ApiError(404, 'not_found', '班组不存在');

    // 厨房时段互斥：同一门店厨房不得有两个有效工单时段重叠
    const clash = get(db,
      `SELECT j.*, c.name AS crew_name FROM jobs j JOIN crews c ON c.id=j.crew_id
       WHERE j.store_id=? AND j.status!='cancelled'
       AND (? < j.sched_end AND j.sched_start < ?) LIMIT 1`,
      store_id, sched_start, sched_end);
    if (clash)
      throw new ApiError(409, 'kitchen_slot_busy',
        `厨房时段冲突：已被工单 ${clash.job_no}（${clash.crew_name}）占用，两个班组不能占用同一厨房时段`);

    return tx(() => {
      const jobNo = 'JOB-' + now().slice(0, 10).replace(/-/g, '') + '-' +
        String(get(db, `SELECT COUNT(*) c FROM jobs`).c + 1).padStart(3, '0');
      const jr = run(db,
        `INSERT INTO jobs(job_no,store_id,hood_id,crew_id,window_id,status,sched_start,sched_end,created_by,created_at)
         VALUES(?,?,?,?,?,'scheduled',?,?,?,?)`,
        jobNo, store_id, hood_id, crew_id, window_id, sched_start, sched_end, user.id, now());
      const jobId = jr.lastId;
      const segs = all(db, `SELECT * FROM segments WHERE hood_id=? ORDER BY seq`, hood_id);
      for (const sg of segs) {
        run(db, `INSERT INTO job_segments(job_id,segment_id,round,status) VALUES(?,?,1,'pending')`,
          jobId, sg.id);
      }
      return jobDetail(jobId);
    });
  }

  function listJobs(filter) {
    const f = filter || {};
    const where = [];
    const params = [];
    if (f.store_id) { where.push('j.store_id=?'); params.push(f.store_id); }
    if (f.crew_id) { where.push('j.crew_id=?'); params.push(f.crew_id); }
    if (f.status) { where.push('j.status=?'); params.push(f.status); }
    return all(db,
      `SELECT j.*, s.name AS store_name, s.code AS store_code, h.name AS hood_name,
              c.name AS crew_name
       FROM jobs j JOIN stores s ON s.id=j.store_id JOIN hoods h ON h.id=j.hood_id
       JOIN crews c ON c.id=j.crew_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY j.sched_start DESC`, ...params);
  }

  function jobSegments(jobId, round) {
    return all(db,
      `SELECT js.*, seg.seq, seg.name AS seg_name, seg.length_m, seg.filter_count, seg.id AS segment_id
       FROM job_segments js JOIN segments seg ON seg.id=js.segment_id
       WHERE js.job_id=? AND js.round=? ORDER BY seg.seq`, jobId, round);
  }

  function jobDetail(jobId) {
    const job = get(db,
      `SELECT j.*, s.name AS store_name, s.code AS store_code, s.segment_price,
              h.name AS hood_name, c.name AS crew_name,
              w.start_ts AS window_start, w.end_ts AS window_end
       FROM jobs j JOIN stores s ON s.id=j.store_id JOIN hoods h ON h.id=j.hood_id
       JOIN crews c ON c.id=j.crew_id LEFT JOIN windows w ON w.id=j.window_id
       WHERE j.id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    job.current_round = (get(db, `SELECT MAX(round) m FROM job_segments WHERE job_id=?`, jobId) || {}).m || 1;
    job.segments = jobSegments(jobId, job.current_round).map(js => {
      js.steps = all(db,
        `SELECT st.* FROM steps st WHERE st.job_segment_id=? AND st.round=? ORDER BY st.id`,
        js.id, job.current_round);
      js.photos = all(db,
        `SELECT id, phase, angle_deg, angle_ok, file_path, created_at FROM photos
         WHERE job_segment_id=? ORDER BY id`, js.id);
      return js;
    });
    const hood = get(db, `SELECT id FROM hoods WHERE id=?`, job.hood_id);
    job.duct_points = all(db,
      `SELECT dp.*, (SELECT velocity FROM airflow_tests a WHERE a.duct_point_id=dp.id AND a.job_id=j.id
        ORDER BY a.attempt DESC LIMIT 1) AS last_velocity,
       (SELECT noise_db FROM airflow_tests a WHERE a.duct_point_id=dp.id AND a.job_id=j.id
        ORDER BY a.attempt DESC LIMIT 1) AS last_noise,
       (SELECT passed FROM airflow_tests a WHERE a.duct_point_id=dp.id AND a.job_id=j.id
        ORDER BY a.attempt DESC LIMIT 1) AS last_passed,
       (SELECT noise_ok FROM airflow_tests a WHERE a.duct_point_id=dp.id AND a.job_id=j.id
        ORDER BY a.attempt DESC LIMIT 1) AS last_noise_ok,
       (SELECT MAX(attempt) FROM airflow_tests a WHERE a.duct_point_id=dp.id AND a.job_id=j.id) AS attempts
       FROM duct_points dp, jobs j WHERE j.id=? AND dp.hood_id=?`, jobId, hood.id);
    job.addons = all(db, `SELECT * FROM addons WHERE job_id=? ORDER BY id`, jobId);
    job.exceptions = all(db, `SELECT * FROM exceptions WHERE job_id=? ORDER BY id`, jobId);
    const acc = get(db, `SELECT * FROM acceptances WHERE job_id=? ORDER BY id DESC LIMIT 1`, jobId);
    job.acceptance = acc;
    job.settlement = get(db, `SELECT * FROM settlements WHERE job_id=?`, jobId);
    return job;
  }

  // ---------- 施工执行 ----------
  function startJob(user, jobId) {
    requireRole(user, ['worker', 'crew_lead']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (job.status !== 'scheduled')
      throw new ApiError(409, 'job_state', `工单状态 ${job.status}，不可开工`);
    if (job.on_hold) throw new ApiError(409, 'on_hold', '工单因临时营业挂起中');
    run(db, `UPDATE jobs SET status='in_progress', started_at=? WHERE id=?`, now(), jobId);
    return jobDetail(jobId);
  }

  function setTempOpen(user, jobId, detail) { // 临时营业：挂起
    requireRole(user, ['store_manager', 'crew_lead', 'inspector']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (job.status === 'accepted' || job.status === 'settled' || job.status === 'cancelled')
      throw new ApiError(409, 'job_state', '该状态工单不可挂起');
    tx(() => {
      run(db, `UPDATE jobs SET on_hold=1 WHERE id=?`, jobId);
      run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
               VALUES(?,?,?, 'open', ?,?)`,
        jobId, 'temp_open', detail || '门店临时营业，停工待命', user.id, now());
      notify('exception', 'warn', `工单 ${job.job_no} 因门店临时营业挂起`,
        { jobId, refKey: `temp_open:${jobId}` });
    });
    return jobDetail(jobId);
  }
  function resumeJob(user, jobId) {
    requireRole(user, ['store_manager', 'crew_lead', 'inspector']);
    tx(() => {
      run(db, `UPDATE jobs SET on_hold=0 WHERE id=?`, jobId);
      run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?,
               resolution='门店恢复停灶，复工'
             WHERE job_id=? AND type='temp_open' AND status='open'`,
        user.id, now(), jobId);
    });
    return jobDetail(jobId);
  }

  function _resolveAddonExceptions(db, jobId, type, resolution, by) {
    run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?, resolution=?
             WHERE job_id=? AND type=? AND status='open'`,
      by, now(), resolution, jobId, type);
  }

  function createAddon(user, jobId, body) { // 现场增项（默认待门店确认）
    requireRole(user, ['worker', 'crew_lead', 'inspector']);
    const { type, description, qty, amount } = body;
    if (!['heavy_grease', 'filter_replace', 'temp_open', 'other'].includes(type))
      throw new ApiError(400, 'bad_request', '增项类型非法');
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    const r = run(db,
      `INSERT INTO addons(job_id,type,description,qty,amount,status,created_by)
       VALUES(?,?,?,?,?,'pending',?)`,
      jobId, type, description || null, qty || 1, amount || 0, user.id);
    notify('exception', 'warn', `工单 ${job.job_no} 出现现场增项待门店确认：${type}`,
      { jobId, refKey: `addon_pending:${r.lastId}` });
    return get(db, `SELECT * FROM addons WHERE id=?`, r.lastId);
  }
  function confirmAddon(user, addonId, approve) { // 必须门店确认
    requireRole(user, ['store_manager']);
    const a = get(db, `SELECT * FROM addons WHERE id=?`, addonId);
    if (!a) throw new ApiError(404, 'not_found', '增项不存在');
    if (a.status !== 'pending')
      throw new ApiError(409, 'addon_state', '增项已处理，不能重复确认');
    tx(() => {
      run(db, `UPDATE addons SET status=?, confirmed_by=?, confirmed_at=? WHERE id=?`,
        approve ? 'confirmed' : 'rejected', user.id, now(), addonId);
      const map = { heavy_grease: 'heavy_grease', filter_replace: 'filter_damage' };
      if (map[a.type])
        _resolveAddonExceptions(db, a.job_id, map[a.type],
          approve ? '门店已确认加项' : '门店拒绝该项，施工方自行承担', user.id);
    });
    return get(db, `SELECT * FROM addons WHERE id=?`, addonId);
  }

  function resolveException(user, exId, resolution) {
    requireRole(user, ['store_manager', 'inspector']);
    const ex = get(db, `SELECT * FROM exceptions WHERE id=?`, exId);
    if (!ex) throw new ApiError(404, 'not_found', '异常不存在');
    if (ex.status === 'resolved') throw new ApiError(409, 'already_resolved', '异常已闭环');
    run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?, resolution=?
             WHERE id=?`, user.id, now(), resolution || '现场已处理', exId);
    return get(db, `SELECT * FROM exceptions WHERE id=?`, exId);
  }

  function recordStep(user, jobId, jsId, step, body) {
    requireRole(user, ['worker', 'crew_lead']);
    body = body || {};
    if (!STEP_ORDER.includes(step))
      throw new ApiError(400, 'bad_step', `未知工序 ${step}`);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (job.status !== 'in_progress')
      throw new ApiError(409, 'job_state', '只有施工中的工单可以登记工序');
    if (job.on_hold) throw new ApiError(409, 'on_hold', '临时营业挂起中，需先复工');

    const js = get(db, `SELECT * FROM job_segments WHERE id=? AND job_id=?`, jsId, jobId);
    if (!js) throw new ApiError(404, 'not_found', '分段施工单不存在');
    const seg = get(db, `SELECT * FROM segments WHERE id=?`, js.segment_id);

    // 步骤顺序：必须按 拆卸→清洗→干燥→复装→试运行 推进
    const idx = STEP_ORDER.indexOf(step);
    const dup = get(db, `SELECT id FROM steps WHERE job_segment_id=? AND round=? AND step=?`,
      js.id, js.round, step);
    if (dup) throw new ApiError(409, 'step_exists', `${STEP_LABEL[step]}已完成，工序记录不可修改`);
    if (idx === 0) {
      if (js.status !== 'pending')
        throw new ApiError(409, 'step_order', '该段已拆卸');
    } else {
      const need = STATUS_AFTER_STEP[STEP_ORDER[idx - 1]];
      if (js.status !== need)
        throw new ApiError(409, 'step_order',
          `工序顺序错误：必须先完成「${STEP_LABEL[STEP_ORDER[idx - 1]]}」才能进行「${STEP_LABEL[step]}」`);
    }

    return tx(() => {
      if (step === 'disassemble') {
        // 开工逐段拆卸并登记滤网数量 + 油污等级
        const removed = Number(body.filters_removed);
        const grease = Number(body.grease_level);
        if (!Number.isInteger(removed) || removed < 0)
          throw new ApiError(400, 'bad_request', '拆卸时必须登记滤网拆卸数量');
        if (!(grease >= 1 && grease <= 5))
          throw new ApiError(400, 'bad_request', '油污等级必须为 1-5 级');
        const damaged = Math.max(0, Number(body.filters_damaged) || 0);
        if (damaged > removed)
          throw new ApiError(400, 'bad_request', '损坏滤网数不能大于拆卸数');
        run(db, `UPDATE job_segments SET grease_level=?, filters_removed=?, filters_damaged=?
                 WHERE id=?`, grease, removed, damaged, js.id);
        if (grease >= 4) {
          run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
                   VALUES(?, 'heavy_grease', ?, 'open', ?, ?)`,
            jobId, `罩体分段 ${seg.name} 油污 ${grease} 级，属重油污`, user.id, now());
          run(db, `INSERT INTO addons(job_id,type,description,qty,amount,status,created_by)
                   VALUES(?, 'heavy_grease', ?, 1, ?, 'pending', ?)`,
            jobId, `重油污加强清洗（${seg.name}）`, HEAVY_GREASE_FEE, user.id);
          notify('exception', 'warn', `分段 ${seg.name} 检出重油污，加项待门店确认`,
            { jobId, refKey: `addon_heavy:${jobId}:${js.id}` });
        }
        if (damaged > 0) {
          run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
                   VALUES(?, 'filter_damage', ?, 'open', ?, ?)`,
            jobId, `分段 ${seg.name} 拆卸发现 ${damaged} 片滤网损坏`, user.id, now());
          run(db, `INSERT INTO addons(job_id,type,description,qty,amount,status,created_by)
                   VALUES(?, 'filter_replace', ?, ?, ?, 'pending', ?)`,
            jobId, `损坏滤网更换（${seg.name}）`, damaged, damaged * FILTER_UNIT_FEE, user.id);
        }
      }
      if (step === 'reassemble') {
        const reinstalled = Number(body.filters_reinstalled);
        if (!Number.isInteger(reinstalled) || reinstalled < 0)
          throw new ApiError(400, 'bad_request', '复装必须登记滤网复装数量');
        run(db, `UPDATE job_segments SET filters_reinstalled=? WHERE id=?`, reinstalled, js.id);
        if (reinstalled < seg.filter_count)
          notify('exception', 'critical',
            `分段 ${seg.name} 疑似漏装滤网（应装 ${seg.filter_count}，复装 ${reinstalled}）`,
            { jobId, refKey: `missing_filter:${jobId}:${js.id}` });
      }
      run(db, `INSERT INTO steps(job_segment_id,round,step,operator_id,started_at,completed_at,note)
               VALUES(?,?,?,?,?,?,?)`,
        js.id, js.round, step, user.id, now(), now(), body.note || null);
      run(db, `UPDATE job_segments SET status=? WHERE id=?`, STATUS_AFTER_STEP[step], js.id);
      return jobDetail(jobId);
    });
  }

  // ---------- 照片（本地目录存储 + 统一角度参考线校验） ----------
  function savePhoto(user, jobId, jsId, phase, payload) {
    requireRole(user, ['worker', 'crew_lead']);
    if (!['before', 'after'].includes(phase))
      throw new ApiError(400, 'bad_request', '照片阶段只能是 before/after');
    const js = get(db, `SELECT js.* FROM job_segments js WHERE js.id=? AND js.job_id=?`, jsId, jobId);
    if (!js) throw new ApiError(404, 'not_found', '分段不存在');
    const angle = Number.isFinite(Number(payload.angle_deg)) ? Number(payload.angle_deg) : 0;
    let d = Math.abs(angle % 360); if (d > 180) d = 360 - d;
    const angleOk = d <= ANGLE_TOLERANCE_DEG;

    const m = /^data:image\/([\w.+-]+);base64,(.+)$/.exec(payload.data_url || '');
    if (!m) throw new ApiError(400, 'bad_request', '照片需为 data URL（image/* base64）');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0) throw new ApiError(400, 'bad_request', '照片内容为空');
    const fname = `job${jobId}_seg${jsId}_${phase}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(photoDir, fname), buf);

    return tx(() => {
      const r = run(db,
        `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        jobId, jsId, phase, angle, angleOk ? 1 : 0, `photos/${fname}`, user.id, now());
      if (!angleOk) {
        run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
                 VALUES(?, 'photo_angle', ?, 'open', ?, ?)`,
          jobId, `分段 #${jsId} ${phase === 'before' ? '清洗前' : '清洗后'}照片角度偏差 ${d.toFixed(0)}°，超出参考线容差 ±${ANGLE_TOLERANCE_DEG}°`,
          user.id, now());
        notify('exception', 'warn', `照片角度不合格，需按统一参考线重拍`,
          { jobId, refKey: `photo_angle:${jobId}:${jsId}:${phase}` });
      } else if (phase === 'after') {
        // 合格的清洗后照片补上：角度异常自动闭环
        run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?,
                 resolution='已按统一参考线重新拍摄并上传'
               WHERE job_id=? AND type='photo_angle' AND status='open'`,
          user.id, now(), jobId);
      }
      return get(db, `SELECT * FROM photos WHERE id=?`, r.lastId);
    });
  }

  // ---------- 风量模拟适配器 ----------
  function measureAirflow(user, jobId, pointId, adapter) {
    requireRole(user, ['worker', 'crew_lead', 'inspector']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    const point = get(db, `SELECT dp.* FROM duct_points dp JOIN hoods h ON h.id=dp.hood_id
                           JOIN jobs j ON j.hood_id=h.id WHERE dp.id=? AND j.id=?`, pointId, jobId);
    if (!point) throw new ApiError(404, 'not_found', '风管点位不属于该工单');
    const attempt = (get(db, `SELECT COALESCE(MAX(attempt),0) m FROM airflow_tests
                              WHERE job_id=? AND duct_point_id=?`, jobId, pointId).m) + 1;
    const reading = adapter.measure({ profile: point.profile, attempt, jobId, pointId });
    const passed = reading.velocity >= AIRFLOW_MIN;
    const noiseOk = reading.noise_db <= NOISE_MAX_DB;
    return tx(() => {
      run(db, `INSERT INTO airflow_tests(job_id,duct_point_id,attempt,velocity,noise_db,passed,noise_ok,measured_by,created_at)
               VALUES(?,?,?,?,?,?,?,?,?)`,
        jobId, pointId, attempt, reading.velocity, reading.noise_db,
        passed ? 1 : 0, noiseOk ? 1 : 0, user.id, now());
      if (!noiseOk) {
        run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
                 VALUES(?, 'noise_abnormal', ?, 'open', ?, ?)`,
          jobId, `点位 ${point.name} 第 ${attempt} 次复测噪声 ${reading.noise_db}dB 异常（限值 ${NOISE_MAX_DB}dB）`,
          user.id, now());
        notify('exception', 'critical', `复测噪声异常：${point.name} ${reading.noise_db}dB`,
          { jobId, refKey: `noise:${jobId}:${pointId}:${attempt}` });
      } else if (!passed) {
        notify('exception', 'warn',
          `风量复测未通过：${point.name} ${reading.velocity.toFixed(1)}m/s（≥${AIRFLOW_MIN}）`,
          { jobId, refKey: `airflow:${jobId}:${pointId}:${attempt}` });
      } else {
        run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?,
                 resolution='复测风量与噪声恢复正常'
               WHERE job_id=? AND type='noise_abnormal' AND status='open'`,
          user.id, now(), jobId);
      }
      return { attempt, ...reading, passed, noise_ok: noiseOk,
               thresholds: { velocity_min: AIRFLOW_MIN, noise_max_db: NOISE_MAX_DB } };
    });
  }

  // ---------- 验收 ----------
  function acceptanceGate(job) {
    const problems = [];
    const round = (get(db, `SELECT MAX(round) m FROM job_segments WHERE job_id=?`, job.id) || {}).m || 1;
    const segs = jobSegments(job.id, round);
    for (const js of segs) {
      const seg = get(db, `SELECT * FROM segments WHERE id=?`, js.segment_id);
      const prefix = `分段 ${js.seq}-${js.seg_name}`;
      // 工序必须按顺序全部完成（状态机保证顺序，这里兜底）
      const doneSteps = new Set(all(db, `SELECT step FROM steps WHERE job_segment_id=? AND round=?`,
        js.id, round).map(r => r.step));
      for (const s of STEP_ORDER) if (!doneSteps.has(s)) problems.push(`${prefix}：缺少工序「${STEP_LABEL[s]}」`);
      if (js.status !== 'done') problems.push(`${prefix}：施工未完成`);
      // 漏装检查（复装登记后才判定；未开工分段由上方工序检查覆盖）
      if (js.filters_reinstalled != null && js.filters_reinstalled < seg.filter_count)
        problems.push(`${prefix}：滤网漏装（应装 ${seg.filter_count}，实装 ${js.filters_reinstalled}）`);
      // 前后照片 + 角度
      const before = get(db, `SELECT COUNT(*) c FROM photos WHERE job_segment_id=? AND phase='before'`, js.id).c;
      const afterOk = get(db, `SELECT COUNT(*) c FROM photos WHERE job_segment_id=? AND phase='after' AND angle_ok=1`, js.id).c;
      if (!before) problems.push(`${prefix}：缺少清洗前照片`);
      if (!afterOk) problems.push(`${prefix}：缺少角度合格的清洗后照片`);
    }
    // 风量复测：每个风管点位最近一次必须通过且噪声正常
    const points = all(db, `SELECT dp.* FROM duct_points dp JOIN hoods h ON h.id=dp.hood_id
                            WHERE h.id=?`, job.hood_id);
    for (const p of points) {
      const last = get(db, `SELECT * FROM airflow_tests WHERE job_id=? AND duct_point_id=?
                            ORDER BY attempt DESC LIMIT 1`, job.id, p.id);
      if (!last) problems.push(`点位 ${p.name}：尚未进行风量复测`);
      else if (!last.passed) problems.push(`点位 ${p.name}：最近一次风量 ${last.velocity}m/s 复测未通过`);
      else if (!last.noise_ok) problems.push(`点位 ${p.name}：最近一次噪声 ${last.noise_db}dB 异常`);
    }
    // 未闭环异常（临时营业/重油污/滤网损坏/角度/超时/噪声/拒签）
    const open = all(db, `SELECT type, detail FROM exceptions WHERE job_id=? AND status='open'`, job.id);
    const label = { temp_open: '临时营业挂起未复工', heavy_grease: '重油污加项未确认', filter_damage: '滤网损坏加项未确认',
      photo_angle: '照片角度不合格未重拍', overtime: '施工超时未闭环', noise_abnormal: '复测噪声异常未消除', refuse_sign: '门店拒签未处理' };
    for (const e of open) problems.push(`${label[e.type] || e.type}：${e.detail || ''}`);
    return { round, segments: segs, problems };
  }

  function submitAcceptance(user, jobId, conclusion) {
    requireRole(user, ['inspector']); // 施工人员不能提交/修改验收结论
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (job.status !== 'in_progress')
      throw new ApiError(409, 'job_state', '仅施工中工单可提交验收');
    const gate = acceptanceGate(job);
    if (gate.problems.length)
      throw new ApiError(409, 'acceptance_gate', '验收不通过：\n' + gate.problems.join('；\n'));
    return tx(() => {
      const r = run(db,
        `INSERT INTO acceptances(job_id,round,result,conclusion,inspector_id,created_at,sign_status)
         VALUES(?,?, 'passed', ?, ?, ?, 'pending')`,
        jobId, gate.round, conclusion || '复装齐全、风量复测达标，同意验收', user.id, now());
      run(db, `UPDATE jobs SET status='acceptance_review', finished_at=? WHERE id=?`, now(), jobId);
      notify('acceptance', 'info', `工单 ${job.job_no} 验收通过，待门店签字`,
        { jobId, refKey: `accept_pending:${jobId}` });
      return get(db, `SELECT * FROM acceptances WHERE id=?`, r.lastId);
    });
  }

  // 验收员判定返工：开启新一轮分段施工
  function requestRework(user, jobId, reason) {
    requireRole(user, ['inspector']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (!['in_progress', 'acceptance_review'].includes(job.status))
      throw new ApiError(409, 'job_state', '当前状态不可返工');
    return tx(() => {
      const prevRound = (get(db, `SELECT MAX(round) m FROM job_segments WHERE job_id=?`, jobId).m) || 1;
      run(db,
        `INSERT INTO acceptances(job_id,round,result,conclusion,inspector_id,created_at,sign_status)
         VALUES(?, ?, 'rework', ?, ?, ?, 'na')`,
        jobId, prevRound, reason || '验收发现问题，需返工', user.id, now());
      const next = prevRound + 1;
      const segs = all(db, `SELECT segment_id FROM job_segments WHERE job_id=? AND round=?`, jobId, prevRound);
      for (const s of segs)
        run(db, `INSERT INTO job_segments(job_id,segment_id,round,status) VALUES(?,?,?,'pending')`,
          jobId, s.segment_id, next);
      run(db, `UPDATE jobs SET status='in_progress' WHERE id=?`, jobId);
      notify('acceptance', 'critical', `工单 ${job.job_no} 被判定返工（第 ${next} 轮）`,
        { jobId, refKey: `rework:${jobId}:${next}` });
      return jobDetail(jobId);
    });
  }

  function signAcceptance(user, jobId, signImage) {
    requireRole(user, ['store_manager']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (job.status !== 'acceptance_review')
      throw new ApiError(409, 'job_state', '工单不在待签字状态');
    const acc = get(db, `SELECT * FROM acceptances WHERE job_id=? AND result='passed'
                          ORDER BY id DESC LIMIT 1`, jobId);
    if (!acc) throw new ApiError(409, 'no_acceptance', '没有可签字的验收结论');
    if (acc.sign_status === 'signed') throw new ApiError(409, 'already_signed', '已签字，不能重复签署');
    let signPath = null;
    if (signImage) {
      const buf = Buffer.from(signImage.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const fname = `sign_job${jobId}_${Date.now()}.png`;
      fs.writeFileSync(path.join(photoDir, fname), buf);
      signPath = `photos/${fname}`;
    }
    return tx(() => {
      run(db, `UPDATE acceptances SET sign_status='signed', signed_by=?, signed_at=?, sign_image=?
               WHERE id=?`, user.id, now(), signPath, acc.id);
      run(db, `UPDATE jobs SET status='accepted' WHERE id=?`, jobId);
      run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?,
               resolution='门店已签字接受' WHERE job_id=? AND type='refuse_sign' AND status='open'`,
        user.id, now(), jobId);
      notify('acceptance', 'info', `工单 ${job.job_no} 门店已签字，可以发起结算`,
        { jobId, refKey: `signed:${jobId}` });
      return jobDetail(jobId);
    });
  }

  function refuseSign(user, jobId, reason) { // 门店拒签
    requireRole(user, ['store_manager']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    if (job.status !== 'acceptance_review')
      throw new ApiError(409, 'job_state', '仅待签字验收单可拒签');
    if (!reason || !reason.trim()) throw new ApiError(400, 'bad_request', '拒签必须填写原因');
    return tx(() => {
      run(db, `UPDATE acceptances SET sign_status='refused', signed_by=?, signed_at=?, refuse_reason=?
               WHERE id=(SELECT id FROM acceptances WHERE job_id=? AND result='passed' ORDER BY id DESC LIMIT 1)`,
        user.id, now(), reason, jobId);
      run(db, `UPDATE jobs SET status='refused' WHERE id=?`, jobId);
      run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
               VALUES(?, 'refuse_sign', ?, 'open', ?, ?)`,
        jobId, `门店拒签：${reason}`, user.id, now());
      notify('acceptance', 'critical', `工单 ${job.job_no} 门店拒签：${reason}`,
        { jobId, refKey: `refuse:${jobId}` });
      return jobDetail(jobId);
    });
  }
  // 拒签处理：协商后重新进入签字
  function resolveRefusal(user, jobId, resolution) {
    requireRole(user, ['store_manager', 'inspector']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job || job.status !== 'refused') throw new ApiError(409, 'job_state', '工单未处于拒签状态');
    tx(() => {
      run(db, `UPDATE jobs SET status='acceptance_review' WHERE id=?`, jobId);
      run(db, `UPDATE acceptances SET sign_status='pending', refuse_reason=NULL
               WHERE id=(SELECT id FROM acceptances WHERE job_id=? AND result='passed' ORDER BY id DESC LIMIT 1)`,
        jobId);
      run(db, `UPDATE exceptions SET status='resolved', resolved_by=?, resolved_at=?, resolution=?
               WHERE job_id=? AND type='refuse_sign' AND status='open'`,
        user.id, now(), resolution || '拒签争议已协商解决，重新签字', jobId);
    });
    return jobDetail(jobId);
  }

  // ---------- 结算快照（幂等） ----------
  function buildSnapshot(jobId) {
    const job = get(db,
      `SELECT j.*, s.name AS store_name, s.code AS store_code, s.segment_price, s.address,
              c.name AS crew_name FROM jobs j JOIN stores s ON s.id=j.store_id
       JOIN crews c ON c.id=j.crew_id WHERE j.id=?`, jobId);
    const round = (get(db, `SELECT MAX(round) m FROM job_segments WHERE job_id=?`, jobId) || {}).m || 1;
    // 实际清洗段数：完成过清洗工序的分段
    const washed = all(db,
      `SELECT js.id, seg.seq, seg.name, js.grease_level, st.completed_at AS washed_at
       FROM job_segments js JOIN segments seg ON seg.id=js.segment_id
       JOIN steps st ON st.job_segment_id=js.id AND st.round=js.round AND st.step='wash'
       WHERE js.job_id=? ORDER BY seg.seq`, jobId);
    const addons = all(db, `SELECT * FROM addons WHERE job_id=? ORDER BY id`, jobId);
    const confirmed = addons.filter(a => a.status === 'confirmed');
    const baseAmount = washed.length * job.segment_price;
    const addonAmount = confirmed.reduce((s, a) => s + a.amount, 0);
    return {
      version: 1,
      generated_at: now(),
      job: { id: job.id, job_no: job.job_no, final_round: round },
      store: { id: job.store_id, code: job.store_code, name: job.store_name, address: job.address },
      crew: job.crew_name,
      pricing: { segment_price: job.segment_price, currency: 'CNY', unit: 'cent' },
      actual_washed_segments: washed.length,
      segments: washed,
      base_amount: baseAmount,
      addons_confirmed: confirmed,
      addons_excluded: addons.filter(a => a.status !== 'confirmed')
        .map(a => ({ id: a.id, type: a.type, amount: a.amount, status: a.status })),
      addon_amount: addonAmount,
      total_amount: baseAmount + addonAmount,
    };
  }

  function createSettlement(user, jobId) {
    requireRole(user, ['finance']);
    const job = get(db, `SELECT * FROM jobs WHERE id=?`, jobId);
    if (!job) throw new ApiError(404, 'not_found', '工单不存在');
    // 幂等：同一工单只有一份快照，重复请求直接返回既有快照
    const existing = get(db, `SELECT * FROM settlements WHERE job_id=?`, jobId);
    if (existing) {
      return { ...existing, snapshot_json: JSON.parse(existing.snapshot_json), idempotent_reused: true };
    }
    if (job.status !== 'accepted')
      throw new ApiError(409, 'not_accepted', `工单状态 ${job.status}，门店签字接受后才能形成结算快照`);
    const snap = buildSnapshot(jobId);
    return tx(() => {
      const r = run(db,
        `INSERT INTO settlements(job_id,snapshot_json,total_amount,status,created_by,created_at)
         VALUES(?,?,?, 'pending_review', ?, ?)`,
        jobId, JSON.stringify(snap), snap.total_amount, user.id, now());
      run(db, `UPDATE jobs SET status='settled' WHERE id=?`, jobId);
      notify('settlement', 'info',
        `工单 ${job.job_no} 结算快照已生成：实际清洗 ${snap.actual_washed_segments} 段，合计 ${(snap.total_amount / 100).toFixed(2)} 元`,
        { jobId, refKey: `settle:${jobId}` });
      const row = get(db, `SELECT * FROM settlements WHERE id=?`, r.lastId);
      return { ...row, snapshot_json: snap, idempotent_reused: false };
    });
  }
  function reviewSettlement(user, settlementId) {
    requireRole(user, ['finance']);
    const st = get(db, `SELECT * FROM settlements WHERE id=?`, settlementId);
    if (!st) throw new ApiError(404, 'not_found', '结算单不存在');
    if (st.status === 'reviewed') throw new ApiError(409, 'already_reviewed', '已复核，请勿重复操作');
    run(db, `UPDATE settlements SET status='reviewed', reviewed_by=?, reviewed_at=? WHERE id=?`,
      user.id, now(), settlementId);
    const row = get(db, `SELECT * FROM settlements WHERE id=?`, settlementId);
    return { ...row, snapshot_json: JSON.parse(row.snapshot_json) };
  }
  function listSettlements() {
    return all(db, `SELECT st.*, j.job_no, s.name AS store_name FROM settlements st
                    JOIN jobs j ON j.id=st.job_id JOIN stores s ON s.id=j.store_id ORDER BY st.id`);
  }

  // ---------- 通知 ----------
  function listNotifications() {
    return all(db, `SELECT * FROM notifications ORDER BY id DESC LIMIT 100`);
  }
  function markRead(id) {
    run(db, `UPDATE notifications SET is_read=1 WHERE id=?`, id);
  }

  return {
    ApiError, constants: { STEP_ORDER, STEP_LABEL, ANGLE_TOLERANCE_DEG, AIRFLOW_MIN, NOISE_MAX_DB, HEAVY_GREASE_FEE, FILTER_UNIT_FEE },
    notify,
    listStores, storeDetail, listStaff, listPlans,
    listWindows, proposeWindow, confirmWindow, rejectWindow,
    scheduleJob, listJobs, jobDetail,
    startJob, setTempOpen, resumeJob,
    recordStep, savePhoto, measureAirflow,
    createAddon, confirmAddon, resolveException,
    acceptanceGate, submitAcceptance, requestRework,
    signAcceptance, refuseSign, resolveRefusal,
    createSettlement, reviewSettlement, listSettlements, buildSnapshot,
    listNotifications, markRead,
  };
}

module.exports = { createServices, ApiError, STEP_ORDER, STEP_LABEL, ROLES, overlap };
