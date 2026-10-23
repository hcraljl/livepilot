# 成员 A · 前端任务清单与工程规范

> **角色**：前端 / 实时看板（Dashboard）模块主责 · 独占 `frontend/`
> **依据**：《方案确认书.md》《模块设计树.md》《团队分工与开发地图.md》《API.md》
> **适用范围**：v0.1.0（M1 脚手架）→ v1.0.0（10/24 提交版）
> **生成时间**：2026-10-22 · 维护人：A · 规范变更走 PR（见 §3.5）

---

## 0. 范围澄清

| 问题 | 结论 |
|---|---|
| 「看板（Kanban）」指什么？ | 本项目「看板」= **实时数据看板（Dashboard）**，非 Kanban 任务看板；项目内**不存在** Kanban 模块。A 的职责以《团队分工与开发地图.md》第 2 节为准 |
| A 拥有什么 | `frontend/` 全部：App / SplitView / useSSE / 9 个组件（含本文件新增的 ProductRanking、ControlBar，见 §6-G4/G5） |
| A 消费什么 | `shared/types.ts`（类型契约）+ `API.md`（REST/SSE 契约），均由 B 冻结后**只读消费** |
| A 不做什么 | 不直接调用 Polyv OpenAPI；不写编排/决策/归因逻辑；不改 `backend/` 及他人文档 |

---

## 1. 现状快照（2026-10-22 19:20 实测）

| 项 | 状态 | 对 A 的影响 |
|---|---|---|
| Git | `main` @ `bb8460d`（骨架已推 origin）；**工作区 3 个文档未提交** | 先提交，避免分叉 |
| `shared/types.ts` | **不存在**（B 待落） | P0 阻塞：A 无类型来源 |
| `frontend/` | 仅 `package.json`；缺 vite/tsconfig/tailwind/index.html/src | 脚手架是 A 第一动作 |
| `node_modules` | 未安装 | `npm install` 为前置 |
| 契约缺口 ×5 | 见 §6 | 需与 B 对齐，否则 M2/M3 返工 |

---

## 2. 工程规范（frontend/ 强制执行）

### 2.1 目标目录结构

```
frontend/
├─ index.html / vite.config.ts / tsconfig.json / tsconfig.node.json
├─ tailwind.config.ts / postcss.config.js
└─ src/
   ├─ main.tsx / App.tsx / index.css
   ├─ hooks/useSSE.ts          # SSE 订阅 + 退避重连 + 帧校验（唯一数据入口）
   ├─ layout/SplitView.tsx     # 分屏：左看板+AI流 | 右观看页
   ├─ components/              # MetricCards / Funnel / InteractionTimeline /
   │                           # DecisionStream / StrategyPanel / ControlBar /
   │                           # ProductRanking / WatchEmbed / ReviewPage
   ├─ lib/                     # format.ts（数值格式）/ validate.ts（类型守卫）/ constants.ts / cn.ts
   └─ types/                   # 仅放前端私有类型；契约类型一律从 shared 导入
```

### 2.2 技术栈与兼容性矩阵

| 层 | 选型 | 版本约束 | 兼容性要求 |
|---|---|---|---|
| 框架 | React | ^18.3.1 | StrictMode 双挂载安全：effect 必须清理连接，防双 SSE |
| 语言 | TypeScript | ^5.5 | `strict: true`；禁 `any`（确需 `unknown` + 类型守卫） |
| 构建 | Vite | ^5.4 | `/api` 代理 → `localhost:4000` |
| 样式 | Tailwind | ^3.4 | 语义色 token 化，组件内禁魔法色值 |
| 数据通道 | EventSource (SSE) | 浏览器原生 | 现代 Chromium；断线指数退避重连 |
| 后端运行时（B） | Node | ≥18 | 仅约定，A 不直接依赖 |

### 2.3 TypeScript 规范

- 契约类型（`LiveState` / `Metrics` / `Decision` / `Mode` / `ActionType`）从 `shared/types.ts` 导入，**禁止在前端重新定义或改字段**
- 组件 props 显式接口化：`interface MetricCardsProps { ... }`，命名导出
- **运行时校验**：SSE 帧是外部输入，编译期类型 ≠ 运行时保证 → `lib/validate.ts` 提供 `isLiveState()` 等守卫；校验失败丢弃该帧并 `console.warn`，不 crash
- 工具函数纯函数化，入参出参类型完备

### 2.4 组件与状态规范

- 函数组件 + Hooks；展示组件零副作用；数据获取只发生在 hooks
- 单一数据源：SSE 全量帧 → `useSSE` → 组件；组件禁止自行 fetch 状态（REST 动作类请求除外）
- 三态齐全：加载态 / 空态 / 错误态；**禁止白屏**
- 性能：曲线与列表 `useMemo`/`memo`；时间轴渲染 rAF 节流；决策列表超 50 条截断 + 滚动（或虚拟化）
- 数值格式统一走 `lib/format.ts`（千分位、`¥` GMV、百分比、分钟）

### 2.5 错误处理与演示健壮性（演示不翻车是硬约束）

| 场景 | 处理 |
|---|---|
| SSE 断线 | `useSSE` 指数退避重连（1s→2s→4s→…→30s 封顶）+ 顶部连接状态条 |
| 后端不可达 | 看板降级为「连接中 / 已断开」提示，不白屏、**不造假数据** |
| POST 失败（模式/确认/开始/停止） | try/catch + 内联错误 + 可重试；不静默吞错 |
| 组件渲染异常 | `ErrorBoundary` 包裹 SplitView，fallback = 「看板异常已降级」+ 刷新按钮 |
| iframe 加载失败 | WatchEmbed 超时降级为占位说明卡 |

### 2.6 注释规范

- 文件头（每个 .ts/.tsx）：模块职责 + 负责人 A + 契约依据（API.md §/types.ts）+ `@since vX.Y.Z`
- 导出组件/hook/函数：JSDoc（`@param` / `@returns` / `@throws`）
- 复杂逻辑（环比算法、退避策略、曲线抽样）：行内注释写清假设
- TODO 必须带责任人与版本：`// TODO(A, v0.2.0): 商品榜点击下钻`
- 禁止注释掉的代码块（历史在 git）

### 2.7 Tailwind 与设计 token

- 语义色进 `tailwind.config.ts`：`brand` / `success` / `warn` / `danger`；组件只准用 token
- 指标语义色用产品语义（正向 emerald / 负向 rose）；**直播运营场景非股票行情，不适用涨红跌绿**；如需切换只改 token 一处
- 演示投影按 1920×1080 设计，兼容 1280×720；关键数字 ≥24px、高对比

---

## 3. 版本管理规范（SemVer 2.0.0）

### 3.1 策略

- 开发期（现在 → 10/24 提交）：`0.x.y`；提交版打 `v1.0.0`
- 三包版本同步：root / frontend / backend 同节奏（frontend 由 A 维护，root/backend 由 B 同步）
- 升降级规则：新功能 = `MINOR`；修复 = `PATCH`；**契约层（types.ts / API.md）不兼容变更 = `MAJOR`**（0.x 期表现为 MINOR + 三方 PR 同步）

### 3.2 里程碑 ↔ 版本映射

| 里程碑 | 时间窗 | A 的交付 | tag |
|---|---|---|---|
| M1 | 10/22 晚–10/23 早 | 脚手架 + useSSE + 契约对齐 | `v0.1.0` |
| M2 | 10/23 白天 | 看板组件全家桶 | `v0.2.0` |
| M3 | 10/23 晚 | 复盘页 + 分屏联调 | `v0.3.0` |
| M4 | 10/24 上午 | 演示打磨 + Deck 共责 | `v1.0.0`（提交版） |

### 3.3 功能版本标注

- 每个新组件/新能力在文件头与 JSDoc 标 `@since vX.Y.Z`
- `API.md` 增加版本头 + 变更记录表（v1.0 = 当前冻结；v1.1 = §6 建议项）

### 3.4 兼容性规则（A 侧承诺）

- SSE 帧 `LiveState` **只增不删**：新字段必须 optional 或有默认值；前端对未知字段宽容（前向兼容）
- EventSource 重连后全量帧替换，不做增量合并，避免状态漂移
- React 18 StrictMode：`useSSE` effect 必须 `close()` 连接

### 3.5 契约变更流程（影响面分析）

`shared/types.ts` 或 `API.md` 变更 → 影响 A（消费）/ B（产出）/ C（decisions 写入）三方 → 必须 PR + 三方确认 + 版本标注。
前端内部重构不影响契约 → 自行 PATCH，PR 自检。

### 3.6 Git 规范

- Conventional Commits：`feat(frontend): ...` / `fix(dashboard): ...` / `docs:` / `chore:` / `refactor:`
- 分支 `feat/xxx` → PR 合 `main`，**每天至少合并一次**
- 里程碑打注解 tag：`git tag -a v0.2.0 -m "M2 看板"`

---

## 4. 可执行事项清单（含完成标准 DoD）

> 优先级：P0 = 阻塞解除；P1 = 里程碑必需；P2 = 体验加分。每项可独立验证。

### P0 · 立即（M1 内）

| ID | 事项 | 产出 | 完成标准（DoD） | 依赖 |
|---|---|---|---|---|
| A-01 | 提交存量文档 | commit：`docs: 团队分工地图/模块设计树/README 更新` | `git status` 干净；origin/main 含这 3 个文档 | 无 |
| A-02 | 契约对齐会 | §6 缺口清单与 B 逐条确认 | 每个缺口有结论：现在做 / 降级 / 排期到 v1.1 | B |
| A-03 | 前端脚手架 | vite/ts/tailwind/postcss/index.html/src 骨架 | `npm install` 成功；`npm run dev` 起 5173 渲染占位页；`tsc --noEmit` 与 `npm run build` 零错误 | 无 |
| A-04 | useSSE 占坑 | `hooks/useSSE.ts` | 联通后端收帧；kill 后端出现断线条且 30s 内自动恢复；未知字段不崩；StrictMode 无双连接 | A-03 |

### P1 · M2 看板（10/23 白天）

| ID | 事项 | 完成标准（DoD） | 依赖 |
|---|---|---|---|
| A-05 | MetricCards ×6 | 在线/累计观看/点击/下单/GMV/互动率；SSE 驱动秒级跟手；迷你趋势线；空态/断线降级；格式统一走 format.ts | A-04, types |
| A-06 | Funnel | 观看→互动→点击→下单四层 + 各层转化率；无数据占位 | A-04 |
| A-07 | InteractionTimeline | 在线曲线 + 决策事件标记；点标记弹出 `Decision.reason`；≥60 数据点不掉帧 | A-04 |
| A-08 | DecisionStream | 三态徽章（suggested/executed/pending_confirm）；半自动确认调 `/api/decision/confirm` 且状态实时更新；失败可重试 | A-04 |
| A-09 | StrategyPanel + ControlBar | 三档模式切换 `/api/mode` 生效并回显；直播开始/停止（补 API.md 已定义但无归属的端点）；阈值配置先禁用态 + 说明（缺口 G1） | A-04 |
| A-10 | ProductRanking | 商品转化榜（契约已有 `productRanking` 但无组件归属，A 补）；点击/下单双列 + 当前讲解标识 | A-04 |

### P1 · M3 复盘与分屏（10/23 晚）

| ID | 事项 | 完成标准（DoD） | 依赖 |
|---|---|---|---|
| A-11 | ReviewPage | 5 段结构渲染（指标总览/互动效果榜/最佳时段/归因结论/优化建议）；导出按钮打通后端导出；LLM 兜底文本可渲染 | 缺口 G2 |
| A-12 | WatchEmbed | 右屏 iframe + sandbox；无真实地址时占位说明卡（不白屏） | B 的 `USE_REAL_POLYV` 开关 |
| A-13 | SplitView 联调 | 1920×1080 与 1280×720 无错位；左右屏视觉一致；ErrorBoundary 演练生效 | A-05~A-12 |

### P2 · M4 收口（10/24 上午）

| ID | 事项 | 完成标准（DoD） |
|---|---|---|
| A-14 | 演示打磨 | 关键数字 ≥24px 高对比；开始演示到看到 AI 动作 ≤2 步；断线恢复演练通过 |
| A-15 | Deck 共责（A/C） | 5~8 页含架构图与分屏截图 |
| A-16 | 版本收口 | 全新 clone → `npm install` → 双 dev 命令跑通（README 步骤复核）；打 `v1.0.0`；CHANGELOG 补齐 |

---

## 5. 风险与对策（A 视角）

| 风险 | 概率 | 对策 |
|---|---|---|
| B 冻结 types 延迟 | 中 | 按 API.md 现有定义建 `src/types/mock.ts` 临时开发；冻结后仅改 import 路径（1 行） |
| 契约缺口 M2 才暴露 | 中高 | §6 清单提前对齐；阈值/结构化复盘先降级为禁用态 |
| SSE 帧频率过高拖垮渲染 | 中 | rAF 节流 + memo；决策列表截断 |
| 现场网络抖断 | 中 | 退避重连 + 状态条；备 1 分钟离线视频（C 负责） |
| 演示机分辨率差异 | 低 | 双分辨率验收（A-13） |

---

## 6. 契约缺口清单（与 B 对齐用）

| # | 缺口 | 证据 | 建议方案 | 影响 |
|---|---|---|---|---|
| G1 | ~~阈值配置端点缺失~~ ✅ **已解决** | 分工地图旧文写 `/api/control`（已过时）；冻结 API.md 实为 **`POST /api/strategy`**（局部更新，字段全集 = `StrategyConfig`） | StrategyPanel 直接调 `/api/strategy`，回显 `state.strategy` | A-09 |
| G2 | ~~复盘数据结构不足~~ ✅ **已解决** | `/api/replay` 返回 `ReplayResp`：`report` 文本 + `structured{summary,keyMetrics,topActions,bestWindow,suggestions}` + `engine` | ReviewPage 渲染 report + structured（有则画图） | A-11 |
| G3 | ~~`shared/` 消费方式未定~~ ✅ **已解决** | B 已在远端落地 `shared/types.ts`（冻结版，main @ fcad9e2）；本地 shared/package.json 为补建的基础设施 | 前端 `import from '@livepilot/shared'`；validate.ts 已按 v1.1 全字段适配（含 DecisionStatus 新增 `failed`） | — |
| G4 | 商品转化榜无组件归属 | `LiveState.productRanking: ProductRank[]`（含 gmv），7 组件清单无对应 | A 补 `ProductRanking.tsx`（A-10） | M2 完整性 |
| G5 | sim start/stop 无 UI 归属 | API.md 有端点无按钮归属 | A 补 ControlBar（并入 A-09） | 演示主链路 |

> **合并规则（2026-10-22 团队确认）**：契约（shared/）、后端（backend/）、共享文档（API.md / README / 分工地图 / 模块设计树）、package-lock.json、根 package.json **取远端**；前端源码（frontend/）与成员A 文档 **取本地**。同步动作：用户本机 `sync-github.sh`（git 通道）或沙箱内 `node api-sync.js <PAT>`（API 通道，PAT 瞬态不落盘）。

---

## 7. 立即行动（接下来 3 步）

1. **A-01**：提交存量 3 个文档（规范见 §3.6）
2. **A-02**：约 B 过 §6 五个缺口（约 15 分钟，阻塞 M2）
3. **A-03 / A-04**：落脚手架 + useSSE → 联调收帧 → 打 `v0.1.0`

---

## 8. 执行记录（M1，2026-10-22 完成）

| 项 | 结果 |
|---|---|
| A-01 存量文档提交 | ✅ 已提交（docs commit） |
| A-03 前端脚手架 | ✅ vite/ts(strict)/tailwind token/postcss/index.html + src 骨架 |
| A-04 useSSE + shared 契约草案 | ✅ useSSE（退避重连+帧守卫）+ `@livepilot/shared` types-only（按 API.md v1.0 转写，**待 B 确认冻结**）+ root workspaces 注册 |
| 验证 DoD | ✅ `npm install`（226 包）· `tsc --noEmit` 零错误 · `vite build` 产出 dist · dev server 5173 HTTP 200 冒烟通过 |
| 提交信息 | `docs: 入库团队分工地图、模块设计树与成员A前端任务规范` + `feat(frontend): M1 脚手架 + useSSE + shared 契约草案（v0.1.0）` |
| ⚠️ 远程同步 | 沙箱内 git 协议被代理拦截（fetch/push 须用户本机执行）。恢复步骤：在用户本机 Git Bash 运行仓库同级目录的 `sync-github.sh`（自动完成 取远端基线→按合并规则合并→只提交前端→推送→合并→打 tag v0.1.0） |
| 环境备注 | ① 沙箱中 bash 侧 `.git` 写入跨调用不持久（本地仓库还曾被并发进程重置），git 流程全部脚本化单进程执行；源文件经 Write 工具写入则持久 ② 远端为 private，沙箱内无凭据不可读，B 的冻结契约细节待用户本机同步时核对 |
| 契约现状 | B 已在远端冻结 `shared/types.ts`（v1.1 全字段）与 API.md（193 行，main @ fcad9e2，共 10 提交含后端全套）；**M2 开工第一件事 = 核对远端冻结契约与 G1/G2 是否已解决** → 已于 21:30 完成 API 同步与适配（见下） |

**M2 入口**：A-02 契约对齐完成后，按 §4 P1·M2 清单推进（A-05 指标卡 → A-10 商品榜）。

### 8.1 契约同步与适配记录（2026-10-22 21:30，API 通道）

- 用户提供 PAT（瞬态使用未落盘）→ `node api-sync.js <PAT>` 拉取远端 26 个管辖文件（backend 全套 + 冻结契约 + 新文档）；frontend 与本文档按规则保留
- **发现的真 bug 已修复**：契约 v1.1 将 `DecisionStatus` 扩展为 4 种（新增 `failed`），原 validate.ts 只认 3 种 → 一条失败决策会丢整帧。已重写 `frontend/src/lib/validate.ts`：补 `failed` + v1.1 全字段守卫（timeline/events/strategy/source/updatedAt 等）
- **验证**：npm install / tsc --noEmit / vite build 全绿（147KB）
- **M2 端点速查**（冻结 API.md，A 消费）：
  - `GET /api/state` 首屏兜底 · `GET /api/stream` SSE（retry:3000、200ms 节流、15s 心跳、连上即推首帧）
  - `POST /api/sim/start|stop`（开始/停止，支持 speed 加速 + seed 固定，**演示必须固定 seed**）· `POST /api/sim/scenario`（现场加戏：online_drop/cold_start/low_ctr/endgame/stream_stall）
  - `POST /api/mode`（三档切换）· `POST /api/strategy`（阈值局部更新）· `POST /api/decision/confirm`（半自动确认）· `POST /api/action`（运营手点）
  - `GET /api/decisions`、`GET /api/events`、`GET /api/replay`（ReplayResp 结构化）、`GET /api/session/export`、`GET /api/polyv/capabilities`（路演能力清单）、`GET /health`（启动探活）
  - **响应壳约定**：REST 统一 `{ok:true,data}` / `{ok:false,error,code}`；例外 `state`/`stream`/`replay` 直返业务对象
- **LiveState v1.1 新增可用字段**：`timeline[]`（时间轴底座，前端免自攒）、`events[]`（事件流）、`strategy`（策略面板直接渲染/回写）、`scenario`、`source`、`sessionId`、`startedAt/endedAt`；`ProductRank` 含 `gmv`；`Decision` 可选 `title/payload/snapshot/result`（result 含 mock 标识与 endpoint，演示取证用）

### 8.2 M2/M3 交付与契约 v2 适配记录（2026-10-23 凌晨）

- **PR #1**：https://github.com/hcraljl/livepilot/pull/1（分支 `feat/a-m1-frontend`，commit ef1b232，仅前端源码 + 本文档；shared/backend/文档按合并规则未动）
- **新增组件**（v0.3.0）：`CopilotPanel`（经验候选 TopK + AI 推荐 + 预览/二次确认执行，`/api/copilot/candidates` + `/apply`）；`ControlBar`（开始/停止 + 5 类现场加戏）；`ErrorBoundary`（每视图独立，key 重置防跨视图粘滞）
- **契约 v2 适配**（C 引擎合入后）：StrategyConfig 新增 `aiLevel`（off/hybrid/full 三档智能）+ `experienceTopK` → StrategyPanel 增智能档位切换与 TopK 配置；ReplayResp 新增 `review: ReviewReport` → ReviewPage 渲染完整归因榜（leaderboard/最佳时段/结论/经验库）；validate.ts 守卫同步补 aiLevel/experienceTopK
- **WatchEmbed 升级**：真实模式改嵌 B 的官方观看 SDK 页 `frontend/watch/index.html`（@polyv/live-watch-sdk v2.20.0，vite 同源服务）
- **浏览器级联调发现并修复 3 个真 bug**（Edge CDP 实测，非编译能发现）：
  1. `/api/replay` 直返对象误走信封解析（HTTP 200 也报错）→ api.ts 增 `getRaw` 契约例外通道
  2. copilot 预览返回 `{requiresConfirm, preview}` 而非 `{decision, result}`，类型假设错误导致渲染崩溃 → 判别联合类型修复
  3. ErrorBoundary 错误状态跨视图粘滞 → 每视图独立边界
- **验证**：tsc/vite build 零错误；Edge CDP 全链路 PASS（实时数据渲染、AI 决策流含归因增量 +¥1521/提升 4200%、时间轴标记、三档智能、副驾预览、复盘页归因榜）；截图存档于 `K:\livepilot\保利威2026hackathon\screenshots\`（ Deck 素材）
- **已知环境现象**（已反馈 C/B）：引擎规则冷却在同一后端进程内跨场次残留（重启后端即恢复）；B 重写模拟器后 online_drop 脚本节点位移，冷场/逼单场景仍稳定触发

### 8.3 用户截图反馈修复（2026-10-23 11:12）

- **现象**（用户截图）：矮视窗（~850px 高）下 AI 决策流被压成只剩表头（"共 1 条"但卡片不可见）
- **根因**：`DecisionStream` 在可滚动 flex 列中误用 `flex-1 min-h-0`——视窗不足时被弹性压缩到近 0 高
- **修复**：section 改自然高度，列表 `max-h-80` 内部滚动；全仓排查同类模式确认其余使用正确（WatchEmbed 的 min-h-0 在固定高度侧栏中属正确用法）
- **验证**：Edge CDP 1280×720 矮视窗实测——修复前复现用户场景，修复后 ul 高 320px、首卡 113px、滚动正常；tsc/build 全绿
- **已直推 main**：commit `77bb11d`（fix(frontend)）；新增工具 `push-main.js`（前端领地内小修复直推 main 通道）
- 教训沉淀：**视口截断类 bug 编译与构建发现不了，必须用矮视窗浏览器实测**；本文档 §2.5 错误处理与演示健壮性之外，布局弹性列为 M2+ 的验收项

### 8.4 前端全面代码审查与 v0.4.0 优化（2026-10-23 11:40）

**审查范围**：frontend/src 全部 22 个文件（App / 8 组件 / layout / hooks / lib×5 / 入口 / 样式）+ 配置 6 份，逐文件读代码并配合 Edge CDP 真实渲染验证。

| # | 问题 | 定性 | 修复 |
|---|---|---|---|
| 1 | 模拟模式下右屏（观众端）整块只是一段说明文字 | **产品级缺陷**：模拟态是演示主模式，等于浪费半屏，且丢掉"AI 决策 → 观众立刻看到互动"的核心故事 | WatchEmbed 重构为双形态：`source='polyv'` 嵌官方 SDK 页；`simulator` 渲染「模拟观众端」= 16:9 直播画面占位（LIVE 角标 + 在线人数 + 当前讲解商品）+ 观众侧互动流（按执行态决策渲染抽奖/答题卡/公告/商品推送/优惠券卡片） |
| 2 | 互动时间轴固定 `viewBox 720×200` + `w-full`，1920 宽屏等比放大到约 400px 高 | 布局缺陷：把 AI 决策流整块挤出首屏 | 改 ResizeObserver 实测容器宽度做 1:1 viewBox 映射，高度锁定 220px（文字不再被横向拉伸）；决策流 top 由 1250px 提前到 878px |
| 3 | 策略面板三档智能/三档模式切换失败时静默（`try/finally` 吞异常） | 可观测性缺陷：点了没反应，演示现场无从判断 | 两处均补 `catch` + 行内错误提示 |
| 4 | SSE 首连失败只有"连接中…"永不报错；且 EventSource 3s 自愈重试会把错误提示擦回"连接中" | 健壮性缺陷：后端没起时现场看不出根因 | ① 8s 首连探测；② `everOpenedRef` 区分"从未连上（提示 npm run dev:backend）"与"连过再断（重连中）"；③ `probeFailedRef` 保持错误态粘滞直到真正 open |
| 5 | 复盘页未用上 `review.productRanking` | 信息缺失：复盘最后一问"哪款卖动了"没有答案 | 抽出可复用的 `ProductRankingTable`，复盘页新增「本场商品转化榜」 |
| 6 | 1280 宽下指标卡环比标签「▲ 89%」被挤成两行 | 视觉瑕疵 | `whitespace-nowrap` |

**验证（全部实测，非推断）**：

- `tsc --noEmit` + `vite build` 零错误（50 模块 / 187.95 kB JS / 14.84 kB CSS）
- 仓库级 `npm run contract:check`（B 的跨端契约自检）：`isLiveState()` 首帧守卫通过、决策 6 条全合规、strategy 12 字段、timeline 226 点 / events 60 条
- Edge CDP 布局与功能 **18/18 + 9/9 通过**：8 个区块齐全、实时连接、观众端卡片、决策流未被压扁、1920×1080 与 1280×720 双分辨率无横向溢出
- Edge CDP 断链场景 **5/5 通过**：拦截 `/api/stream` → 提示"无法连接实时数据流：请确认后端已启动（npm run dev:backend，端口 4000）"、8s 后不被重试擦掉、解除拦截后自动回到「实时同步中」且数据流恢复
- 截图更新：`screenshots/07-dashboard-viewer-1080p.png`、`08-review-v2.png`、`09-dashboard-720p.png`

**契约前向兼容确认**：B 的 `Metrics` 新增 `productCtr` 字段，我的 `isMetrics` 只校验必需字段（不做白名单穷举），因此新增字段天然兼容——这是 v0.1.0 就定下的守卫策略（§2.3）。

### 8.5 本地对齐远端 + WatchEmbed v0.5.0（2026-10-23 12:30）

**一、本地 ↔ 远端对齐（新增工具 `align-remote.js`，仓库外）**

- 原理：远端 git tree 的每个 blob 与本地文件按 `git blob sha1` 逐字节比对，只下载不一致项；大文件走 git blobs API（contents API 有 1MB 上限）；`.gitignore` 覆盖的路径（node_modules / dist / .env / backend/data）不参与
- 结果：远端 `185d831` → **236/236 文件与远端完全一致**；本次拉取 152 个新增（B 的 `frontend/watch-sdk/**` 官方观看页构建产物 15.15MB）+ 5 个更新（backend polyv 改动、package-lock、api.ts）
- 本地多余文件仅 3 个：`.workbuddy/memory/*`（自动化工作记忆，**建议把 `.workbuddy/` 加进 .gitignore**，否则谁在本机跑 `git add -A` 会把内部笔记提交上去）
- 对齐后 `install / typecheck / build / contract:check` 全绿

**二、WatchEmbed v0.5.0（修复 B 反馈的真 bug + 接上 B 新接口）**

| 问题 | 说明 | 修复 |
|---|---|---|
| 真实频道下右屏退回模拟画面 | 旧条件 `source === 'polyv' && channelId`；而后端 `LiveState.source` 默认恒为 `'simulator'`（只有 `startSession(source='polyv')` 才是 polyv），`channelId` 取 effectiveChannelId（.env 或运行时）——「真实频道 + 模拟动作」组合下永远不进 iframe | 嵌入条件改为**只看 channelId**；频道号以 `GET /api/polyv/channel` 为准（含 `embeddable`），接口不可用时回退 SSE 帧的 `channelId` |
| 官方观看页被 16:9 裁掉半截 | 该页是完整页面而非纯播放器 | 嵌入槽位改 `h-[38vh] max-h-420 min-h-200`；无频道时仍用 16:9 占位保持"视频"观感 |
| 运行时换频道接口无人调用 | B 已提供 `GET/POST /api/polyv/channel`，api.ts 有封装但界面没入口 | 右屏头部加「换频道」，可现场切频道而不重启后端；切换后以接口返回为准并即时重载 iframe |
| 有真实频道时互动流消失 | 旧实现 iframe 与观众端互动流二选一 | 拆成 `PlayerSlot` + `ViewerFeed` 两个块，真实频道下**画面与互动流同时在**（产品故事：AI 动作在观众侧长什么样） |

**验证（Edge CDP，7/7 通过）**：无频道 → 模拟观众端；点「换频道」→ 输入 8659539 → 切换 → iframe `src=/watch/index.html?channelId=8659539`、徽章「真实频道」、显示频道号、互动流保留、无报错；iframe 内部页面已自动带上频道号（截图 `screenshots/10-watch-real-channel.png`）。

### 8.6 仓库一致性审查与 v0.5.1 优化（2026-10-23 13:35）

**方法**：先 `align-remote.js` 把本地对齐到远端 `0e3b443`（逐 blob 校验 237/237 一致），再逐项读结构（shared / backend / frontend / scripts / docs）、配置（root·frontend·backend package.json、vite、tsconfig×2、.gitignore）、依赖（源码 import 与 package.json 对账），并用 Edge CDP 实测验证。

| # | 发现（问题） | 类型 | 调整 | 目的 | 预期效果 |
|---|---|---|---|---|---|
| 1 | 观看页地址写死 `/watch/index.html`：dev 下命中 Vite 静态目录里的**轻量兜底页**，而生产由后端 `/watch/` 托管**官方开源观看页**（watch-sdk 存在时优先） | **dev/prod 不一致**（最严重） | `WATCH_PAGE` 改为 `/watch/`；`vite.config.ts` 把 `/watch`、`/demo` 代理到后端 | 让"用哪一份观看页"只由后端一处决定 | 右屏在 dev 与生产打开同一份官方页：真实播放器 + 聊天室 + 互动接收端（抽奖/答题卡/签到/卡片/公告） |
| 2 | 官方页在 400px 侧栏里横向溢出（实测 iframe 351px 时 `scrollWidth≈1076px`，按 PC 布局不随宽度收缩） | 布局缺陷 | 以 1080 逻辑宽渲染 + 按容器宽度等比缩放；面板加「全屏打开」（新窗口 1:1） | 消除横向滚动与内容截断，同时保留 1:1 观看入口 | 侧栏内一屏看全播放器与频道信息卡；需要看清细节时一键全屏 |
| 3 | `frontend/package.json` 版本 `0.1.0`，与文档迭代（v0.2→v0.5.x）脱节 | 版本一致性 | 升到 `0.5.0` | 构建日志/`npm ls` 能对上文档的版本语义 | 任何一次构建输出都可追溯到功能里程碑（SemVer §3） |
| 4 | `@polyv/live-watch-sdk`、`@polyv/interactions-receive-sdk-ui-default` 在 `src/` 中**零 import**（观看页用的是入库的 UMD 产物），却挂在 `dependencies` | 依赖语义错误 | 移入 `devDependencies` | 运行时依赖只剩 `react/react-dom/@livepilot/shared`，语义正确 | `npm ci --omit=dev` 语义成立；新人看依赖即知真实运行时组合 |
| 5 | `.gitignore` 缺 `.workbuddy/`（AI 会话记忆）与 `.tmp/`（`build-watch-sdk.sh` 会拉约 850MB） | 仓库卫生 | 补两条并注明原因 | 防止内部笔记与大体积临时目录被 `git add -A` 带入 | 仓库只留可交付内容；误提交风险归零 |
| 6 | `constants.ts` 里 `PLACEHOLDER_MODULES` 是 M1 遗留、已无任何引用 | 死代码 | 删除；并在文件头写明"标签表完整性由 TS 保证，禁止用 Partial 绕开" | 减少误导 | 改契约枚举时编译期即报错（有意为之），不再有第二份"模块清单"真相 |
| 7 | `api.ts` 有 6 个导出未被界面消费（`fetchState/fetchDecisions/fetchEvents/triggerAction/fetchCapabilities/fetchPolyvOperations`），易被误判为死代码随手删掉 | 可维护性 | 文件头补「消费状态表」：哪些在用、哪些是契约覆盖待消费、以及"要删须连 API.md 一起清" | 保留接口与契约一一对应的完整性 | 后人不必反推每个函数的去留，删除动作有明确约束 |
| 8 | 根 `verify` 只跑后端 typecheck，前端类型错误可漏过 | 自检覆盖不全 | `verify` 改用 `npm run typecheck`（含 backend + frontend） | 一条命令覆盖两端 | 提交前自检不再漏前端；CI 若接 `verify` 即刻生效 |
| 9 | README 入口表写 `/watch/` = "观看 SDK + 模拟开播按钮"（实为轻量页描述），且未提 `/watch-lite/` | 文档与实现不符 | 更正两行并补 `/watch/` 代理与缩放说明 | 文档成为可信入口索引 | 队友/评委按 README 点开即所见即所得 |

**验证（全部实测）**

- `align-remote.js`：远端 `0e3b443` → 237/237 blob 一致（含 B 的「下线 coupon：8→7 动作」契约变更，前端 `ACTION_LABELS` 已随之收敛为 7 项）
- `tsc --noEmit`（backend + frontend）· `vite build`（50 模块 / 190.11 kB）零错误
- `npm run verify`（含新增前端 typecheck）全绿：签名与官方样例逐位一致 · 模拟器流水线自检通过
- `npm run contract:check`：`isLiveState()` 首帧守卫通过 · strategy 12 字段 · 决策/事件全合规
- Edge CDP **5/5**：iframe `src=/watch/?channelId=1234568`、iframe 内确为官方页（含 `chunk-polyv`、有 `video` 元素、内容高 1400）、徽章=真实频道、嵌入高度 474px
- Edge CDP **9/9** 回归：时间轴 220px、决策流进首屏、观众端互动流、720p 无横向溢出
- 截图：`screenshots/11-official-watch.png`（右屏官方观看页缩略 + 全屏入口）

**评估后未做（留作建议，避免赛前引入风险）**

| 建议 | 理由 | 为何暂不做 |
|---|---|---|
| ESLint + Prettier | 目前靠 TS strict + 人工约定，风格靠 review | 会一次性改写大量文件、制造无意义 diff；赛后再上一轮格式化更划算 |
| 单命令并行起前后端（`npm run dev`） | 现在要开两个终端 | 需引入 `concurrently` 或新增共享脚本，改动落在团队公共区（scripts/），赛前不宜动 |
| 观看页产物体积（watch-sdk 15.15MB + UMD 1.1MB） | 离线演示必需，已有构建脚本可复现 | 未超 50MB，无需 LFS；如后续膨胀再考虑 |

---

*本文档由 A 维护；规范变更走 PR（§3.5）。配套架构图与时间线见项目会话记录。*
