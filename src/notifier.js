'use strict';
// 进程内任务推送：写入通知表 + SSE 广播；定时扫描周期到期与施工超时
function createNotifier(db) {
  const clients = new Set();

  function notify(type, title, body, refType, refId) {
    const r = db.prepare(
      'INSERT INTO notifications(type,title,body,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(type, title, body || null, refType || null, refId || null, new Date().toISOString());
    const item = db.prepare('SELECT * FROM notifications WHERE id=?').get(r.lastInsertRowid);
    for (const res of clients) {
      try { res.write(`data: ${JSON.stringify(item)}\n\n`); } catch { clients.delete(res); }
    }
    return item;
  }

  function attach(res) {
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', title: '已连接提醒通道' })}\n\n`);
    res.on('close', () => clients.delete(res));
  }

  // 周期到期 / 施工超时扫描
  function scan() {
    const today = new Date().toISOString().slice(0, 10);
    const due = db.prepare(
      `SELECT cp.id, cp.next_due_date, s.name FROM cycle_plans cp
       JOIN stores s ON s.id=cp.store_id
       WHERE cp.active=1 AND cp.next_due_date <= date(?, '+3 days')`).all(today);
    for (const p of due) {
      const exists = db.prepare(
        "SELECT id FROM notifications WHERE type='cycle_due' AND ref_type='plan' AND ref_id=?").get(p.id);
      if (!exists) notify('cycle_due', '清洗周期临近到期',
        `${p.name} 计划清洗日 ${p.next_due_date}，请尽快协调停灶窗口`, 'plan', p.id);
    }
    const nowIso = new Date().toISOString();
    const running = db.prepare(
      `SELECT j.id, j.code, j.scheduled_end, s.name FROM jobs j JOIN stores s ON s.id=j.store_id
       WHERE j.status IN ('in_progress','cleaning','drying','reassembling','testing')`).all();
    for (const j of running) {
      if (new Date(j.scheduled_end) < new Date(nowIso)) {
        const exists = db.prepare(
          "SELECT id FROM notifications WHERE type='job_overtime' AND ref_type='job' AND ref_id=?").get(j.id);
        if (!exists) notify('job_overtime', '施工超时提醒',
          `${j.code}（${j.name}）已超过计划结束时间，请尽快收尾或申请延时`, 'job', j.id);
      }
    }
  }

  const timer = setInterval(scan, 30 * 1000);
  if (timer.unref) timer.unref();
  scan();

  return { notify, attach, scan };
}

module.exports = { createNotifier };
