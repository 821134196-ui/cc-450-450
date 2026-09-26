'use strict';
// 零依赖 HTTP 服务：REST API + 静态前端 + 本地照片目录
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { get } = require('./db');
const { ApiError } = require('./services');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

function createServer({ db, services, adapter, publicDir, photoDir }) {
  // 简单路由表：[method, pattern(分段), handler]
  const routes = [];
  const route = (method, pattern, handler) => {
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  };
  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  function currentUser(req) {
    const id = Number(req.headers['x-staff-id'] || 0);
    if (!id) return null;
    return get(db, `SELECT s.*, c.name AS crew_name FROM staff s
                    LEFT JOIN crews c ON c.id=s.crew_id WHERE s.id=?`, id) || null;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new ApiError(400, 'bad_json', '请求体不是合法 JSON'); }
  }

  // ---------------- API 路由 ----------------
  route('GET', '/api/meta', async () => ({
    roles: ['worker', 'crew_lead', 'inspector', 'finance', 'store_manager', 'admin'],
    constants: services.constants,
  }));
  route('GET', '/api/stores', async () => services.listStores());
  route('GET', '/api/stores/:id', async (req, p) => services.storeDetail(Number(p.id)));
  route('GET', '/api/staff', async () => services.listStaff());
  route('GET', '/api/plans', async () => services.listPlans());

  route('GET', '/api/windows', async (req, p, q) =>
    services.listWindows(q.store_id ? Number(q.store_id) : null));
  route('POST', '/api/windows', async (req, p, q, u, body) => services.proposeWindow(u, body));
  route('POST', '/api/windows/:id/confirm', async (req, p, q, u) => services.confirmWindow(u, Number(p.id)));
  route('POST', '/api/windows/:id/reject', async (req, p, q, u, body) =>
    services.rejectWindow(u, Number(p.id), body.note));

  route('GET', '/api/jobs', async (req, p, q) => services.listJobs(q));
  route('POST', '/api/jobs', async (req, p, q, u, body) => services.scheduleJob(u, body));
  route('GET', '/api/jobs/:id', async (req, p) => services.jobDetail(Number(p.id)));
  route('POST', '/api/jobs/:id/start', async (req, p, q, u) => services.startJob(u, Number(p.id)));
  route('POST', '/api/jobs/:id/hold', async (req, p, q, u, body) =>
    services.setTempOpen(u, Number(p.id), body.detail));
  route('POST', '/api/jobs/:id/resume', async (req, p, q, u) => services.resumeJob(u, Number(p.id)));

  route('POST', '/api/jobs/:id/segments/:jsId/steps/:step', async (req, p, q, u, body) =>
    services.recordStep(u, Number(p.id), Number(p.jsId), p.step, body));
  route('POST', '/api/jobs/:id/segments/:jsId/photos/:phase', async (req, p, q, u, body) =>
    services.savePhoto(u, Number(p.id), Number(p.jsId), p.phase, body));
  route('POST', '/api/jobs/:id/airflow/:pointId', async (req, p, q, u) =>
    services.measureAirflow(u, Number(p.id), Number(p.pointId), adapter));

  route('POST', '/api/jobs/:id/addons', async (req, p, q, u, body) =>
    services.createAddon(u, Number(p.id), body));
  route('POST', '/api/addons/:id/confirm', async (req, p, q, u, body) =>
    services.confirmAddon(u, Number(p.id), body.approve !== false));
  route('POST', '/api/exceptions/:id/resolve', async (req, p, q, u, body) =>
    services.resolveException(u, Number(p.id), body.resolution));

  route('GET', '/api/jobs/:id/gate', async (req, p) => {
    const job = services.jobDetail(Number(p.id));
    return services.acceptanceGate(job);
  });
  route('POST', '/api/jobs/:id/acceptance', async (req, p, q, u, body) =>
    services.submitAcceptance(u, Number(p.id), body.conclusion));
  route('POST', '/api/jobs/:id/rework', async (req, p, q, u, body) =>
    services.requestRework(u, Number(p.id), body.reason));
  route('POST', '/api/jobs/:id/sign', async (req, p, q, u, body) =>
    services.signAcceptance(u, Number(p.id), body.sign_image));
  route('POST', '/api/jobs/:id/refuse', async (req, p, q, u, body) =>
    services.refuseSign(u, Number(p.id), body.reason));
  route('POST', '/api/jobs/:id/resolve-refusal', async (req, p, q, u, body) =>
    services.resolveRefusal(u, Number(p.id), body.resolution));

  route('POST', '/api/jobs/:id/settlement', async (req, p, q, u) =>
    services.createSettlement(u, Number(p.id)));
  route('GET', '/api/settlements', async () => services.listSettlements());
  route('POST', '/api/settlements/:id/review', async (req, p, q, u) =>
    services.reviewSettlement(u, Number(p.id)));

  route('GET', '/api/notifications', async () => services.listNotifications());
  route('POST', '/api/notifications/:id/read', async (req, p) => {
    services.markRead(Number(p.id)); return { ok: true };
  });

  // ---------------- 静态与照片 ----------------
  function serveFile(res, absPath) {
    if (!absPath.startsWith(publicDir) && !absPath.startsWith(photoDir)) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(absPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const query = Object.fromEntries(url.searchParams.entries());

      if (pathname.startsWith('/photos/')) {
        return serveFile(res, path.join(photoDir, pathname.slice('/photos/'.length)));
      }
      if (pathname.startsWith('/api/')) {
        const parts = pathname.split('/').filter(Boolean);
        for (const r of routes) {
          if (r.method !== req.method || r.parts.length !== parts.length) continue;
          const params = {};
          let ok = true;
          for (let i = 0; i < parts.length; i++) {
            if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = parts[i];
            else if (r.parts[i] !== parts[i]) { ok = false; break; }
          }
          if (!ok) continue;
          const user = currentUser(req);
          const body = req.method === 'GET' ? {} : await readBody(req);
          const result = await r.handler(req, params, query, user, body);
          return json(res, 200, result ?? { ok: true });
        }
        throw new ApiError(404, 'not_found', `接口不存在 ${req.method} ${pathname}`);
      }
      // 前端静态资源（SPA 回退到 index.html）
      let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      let abs = path.join(publicDir, rel);
      if (!abs.startsWith(publicDir)) { res.writeHead(403); return res.end('forbidden'); }
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) abs = path.join(publicDir, 'index.html');
      return serveFile(res, abs);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[server]', e);
      return json(res, status, { error: { code: e.code || 'internal', message: e.message || String(e) } });
    }
  });
  return server;
}

module.exports = { createServer };
