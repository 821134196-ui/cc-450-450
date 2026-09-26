'use strict';
// 模拟适配器：给出风量测试值与噪声值。
// 通过 job.code 的场景标记返回不同读数：正常 / 返工(首次不达标，复测达标) / 噪声异常
const { AIRFLOW_THRESHOLD, NOISE_LIMIT } = require('./services');

class MockAirAdapter {
  constructor() {
    // jobId -> 场景
    this.scenarios = new Map();
    // jobId -> 已测试次数
    this.attempts = new Map();
  }
  setScenario(jobId, scenario) { this.scenarios.set(jobId, scenario); }

  measure(job, point, opts = {}) {
    const scenario = this.scenarios.get(job.id) || 'normal';
    const n = (this.attempts.get(job.id) || 0) + 1;
    this.attempts.set(job.id, opts.is_retest ? n : n);

    // 稳定的伪随机（基于测点字符），同一单同一点复测有差异
    const seed = [...String(point)].reduce((a, c) => a + c.charCodeAt(0), 0);
    const jitter = (seed % 7) * 8;

    if (scenario === 'rework' && !opts.is_retest) {
      return { airflow: AIRFLOW_THRESHOLD - 150 - jitter, noise_db: 68 + (seed % 5), noise_abnormal: false };
    }
    if (scenario === 'noise') {
      // 噪声始终异常，需要排查（样例演示复测噪声异常处理）
      return { airflow: AIRFLOW_THRESHOLD + 220 + jitter, noise_db: NOISE_LIMIT + 6 + (seed % 4), noise_abnormal: true };
    }
    // normal / rework 复测
    return {
      airflow: AIRFLOW_THRESHOLD + 180 + jitter,
      noise_db: 64 + (seed % 9),
      noise_abnormal: false,
    };
  }
}

module.exports = { MockAirAdapter };
