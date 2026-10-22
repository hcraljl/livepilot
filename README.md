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
├─ backend/                # Node + TS + Express
│  ├─ src/
│  │  ├─ config.ts         # 环境变量（密钥仅后端）
│  │  ├─ polyv/            # 保利威接入层（签名 + OpenAPI 封装，B 负责）
│  │  ├─ simulator/        # 直播模拟器（B 负责）
│  │  ├─ store/            # 内存状态 + SSE 订阅
│  │  ├─ engine/           # 规则 + DeepSeek + 编排器（C 负责）
│  │  ├─ routes/           # REST + Webhook + SSE
│  │  └─ index.ts
│  └─ .env.example
├─ frontend/               # React + TS + Tailwind（A 负责）
├─ API.md                  # 前后端接口契约（并行开发依据）
└─ 方案确认书（见仓库外 ../方案确认书.md）
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

打开 http://localhost:5173 ，点「开始直播（模拟）」，即可看到 AI 自动编排实时演示。

## 三人协作（git 工作流）

- 单仓库 monorepo，按文件夹分工：A=frontend/，B=backend 的 polyv/simulator/store/routes，C=backend 的 engine/。
- 每人一个分支 `feat/xxx`，写完开 PR 合并到 `main`，**每天至少合并一次**。
- **禁止提交 `backend/.env`**（含 Polyv 密钥），已被 .gitignore 排除。
- 详细接口契约见 `API.md`，前后端据此并行开发。

## Polyv 能力使用（加分项）

- 服务端 OpenAPI（程序化发起互动）：抽奖 / 答题卡 / 卡片推送 / 商品推送 / 公告 / 批量签到 / 优惠券 + 统计轮询。
- 开源观看页 SDK `polyv-web-live-watch-sdk` + 互动接收端 SDK `polyv-web-interactions-receive-sdk-ui-default`（演示侧真实观看页）。
- 详细清单见交付物「Polyv 能力使用清单」。
