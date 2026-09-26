# 净厨 HoodCare — 餐饮后厨排烟罩清洗与验收平台

零第三方依赖（仅 Node.js ≥ 22 内置模块：`node:sqlite` / `http` / SSE）。覆盖
**周期计划 → 停灶协调 → 分段施工 → 照片对照 → 复装核验 → 门店签字 → 费用复核** 全流程。

## 一键启动

```bash
npm start          # http://localhost:8080 （PORT 可改端口）
```

首次启动自动建库（`data/hoodcare.db`）、在 `data/photos/<施工单>/` 写入示例照片，
并准备好四张样例施工单：

| 单号 | 场景 | 状态 |
|---|---|---|
| SG-DEMO-01 | **正常**：4 段全部完成、重油污+滤网损坏增项已确认、已签字已结算 | 已结算 |
| SG-DEMO-02 | **返工**：首测风量不足判定返工，整改复测达标后可合格签字 | 返工 |
| SG-DEMO-03 | **拒签**：验收合格但门店对超时费有异议拒签，争议解除后可补签结算 | 门店拒签 |
| SG-DEMO-04 | **今晚进行中**：全部段已拆卸登记，A 段已清洗（模拟适配器首测将报噪声异常） | 清洗中 |

右上角可切换当前登录人员（施工 / 验收员 / 财务 / 门店 / 计划调度），不同角色看到的操作不同。

## 测试

```bash
npm test
```

12 个用例覆盖：**排期互斥**、**步骤顺序**（段内 + 全局闸门）、**漏装/风量/噪声/照片角度阻断验收**、
**增项确认**、**验收权限**、**结算幂等**（按实际清洗段数出快照、重复提交不变化）。

## 核心业务规则

- **窗口先行**：门店确认停灶窗口后才能排班；排班必须落在窗口内；门店登记临时营业则禁止开工。
- **厨房时段互斥**：同一门店厨房在重叠时段只允许一个班组施工。
- **开工逐段登记**：开工后逐段登记拆卸滤网数量（损坏自动生成待门店确认的补装增项，不可重复登记）。
- **严格工序**：拆卸 → 清洗 → 干燥 → 复装 → 试运行；支持段内顺序与「所有段完成上一工序才能进入下一工序」全局闸门。
- **验收闸门**：复装核验无漏装、风量复测全部 ≥ 1200 m³/h 且噪声 ≤ 80dB、每段前后照片齐全且**最新一张**角度合格，
  才能提交合格验收。
- **权限分离**：施工人员只能推进工序、**不能修改验收结论**；财务只能生成结算单、**不能改动工序记录**；
  增项必须门店确认；只有门店能签字/拒签。
- **结算幂等**：按 `job_id` 唯一，出具时固化「实际清洗段数 × 单价 + 已确认增项」快照，重复请求返回同一快照。

## 异常处理入口

| 异常 | 处理 |
|---|---|
| 临时营业 | 停灶协调页登记，阻止开工并通知改期 |
| 重油污加项 / 施工超时 | 施工单内申报增项 → 门店确认后计入结算 |
| 滤网损坏 | 拆卸登记时自动生成补装增项，待门店确认 |
| 照片角度不合格 | 标记重拍；就绪校验取每段每阶段最新一张照片 |
| 施工超时 | 结束时按窗口计算超时分钟并生成待确认超时增项；进程内定时推送超时提醒 |
| 复测噪声异常 | 模拟适配器读数 >80dB，阻止验收，需排查后复测 |
| 门店拒签 | 保留验收员合格结论，仅标记拒签与原因；补签后可结算 |

## 技术形态

- `src/db.js`：`node:sqlite` schema（users/teams/stores/hood_segments/cycle_plans/shutdown_windows/
  jobs/job_segments/work_steps/photos/air_tests/addons/acceptances/invoices/notifications）。
- `src/services.js`：全部领域规则（无 HTTP 依赖，可单测）。
- `src/adapter.js`：风量/噪声模拟适配器，按施工单场景（normal / rework / noise）读数。
- `src/notifier.js`：进程内定时扫描周期到期与施工超时，写通知表并经 **SSE** 推送。
- `src/seed.js`：示例门店、班组、人员、罩体分段与四种场景数据。
- `src/server.js`：HTTP API + 静态资源 + `/photos/...` 照片服务 + `/api/events` SSE。
- `public/`：零依赖原生 JS 单页应用。

## 视觉

不锈钢灰 + 炭黑侧栏 + 清洁绿主色。施工单以**罩体分段示意条**（顶部排烟栅格 + 从左到右填充完成度）
替代普通卡片；照片对照区常驻**统一拍摄角度参考线**（45° 取景框 + 十字辅助线）；
签字页 56px 大按钮、5px 粗笔迹、`touch-action:none`，适配戴手套操作。

## 主要 API

| 方法 | 路径 | 角色 |
|---|---|---|
| GET/POST | `/api/plans` | 查看 / 调度维护周期 |
| GET/POST | `/api/windows`，`POST /api/windows/:id/status` | 发起窗口 / 门店确认·临时营业 |
| POST | `/api/jobs/schedule` | 调度/班长（窗口确认 + 互斥校验） |
| POST | `/api/jobs/:id/start` | 施工开工 |
| POST | `/api/jobs/:id/segments/:sid/filters` | 逐段登记滤网 |
| POST | `/api/jobs/:id/segments/:sid/advance` | 推进 clean/dry/reassemble/test_run |
| POST | `/api/jobs/:id/photos` | 前后照片（base64 落本地目录） |
| POST | `/api/jobs/:id/reassembly` | 复装核验（漏装检查） |
| POST | `/api/jobs/:id/air-test` | 风量/噪声（模拟适配器） |
| POST | `/api/jobs/:id/addons`，`POST /api/addons/:id/confirm` | 申报增项 / 门店确认 |
| POST | `/api/jobs/:id/acceptance` | **仅验收员**出具 pass/rework |
| POST | `/api/jobs/:id/sign` · `/reject-sign` | **仅门店**签字 / 拒签 |
| POST | `/api/jobs/:id/invoice` | **仅财务**结算（幂等快照） |

请求头 `X-User-Id` 标识当前人员（演示用，无真实鉴权）。
