'use strict';
// 一条命令启动全套服务：node run.js  （npm start）
// 自动建库、首次启动写入正常/返工/拒签样例，启动 API、静态前端与进程内提醒。
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./src/db');
const { createServices } = require('./src/services');
const { createAirflowAdapter } = require('./src/airflow');
const { createReminder } = require('./src/reminders');
const { createServer } = require('./src/server');
const { seed } = require('./src/seed');

const root = __dirname;
const PORT = Number(process.env.PORT || 5180);
const dataDir = path.join(root, 'data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'hoodcare.db');
const photoDir = process.env.PHOTO_DIR || path.join(dataDir, 'photos');
const publicDir = path.join(root, 'public');

const reset = process.argv.includes('--reset');
if (reset && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}
const firstRun = !fs.existsSync(dbPath);
const db = openDb(dbPath);
const services = createServices(db, { photoDir });
const adapter = createAirflowAdapter();

if (firstRun || reset) {
  console.log('▶ 准备示例数据（正常 / 返工 / 拒签 三样例）…');
  const result = seed(db, photoDir);
  console.log('  样例工单：', result.ids);
}

// 启动即扫描一次到期/超时，然后每 5 秒轮询
const reminder = createReminder(db, services, { intervalMs: 5000 });
reminder.sweep();
reminder.start();

const server = createServer({ db, services, adapter, publicDir, photoDir });
server.listen(PORT, () => {
  console.log('');
  console.log('  排烟罩清洗与验收平台已启动');
  console.log(`  ▸ 工作台    http://localhost:${PORT}/`);
  console.log(`  ▸ SQLite   ${dbPath}`);
  console.log(`  ▸ 现场照片  ${photoDir}`);
  console.log('  ▸ 切换身份：页面右上角选择（验收员/财务/门店经理/班组长/施工员）');
  console.log('  ▸ 重置样例：npm start -- --reset');
  console.log('');
});

process.on('SIGINT', () => { reminder.stop(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { reminder.stop(); server.close(() => process.exit(0)); });
