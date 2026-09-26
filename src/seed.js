'use strict';
// 示例数据：示例门店/班组/人员，正常、返工、拒签三类样例工单
const fs = require('node:fs');
const path = require('node:path');
const { openDb, get, run } = require('./db');
const { createServices } = require('./services');
const { createAirflowAdapter } = require('./airflow');

function photoSvg(phase, label, angleOk) {
  const dirty = phase === 'before';
  const grease = dirty
    ? `<g opacity="0.75">
         <ellipse cx="150" cy="170" rx="46" ry="16" fill="#7a5230"/>
         <ellipse cx="250" cy="180" rx="60" ry="20" fill="#6b4727"/>
         <ellipse cx="340" cy="165" rx="38" ry="13" fill="#7d5634"/>
         <path d="M150 182 q4 26 -2 44" stroke="#5b3a1e" stroke-width="5" fill="none" stroke-linecap="round"/>
         <path d="M250 192 q-6 30 3 52" stroke="#5b3a1e" stroke-width="6" fill="none" stroke-linecap="round"/>
         <path d="M330 174 q8 24 0 40" stroke="#5b3a1e" stroke-width="4" fill="none" stroke-linecap="round"/>
       </g>`
    : `<g opacity="0.9">
         <path d="M110 120 L150 210" stroke="#ffffff" stroke-width="7" opacity="0.55" stroke-linecap="round"/>
         <path d="M190 110 L215 215" stroke="#ffffff" stroke-width="4" opacity="0.4" stroke-linecap="round"/>
         <circle cx="360" cy="90" r="26" fill="#2faa6e"/>
         <path d="M347 90 l10 11 18 -22" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
       </g>`;
  const angleWarn = angleOk ? '' :
    `<rect x="8" y="8" width="464" height="304" fill="none" stroke="#e0524d" stroke-width="4" stroke-dasharray="12 8"/>
     <text x="240" y="40" text-anchor="middle" font-size="22" fill="#e0524d" font-family="sans-serif">角度偏差超标</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
  <defs>
    <linearGradient id="steel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${dirty ? '#8d939b' : '#c9ced6'}"/>
      <stop offset="0.5" stop-color="${dirty ? '#6f7680' : '#aeb5bf'}"/>
      <stop offset="1" stop-color="${dirty ? '#585e68' : '#939ba6'}"/>
    </linearGradient>
  </defs>
  <rect width="480" height="320" fill="#23262b"/>
  <polygon points="80,90 400,90 360,210 120,210" fill="url(#steel)" stroke="#45494f" stroke-width="2"/>
  <rect x="120" y="210" width="240" height="16" fill="#70757d"/>
  ${grease}
  <g stroke="#35c9c2" stroke-width="1.5" opacity="0.85">
    <rect x="66" y="76" width="348" height="164" fill="none"/>
    <line x1="240" y1="70" x2="240" y2="252" stroke-dasharray="5 6"/>
    <line x1="60" y1="158" x2="420" y2="158" stroke-dasharray="5 6"/>
    <path d="M66 92 h18 M66 92 v18 M414 92 h-18 M414 92 v18 M66 224 h18 M66 224 v-18 M414 224 h-18 M414 224 v-18" stroke-width="2.5"/>
  </g>
  <text x="80" y="286" font-size="16" fill="#c9ced6" font-family="sans-serif">${label} · ${dirty ? '清洗前 BEFORE' : '清洗后 AFTER'}</text>
  <text x="240" y="306" text-anchor="middle" font-size="13" fill="#5fd6d0" font-family="sans-serif">统一机位 / 角度参考线</text>
  ${angleWarn}
</svg>`;
}

function signSvg(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140">
  <rect width="320" height="140" fill="#f5f6f4"/>
  <line x1="20" y1="120" x2="300" y2="120" stroke="#3a3d42" stroke-width="1.5"/>
  <path d="M60 95 q30 -70 60 -10 q20 40 45 -25 q15 -30 40 5 q15 18 35 -8"
        stroke="#1f6f4a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  <text x="238" y="108" font-size="16" fill="#1f6f4a" font-family="sans-serif">${name}</text>
</svg>`;
}

function isoOffset(base, hours) {
  return new Date(base.getTime() + hours * 3600000).toISOString();
}

function seed(db, photoDir, t0) {
  t0 = t0 || new Date();
  fs.mkdirSync(photoDir, { recursive: true });
  db.exec(`DELETE FROM notifications; DELETE FROM settlements; DELETE FROM acceptances;
           DELETE FROM exceptions; DELETE FROM addons; DELETE FROM airflow_tests;
           DELETE FROM photos; DELETE FROM steps; DELETE FROM job_segments; DELETE FROM jobs;
           DELETE FROM windows; DELETE FROM plans; DELETE FROM duct_points;
           DELETE FROM segments; DELETE FROM hoods; DELETE FROM staff;
           DELETE FROM stores; DELETE FROM crews;`);
  // sqlite 序列不重置无妨，自增即可

  const svc = createServices(db, { now: () => t0.toISOString(), photoDir });
  const adapter = createAirflowAdapter();

  // ---------- 组织与人员 ----------
  run(db, `INSERT INTO crews(id,name) VALUES(1,'A组·王强班组'),(2,'B组·李刚班组')`);
  const stores = [
    { id: 1, code: 'S001', name: '金鼎轩（望京店）', contact: '黄敏', phone: '138-0001-1001',
      address: '北京市朝阳区望京 SOHO T1 5F', price: 26000 },
    { id: 2, code: 'S002', name: '海底捞（国贸店）', contact: '吴琳', phone: '138-0002-1002',
      address: '北京市朝阳区国贸中心 B2', price: 30000 },
    { id: 3, code: 'S003', name: '西贝莜面村（中关村店）', contact: '郑楠', phone: '138-0003-1003',
      address: '北京市海淀区中关村广场 3F', price: 24000 },
  ];
  for (const s of stores)
    run(db, `INSERT INTO stores(id,code,name,contact,phone,address,segment_price)
             VALUES(?,?,?,?,?,?,?)`, s.id, s.code, s.name, s.contact, s.phone, s.address, s.price);

  const staff = [
    [1, '林运维', 'admin', null, null, '139-0000-0000'],
    [2, '王强', 'crew_lead', 1, null, '139-1000-0001'],
    [3, '赵勇', 'worker', 1, null, '139-1000-0002'],
    [4, '孙磊', 'worker', 1, null, '139-1000-0003'],
    [5, '李刚', 'crew_lead', 2, null, '139-2000-0001'],
    [6, '周浩', 'worker', 2, null, '139-2000-0002'],
    [7, '陈静', 'inspector', null, null, '139-3000-0001'],
    [8, '刘洋', 'finance', null, null, '139-4000-0001'],
    [9, '黄敏', 'store_manager', null, 1, '138-0001-1001'],
    [10, '吴琳', 'store_manager', null, 2, '138-0002-1002'],
    [11, '郑楠', 'store_manager', null, 3, '138-0003-1003'],
  ];
  for (const s of staff)
    run(db, `INSERT INTO staff(id,name,role,crew_id,store_id,phone) VALUES(?,?,?,?,?,?)`, ...s);
  const U = Object.fromEntries(staff.map(s => [s[1], { id: s[0], name: s[1], role: s[2] }]));

  // ---------- 罩体 / 分段 / 风管点位 ----------
  function buildHood(storeId, profiles) {
    const hid = run(db, `INSERT INTO hoods(store_id,name,model) VALUES(?, '主厨房排烟罩', 'JSY-2400 不锈钢集烟罩')`, storeId).lastId;
    const seqNames = ['A 段（炒灶区）', 'B 段（煲仔区）', 'C 段（蒸制区）', 'D 段（出餐区）'];
    for (let i = 0; i < 4; i++) {
      run(db, `INSERT INTO segments(hood_id,seq,name,length_m,filter_count) VALUES(?,?,?,2.4,2)`,
        hid, i + 1, seqNames[i]);
    }
    const p1 = run(db, `INSERT INTO duct_points(hood_id,name,position,profile) VALUES(?, 'P1 主风管测点', '罩体中部集烟腔', ?)`,
      hid, profiles[0]).lastId;
    const p2 = run(db, `INSERT INTO duct_points(hood_id,name,position,profile) VALUES(?, 'P2 支管测点', '末端弯头前', ?)`,
      hid, profiles[1]).lastId;
    return { hid, p1, p2 };
  }
  const h1 = buildHood(1, ['normal', 'normal']);
  const h2 = buildHood(2, ['dirty_first', 'normal']);
  const h3 = buildHood(3, ['normal', 'noisy_first']);

  // ---------- 周期计划 ----------
  const plans = [
    [1, '季度清洗', 90, isoOffset(t0, -88), isoOffset(t0, 2)],
    [2, '季度清洗', 90, isoOffset(t0, -85), isoOffset(t0, 5)],
    [3, '月度清洗', 30, isoOffset(t0, -26), isoOffset(t0, 4)],
  ];
  for (const p of plans)
    run(db, `INSERT INTO plans(store_id,cycle_label,interval_days,last_done,next_due,status)
             VALUES(?,?,?,?,?,'active')`, ...p);

  // ---------- 照片写入本地目录 ----------
  function photoFile(name, svg) {
    const fp = path.join(photoDir, name);
    fs.writeFileSync(fp, svg, 'utf8');
    return `photos/${name}`;
  }

  // ================= 样例 1：正常工单（已验收签字 + 结算已复核） =================
  const w1Start = isoOffset(t0, -26), w1End = isoOffset(t0, -22);
  const w1 = svc.proposeWindow(U['陈静'], { store_id: 1, start_ts: w1Start, end_ts: w1End, note: '商场凌晨停业时段' });
  svc.confirmWindow(U['黄敏'], w1.id);
  const j1 = svc.scheduleJob(U['陈静'], {
    store_id: 1, hood_id: h1.hid, crew_id: 1, window_id: w1.id,
    sched_start: w1Start, sched_end: isoOffset(t0, -23),
  });
  svc.startJob(U['王强'], j1.id);
  const segs1 = svc.jobDetail(j1.id).segments;
  for (const js of segs1) {
    svc.recordStep(U['赵勇'], j1.id, js.id, 'disassemble',
      { filters_removed: 2, filters_damaged: 0, grease_level: js.seq === 1 ? 3 : 2 });
    const fp = photoFile(`job1_seg${js.seq}_before.svg`, photoSvg('before', `${js.seg_name}`, true));
    run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
             VALUES(?,?, 'before',0,1,?,?,?)`,
      j1.id, js.id, fp, U['赵勇'].id, t0.toISOString());
    svc.recordStep(U['赵勇'], j1.id, js.id, 'wash', {});
    svc.recordStep(U['孙磊'], j1.id, js.id, 'dry', {});
    const fa = photoFile(`job1_seg${js.seq}_after.svg`, photoSvg('after', `${js.seg_name}`, true));
    run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
             VALUES(?,?, 'after',0,1,?,?,?)`,
      j1.id, js.id, fa, U['孙磊'].id, t0.toISOString());
    svc.recordStep(U['王强'], j1.id, js.id, 'reassemble', { filters_reinstalled: 2 });
    svc.recordStep(U['王强'], j1.id, js.id, 'trial', {});
  }
  svc.measureAirflow(U['陈静'], j1.id, h1.p1, adapter);
  svc.measureAirflow(U['陈静'], j1.id, h1.p2, adapter);
  svc.submitAcceptance(U['陈静'], j1.id, '各段复装齐全、前后照片角度合格，风量复测达标。');
  svc.signAcceptance(U['黄敏'], j1.id,
    'data:image/svg+xml;base64,' + Buffer.from(signSvg('黄敏')).toString('base64'));
  const st1 = svc.createSettlement(U['刘洋'], j1.id);
  svc.reviewSettlement(U['刘洋'], st1.id);

  // ================= 样例 2：返工工单（首轮风量不足被打回，第 2 轮进行中） =================
  const w2Start = isoOffset(t0, -6), w2End = isoOffset(t0, -2);
  const w2 = svc.proposeWindow(U['陈静'], { store_id: 2, start_ts: w2Start, end_ts: w2End, note: '上午低峰停灶' });
  svc.confirmWindow(U['吴琳'], w2.id);
  const j2 = svc.scheduleJob(U['陈静'], {
    store_id: 2, hood_id: h2.hid, crew_id: 2, window_id: w2.id,
    sched_start: w2Start, sched_end: isoOffset(t0, -3),   // 已过结束时间 → 超时提醒
  });
  svc.startJob(U['李刚'], j2.id);
  const segs2r1 = svc.jobDetail(j2.id).segments;
  for (const js of segs2r1) {
    svc.recordStep(U['周浩'], j2.id, js.id, 'disassemble',
      { filters_removed: 2, grease_level: 3 });
    const fp = photoFile(`job2r1_seg${js.seq}_before.svg`, photoSvg('before', js.seg_name, true));
    run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
             VALUES(?,?, 'before',0,1,?,?,?)`, j2.id, js.id, fp, U['周浩'].id, t0.toISOString());
    svc.recordStep(U['周浩'], j2.id, js.id, 'wash', {});
    svc.recordStep(U['周浩'], j2.id, js.id, 'dry', {});
    const fa = photoFile(`job2r1_seg${js.seq}_after.svg`, photoSvg('after', js.seg_name, true));
    run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
             VALUES(?,?, 'after',0,1,?,?,?)`, j2.id, js.id, fa, U['周浩'].id, t0.toISOString());
    svc.recordStep(U['李刚'], j2.id, js.id, 'reassemble', { filters_reinstalled: 2 });
    svc.recordStep(U['李刚'], j2.id, js.id, 'trial', {});
  }
  const m1 = svc.measureAirflow(U['陈静'], j2.id, h2.p1, adapter); // dirty_first 首轮不过
  svc.measureAirflow(U['陈静'], j2.id, h2.p2, adapter);
  svc.requestRework(U['陈静'], j2.id,
    `P1 主风管测点风量仅 ${m1.velocity.toFixed(1)}m/s，疑似 A 段集烟腔油垢残留，返工重做并复测。`);
  // 第 2 轮：A 段已拆卸，检出重油污 + 1 片滤网损坏；前照片角度不合格，待重拍
  const r2 = svc.jobDetail(j2.id);
  const segA = r2.segments[0];
  svc.recordStep(U['李刚'], j2.id, segA.id, 'disassemble',
    { filters_removed: 2, filters_damaged: 1, grease_level: 4 });
  const bad = photoFile(`job2r2_segA_before_bad.svg`, photoSvg('before', segA.seg_name, false));
  run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
           VALUES(?,?, 'before',26,0,?,?,?)`, j2.id, segA.id, bad, U['周浩'].id, t0.toISOString());
  run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
           VALUES(?, 'photo_angle', 'A 段返工前照片角度偏差 26°，超出参考线容差 ±10°，需按统一机位重拍','open',?,?)`,
    j2.id, U['周浩'].id, t0.toISOString());

  // ================= 样例 3：拒签工单（验收通过但门店拒签，争议待处理） =================
  const w3Start = isoOffset(t0, -9), w3End = isoOffset(t0, -5);
  const w3 = svc.proposeWindow(U['陈静'], { store_id: 3, start_ts: w3Start, end_ts: w3End, note: '商场统一检修时段' });
  svc.confirmWindow(U['郑楠'], w3.id);
  const j3 = svc.scheduleJob(U['陈静'], {
    store_id: 3, hood_id: h3.hid, crew_id: 1, window_id: w3.id,
    sched_start: w3Start, sched_end: isoOffset(t0, -6),
  });
  svc.startJob(U['王强'], j3.id);
  const segs3 = svc.jobDetail(j3.id).segments;
  for (const js of segs3) {
    svc.recordStep(U['赵勇'], j3.id, js.id, 'disassemble',
      { filters_removed: 2, grease_level: 2 });
    const fp = photoFile(`job3_seg${js.seq}_before.svg`, photoSvg('before', js.seg_name, true));
    run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
             VALUES(?,?, 'before',0,1,?,?,?)`, j3.id, js.id, fp, U['赵勇'].id, t0.toISOString());
    svc.recordStep(U['赵勇'], j3.id, js.id, 'wash', {});
    svc.recordStep(U['孙磊'], j3.id, js.id, 'dry', {});
    const fa = photoFile(`job3_seg${js.seq}_after.svg`, photoSvg('after', js.seg_name, true));
    run(db, `INSERT INTO photos(job_id,job_segment_id,phase,angle_deg,angle_ok,file_path,uploaded_by,created_at)
             VALUES(?,?, 'after',0,1,?,?,?)`, j3.id, js.id, fa, U['孙磊'].id, t0.toISOString());
    svc.recordStep(U['王强'], j3.id, js.id, 'reassemble', { filters_reinstalled: 2 });
    svc.recordStep(U['王强'], j3.id, js.id, 'trial', {});
  }
  svc.measureAirflow(U['陈静'], j3.id, h3.p1, adapter);
  svc.measureAirflow(U['陈静'], j3.id, h3.p2, adapter); // noisy_first 首轮噪声异常
  svc.measureAirflow(U['陈静'], j3.id, h3.p2, adapter); // 第 2 次正常，异常闭环
  svc.submitAcceptance(U['陈静'], j3.id, '返工后噪声消除，风量达标，复装齐全。');
  svc.refuseSign(U['郑楠'], j3.id, 'C 段罩面仍可见少量油痕，要求免费补洗后再签。');

  // ---------- 一个待确认窗口（演示：未确认不能排班） ----------
  svc.proposeWindow(U['陈静'], {
    store_id: 1,
    start_ts: isoOffset(t0, 26), end_ts: isoOffset(t0, 30),
    note: '拟用次日凌晨停业时段',
  });

  return { ids: { jobNormal: j1.id, jobRework: j2.id, jobRefused: j3.id } };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const dbPath = process.env.DB_PATH || path.join(root, 'data', 'hoodcare.db');
  const photoDir = process.env.PHOTO_DIR || path.join(root, 'data', 'photos');
  const db = openDb(dbPath);
  const result = seed(db, photoDir);
  console.log('种子数据完成:', result.ids);
}

module.exports = { seed, photoSvg, signSvg };
