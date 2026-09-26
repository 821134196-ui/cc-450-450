'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../src/db');
const { createServices } = require('../src/services');
const { MockAirAdapter } = require('../src/adapter');

function fresh() {
  const { db } = openDb(':memory:');
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-photo-'));
  const adapter = new MockAirAdapter();
  const notes = [];
  const svc = createServices({ db, photoDir, adapter, notify: (type, title, body, refType, refId) => notes.push({ type, title, body, refType, refId }) });

  const u = db.prepare('INSERT INTO users(username,display_name,role) VALUES(?,?,?)');
  const users = {
    crew: u.run('crew1', '施工员王建国', 'crew').lastInsertRowid,
    crew2: u.run('crew2', '施工员赵大强', 'crew').lastInsertRowid,
    inspector: u.run('insp1', '验收员陈静', 'inspector').lastInsertRowid,
    finance: u.run('fin1', '财务周敏', 'finance').lastInsertRowid,
    planner: u.run('plan1', '调度刘航', 'planner').lastInsertRowid,
    store: u.run('store1', '店长张磊', 'store').lastInsertRowid,
    store2: u.run('store2', '二店店长杨丽', 'store').lastInsertRowid,
  };
  const t = db.prepare('INSERT INTO teams(name,leader_id) VALUES(?,?)');
  const teams = { A: t.run('甲班', users.crew).lastInsertRowid, B: t.run('乙班', users.crew2).lastInsertRowid };
  const s = db.prepare('INSERT INTO stores(name,brand,address,contact,phone) VALUES(?,?,?,?,?)');
  const stores = {
    one: s.run('金鼎轩望京店', '金鼎轩', '望京SOHO', '张磊', '010').lastInsertRowid,
    two: s.run('蜀香坊中关村店', '蜀香坊', '中关村15号', '杨丽', '020').lastInsertRowid,
  };
  const seg = db.prepare('INSERT INTO hood_segments(store_id,code,name,length_m,filters_expected,duct_points) VALUES(?,?,?,?,?,?)');
  const mkSegs = (storeId, n) => Array.from({ length: n }, (_, i) =>
    seg.run(storeId, String.fromCharCode(65 + i), `${i + 1}号罩体`, 1.2, 2, JSON.stringify([`P${i + 1}`])).lastInsertRowid);
  const segments = { one: mkSegs(stores.one, 2), two: mkSegs(stores.two, 2) };

  return { db, svc, adapter, notes, users, teams, stores, segments, photoDir };
}

function futureWindow(h = 2) {
  const start = new Date(Date.now() + 3600e3);
  const end = new Date(Date.now() + (h + 3) * 3600e3);
  return { start_at: start.toISOString(), end_at: end.toISOString() };
}

function confirmedWindow(ctx, storeId, userId) {
  const w = futureWindow();
  const win = ctx.svc.proposeWindow({ store_id: storeId, ...w });
  ctx.svc.setWindowStatus(win.id, userId, 'confirmed');
  return win;
}

const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>').toString('base64');

// 把一单推进到「满足验收条件」
function driveToReady(ctx, job, { scenario = 'normal', badAngle = false } = {}) {
  const { svc, users } = ctx;
  if (scenario !== 'normal') ctx.adapter.setScenario(job.id, scenario);
  svc.startJob(job.id, users.crew);
  for (const s of job.segments) {
    svc.registerFilters(job.id, s.id, { filters_removed: 2, damaged_filters: 0 }, users.crew);
  }
  for (const step of ['clean', 'dry', 'reassemble', 'test_run']) {
    for (const s of job.segments) {
      svc.advanceSegment(job.id, s.id, step, users.crew);
    }
  }
  const r = svc.reassemblyCheck(job.id, job.segments.map(s => ({ job_segment_id: s.id, reinstalled: 2 })), users.crew);
  assert.equal(r.passed, true);
  svc.runAirTest(job.id, users.crew, { is_retest: false });
  for (const s of job.segments) {
    svc.addPhoto(job.id, { job_segment_id: s.id, phase: 'before', dataUrl: SVG, angle_ok: !badAngle }, users.crew);
    svc.addPhoto(job.id, { job_segment_id: s.id, phase: 'after', dataUrl: SVG, angle_ok: true }, users.crew);
  }
  return svc.jobDetail(job.id);
}

/* ================= 1. 排期互斥 ================= */
test('门店确认停灶窗口后才能排班', () => {
  const ctx = fresh();
  const w = futureWindow();
  const win = ctx.svc.proposeWindow({ store_id: ctx.stores.one, ...w });
  assert.equal(win.status, 'proposed');
  assert.throws(
    () => ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: w.start_at, end_at: w.end_at, userId: ctx.users.planner }),
    e => e.code === 'window_not_confirmed');

  ctx.svc.setWindowStatus(win.id, ctx.users.store, 'confirmed');
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: w.start_at, end_at: w.end_at, userId: ctx.users.planner });
  assert.equal(job.segments.length, 2);
});

test('两个班组不能占用同一厨房时段（互斥），不同厨房可并行', () => {
  const ctx = fresh();
  const win1 = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const win2 = confirmedWindow(ctx, ctx.stores.two, ctx.users.store2);

  const mid = new Date((+new Date(win1.start_at) + +new Date(win1.end_at)) / 2).toISOString();
  // 甲班占前半段
  ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win1.id, start_at: win1.start_at, end_at: mid, userId: ctx.users.planner });
  // 乙班想占整段 → 与甲班前半段冲突
  assert.throws(
    () => ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.B, window_id: win1.id, start_at: win1.start_at, end_at: win1.end_at, userId: ctx.users.planner }),
    e => e.code === 'kitchen_busy');

  // 同一厨房、时间不重叠（乙班占后半段）：允许
  const job3 = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.B, window_id: win1.id, start_at: mid, end_at: win1.end_at, userId: ctx.users.planner });
  assert.ok(job3.id);
  // 与甲班时间重叠但在另一个门店厨房：允许
  const jobOther = ctx.svc.scheduleJob({ store_id: ctx.stores.two, team_id: ctx.teams.B, window_id: win2.id, start_at: win2.start_at, end_at: win2.end_at, userId: ctx.users.planner });
  assert.ok(jobOther.id);
});

test('只有门店能确认停灶窗口；临时营业阻止开工', () => {
  const ctx = fresh();
  const w = futureWindow();
  const win = ctx.svc.proposeWindow({ store_id: ctx.stores.one, ...w });
  assert.throws(() => ctx.svc.setWindowStatus(win.id, ctx.users.crew, 'confirmed'), e => e.code === 'forbidden');
  ctx.svc.setWindowStatus(win.id, ctx.users.store, 'confirmed');
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: w.start_at, end_at: w.end_at, userId: ctx.users.planner });
  ctx.svc.setWindowStatus(win.id, ctx.users.store, 'temporary_business', '临时包场');
  assert.throws(() => ctx.svc.startJob(job.id, ctx.users.crew), e => e.code === 'window_temp_business');
});

/* ================= 2. 步骤顺序 ================= */
test('工序必须按 拆卸→清洗→干燥→复装→试运行 顺序完成', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });

  assert.throws(() => ctx.svc.startJob(job.id, ctx.users.finance), e => e.code === 'forbidden'); // 财务不能动工序
  ctx.svc.startJob(job.id, ctx.users.crew);
  const [s1, s2] = job.segments;

  // 未登记滤网不能清洗
  assert.throws(() => ctx.svc.advanceSegment(job.id, s1.id, 'clean', ctx.users.crew), e => e.code === 'step_order');
  ctx.svc.registerFilters(job.id, s1.id, { filters_removed: 2 }, ctx.users.crew);
  // s2 未拆卸：s1 可清洗，但不能干燥（所有段必须先完成清洗）
  ctx.svc.advanceSegment(job.id, s1.id, 'clean', ctx.users.crew);
  assert.throws(() => ctx.svc.advanceSegment(job.id, s1.id, 'dry', ctx.users.crew), e => e.code === 'step_order');
  // 不能跳步复装
  assert.throws(() => ctx.svc.advanceSegment(job.id, s1.id, 'reassemble', ctx.users.crew), e => e.code === 'step_order');

  ctx.svc.registerFilters(job.id, s2.id, { filters_removed: 2 }, ctx.users.crew);
  ctx.svc.advanceSegment(job.id, s2.id, 'clean', ctx.users.crew);
  for (const step of ['dry', 'reassemble', 'test_run']) {
    ctx.svc.advanceSegment(job.id, s1.id, step, ctx.users.crew);
    // 段间闸门：s2 落后时 s1 不能进入下一工序
    if (step !== 'test_run') {
      assert.throws(() => ctx.svc.advanceSegment(job.id, s1.id,
        step === 'dry' ? 'reassemble' : 'test_run', ctx.users.crew), e => e.code === 'step_order');
    }
    ctx.svc.advanceSegment(job.id, s2.id, step, ctx.users.crew);
  }
  const done = ctx.svc.jobDetail(job.id);
  assert.ok(done.segments.every(s => s.step === 'tested'));
});

test('开工时逐段登记滤网数量，损坏自动生成待确认增项，不可重复登记', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  ctx.svc.startJob(job.id, ctx.users.crew);
  const [s1] = job.segments;
  ctx.svc.registerFilters(job.id, s1.id, { filters_removed: 3, damaged_filters: 1 }, ctx.users.crew);
  assert.throws(() => ctx.svc.registerFilters(job.id, s1.id, { filters_removed: 3 }, ctx.users.crew), e => e.code === 'already_registered');
  const jd = ctx.svc.jobDetail(job.id);
  assert.equal(jd.segments[0].filters_removed, 3);
  const addon = jd.addons.find(a => a.kind === 'filter_damage');
  assert.ok(addon && addon.status === 'pending' && addon.amount > 0);
});

/* ================= 3. 漏装 / 风量 / 照片角度阻断验收 ================= */
test('漏装或风量复测未通过或照片角度不合格不能提交验收', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });

  // 返工场景适配器：首测风量不达标
  const jd = driveToReady(ctx, job, { scenario: 'rework' });
  const [s1] = jd.segments;
  // 复装核验发现漏装
  const check = ctx.svc.reassemblyCheck(jd.id, jd.segments.map(s => ({
    job_segment_id: s.id, reinstalled: s.id === s1.id ? 1 : 2 })), ctx.users.crew);
  assert.equal(check.passed, false);
  assert.equal(check.missing.length, 1);

  let r = ctx.svc.acceptanceReadiness(jd.id);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some(x => x.includes('漏装')));
  assert.ok(r.reasons.some(x => x.includes('风量复测未通过')));

  // 整改：补齐复装 + 复测（rework 场景复测达标）
  ctx.svc.decideAcceptance(jd.id, 'rework', ctx.users.inspector); // 先判返工
  ctx.svc.reworkRedo(jd.id, ctx.users.crew);
  ctx.svc.reassemblyCheck(jd.id, jd.segments.map(s => ({ job_segment_id: s.id, reinstalled: 2 })), ctx.users.crew);
  const air = ctx.svc.runAirTest(jd.id, ctx.users.crew, { is_retest: true });
  assert.equal(air.passed, true);
  r = ctx.svc.acceptanceReadiness(jd.id);
  assert.equal(r.ready, true, '整改后应满足验收条件：' + r.reasons.join('；'));

  // 照片角度不合格再次阻断
  ctx.svc.addPhoto(jd.id, { job_segment_id: s1.id, phase: 'before', dataUrl: SVG, angle_ok: false }, ctx.users.crew);
  r = ctx.svc.acceptanceReadiness(jd.id);
  assert.ok(r.reasons.some(x => x.includes('角度不合格')));
  // 重拍合格照片（同段最新一张合格）
  ctx.svc.addPhoto(jd.id, { job_segment_id: s1.id, phase: 'before', dataUrl: SVG, angle_ok: true }, ctx.users.crew);
  assert.equal(ctx.svc.acceptanceReadiness(jd.id).ready, true);
});

test('复测噪声异常不能通过验收', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  const jd = driveToReady(ctx, job, { scenario: 'noise' });
  const r = ctx.svc.acceptanceReadiness(jd.id);
  assert.ok(r.reasons.some(x => x.includes('噪声异常')));
  assert.throws(() => ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.inspector), e => e.code === 'not_ready');
});

/* ================= 4. 增项确认 ================= */
test('现场增项必须先获得门店确认，财务/班组无权确认', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  const addon = ctx.svc.requestAddon(job.id, { kind: 'heavy_oil', description: '重油污二次药剂清洗', amount: 20000 }, ctx.users.crew);
  assert.equal(addon.status, 'pending');
  assert.throws(() => ctx.svc.confirmAddon(addon.id, ctx.users.finance, true), e => e.code === 'forbidden');
  assert.throws(() => ctx.svc.confirmAddon(addon.id, ctx.users.crew, true), e => e.code === 'forbidden');
  ctx.svc.confirmAddon(addon.id, ctx.users.store, true);
  assert.throws(() => ctx.svc.confirmAddon(addon.id, ctx.users.store, true), e => e.code === 'addon_decided'); // 不可重复确认
});

/* ================= 5. 验收权限 ================= */
test('施工人员不能修改验收结论，只有验收员可出具结论', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  const jd = driveToReady(ctx, job);
  assert.throws(() => ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.crew), e => e.code === 'forbidden');
  assert.throws(() => ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.finance), e => e.code === 'forbidden');
  const done = ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.inspector);
  assert.equal(done.status, 'completed');
  assert.equal(done.acceptance.conclusion, 'pass');
});

test('门店拒签单独留痕，需补签后才能结算', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  const jd = driveToReady(ctx, job);
  ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.inspector);
  // 未签字不能结算
  assert.throws(() => ctx.svc.createInvoice(jd.id, ctx.users.finance), e => e.code === 'not_signed');
  // 施工员不能签字
  assert.throws(() => ctx.svc.storeSign(jd.id, { name: '王某' }, ctx.users.crew), e => e.code === 'forbidden');
  // 门店拒签
  const rej = ctx.svc.storeRejectSign(jd.id, { name: '张磊', note: '对超时费有异议' }, ctx.users.store);
  assert.equal(rej.status, 'rejected_sign');
  assert.throws(() => ctx.svc.createInvoice(jd.id, ctx.users.finance), e => e.code === 'not_signed');
  // 异议解除补签
  const signed = ctx.svc.storeSign(jd.id, { name: '张磊', signature: SVG }, ctx.users.store);
  assert.equal(signed.acceptance.store_signed, 1);
  assert.ok(fs.existsSync(path.join(ctx.photoDir, String(jd.id), signed.acceptance.sign_file)));
});

/* ================= 6. 结算幂等快照 ================= */
test('验收结束后按实际清洗段数形成结算快照，重复生成幂等', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  let jd = driveToReady(ctx, job);
  // 一个确认增项（重油污）+ 一个待确认增项（不应计入）
  const a1 = ctx.svc.requestAddon(jd.id, { kind: 'heavy_oil', description: '重油污加项', amount: 20000 }, ctx.users.crew);
  ctx.svc.requestAddon(jd.id, { kind: 'other', description: '未确认增项', amount: 99999 }, ctx.users.crew);
  ctx.svc.confirmAddon(a1.id, ctx.users.store, true);

  ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.inspector);
  ctx.svc.storeSign(jd.id, { name: '张磊' }, ctx.users.store);

  // 只有财务能结算
  assert.throws(() => ctx.svc.createInvoice(jd.id, ctx.users.crew), e => e.code === 'forbidden');

  const snap1 = ctx.svc.createInvoice(jd.id, ctx.users.finance);
  assert.equal(snap1.segment_count, 2);                 // 实际清洗段数
  assert.equal(snap1.base_amount, 2 * 38000);
  assert.equal(snap1.addon_amount, 20000);              // 仅确认增项
  assert.equal(snap1.total_amount, 2 * 38000 + 20000);

  // 幂等：再次生成返回同一快照，不新增结算单
  const snap2 = ctx.svc.createInvoice(jd.id, ctx.users.finance);
  assert.deepEqual(snap2, snap1);
  const count = ctx.db.prepare('SELECT COUNT(*) c FROM invoices WHERE job_id=?').get(jd.id).c;
  assert.equal(count, 1);
});

test('实际只清洗部分段时结算按实际段数计', () => {
  const ctx = fresh();
  const win = confirmedWindow(ctx, ctx.stores.one, ctx.users.store);
  const job = ctx.svc.scheduleJob({ store_id: ctx.stores.one, team_id: ctx.teams.A, window_id: win.id, start_at: win.start_at, end_at: win.end_at, userId: ctx.users.planner });
  // 该单先合格验收+签字，随后模拟「实际只清洗 1 段」的口径：
  // 结算快照在出具时统计 cleaned 及以上的分段
  let jd = driveToReady(ctx, job);
  ctx.svc.decideAcceptance(jd.id, 'pass', ctx.users.inspector);
  ctx.svc.storeSign(jd.id, { name: '张磊' }, ctx.users.store);
  ctx.db.prepare("UPDATE job_segments SET step='removed' WHERE id=?").run(jd.segments[0].id);
  const snap = ctx.svc.createInvoice(jd.id, ctx.users.finance);
  assert.equal(snap.segment_count, 1);
  assert.equal(snap.base_amount, 38000);
});
