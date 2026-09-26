'use strict';
// SQLite 数据层：工序记录与结算快照持久化（node:sqlite，零依赖）
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS crews (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  address TEXT,
  segment_price INTEGER NOT NULL DEFAULT 26000  -- 每段清洗单价（分）
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,              -- worker|crew_lead|inspector|finance|store_manager|admin
  crew_id INTEGER REFERENCES crews(id),
  store_id INTEGER REFERENCES stores(id),
  phone TEXT
);

CREATE TABLE IF NOT EXISTS hoods (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  name TEXT NOT NULL,
  model TEXT
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  hood_id INTEGER NOT NULL REFERENCES hoods(id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  length_m REAL NOT NULL DEFAULT 1.2,
  filter_count INTEGER NOT NULL DEFAULT 2   -- 应装滤网数量
);

CREATE TABLE IF NOT EXISTS duct_points (
  id INTEGER PRIMARY KEY,
  hood_id INTEGER NOT NULL REFERENCES hoods(id),
  name TEXT NOT NULL,
  position TEXT,
  profile TEXT NOT NULL DEFAULT 'normal'    -- 模拟适配器场景: normal|dirty_first|noisy_first
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  cycle_label TEXT NOT NULL,                -- 如 季度清洗
  interval_days INTEGER NOT NULL DEFAULT 90,
  last_done TEXT,
  next_due TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS windows (        -- 停灶窗口
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed|confirmed|rejected
  proposed_by INTEGER,
  confirmed_by INTEGER,
  confirmed_at TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  job_no TEXT UNIQUE NOT NULL,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  hood_id INTEGER NOT NULL REFERENCES hoods(id),
  crew_id INTEGER NOT NULL REFERENCES crews(id),
  window_id INTEGER REFERENCES windows(id),
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|in_progress|acceptance_review|accepted|refused|settled|cancelled
  sched_start TEXT NOT NULL,
  sched_end TEXT NOT NULL,
  on_hold INTEGER NOT NULL DEFAULT 0,       -- 临时营业挂起
  started_at TEXT,
  finished_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_segments (   -- 分段施工单
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  segment_id INTEGER NOT NULL REFERENCES segments(id),
  round INTEGER NOT NULL DEFAULT 1,         -- 返工轮次
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|disassembled|washed|dried|reassembled|done
  grease_level INTEGER,                     -- 油污等级 1-5
  filters_removed INTEGER,
  filters_damaged INTEGER NOT NULL DEFAULT 0,
  filters_reinstalled INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS steps (          -- 工序记录（财务只读）
  id INTEGER PRIMARY KEY,
  job_segment_id INTEGER NOT NULL REFERENCES job_segments(id),
  round INTEGER NOT NULL DEFAULT 1,
  step TEXT NOT NULL,                       -- disassemble|wash|dry|reassemble|trial
  operator_id INTEGER NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS photos (         -- 前后照片（文件存本地目录，此处存路径）
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  job_segment_id INTEGER NOT NULL REFERENCES job_segments(id),
  phase TEXT NOT NULL,                      -- before|after
  angle_deg REAL NOT NULL DEFAULT 0,        -- 与统一拍摄角度的偏差
  angle_ok INTEGER NOT NULL DEFAULT 1,
  file_path TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS airflow_tests (  -- 风量复测（模拟适配器写值）
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  duct_point_id INTEGER NOT NULL REFERENCES duct_points(id),
  attempt INTEGER NOT NULL,
  velocity REAL NOT NULL,                   -- m/s
  noise_db REAL NOT NULL,
  passed INTEGER NOT NULL,
  noise_ok INTEGER NOT NULL,
  measured_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addons (         -- 现场增项（须门店确认）
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  type TEXT NOT NULL,                       -- heavy_grease|filter_replace|temp_open|other
  description TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL DEFAULT 0,        -- 分
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|confirmed|rejected
  created_by INTEGER NOT NULL,
  confirmed_by INTEGER,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS exceptions (     -- 异常事件
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  type TEXT NOT NULL,                       -- temp_open|heavy_grease|filter_damage|photo_angle|overtime|noise_abnormal|refuse_sign
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- open|resolved
  created_by INTEGER,
  created_at TEXT NOT NULL,
  resolved_by INTEGER,
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS acceptances (    -- 验收结论（施工人员不可改）
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  round INTEGER NOT NULL,
  result TEXT NOT NULL,                     -- passed|rework
  conclusion TEXT,
  inspector_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sign_status TEXT NOT NULL DEFAULT 'pending', -- pending|signed|refused|na
  signed_by INTEGER,
  signed_at TEXT,
  sign_image TEXT,
  refuse_reason TEXT
);

CREATE TABLE IF NOT EXISTS settlements (    -- 结算快照（幂等：每单一份）
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  snapshot_json TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review|reviewed
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (  -- 进程内提醒推送落库
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                       -- plan_due|overtime|window_pending|exception|acceptance|settlement
  level TEXT NOT NULL DEFAULT 'info',       -- info|warn|critical
  message TEXT NOT NULL,
  job_id INTEGER,
  ref_key TEXT,
  created_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_store ON jobs(store_id, status);
CREATE INDEX IF NOT EXISTS idx_steps_seg ON steps(job_segment_id, round);
CREATE INDEX IF NOT EXISTS idx_photos_seg ON photos(job_segment_id, phase);
CREATE INDEX IF NOT EXISTS idx_notif_ref ON notifications(ref_key);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// ---- 轻量查询助手 ----
function all(db, sql, ...params) { return db.prepare(sql).all(...params); }
function get(db, sql, ...params) { return db.prepare(sql).get(...params); }
function run(db, sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

module.exports = { openDb, all, get, run };
