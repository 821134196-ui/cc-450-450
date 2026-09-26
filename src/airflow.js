'use strict';
// 模拟风量测试适配器：按风管点位场景(profile)与尝试次数给出确定性的风量/噪声读数。
// 真实部署时替换为现场风速计/声级计驱动，接口保持 measure({profile, attempt}) 不变。
function createAirflowAdapter() {
  function measure({ profile, attempt }) {
    const jitter = (seed) => { // 确定性抖动，避免 Math.random 破坏可复现性
      const x = Math.sin(seed * 9973 + attempt * 131) * 10000;
      return (x - Math.floor(x)) * 0.6 - 0.3;
    };
    const seed = attempt * 7 + 3;
    switch (profile) {
      case 'dirty_first': // 首轮风量不足（油垢未清），复测后恢复
        return attempt === 1
          ? { velocity: 7.4 + jitter(seed), noise_db: 66 + jitter(seed) * 4 }
          : { velocity: 9.6 + jitter(seed), noise_db: 63 + jitter(seed) * 4 };
      case 'noisy_first': // 首轮噪声异常（风机共振），调整后复测正常
        return attempt === 1
          ? { velocity: 9.5 + jitter(seed), noise_db: 78 + jitter(seed) * 4 }
          : { velocity: 9.8 + jitter(seed), noise_db: 64 + jitter(seed) * 4 };
      case 'normal':
      default:
        return { velocity: 10.2 + jitter(seed), noise_db: 62 + jitter(seed) * 4 };
    }
  }
  return { measure };
}

module.exports = { createAirflowAdapter };
