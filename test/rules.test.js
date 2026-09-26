'use strict';
// 核心规则测试：排期互斥、步骤顺序、增项确认、验收权限、结算幂等
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, get, run } = require('../src/db');
const { createServices, ApiError } = require('../src/services');
const { createAirflowAdapter } = require('../src/airflow');

// ---------- 测试夹具 ----------
let db, svc, adapter, U;
const T0 = new Date('2026-09-26T02:00:00.000Z');
const iso = h => new Date(T0.getTime() + h * 3600000).toISOString();

function expectErr(fn, code) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ApiError, `期望 ApiError，实际 ${e}`);
    assert.equal(e.code, code, `期望错误码 ${code}，实际 ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`期望抛出 ${code}，但成功执行`);
}

before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
  db = openDb(':memory:');
  svc = createServices(db, { now: () => T0.toISOString(), photoDir: tmp });
  adapter = createAirflowAdapter();

  run(db, `INSERT INTO crews(id,name) VALUES(1,'甲班'),(2,'乙班')`);
  run(db, `INSERT INTO stores(id,code,name,segment_price) VALUES(1,'T001','测试门店',20000)`);
  run(db, `INSERT INTO stores(id,code,name,segment_price) VALUES(2,'T002','隔壁门店',20000)`);
  const staff = [
    [1, '调度', 'inspector', null], [2, '班长甲', 'crew_lead', 1], [3, '工人甲', 'worker', 1],
    [4, '财务', 'finance', null], [5, '店长', 'store_manager', null], [6, '班长乙', 'crew_lead', 2],
  ];
  for (const [id, name, role, crew] of staff)
    run(db, `INSERT INTO staff(id,name,role,crew_id,store_id) VALUES(?,?,?,?,?)`,
      id, name, role, crew, role === 'store_manager' ? 1 : null);
  U = Object.fromEntries(staff.map(s => [s[1], { id: s[0], name: s[1], role: s[2], crew_id: s[3] }]));

  run(db, `INSERT INTO hoods(id,store_id,name) VALUES(1,1,'主罩'),(2,2,'副罩')`);
  for (let i = 1; i <= 3; i++)
    run(db, `INSERT INTO segments(hood_id,seq,name,filter_count) VALUES(1,?,?,2)`, '段' + i, i);
  run(db, `INSERT INTO segments(hood_id,seq,name,filter_count) VALUES(2,1,'段1',2)`);
  run(db, `INSERT INTO duct_points(id,hood_id,name,profile) VALUES(1,1,'P1','normal')`);
});

function confirmedWindow(storeId, s, e) {
  const w = svc.proposeWindow(U['调度'], { store_id: storeId, start_ts: s, end_ts: e });
  return svc.confirmWindow(U['店长'], w.id);
}
function makeJob(winId, hoodId, crewId, s, e) {
  return svc.scheduleJob(U['调度'], {
    store_id: hoodId === 1 ? 1 : 2, hood_id: hoodId, crew_id: crewId,
    window_id: winId, sched_start: s, sched_end: e,
  });
}
// 把工单推进到可验收状态
function driveToAcceptable(job, ductPointId) {
  svc.startJob(U['班长甲'], job.id);
  for (const js of svc.jobDetail(job.id).segments) {
    svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble', { filters_removed: 2, grease_level: 2 });
    svc.recordStep(U['工人甲'], job.id, js.id, 'wash', {});
    svc.recordStep(U['工人甲'], job.id, js.id, 'dry', {});
    svc.recordStep(U['工人甲'], job.id, js.id, 'reassemble', { filters_reinstalled: 2 });
    svc.recordStep(U['工人甲'], job.id, js.id, 'trial', {});
    for (const phase of ['before', 'after']) {
      svc.savePhoto(U['工人甲'], job.id, js.id, phase, {
        angle_deg: 0, data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
      });
    }
  }
  svc.measureAirflow(U['调度'], job.id, ductPointId, adapter);
}

// ---------- 1. 排期互斥 ----------
test('排期互斥：未确认窗口不能排班；同一厨房时段两个班组互斥；跨门店不冲突', () => {
  const w = svc.proposeWindow(U['调度'], { store_id: 1, start_ts: iso(100), end_ts: iso(104) });
  // 未确认 → 拒绝
  expectErr(() => makeJob(w.id, 1, 1, iso(100), iso(103)), 'window_not_confirmed');
  svc.confirmWindow(U['店长'], w.id);
  // 确认后甲班排班成功
  const j1 = makeJob(w.id, 1, 1, iso(100), iso(103));
  assert.equal(j1.status, 'scheduled');
  assert.equal(j1.segments.length, 3);
  // 乙班同时段 → 冲突
  expectErr(() => makeJob(w.id, 1, 2, iso(101), iso(103)), 'kitchen_slot_busy');
  // 部分重叠也算冲突（窗内 102~104 与甲班 100~103 重叠）
  expectErr(() => makeJob(w.id, 1, 2, iso(102), iso(104)), 'kitchen_slot_busy');
  // 超出窗口范围 → 拒绝
  expectErr(() => makeJob(w.id, 1, 2, iso(99), iso(101)), 'out_of_window');
  // 另一门店同时段 → 允许（不同厨房）
  const w2 = confirmedWindow(2, iso(100), iso(104));
  const j2 = makeJob(w2.id, 2, 2, iso(100), iso(103));
  assert.equal(j2.store_id, 2);
});

// ---------- 2. 步骤顺序 ----------
test('步骤顺序：拆卸→清洗→干燥→复装→试运行 不可跳跃、不可重复', () => {
  const w = confirmedWindow(1, iso(110), iso(114));
  const job = makeJob(w.id, 1, 1, iso(110), iso(113));
  const js = svc.jobDetail(job.id).segments[0];

  // 未开工不能登记
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble',
    { filters_removed: 2, grease_level: 2 }), 'job_state');
  svc.startJob(U['班长甲'], job.id);
  // 跳步：直接清洗 → 拒绝
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'wash', {}), 'step_order');
  // 拆卸必须登记滤网数与油污等级
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble', {}), 'bad_request');
  svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble', { filters_removed: 2, grease_level: 3 });
  // 重复工序 → 拒绝（工序记录不可改）
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble',
    { filters_removed: 2, grease_level: 3 }), 'step_exists');
  // 跳级：干燥前必须先清洗
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'dry', {}), 'step_order');
  svc.recordStep(U['工人甲'], job.id, js.id, 'wash', {});
  svc.recordStep(U['工人甲'], job.id, js.id, 'dry', {});
  // 试运行前必须先复装
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'trial', {}), 'step_order');
  svc.recordStep(U['工人甲'], job.id, js.id, 'reassemble', { filters_reinstalled: 2 });
  svc.recordStep(U['工人甲'], job.id, js.id, 'trial', {});
  const after = svc.jobDetail(job.id).segments.find(s => s.id === js.id);
  assert.equal(after.status, 'done');
});

// ---------- 3. 增项确认 ----------
test('增项确认：重油污/滤网损坏自动生成待确认增项，仅门店可确认，验收被未确认增项拦截', () => {
  const w = confirmedWindow(1, iso(120), iso(124));
  const job = makeJob(w.id, 1, 1, iso(120), iso(123));
  svc.startJob(U['班长甲'], job.id);
  const js = svc.jobDetail(job.id).segments[0];

  svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble',
    { filters_removed: 2, filters_damaged: 1, grease_level: 4 });
  let detail = svc.jobDetail(job.id);
  const addons = detail.addons;
  assert.equal(addons.length, 2);
  assert.ok(addons.every(a => a.status === 'pending'));
  assert.ok(detail.exceptions.some(e => e.type === 'heavy_grease' && e.status === 'open'));
  assert.ok(detail.exceptions.some(e => e.type === 'filter_damage' && e.status === 'open'));

  // 施工人员不能确认增项
  expectErr(() => svc.confirmAddon(U['班长甲'], addons[0].id, true), 'forbidden');
  // 财务也不能
  expectErr(() => svc.confirmAddon(U['财务'], addons[0].id, true), 'forbidden');
  // 门店确认
  svc.confirmAddon(U['店长'], addons[0].id, true);
  svc.confirmAddon(U['店长'], addons[1].id, false); // 拒绝滤网更换
  detail = svc.jobDetail(job.id);
  assert.equal(detail.addons.find(a => a.type === 'heavy_grease').status, 'confirmed');
  assert.equal(detail.addons.find(a => a.type === 'filter_replace').status, 'rejected');
  // 重油污异常随确认闭环；滤网损坏异常随拒绝闭环（施工方自担）
  assert.ok(detail.exceptions.every(e => e.status === 'resolved'));
  // 重复确认 → 拒绝
  expectErr(() => svc.confirmAddon(U['店长'], addons[0].id, true), 'addon_state');
});

// ---------- 4. 验收权限与门禁 ----------
test('验收权限：施工人员/财务不能提交验收；漏装、缺照片、风量未过均被拦截', () => {
  const w = confirmedWindow(1, iso(130), iso(134));
  const job = makeJob(w.id, 1, 1, iso(130), iso(133));
  svc.startJob(U['班长甲'], job.id);
  const segs = svc.jobDetail(job.id).segments;

  // 只完成第一段且漏装滤网
  const js = segs[0];
  svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble', { filters_removed: 2, grease_level: 2 });
  svc.recordStep(U['工人甲'], job.id, js.id, 'wash', {});
  svc.recordStep(U['工人甲'], job.id, js.id, 'dry', {});
  svc.recordStep(U['工人甲'], job.id, js.id, 'reassemble', { filters_reinstalled: 1 }); // 漏装
  svc.recordStep(U['工人甲'], job.id, js.id, 'trial', {});

  // 施工人员提交验收 → 403
  expectErr(() => svc.submitAcceptance(U['工人甲'], job.id, 'x'), 'forbidden');
  expectErr(() => svc.submitAcceptance(U['班长甲'], job.id, 'x'), 'forbidden');
  // 财务提交 → 403
  expectErr(() => svc.submitAcceptance(U['财务'], job.id, 'x'), 'forbidden');
  // 验收员提交 → 被门禁拦截（漏装 + 其他段未完成 + 缺照片 + 未复测）
  const e1 = expectErr(() => svc.submitAcceptance(U['调度'], job.id, 'x'), 'acceptance_gate');
  assert.match(e1.message, /漏装/);
  assert.match(e1.message, /缺少工序/);
  assert.match(e1.message, /尚未进行风量复测/);

  // 修正漏装
  const jsFresh = svc.jobDetail(job.id).segments.find(s => s.id === js.id);
  run(db, `UPDATE job_segments SET filters_reinstalled=2 WHERE id=?`, jsFresh.id); // 直接修库模拟补装
  // 完成其余段 + 全部照片 + 复测
  for (const s of svc.jobDetail(job.id).segments) {
    if (s.status === 'pending') {
      svc.recordStep(U['工人甲'], job.id, s.id, 'disassemble', { filters_removed: 2, grease_level: 2 });
      svc.recordStep(U['工人甲'], job.id, s.id, 'wash', {});
      svc.recordStep(U['工人甲'], job.id, s.id, 'dry', {});
      svc.recordStep(U['工人甲'], job.id, s.id, 'reassemble', { filters_reinstalled: 2 });
      svc.recordStep(U['工人甲'], job.id, s.id, 'trial', {});
    }
    for (const phase of ['before', 'after'])
      svc.savePhoto(U['工人甲'], job.id, s.id, phase,
        { angle_deg: 0, data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  }
  svc.measureAirflow(U['调度'], job.id, 1, adapter);
  const acc = svc.submitAcceptance(U['调度'], job.id, '全部达标');
  assert.equal(acc.result, 'passed');
  assert.equal(svc.jobDetail(job.id).status, 'acceptance_review');
});

test('照片角度：超差照片产生异常并拦截验收，重拍合格后自动闭环', () => {
  const w = confirmedWindow(1, iso(140), iso(144));
  const job = makeJob(w.id, 1, 1, iso(140), iso(143));
  svc.startJob(U['班长甲'], job.id);
  const js = svc.jobDetail(job.id).segments[0];
  const bad = svc.savePhoto(U['工人甲'], job.id, js.id, 'after',
    { angle_deg: 25, data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  assert.equal(bad.angle_ok, 0);
  let detail = svc.jobDetail(job.id);
  assert.ok(detail.exceptions.some(e => e.type === 'photo_angle' && e.status === 'open'));
  const good = svc.savePhoto(U['工人甲'], job.id, js.id, 'after',
    { angle_deg: 3, data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  assert.equal(good.angle_ok, 1);
  detail = svc.jobDetail(job.id);
  assert.ok(detail.exceptions.filter(e => e.type === 'photo_angle').every(e => e.status === 'resolved'));
});

// ---------- 5. 结算幂等 ----------
test('结算幂等：同一工单重复结算返回同一快照；未签字不能结算；金额=实际清洗段数×单价+已确认增项', () => {
  const w = confirmedWindow(1, iso(150), iso(156));
  const job = makeJob(w.id, 1, 1, iso(150), iso(155));
  driveToAcceptable(job, 1);
  svc.submitAcceptance(U['调度'], job.id, 'ok');

  // 未签字 → 不能结算
  expectErr(() => svc.createSettlement(U['财务'], job.id), 'not_accepted');
  svc.signAcceptance(U['店长'], job.id, null);

  // 非财务不能结算
  expectErr(() => svc.createSettlement(U['调度'], job.id), 'forbidden');

  const s1 = svc.createSettlement(U['财务'], job.id);
  assert.equal(s1.idempotent_reused, false);
  assert.equal(s1.snapshot_json.actual_washed_segments, 3);
  assert.equal(s1.total_amount, 3 * 20000);
  assert.equal(svc.jobDetail(job.id).status, 'settled');

  // 重复结算 → 同一快照（幂等）
  const s2 = svc.createSettlement(U['财务'], job.id);
  assert.equal(s2.idempotent_reused, true);
  assert.equal(s2.id, s1.id);
  assert.equal(s2.total_amount, s1.total_amount);
  assert.deepEqual(s2.snapshot_json.generated_at, s1.snapshot_json.generated_at);
  assert.equal(get(db, `SELECT COUNT(*) c FROM settlements WHERE job_id=?`, job.id).c, 1);

  // 复核
  const reviewed = svc.reviewSettlement(U['财务'], s1.id);
  assert.equal(reviewed.status, 'reviewed');
  expectErr(() => svc.reviewSettlement(U['财务'], s1.id), 'already_reviewed');
});

test('结算快照包含已确认增项、排除未确认增项', () => {
  const w = confirmedWindow(1, iso(160), iso(166));
  const job = makeJob(w.id, 1, 1, iso(160), iso(165));
  svc.startJob(U['班长甲'], job.id);
  const js0 = svc.jobDetail(job.id).segments[0];
  svc.recordStep(U['工人甲'], job.id, js0.id, 'disassemble',
    { filters_removed: 2, grease_level: 5 }); // 触发重油污增项
  const addon = svc.jobDetail(job.id).addons[0];
  svc.createAddon(U['班长甲'], job.id, { type: 'other', description: '夜间施工', qty: 1, amount: 5000 });
  // 一个确认、一个保持待确认
  svc.confirmAddon(U['店长'], addon.id, true);
  // 完成剩余工序
  for (const s of svc.jobDetail(job.id).segments) {
    if (s.status === 'pending')
      svc.recordStep(U['工人甲'], job.id, s.id, 'disassemble', { filters_removed: 2, grease_level: 2 });
    for (const st of ['wash', 'dry']) svc.recordStep(U['工人甲'], job.id, s.id, st, {});
    svc.recordStep(U['工人甲'], job.id, s.id, 'reassemble', { filters_reinstalled: 2 });
    svc.recordStep(U['工人甲'], job.id, s.id, 'trial', {});
    for (const phase of ['before', 'after'])
      svc.savePhoto(U['工人甲'], job.id, s.id, phase,
        { angle_deg: 0, data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  }
  svc.measureAirflow(U['调度'], job.id, 1, adapter);
  // 未确认的 other 增项不拦截验收，但也不计入结算
  svc.submitAcceptance(U['调度'], job.id, 'ok');
  svc.signAcceptance(U['店长'], job.id, null);
  const s = svc.createSettlement(U['财务'], job.id);
  assert.equal(s.snapshot_json.addons_confirmed.length, 1);
  assert.equal(s.snapshot_json.addons_excluded.length, 1);
  assert.equal(s.total_amount, 3 * 20000 + 8000);
});

// ---------- 附加：临时营业 / 拒签 / 返工 ----------
test('临时营业挂起阻断工序登记，复工后恢复', () => {
  const w = confirmedWindow(1, iso(170), iso(174));
  const job = makeJob(w.id, 1, 1, iso(170), iso(173));
  svc.startJob(U['班长甲'], job.id);
  svc.setTempOpen(U['店长'], job.id, '午间临时营业');
  const js = svc.jobDetail(job.id).segments[0];
  expectErr(() => svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble',
    { filters_removed: 2, grease_level: 2 }), 'on_hold');
  svc.resumeJob(U['店长'], job.id);
  svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble', { filters_removed: 2, grease_level: 2 });
  assert.equal(svc.jobDetail(job.id).segments[0].status, 'disassembled');
});

test('门店拒签阻断结算，协商后可重新签字', () => {
  const w = confirmedWindow(1, iso(180), iso(186));
  const job = makeJob(w.id, 1, 1, iso(180), iso(185));
  driveToAcceptable(job, 1);
  svc.submitAcceptance(U['调度'], job.id, 'ok');
  svc.refuseSign(U['店长'], job.id, 'C 段仍有油痕');
  let detail = svc.jobDetail(job.id);
  assert.equal(detail.status, 'refused');
  assert.ok(detail.exceptions.some(e => e.type === 'refuse_sign' && e.status === 'open'));
  expectErr(() => svc.createSettlement(U['财务'], job.id), 'not_accepted');
  svc.resolveRefusal(U['店长'], job.id, '已补洗，重新签字');
  svc.signAcceptance(U['店长'], job.id, null);
  const s = svc.createSettlement(U['财务'], job.id);
  assert.equal(s.total_amount, 3 * 20000);
});

test('返工开启新一轮分段，验收结论只能由验收员判定', () => {
  const w = confirmedWindow(1, iso(190), iso(196));
  const job = makeJob(w.id, 1, 1, iso(190), iso(195));
  driveToAcceptable(job, 1);
  expectErr(() => svc.requestRework(U['工人甲'], job.id, 'x'), 'forbidden');
  const after = svc.requestRework(U['调度'], job.id, '风量不达标');
  assert.equal(after.current_round, 2);
  assert.equal(after.status, 'in_progress');
  assert.ok(after.segments.every(s => s.status === 'pending'));
  // 新一轮可重新登记工序
  const js = after.segments[0];
  svc.recordStep(U['工人甲'], job.id, js.id, 'disassemble', { filters_removed: 2, grease_level: 3 });
  assert.equal(svc.jobDetail(job.id).segments[0].status, 'disassembled');
});

test('超时提醒：进行中工单超过排班结束时间产生 overtime 异常（幂等）', () => {
  const { createReminder } = require('../src/reminders');
  const w = confirmedWindow(1, iso(200), iso(202));
  const job = makeJob(w.id, 1, 1, iso(200), iso(201));
  svc.startJob(U['班长甲'], job.id);
  const later = new Date(T0.getTime() + 203 * 3600000).toISOString();
  const reminder = createReminder(db, svc, { now: () => later });
  reminder.sweep();
  reminder.sweep(); // 第二次扫描不应重复
  const exs = svc.jobDetail(job.id).exceptions.filter(e => e.type === 'overtime');
  assert.equal(exs.length, 1);
});
