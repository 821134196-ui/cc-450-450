'use strict';
// 进程内任务推送：周期计划到期提醒 + 施工超时提醒（轮询落库，前端轮询拉取）
const { all, get, run } = require('./db');

function createReminder(db, services, opts = {}) {
  const intervalMs = opts.intervalMs || 5000;
  const now = opts.now || (() => new Date().toISOString());
  let timer = null;

  function sweep() {
    const t = now();
    // 1) 清洗周期到期（未来 7 天内到期且尚无有效工单）
    const plans = all(db,
      `SELECT p.*, s.name AS store_name FROM plans p JOIN stores s ON s.id=p.store_id
       WHERE p.status='active'`);
    for (const p of plans) {
      const days = (new Date(p.next_due).getTime() - Date.parse(t)) / 86400000;
      if (days <= 7) {
        const active = get(db,
          `SELECT id FROM jobs WHERE store_id=? AND status IN ('scheduled','in_progress','acceptance_review') LIMIT 1`,
          p.store_id);
        if (!active) {
          services.notify('plan_due', days < 0 ? 'critical' : 'warn',
            `【${p.store_name}】${p.cycle_label} ${days < 0 ? '已逾期' : Math.ceil(days) + ' 天后到期'}（${p.next_due.slice(0, 10)}），请协调停灶窗口并排班`,
            { refKey: `plan_due:${p.id}:${p.next_due}` });
        }
      }
    }
    // 2) 施工超时：进行中工单超过排班结束时间
    const jobs = all(db, `SELECT * FROM jobs WHERE status='in_progress' AND sched_end < ?`, t);
    for (const j of jobs) {
      const open = get(db,
        `SELECT id FROM exceptions WHERE job_id=? AND type='overtime' AND status='open'`, j.id);
      if (!open) {
        run(db, `INSERT INTO exceptions(job_id,type,detail,status,created_by,created_at)
                 VALUES(?, 'overtime', ?, 'open', NULL, ?)`,
          j.id, `施工超出排班结束时间 ${j.sched_end}，需登记延时并与门店确认`, t);
        services.notify('overtime', 'critical',
          `工单 ${j.job_no} 施工超时（计划 ${j.sched_end.slice(11, 16)} 结束）`,
          { jobId: j.id, refKey: `overtime:${j.id}` });
      }
    }
    // 3) 停灶窗口临期未确认（24h 内开始）
    const wins = all(db, `SELECT * FROM windows WHERE status='proposed'`);
    for (const w of wins) {
      const hrs = (new Date(w.start_ts).getTime() - Date.parse(t)) / 3600000;
      if (hrs <= 24 && hrs > -2) {
        services.notify('window_pending', 'warn',
          `门店 #${w.store_id} 停灶窗口 ${w.start_ts.slice(5, 16).replace('T', ' ')} 临期仍未确认，无法排班`,
          { refKey: `window_urgent:${w.id}` });
      }
    }
  }

  return {
    sweep,
    start() { if (!timer) timer = setInterval(sweep, intervalMs); timer.unref?.(); return this; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createReminder };
