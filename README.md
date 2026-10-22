# LivePilot · 智播副驾

> 保利威 2026 Hackathon 参赛项目 · 运营端 × 营销带货场景  
> AI 直播运营智能体驾驶舱：让 AI 实时盯场、自动决策、自动执行互动，并在直播后一键产出转化归因复盘。

## 一句话定位

**LivePilot** 把保利威的直播数据、互动能力、商品能力全部接进一个统一后台，提供「实时看板 + AI 副驾（自动驾驶）+ 智能复盘」三位一体，专为解决私域中小品牌自播「没人、没经验、互动乱、转化低」的痛点。

## 创新点

- **AI 自动运营编排引擎（混合内核）**：规则护栏 + 硬触发保证演示不翻车，LLM（DeepSeek）负责自然语言决策解释与复盘报告。
- 五大自动编排规则：留存保卫 / 转化助推 / 氛围激活 / 逼单 / 异常兜底。
- 三档模式：建议 / 半自动（确认执行）/ 全自动（自动驾驶）。

## 技术栈

- 前端：`React + TypeScript + Tailwind`（运营驾驶舱看板）
- 后端：`Node + TypeScript + Express`（Polyv OpenAPI 集成 + 直播模拟器 + Webhook 接收 + SSE 推送）
- AI 层：`DeepSeek`（规则解释 + 复盘报告）
- 数据：内置直播模拟器为主 + 真实 Polyv 账号可选接入（密钥仅存后端）

## 目录结构

```
livepilot/
├─ shared/
│  └─ types.ts            # 前后端唯一类型契约（B 维护，改动须三方同步）
├─ backend/                # Node + TS + Express
│  ├─ src/
│  │  ├─ config.ts         # 环境变量（密钥仅后端）
│  │  ├─ polyv/            # 保利威接入层（sign 签名 / client OpenAPI / executor 执行层，B 负责）
│  │  ├─ simulator/        # 直播模拟器（B 负责）
│  │  ├─ store/            # 内存状态 + 订阅 + 事件留存（B 负责）
│  │  ├─ engine/           # 规则 + DeepSeek + 编排器（C 负责）
│  │  ├─ review/           # 转化归因 + 复盘报告（C 负责）
│  │  ├─ services/         # 复盘兜底等横切能力
│  │  ├─ routes/           # REST + Webhook + SSE
│  │  └─ index.ts
│  └─ .env.example
├─ frontend/               # React + TS + Tailwind（A 负责）
├─ API.md                  # 前后端接口契约（并行开发依据）
└─ Polyv能力使用清单.md      # 加分项取证（B 负责）
```

## 快速开始

```bash
# 1. 安装依赖（根目录，npm workspaces 一次装齐）
npm install

# 2. 配置后端密钥（复制模板，按需填入；演示默认走模拟器，可留空）
cp backend/.env.example backend/.env

# 3. 启动后端（4000 端口）
npm run dev:backend

# 4. 另开终端启动前端（5173 端口，已代理 /api 到后端）
npm run dev:frontend
```

打开 <http://localhost:5173> ，点「开始直播（模拟）」，即可看到 AI 自动编排实时演示。

## 后端（成员 B）开发须知

### 自检命令（改完后端先跑这三条）

```bash
npm run typecheck -w backend      # 类型检查，零报错才算完
npm run sign:selftest -w backend  # 保利威签名算法与官方样例比对（输出 ✅）
npm run sim:check -w backend      # 无界面跑完整场模拟（约 8 秒），验证指标/场景/事件流

# 后端起在 4000 后，另开终端：
npm run smoke -w backend          # 19 项 HTTP 端到端断言（SSE 首帧 / 动作回执 / 僵尸 tick / 参数校验）
```

### 模拟器节奏

- 默认 30 分钟场次、加速 10 倍（1 秒真实时间 = 10 秒直播时间）→ 约 3 分钟跑完，适合演示；
  现场想更快：`POST /api/sim/start {"totalMin":30,"speed":20}`。
- 随机种子固定（`SIM_SEED=20261024`），**每次演示曲线与场景节点完全一致**，方便反复彩排。
- 剧本自动安排 4 个场景（留存断崖 / 冷场 / 点击停滞 / 推流抖动）+ 末段自然形成逼单窗口；
  现场想"再演一次"可 `POST /api/sim/scenario {"name":"cold_start"}` 手动加戏。

### 真实账号接入（可选）

`.env` 填好 `POLYV_APP_ID / POLYV_APP_SECRET / POLYV_CHANNEL_ID`，并把 `USE_REAL_POLYV=true`。
缺任一密钥会自动降级为模拟执行，**不会因为环境没配好就让演示崩**；回执里 `mock:true/false` 可一眼看出走的是哪条路。

### 接口

完整契约见 [`API.md`](./API.md)（含 SSE 帧格式、Webhook 验签、给 C 的引擎接入约定）。
快速验证：

```bash
curl http://localhost:4000/health
curl -X POST http://localhost:4000/api/sim/start -H "Content-Type: application/json" -d '{"totalMin":30,"speed":20}'
curl http://localhost:4000/api/state
curl http://localhost:4000/api/polyv/capabilities
curl http://localhost:4000/api/replay
```

## 三人协作（git 工作流）

- 单仓库 monorepo，按文件夹分工：A=frontend/，B=backend 的 polyv/simulator/store/routes，C=backend 的 engine/。
- 每人一个分支 `feat/xxx`，写完开 PR 合并到 `main`，**每天至少合并一次**。
- **禁止提交 `backend/.env`**（含 Polyv 密钥），已被 .gitignore 排除。
- 详细接口契约见 `API.md`，前后端据此并行开发。

## Polyv 能力使用（加分项）

- 服务端 OpenAPI（程序化发起互动）：抽奖 / 答题卡 / 卡片推送 / 商品推送 / 公告 / 批量签到 / 优惠券 + 统计轮询。
- 开源观看页 SDK `polyv-web-live-watch-sdk` + 互动接收端 SDK `polyv-web-interactions-receive-sdk-ui-default`（演示侧真实观看页）。
- 详细清单见交付物「Polyv 能力使用清单」。
