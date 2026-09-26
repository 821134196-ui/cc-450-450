'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_PATH = process.env.HOODCARE_DB || path.join(DATA_DIR, 'hoodcare.db');

function ensureDirs() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

function openDb(file = DB_PATH) {
  ensureDirs();
  const isMemory = file === ':memory:';
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return { db, photoDir: isMemory ? PHOTO_DIR : path.join(path.dirname(file), 'photos') };
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('crew','inspector','finance','store','planner'))
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    leader_id INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL,
    phone TEXT,
    team_id INTEGER REFERENCES teams(id)
  );

  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT,
    address TEXT,
    contact TEXT,
    phone TEXT,
    kitchen_note TEXT
  );

  -- 罩体分段
  CREATE TABLE IF NOT EXISTS hood_segments (
    id INTEGER PRIMARY KEY,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    code TEXT NOT NULL,           -- A / B / C ...
    name TEXT NOT NULL,
    length_m REAL NOT NULL DEFAULT 1.2,
    filters_expected INTEGER NOT NULL DEFAULT 2,  -- 标准滤网位数
    duct_points TEXT NOT NULL DEFAULT '[]'        -- JSON: 风管测点名称
  );

  -- 清洗周期计划
  CREATE TABLE IF NOT EXISTS cycle_plans (
    id INTEGER PRIMARY KEY,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    period_days INTEGER NOT NULL DEFAULT 60,
    next_due_date TEXT NOT NULL,  -- YYYY-MM-DD
    heavy_oil INTEGER NOT NULL DEFAULT 0,  -- 重油污门店
    active INTEGER NOT NULL DEFAULT 1
  );

  -- 停灶窗口：门店确认后才能排班
  CREATE TABLE IF NOT EXISTS shutdown_windows (
    id INTEGER PRIMARY KEY,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    start_at TEXT NOT NULL,       -- ISO
    end_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed','confirmed','temporary_business','cancelled')),
    note TEXT,
    confirmed_at TEXT,
    confirmed_by INTEGER REFERENCES users(id)
  );

  -- 施工单
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    window_id INTEGER REFERENCES shutdown_windows(id),
    scheduled_start TEXT NOT NULL,
    scheduled_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled','in_progress','cleaning','drying','reassembling',
                        'testing','acceptance','completed','rework','rejected_sign','settled')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    overtime_minutes INTEGER NOT NULL DEFAULT 0,
    plan_segment_count INTEGER NOT NULL DEFAULT 0
  );

  -- 施工单 × 分段（开工时逐段登记滤网数量）
  CREATE TABLE IF NOT EXISTS job_segments (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    segment_id INTEGER NOT NULL REFERENCES hood_segments(id),
    seq INTEGER NOT NULL,
    filters_removed INTEGER,          -- 拆卸登记数量，未开工为 NULL
    registered_by INTEGER REFERENCES users(id),
    registered_at TEXT,
    damaged_filters INTEGER NOT NULL DEFAULT 0,
    damage_note TEXT,
    step TEXT NOT NULL DEFAULT 'pending'
      CHECK (step IN ('pending','removed','cleaned','dried','reassembled','tested')),
    UNIQUE (job_id, segment_id)
  );

  -- 工序记录（财务不可改；只追加）
  CREATE TABLE IF NOT EXISTS work_steps (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    job_segment_id INTEGER REFERENCES job_segments(id),
    step TEXT NOT NULL CHECK (step IN ('remove','clean','dry','reassemble','test_run')),
    operator_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );

  -- 照片：本地目录存储
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    job_segment_id INTEGER REFERENCES job_segments(id),
    phase TEXT NOT NULL CHECK (phase IN ('before','after')),
    file_name TEXT NOT NULL,
    angle_ok INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  -- 风量/噪声复测（模拟适配器写入）
  CREATE TABLE IF NOT EXISTS air_tests (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    point_name TEXT NOT NULL,
    airflow REAL NOT NULL,           -- m3/h
    threshold REAL NOT NULL DEFAULT 1200,
    passed INTEGER NOT NULL,
    is_retest INTEGER NOT NULL DEFAULT 0,
    noise_db REAL,
    noise_abnormal INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
  );

  -- 现场增项：必须先获得门店确认
  CREATE TABLE IF NOT EXISTS addons (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL CHECK (kind IN ('heavy_oil','temporary_business','filter_damage','overtime','other')),
    description TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,   -- 分
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','confirmed','rejected')),
    requested_by INTEGER REFERENCES users(id),
    requested_at TEXT NOT NULL,
    confirmed_at TEXT,
    confirmed_by INTEGER REFERENCES users(id),
    reject_reason TEXT
  );

  -- 验收结论（施工人员不可修改）
  CREATE TABLE IF NOT EXISTS acceptances (
    job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
    conclusion TEXT CHECK (conclusion IN ('pass','rework','rejected_sign')),
    inspector_id INTEGER REFERENCES users(id),
    reassembly_passed INTEGER NOT NULL DEFAULT 0,  -- 复装核验：无漏装
    air_retest_passed INTEGER NOT NULL DEFAULT 0,  -- 风量复测通过且无噪声异常
    photos_angle_passed INTEGER NOT NULL DEFAULT 0,
    decided_at TEXT,
    store_signed INTEGER NOT NULL DEFAULT 0,
    store_rejected INTEGER NOT NULL DEFAULT 0,  -- 门店拒签（保留验收员原结论）
    signed_by_name TEXT,
    signed_at TEXT,
    sign_file TEXT,
    sign_note TEXT
  );

  -- 结算单（按 job_id 唯一 -> 幂等；保存快照）
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    invoice_no TEXT UNIQUE NOT NULL,
    segment_count INTEGER NOT NULL,
    base_amount INTEGER NOT NULL DEFAULT 0,    -- 分
    addon_amount INTEGER NOT NULL DEFAULT 0,
    damage_deduction INTEGER NOT NULL DEFAULT 0,
    total_amount INTEGER NOT NULL DEFAULT 0,
    snapshot TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    ref_type TEXT,
    ref_id INTEGER,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_store ON jobs(store_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_team_time ON jobs(team_id, scheduled_start, scheduled_end);
  CREATE INDEX IF NOT EXISTS idx_segments_store ON hood_segments(store_id);
  `);
  // 旧库兼容
  const cols = db.prepare("PRAGMA table_info(acceptances)").all().map(c => c.name);
  if (!cols.includes('store_rejected')) db.exec('ALTER TABLE acceptances ADD COLUMN store_rejected INTEGER NOT NULL DEFAULT 0');
}

module.exports = { openDb, DATA_DIR, PHOTO_DIR, DB_PATH };
