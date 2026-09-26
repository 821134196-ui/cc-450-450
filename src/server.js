'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { openDb, PHOTO_DIR } = require('./db');
const { createServices, DomainError } = require('./services');
const { MockAirAdapter } = require('./adapter');
const { createNotifier } = require('./notifier');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const { db, photoDir } = openDb(process.env.HOODCARE_DB || undefined);
  const adapter = new MockAirAdapter();
  const notifier = createNotifier(db);
  const svc = createServices({ db, photoDir, adapter, notify: notifier.notify });
  const seeded = seed({ db, photoDir, adapter });

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.code || 'error', message: err.message || String(err) });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      notifier.attach(res);
      return;
    }

    if (p.startsWith('/api/')) return api(req, res, url);

    // 照片
    const pm = p.match(/^\/photos\/(\d+)\/(.+)$/);
    if (pm) return serveFile(res, path.join(photoDir, pm[1], pm[2]), true);

    return serveStatic(req, res, p);
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    // 简易身份：X-User-Id 头（演示平台，无真实鉴权）
    const uid = req.headers['x-user-id'];
    const userId = uid ? Number(uid) : null;
    const S = svc;

    // 字典数据
    if (p === '/api/bootstrap' && req.method === 'GET') {
      return sendJson(res, 200, {
        users: db.prepare('SELECT * FROM users ORDER BY role,id').all(),
        teams: db.prepare('SELECT * FROM teams ORDER BY id').all(),
        stores: db.prepare('SELECT * FROM stores ORDER BY id').all(),
        segments: db.prepare(`SELECT hs.*, s.name AS store_name FROM hood_segments hs JOIN stores s ON s.id=hs.store_id ORDER BY hs.store_id,hs.id`).all()
          .map(x => ({ ...x, duct_points: JSON.parse(x.duct_points) })),
        notifications: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 30').all(),
      });
    }

    if (p === '/api/plans') {
      if (req.method === 'GET') return sendJson(res, 200, S.listPlans());
      if (req.method === 'POST') return sendJson(res, 200, S.upsertPlan({ ...body }));
    }
    if (p === '/api/windows') {
      if (req.method === 'GET') return sendJson(res, 200, S.listWindows());
      if (req.method === 'POST') return sendJson(res, 200, S.proposeWindow({ ...body }));
    }
    let m;
    if ((m = p.match(/^\/api\/windows\/(\d+)\/status$/)) && req.method === 'POST')
      return sendJson(res, 200, S.setWindowStatus(Number(m[1]), userId, body.status, body.note));

    if (p === '/api/jobs' && req.method === 'GET')
      return sendJson(res, 200, db.prepare(
        `SELECT j.*, s.name AS store_name, t.name AS team_name FROM jobs j
         JOIN stores s ON s.id=j.store_id JOIN teams t ON t.id=j.team_id ORDER BY j.scheduled_start DESC`).all());
    if (p === '/api/jobs/schedule' && req.method === 'POST')
      return sendJson(res, 200, S.scheduleJob({ ...body, userId }));
    if ((m = p.match(/^\/api\/jobs\/(\d+)$/)) && req.method === 'GET')
      return sendJson(res, 200, S.jobDetail(Number(m[1])));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/start$/)) && req.method === 'POST')
      return sendJson(res, 200, S.startJob(Number(m[1]), userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/segments\/(\d+)\/filters$/)) && req.method === 'POST')
      return sendJson(res, 200, S.registerFilters(Number(m[1]), Number(m[2]), body, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/segments\/(\d+)\/advance$/)) && req.method === 'POST')
      return sendJson(res, 200, S.advanceSegment(Number(m[1]), Number(m[2]), body.step, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/photos$/)) && req.method === 'POST')
      return sendJson(res, 200, S.addPhoto(Number(m[1]), body, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/reassembly$/)) && req.method === 'POST')
      return sendJson(res, 200, S.reassemblyCheck(Number(m[1]), body.items || [], userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/air-test$/)) && req.method === 'POST')
      return sendJson(res, 200, S.runAirTest(Number(m[1]), userId, body));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/addons$/)) && req.method === 'POST')
      return sendJson(res, 200, S.requestAddon(Number(m[1]), body, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/readiness$/)) && req.method === 'GET')
      return sendJson(res, 200, S.acceptanceReadiness(Number(m[1])));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/acceptance$/)) && req.method === 'POST')
      return sendJson(res, 200, S.decideAcceptance(Number(m[1]), body.conclusion, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/rework-redo$/)) && req.method === 'POST')
      return sendJson(res, 200, S.reworkRedo(Number(m[1]), userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/sign$/)) && req.method === 'POST')
      return sendJson(res, 200, S.storeSign(Number(m[1]), body, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/reject-sign$/)) && req.method === 'POST')
      return sendJson(res, 200, S.storeRejectSign(Number(m[1]), body, userId));
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/invoice$/)) && (req.method === 'POST' || req.method === 'GET'))
      return sendJson(res, 200, S.createInvoice(Number(m[1]), userId));

    if ((m = p.match(/^\/api\/photos\/(\d+)\/review$/)) && req.method === 'POST')
      return sendJson(res, 200, S.reviewPhoto(Number(m[1]), body, userId));
    if ((m = p.match(/^\/api\/addons\/(\d+)\/confirm$/)) && req.method === 'POST')
      return sendJson(res, 200, S.confirmAddon(Number(m[1]), userId, !!body.approved, body.reason));

    if (p === '/api/notifications' && req.method === 'GET')
      return sendJson(res, 200, db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all());

    sendJson(res, 404, { error: 'not_found', message: `未知接口 ${p}` });
  }

  function serveStatic(req, res, p) {
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    return serveFile(res, full, false);
  }

  return { server, db, svc, adapter, notifier, photoDir, seeded };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};
function serveFile(res, full, isPhoto) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      if (isPhoto) return sendJson(res, 404, { error: 'no_photo' });
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), false);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 12 * 1024 * 1024) reject(new DomainError('too_large', '请求体过大')); });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(new DomainError('bad_json', 'JSON 解析失败')); } });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

if (require.main === module) {
  const app = createApp();
  app.server.listen(PORT, () => {
    console.log('');
    console.log('  排烟罩清洗与验收平台已启动');
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  样例数据：${app.seeded ? '已初始化（正常 SG-DEMO-01 / 返工 SG-DEMO-02 / 拒签 SG-DEMO-03 / 今晚进行中 SG-DEMO-04）' : '沿用已有数据'}`);
    console.log('');
  });
}

module.exports = { createApp };
