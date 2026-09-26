'use strict';
// 样例数据：示例门店、班组、人员、罩体分段；正常 / 返工 / 拒签 / 进行中 四张施工单
const fs = require('node:fs');
const path = require('node:path');

function iso(d) { return new Date(d).toISOString(); }
function shift(days, hour, durH = 4) {
  const d = new Date(Date.now() + days * 86400e3);
  d.setHours(hour, 0, 0, 0);
  return [iso(d), iso(new Date(+d + durH * 3600e3))];
}

function svg(label, sub, bg, accent = '#35c46a') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#14181d"/>
  </linearGradient></defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <rect x="40" y="60" width="560" height="200" rx="10" fill="none" stroke="${accent}" stroke-width="2" stroke-dasharray="10 8" opacity="0.7"/>
  <line x1="320" y1="60" x2="320" y2="260" stroke="${accent}" stroke-width="1" stroke-dasharray="4 8" opacity="0.4"/>
  <line x1="40" y1="160" x2="600" y2="160" stroke="${accent}" stroke-width="1" stroke-dasharray="4 8" opacity="0.4"/>
  <text x="320" y="150" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#eef2f5" font-weight="700">${label}</text>
  <text x="320" y="195" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#aab4bd">${sub}</text>
  <text x="600" y="330" text-anchor="end" font-family="monospace" font-size="14" fill="#7d8892">角度参考线 · 罩体正面 45°</text>
</svg>`;
}

function seed(ctx) {
  const { db, photoDir, adapter } = ctx;
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return false;

  const writePhoto = (jobId, file, content) => {
    const dir = path.join(photoDir, String(jobId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };

  const insUser = db.prepare('INSERT INTO users(username,display_name,role) VALUES(?,?,?)');
  const users = {
    wang: insUser.run('wangjianguo', '王建国', 'crew').lastInsertRowid,
    zhao: insUser.run('zhaodaqiang', '赵大强', 'crew').lastInsertRowid,
    chen: insUser.run('chenjing', '陈静（验收员）', 'inspector').lastInsertRowid,
    zhou: insUser.run('zhoumin', '周敏（财务）', 'finance').lastInsertRowid,
    liu: insUser.run('liuhang', '刘航（计划调度）', 'planner').lastInsertRowid,
    zhang: insUser.run('zhanglei', '张磊（望京店店长）', 'store').lastInsertRowid,
    yang: insUser.run('yangli', '杨丽（中关村店店长）', 'store').lastInsertRowid,
    lin: insUser.run('lintao', '林涛（国贸店店长）', 'store').lastInsertRowid,
  };

  const insTeam = db.prepare('INSERT INTO teams(name,leader_id) VALUES(?,?)');
  const teamA = insTeam.run('甲班·攻坚组', users.wang).lastInsertRowid;
  const teamB = insTeam.run('乙班·精洗组', users.zhao).lastInsertRowid;

  const insWorker = db.prepare('INSERT INTO workers(user_id,name,phone,team_id) VALUES(?,?,?,?)');
  insWorker.run(users.wang, '王建国', '138-0000-1001', teamA);
  insWorker.run(null, '孙大壮', '138-0000-1002', teamA);
  insWorker.run(null, '吴海峰', '138-0000-1003', teamA);
  insWorker.run(users.zhao, '赵大强', '138-0000-2001', teamB);
  insWorker.run(null, '郑小云', '138-0000-2002', teamB);
  insWorker.run(null, '冯磊', '138-0000-2003', teamB);

  const insStore = db.prepare('INSERT INTO stores(name,brand,address,contact,phone,kitchen_note) VALUES(?,?,?,?,?,?)');
  const s1 = insStore.run('金鼎轩（望京店）', '金鼎轩', '北京市朝阳区望京 SOHO T1-B1', '张磊', '010-8800-1001', '粤菜明档，夜间 22:00 后可停灶；重油污').lastInsertRowid;
  const s2 = insStore.run('蜀香坊（中关村店）', '蜀香坊', '北京市海淀区中关村大街 15 号', '杨丽', '010-8800-2002', '川菜重油烟，排风管较长').lastInsertRowid;
  const s3 = insStore.run('和风料理（国贸店）', '和风料理', '北京市朝阳区建国门外大街 1 号', '林涛', '010-8800-3003', '日料轻油烟，商场规定 23:00 后施工').lastInsertRowid;

  const insSeg = db.prepare('INSERT INTO hood_segments(store_id,code,name,length_m,filters_expected,duct_points) VALUES(?,?,?,?,?,?)');
  const segDefs = {
    [s1]: [
      ['A', '炒灶区罩体', 1.6, 3, ['A-主烟口', 'A-支管末端']],
      ['B', '蒸炖区罩体', 1.2, 2, ['B-主烟口']],
      ['C', '明档烧烤区', 1.4, 3, ['C-主烟口', 'C-弯头点']],
      ['D', '洗碗间辅罩', 1.0, 2, ['D-末端']],
    ],
    [s2]: [
      ['A', '大锅菜区', 1.8, 4, ['A-主烟口', 'A-支管末端']],
      ['B', '小炒区', 1.4, 3, ['B-主烟口']],
      ['C', '面点区', 1.2, 2, ['C-末端']],
    ],
    [s3]: [
      ['A', '炉端烧区', 1.4, 2, ['A-主烟口']],
      ['B', '炸物区', 1.2, 2, ['B-主烟口', 'B-弯头点']],
      ['C', '出餐辅罩', 1.0, 2, ['C-末端']],
    ],
  };
  const segIds = {};
  for (const [storeId, defs] of Object.entries(segDefs)) {
    segIds[storeId] = defs.map(([code, name, len, f, points]) =>
      insSeg.run(storeId, code, name, len, f, JSON.stringify(points)).lastInsertRowid);
  }

  // 周期计划（s3 明天到期，启动时即产生到期提醒）
  const insPlan = db.prepare('INSERT INTO cycle_plans(store_id,period_days,next_due_date,heavy_oil) VALUES(?,?,?,?)');
  const inDays = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  insPlan.run(s1, 60, inDays(50), 1);
  insPlan.run(s2, 45, inDays(12), 1);
  insPlan.run(s3, 60, inDays(1), 0);

  const insWin = db.prepare(
    `INSERT INTO shutdown_windows(store_id,start_at,end_at,status,note,confirmed_at,confirmed_by) VALUES(?,?,?,?,?,?,?)`);
  const [w1s, w1e] = shift(-10, 22);
  const [w2s, w2e] = shift(-3, 22);
  const [w3s, w3e] = shift(-6, 23);
  const [w4s, w4e] = shift(0, new Date().getHours() - 1, 4);
  const [w5s, w5e] = shift(2, 22, 3);
  const win1 = insWin.run(s1, w1s, w1e, 'confirmed', '月度夜间清洗', w1s, users.zhang).lastInsertRowid;
  const win2 = insWin.run(s2, w2s, w2e, 'confirmed', '周期清洗', w2s, users.yang).lastInsertRowid;
  const win3 = insWin.run(s3, w3s, w3e, 'confirmed', '商场夜间施工', w3s, users.lin).lastInsertRowid;
  const win4 = insWin.run(s1, w4s, w4e, 'confirmed', '今晚加急清洗', w4s, users.zhang).lastInsertRowid;
  const win5 = insWin.run(s2, w5s, w5e, 'proposed', '下轮周期窗口（待门店确认）', null, null).lastInsertRowid;

  const insJob = db.prepare(
    `INSERT INTO jobs(code,store_id,team_id,window_id,scheduled_start,scheduled_end,status,created_by,created_at,started_at,finished_at,overtime_minutes,plan_segment_count)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const t = (d, h = 22, m = 10) => { const x = new Date(d); x.setHours(h, m, 0, 0); return iso(x); };
  const j1 = insJob.run('SG-DEMO-01', s1, teamA, win1, w1s, w1e, 'settled', users.liu, iso(+new Date(w1s) - 3600e3), t(Date.now() - 10 * 86400e3, 22, 12), t(Date.now() - 10 * 86400e3 + 86400e3, 1, 40), 0, 4).lastInsertRowid;
  const j2 = insJob.run('SG-DEMO-02', s2, teamB, win2, w2s, w2e, 'rework', users.liu, iso(+new Date(w2s) - 3600e3), t(Date.now() - 3 * 86400e3, 22, 10), null, 0, 3).lastInsertRowid;
  const j3 = insJob.run('SG-DEMO-03', s3, teamA, win3, w3s, w3e, 'rejected_sign', users.liu, iso(+new Date(w3s) - 3600e3), t(Date.now() - 6 * 86400e3, 23, 5), t(Date.now() - 6 * 86400e3 + 86400e3, 2, 35), 35, 3).lastInsertRowid;
  const j4 = insJob.run('SG-DEMO-04', s1, teamB, win4, w4s, w4e, 'cleaning', users.liu, iso(+new Date(w4s) - 1800e3), iso(new Date()), null, 0, 4).lastInsertRowid;

  const insJS = db.prepare(
    `INSERT INTO job_segments(job_id,segment_id,seq,filters_removed,registered_by,registered_at,damaged_filters,damage_note,step)
     VALUES(?,?,?,?,?,?,?,?,?)`);
  const mkSegs = (jobId, storeId, step, removed, damaged = {}) => {
    segIds[storeId].forEach((sid, i) => insJS.run(
      jobId, sid, i + 1, removed[i], users.wang, iso(new Date(jobTiming[jobId].start)),
      damaged[i] || 0, damaged[i] ? '滤网边框变形' : null, step));
  };
  const jobTiming = {
    [j1]: { start: t(Date.now() - 10 * 86400e3, 22, 12) },
    [j2]: { start: t(Date.now() - 3 * 86400e3, 22, 10) },
    [j3]: { start: t(Date.now() - 6 * 86400e3, 23, 5) },
    [j4]: { start: iso(new Date()) },
  };
  mkSegs(j1, s1, 'tested', [3, 2, 3, 2], { 2: 1 });
  mkSegs(j2, s2, 'tested', [4, 3, 2]);
  mkSegs(j3, s3, 'tested', [2, 2, 2]);
  // j4：全部已拆卸登记，A 段已清洗，正在清洗阶段
  segIds[s1].forEach((sid, i) => insJS.run(j4, sid, i + 1, segDefs[s1][i][3], users.zhao,
    iso(new Date(+new Date(w4s) + 20 * 60000)), 0, null, i === 0 ? 'cleaned' : 'removed'));

  const insStep = db.prepare("INSERT INTO work_steps(job_id,job_segment_id,step,operator_id,at,payload) VALUES(?,?,?,?,?,?)");
  const flowSteps = ['remove', 'clean', 'dry', 'reassemble', 'test_run'];
  for (const [jobId, base] of [[j1, +new Date(w1s) + 600000], [j2, +new Date(w2s) + 600000], [j3, +new Date(w3s) + 600000]]) {
    flowSteps.forEach((st, k) => insStep.run(jobId, null, st, users.wang, iso(base + k * 1800000), '{}'));
  }
  insStep.run(j4, null, 'remove', users.zhao, iso(new Date(+new Date(w4s) + 60000)), '{}');

  // 照片（本地目录 SVG 示例）
  const insPhoto = db.prepare(
    'INSERT INTO photos(job_id,job_segment_id,phase,file_name,angle_ok,note,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const codeOf = (storeId, i) => segDefs[storeId][i][0];
  const addSegPhotos = (jobId, storeId, at) => {
    segIds[storeId].forEach((sid, i) => {
      for (const phase of ['before', 'after']) {
        const file = `${phase}-${sid}-${i}.svg`;
        const label = phase === 'before' ? `清洗前 · ${codeOf(storeId, i)}段` : `清洗后 · ${codeOf(storeId, i)}段`;
        writePhoto(jobId, file, svg(label, `${phase === 'before' ? '油污等级 III 级' : '油污等级 0 级 · 验收留档'}`,
          phase === 'before' ? '#3a2a1c' : '#1d2a24', phase === 'before' ? '#c98a3d' : '#35c46a'));
        insPhoto.run(jobId, sid, phase, file, 1, phase === 'before' ? '重油污正面照' : '清洗完成正面照', users.wang, iso(at));
      }
    });
  };
  addSegPhotos(j1, s1, +new Date(w1s) + 1200000);
  addSegPhotos(j2, s2, +new Date(w2s) + 1200000);
  addSegPhotos(j3, s3, +new Date(w3s) + 1200000);
  // j4：A 段已有前后照片
  const f4 = 'before-a.svg';
  writePhoto(j4, f4, svg('清洗前 · A段', '今晚加急 · 油污等级 II 级', '#3a2a1c', '#c98a3d'));
  insPhoto.run(j4, segIds[s1][0], 'before', f4, 1, null, users.zhao, iso(new Date()));

  // 风量测点
  const insAir = db.prepare(
    'INSERT INTO air_tests(job_id,point_name,airflow,threshold,passed,is_retest,noise_db,noise_abnormal,at) VALUES(?,?,?,?,?,?,?,?,?)');
  const pointsOf = (storeId) => segDefs[storeId].flatMap(d => d[4]);
  const airRows = (jobId, storeId, at, failFirstPoint) => {
    pointsOf(storeId).forEach((p, i) => insAir.run(jobId, p,
      failFirstPoint && i === 0 ? 1020 : 1380 + i * 30, 1200,
      failFirstPoint && i === 0 ? 0 : 1, 0, 66 + i, 0, iso(at)));
  };
  airRows(j1, s1, +new Date(w1s) + 4 * 3600e3, false);
  airRows(j2, s2, +new Date(w2s) + 4 * 3600e3, true);   // 返工：首测风量不足
  airRows(j3, s3, +new Date(w3s) + 3 * 3600e3, false);

  // 增项
  const insAddon = db.prepare(
    'INSERT INTO addons(job_id,kind,description,amount,status,requested_by,requested_at,confirmed_at,confirmed_by,reject_reason) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insAddon.run(j1, 'heavy_oil', '重油污加项：C 段明档烧烤区加厚油垢，二次药剂清洗', 20000, 'confirmed', users.wang, iso(+new Date(w1s) + 3600e3), iso(+new Date(w1s) + 3800e3), users.zhang, null);
  insAddon.run(j1, 'filter_damage', '滤网损坏 1 片，补装同规格滤网', 15000, 'confirmed', users.wang, iso(+new Date(w1s) + 1800e3), iso(+new Date(w1s) + 2000e3), users.zhang, null);
  insAddon.run(j3, 'overtime', '施工超时 35 分钟（商场货梯占用），超时费待确认', 8000, 'pending', users.wang, iso(+new Date(w3s) + 4 * 3600e3), null, null, null);

  // 验收
  const insAcc = db.prepare(
    `INSERT INTO acceptances(job_id,conclusion,inspector_id,reassembly_passed,air_retest_passed,photos_angle_passed,decided_at,store_signed,store_rejected,signed_by_name,signed_at,sign_file,sign_note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // J1 合格 + 门店签字 + 签名图
  const signFile = 'sign-demo.svg';
  writePhoto(j1, signFile, `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="200" viewBox="0 0 520 200">
<rect width="520" height="200" fill="#f4f6f7"/>
<path d="M40 130 C90 40,130 170,180 100 S280 60,330 120 S430 150,480 90" fill="none" stroke="#1d2329" stroke-width="4" stroke-linecap="round"/>
<text x="40" y="180" font-family="sans-serif" font-size="16" fill="#5b6670">门店负责人：张磊</text></svg>`);
  insAcc.run(j1, 'pass', users.chen, 1, 1, 1, iso(+new Date(w1s) + 4.5 * 3600e3), 1, 0, '张磊', iso(+new Date(w1s) + 4.6 * 3600e3), signFile, null);
  // J2 返工：复装没问题，但风量首测不过
  insAcc.run(j2, 'rework', users.chen, 1, 0, 1, iso(+new Date(w2s) + 4.5 * 3600e3), 0, 0, null, null, null, 'A-主烟口风量 1020m³/h，清洗后管道阻力异常，需返工排查后复测');
  // J3 合格但门店拒签
  insAcc.run(j3, 'pass', users.chen, 1, 1, 1, iso(+new Date(w3s) + 3.5 * 3600e3), 0, 1, null, null, null, '门店拒签：对超时费有异议，需区域经理复核');

  // J1 结算快照
  const snapshot = {
    invoice_no: 'JS-SG-DEMO-01',
    job_code: 'SG-DEMO-01',
    store: { id: s1, name: '金鼎轩（望京店）', address: '北京市朝阳区望京 SOHO T1-B1' },
    team: '甲班·攻坚组',
    generated_at: iso(+new Date(w1s) + 5 * 3600e3),
    price_per_segment: 38000,
    segment_count: 4,
    segments: segDefs[s1].map((d, i) => ({ seq: i + 1, code: d[0], name: d[1], filters_removed: [3,2,3,2][i], damaged_filters: i === 2 ? 1 : 0, step: 'tested' })),
    base_amount: 152000,
    addons: [
      { id: 1, kind: 'heavy_oil', description: '重油污加项：C 段明档烧烤区加厚油垢，二次药剂清洗', amount: 20000 },
      { id: 2, kind: 'filter_damage', description: '滤网损坏 1 片，补装同规格滤网', amount: 15000 },
    ],
    addon_amount: 35000,
    damage_deduction: 0,
    total_amount: 187000,
  };
  db.prepare(
    `INSERT INTO invoices(job_id,invoice_no,segment_count,base_amount,addon_amount,damage_deduction,total_amount,snapshot,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(j1, snapshot.invoice_no, 4, 152000, 35000, 0, 187000, JSON.stringify(snapshot), users.zhou, snapshot.generated_at);

  // 模拟适配器场景：j2 返工单复测将达标；j4 今晚单首测会出现噪声异常
  adapter.setScenario(j2, 'rework');
  adapter.setScenario(j4, 'noise');

  return true;
}

module.exports = { seed };
