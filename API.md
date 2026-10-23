# API 契约（前后端并行开发依据）

> 维护：**成员 B（后端 / 集成）**。任何字段调整必须先改本文件 + `shared/types.ts`，再通知 A / C。
> 后端基础地址：`http://localhost:4000`；前端 Vite 已代理 `/api` → 后端。
> 统一响应壳：成功 `{ ok: true, data: ... }`，失败 `{ ok: false, error: "...", code: 400 }`。
> 例外：`GET /api/state`、`GET /api/stream`、`GET /api/replay` 直接返回业务对象本身（见下）。

---

## 一、REST 接口清单

| 方法 | 路径 | 说明 | 主要消费方 |
| --- | --- | --- | --- |
| GET | `/health`（含 `/api/health`） | 健康检查 | 前端启动探活 |
| GET | `/api/state` | 完整 `LiveState`（首屏兜底） | A |
| GET | `/api/stream` | SSE 实时推送，见第二节 | A |
| POST | `/api/sim/start` | 启动模拟器 | A 的「开始直播」按钮 |
| POST | `/api/sim/stop` | 停止模拟器 | A |
| POST | `/api/sim/scenario` | 现场手动加戏 | A / 演示控制台 |
| POST | `/api/mode` | 切换建议 / 半自动 / 全自动 | A 的策略面板 |
| POST | `/api/strategy` | 更新策略阈值 | A 的策略面板 |
| GET | `/api/decisions` | 决策列表（可按状态过滤） | A / C |
| POST | `/api/decision/confirm` | 半自动：确认执行某条决策 | A |
| POST | `/api/action` | 手动触发一个互动动作 | A（运营手点） |
| GET | `/api/events` | 事件流（`since` / `type` 过滤） | A 时间轴 / C 复盘 |
| GET | `/api/replay` | 一键复盘（AI 优先，缺位走兜底） | A 复盘页 |
| GET | `/api/session/export` | 本场全量数据导出（`?download=1` 触发下载） | C / 留档 |
| GET | `/api/polyv/capabilities` | 保利威能力清单（8 个动作 + 接口路径 + 是否真实模式） | 路演展示 |
| GET | `/api/polyv/mode` | 当前是模拟演练还是真实频道（含凭据是否齐备） | A 顶部徽标 |
| POST | `/api/polyv/mode` | 运行时切换模拟/真实（`{useReal:boolean}`） | A 一键切换 |
| GET | `/api/polyv/channel` | 当前生效频道号（运行时覆盖优先） | 观众端预览弹层 |
| POST | `/api/polyv/channel` | 运行时切换频道（`{channelId:string}`，空串恢复 .env） | 弹层内「换频道」 |
| POST | `/polyv/webhook` | 保利威回调接收（验签） | 保利威服务器 |
| POST | `/api/commands` | 一句话人工指令：解析 → 立即执行 / 排程 | A 的指挥台 |
| GET | `/api/commands` | 指令排程表（pending 在前 + 最近历史） | A 的指挥台 |
| DELETE | `/api/commands/:id` | 取消待执行指令 | A 的指挥台 |

### 1. 健康检查

`GET /health` →
```json
{ "ok": true, "useReal": false, "running": false, "mode": "auto",
  "source": "simulator", "sessionId": "", "uptimeSec": 12 }
```

### 2. 状态

`GET /api/state` → 完整 `LiveState`（结构见第四节）。前端首屏先拉它，随后的变更都从 SSE 来。

### 3. 启动 / 停止模拟器

`POST /api/sim/start`
```json
{ "totalMin": 30, "speed": 10, "seed": 20261024 }
```
- `totalMin` 计划时长（分钟，默认 30）
- `speed` 加速倍数：1 秒真实时间 = `speed` 秒直播时间（默认 10 → 30 分钟场次约 3 分钟跑完，演示可传 20 更快）
- `seed` 随机种子（固定则每次曲线、场景节点完全一致，**演示必须固定**）

返回：启动瞬间的 `LiveState`（`data` 内）。
`POST /api/sim/stop` → `{ "ok": true, "data": { "running": false } }`

### 4. 现场加戏（可选）

`POST /api/sim/scenario`
```json
{ "name": "cold_start" }
```
`name` ∈ `online_drop` | `cold_start` | `low_ctr` | `endgame` | `stream_stall`
> 剧本已自动排在这些节点，本接口用于评审现场"再演一次"。
> 未运行模拟器时返回 409。

### 5. 模式切换

`POST /api/mode` `{ "mode": "suggest" | "semiauto" | "auto" }` → `{ "ok": true, "data": { "mode": "auto" } }`

### 6. 策略阈值

`POST /api/strategy`（局部更新，只传要改的字段）
```json
{ "aiLevel": "hybrid", "retentionDropPct": 0.12, "gmvTarget": 150000, "enabled": true }
```
`aiLevel` 三档：`off` = 纯规则 + TF-IDF + 模板，零 LLM 调用；`hybrid` = 规则决策 + LLM 解释/复盘（默认）；`full` = LLM 在规则候选内重排，非法输出自动回退规则优先级。
字段全集见 `shared/types.ts` 的 `StrategyConfig`。返回 `{ ok: true, data: { strategy: {...} } }`。

### 7. 决策

`GET /api/decisions?status=pending_confirm` → `{ ok: true, data: Decision[] }`

`POST /api/decision/confirm` `{ "id": "dec_xxx" }`
→ `{ "ok": true, "data": { "decision": {...}, "result": { "ok": true, "mock": true, "code": 200, "message": "...", "endpoint": "MOCK POST /live/v4/..." } } }`
> 半自动模式下，引擎产出 `pending_confirm` 决策，运营点「执行」调这里；全自动模式由引擎自己调执行层，不需要前端参与。

### 8. 手动动作（演示"人点一下"）

`POST /api/action`
```json
{ "action": "bulletin", "title": "运营手动逼单", "params": { "content": "最后 5 分钟，专属价即将结束" } }
```
`action` ∈ `lottery` | `welfare_lottery` | `answer_card` | `checkin` | `push_card` | `push_product` | `bulletin`
（`coupon` 已按业务要求下线，不再出现在动作集合中）
返回同 `decision/confirm`。

### 9. 事件流

`GET /api/events?since=1690000000000&type=decision` → `{ ok: true, data: LiveEvent[] }`
`type` ∈ `session` | `metric` | `scenario` | `decision` | `action` | `webhook` | `system`

### 10. 复盘

`GET /api/replay` → `ReplayResp`
```json
{ "report": "【本场关键指标】...", "generatedAt": 1690000000000, "engine": "template",
  "structured": { "summary": "...", "keyMetrics": {...}, "topActions": [...],
                  "bestWindow": {...}, "suggestions": ["..."] } }
```
- `engine`: `ai`（DeepSeek 生成的正式版）| `template`（B 的兜底版）
- 前端只需渲染 `report` 文本 + `structured`（有则画图）

### 11. 能力清单

`GET /api/polyv/capabilities` → `{ ok: true, data: { useReal, dryRun, credentialsReady, channelId, apiBase,
   actions: [{ action, label, method, path, requiredParams, ready, missing }], webhook, statsPath } }`

### 11.1 模拟 / 真实 切换（演示必需）

`GET /api/polyv/mode` →
```json
{ "ok": true, "data": { "useReal": false, "dryRun": true, "credentialsReady": false,
  "channelId": null, "label": "模拟演练（不发真实请求）" } }
```

`POST /api/polyv/mode` `{ "useReal": false }` → 切回模拟演练（永远成功，任何环境都能演示）
`POST /api/polyv/mode` `{ "useReal": true }` → 切真实频道；凭据不全返回 **409** 并保持模拟

### 11.1 运行时频道切换

`GET /api/polyv/channel` → `{ ok, data: { channelId, source: 'env'|'runtime', embeddable } }`

`POST /api/polyv/channel` `{ "channelId": "1234568" }` →
`{ ok, data: { channelId: '1234568', source: 'runtime', embeddable: true } }`

- 只切换「看哪个频道 / 往哪个频道发互动」，不涉及任何密钥
- 传 `""` 恢复 `.env` 的 `POLYV_CHANNEL_ID`
- 非法值（含空格、斜杠等）返回 **400**
- 切换后 `LiveState.channelId` 立即同步（SSE 下一帧生效），观众端弹层 iframe 自动重载

> `dryRun:true` 表示强制演练：即使密钥齐备也不发真实请求，所有动作回执 `mock:true`。
> 界面上的「切到真实频道 / 切回模拟演练」按钮就是打这个接口。

### 11.2 页面入口（后端单端口托管）

| 路径 | 内容 |
| --- | --- |
| `/` | 有正式前端则进正式前端，否则 302 → `/demo/` |
| `/demo/` | 模拟演示台（AI 看板 + 开播控制 + 复盘侧栏） |
| `/watch/` | 真实观看页（保利威观看 SDK，带模拟开播按钮） |

### 12. 副驾候选 / 操作选择（C 扩展）

`GET /api/copilot/candidates?topK=5` → `{ ok: true, data: CopilotCandidatesResp }`

- 用当前指标 + 近期归因生成 query，返回 TF-IDF TopK 历史经验（不是只给一条）；
- `topK` 可传 1~10，缺省读 `strategy.experienceTopK`（默认 5）；
- `actions` 是经验里可复用的动作白名单；`recommendation` 是可选 AI 建议：
  - `aiLevel=off` → 永远 `null`，只给人工选；
  - `aiLevel=hybrid/full` → LLM 在候选动作里选一个；无 key / 超时 / 非法输出时回退为相似度最高的模板建议；
- 低价值经验（GMV<300 或订单<5、短场次、单动作）会被过滤，不进入候选。

`POST /api/copilot/apply`

```json
{ "experienceId": "seed-conversion-1", "action": "push_product", "confirm": false }
```

- `confirm=false` → 只返回预览（动作、标题、按当前商品实例化的参数），**不执行**；
- `confirm=true` → 二次确认后调用执行层；动作必须是该经验 `actions` 里的白名单项，否则 400；
- 返回执行决策与 Polyv 回执（mock/real 可在 `result.mock` 区分）。

### 13. 官方 API 常量目录（C 扩展）

`GET /api/polyv/operations` → `{ ok: true, data: { auth, operations } }`

- `auth`：公共签名参数名（`appId / timestamp / sign`）；
- `operations`：8 个互动动作 + 统计 + 回调的官方 method / path / 必填参数 / docUrl；
  - `path` 是**官方公开路径**，客户/前端可见；
  - B 的内部执行路径与默认参数只留在 `backend/src/polyv/client.ts`，**不通过本接口暴露**；
- 这是**常量目录**，不写入经验库、不参与 TF-IDF；
- 完整说明见 [`docs/polyv-api.md`](./docs/polyv-api.md)；
- 官方全量 488 页文档索引见 [`docs/polyv-api-index.md`](./docs/polyv-api-index.md)。

---

## 二、SSE 实时推送

`GET /api/stream` → `text/event-stream`，**每次推送一帧完整 `LiveState` JSON**：

```
retry: 3000

data: {"running":true,"mode":"auto","metrics":{...},"decisions":[...],...}

```

- 连接建立后立即推一帧，不用等第一次变更
- 服务端节流 200ms；15 秒一次 `: ping` 心跳（防代理断连）
- 前端用法：
```ts
const es = new EventSource('http://localhost:4000/api/stream');
es.onmessage = (e) => setState(JSON.parse(e.data));
```

---

## 三、Webhook（真实账号接入）

`POST /polyv/webhook`：保利威事件回调，用同一套签名算法验签（`sign` 在 body 或 query）。
识别字段宽容匹配 `event` / `type` / `eventType`：含 `start` → 开播、含 `end`/`stop` → 下播、含 `record` → 录制完成、含 `online`/`viewer` → 在线数据。
无法识别的事件原样写入事件流（`type: "webhook"`），不会覆盖状态。
> 演示默认走模拟器；只有 `USE_REAL_POLYV=true` 且配好密钥时才需要它。

---

## 四、数据结构（与 `shared/types.ts` 一一对应）

```ts
type Mode = 'suggest' | 'semiauto' | 'auto';

interface Metrics {
  online: number;          // 当前在线
  totalViewers: number;    // 累计观看
  productClicks: number;   // 商品点击数
  orders: number;          // 下单数
  gmv: number;             // 成交金额
  danmakuRate: number;     // 弹幕 / 互动率 0~1
  currentProduct: string;  // 当前讲解商品
  elapsedMin: number;      // 已播分钟
  totalMin: number;        // 计划总时长
}

type ActionType = 'lottery' | 'welfare_lottery' | 'answer_card' | 'checkin'
                | 'push_card' | 'push_product' | 'bulletin';

interface Decision {
  id: string;
  ts: number;
  rule: string;                 // 触发规则名
  action: ActionType;
  reason: string;               // AI / 模板生成的中文理由
  mode: Mode;
  status: 'suggested' | 'pending_confirm' | 'executed' | 'failed';
  channelId: string;
  title?: string;
  payload?: Record<string, unknown>;
  snapshot?: Partial<Metrics>;  // 决策时刻指标快照（归因用）
  executedAt?: number;
  result?: PolyvCallResult;     // { ok, mock, code, message, endpoint, latencyMs }
}

interface LiveState {
  running: boolean;
  mode: Mode;
  channelId: string;
  sessionId: string;
  startedAt: number | null;
  endedAt: number | null;
  metrics: Metrics;
  decisions: Decision[];
  funnel: { view: number; interact: number; click: number; order: number };
  productRanking: { name: string; clicks: number; orders: number; gmv: number }[];
  timeline: { t: number; online: number; gmv: number; orders: number; danmakuRate: number; marked?: boolean }[];
  events: LiveEvent[];
  strategy: StrategyConfig;
  scenario: string | null;      // 当前生效的模拟场景
  source: 'simulator' | 'polyv';
  updatedAt: number;
}
```

---

## 五、AI 引擎接入（已实现）

代码位置：`backend/src/engine/`（规则 + 编排 + DeepSeek）、`backend/src/review/`（归因 + 复盘）、`backend/src/experience/`（TF-IDF 经验库）。

### 自动挂载

`index.ts` 启动时动态 import `engine/orchestrator.ts` 并调用 `start(ctx)`。引擎行为：

- 通过 `store.onTick` + 1s 定时器消费 `LiveState`，阈值 / 冷却统一从 `state.strategy` 读取；
- 规则硬触发，LLM 只异步补决策理由，**不阻塞动作**；
- `auto` → `ctx.executeDecision(id)`；`semiauto` → `pending_confirm`；`suggest` → 只记录不执行；
- 同一次规则触发的多动作共享 `groupId`，自动执行后 3 分钟回算 `Decision.outcome`；
- 动作全部落地后，`/api/replay` 生成归因复盘并写入经验库。

### `/api/replay`

`review/report.ts` 导出 `generateReport(session, ctx)`，B 的兜底路由会自动让位。返回：

```ts
{
  report: string,                 // 中文复盘文本
  structured: {
    summary, keyMetrics, topActions, bestWindow, suggestions,
    leaderboard,                  // C 扩展：完整归因榜
    experiences                   // C 扩展：历史相似经验
  },
  generatedAt: number,
  engine: 'ai' | 'template',
  review: ReviewReport            // C 扩展：完整复盘（timeline + marks + 经验）
}
```

### 引擎新增字段

- `Decision.groupId / ruleId / expectedEffect / reasonSource / executedElapsedMin / outcome`
- `Metrics.productCtr`（当前商品点击率，模拟器写入；无数据时缺省）
- `ReviewReport / AttributionItem / ExperienceEntry / ExperienceMatch / SessionExport` 见 `shared/types.ts`

### 智能档位

`StrategyConfig.aiLevel` 与执行模式（`suggest / semiauto / auto`）正交：

- **off**：规则 + TF-IDF + 模板，完全不调 LLM；动作仍可按执行模式自动落地；
- **hybrid**：规则决定动作，LLM 异步补理由 + 生成复盘（默认）；
- **full**：LLM 在已通过阈值/冷却的候选规则内选一个，输出做白名单与数字校验；超时/非法输出自动回退第一条规则，不会发明新动作。

### 复盘经验库

- 数据文件：`backend/data/experiences.json`（已 gitignore；首次运行写入 5 条种子）；
- 检索：零依赖中文分词（`Intl.Segmenter` + CJK bigram + 运营领域词典）→ TF-IDF 余弦相似度 → 历史增量 / 置信度加权优先级；
- 性能：索引首次搜索构建后缓存复用；新增经验只对新文档分词、旧文档刷新权重（IDF 是全局统计，无法完全零全局计算）；默认 2000 条上限，超出批量裁剪旧复盘并保留 playbook；
- 每场复盘自动沉淀；知识库 SOP 用 `source: 'playbook'` 导入，复用同一套检索。

---

## 六、人工指令台（自然语言 → 执行）

> 维护：**成员 B**。目的：让人机协作可演示——运营说一句，AI 负责解析时间/动作/条件并落地。

### POST /api/commands

请求：

```json
{ "text": "5 分钟后发一个签到" }
```

响应三种形态（统一 `{ ok: true, data }` 信封，`data.kind` 区分）：

```jsonc
// 1) 立即执行（无延迟、无条件）
{ "kind": "executed", "parsed": { ... }, "decision": { ... }, "result": { "ok": true, "mock": true } }

// 2) 已排程（定时 / 条件）
{ "kind": "scheduled", "parsed": { ... }, "command": { "id": "cmd_xxx", "dueAt": 1792738000000, "status": "pending" } }

// 3) 没听懂（不执行，回执说明原因）
{ "kind": "rejected", "parsed": { ... }, "message": "没听懂要做什么。现在支持：抽奖 / 福利抽奖 / ..." }
```

`parsed` 结构（`backend/src/commands/parse.ts` 的 `ParsedCommand`）：

| 字段 | 说明 |
| --- | --- |
| `action` | `lottery / welfare_lottery / answer_card / checkin / push_card / push_product / bulletin`，未识别为 `null` |
| `delaySec` | 相对延迟（秒），`0` = 立即 |
| `dueAt` | 绝对执行时间（条件型为**超时时间**） |
| `condition` | `{ kind: "online_below" \| "online_above", value, label }` |
| `note` | AI 复述的"我理解为…"，前端直接渲染 |
| `confidence` | 0~1，规则命中词越多越高 |
| `source` | `llm`（配了 `DEEPSEEK_API_KEY`）或 `rule`（正则兜底） |

支持的表达（`npm run cmd:check -w backend` 覆盖 12 例）：

- 动作：抽奖 / 福利抽奖 / 答题卡 / 签到 / 卡片 / 推一下（商品）/ 公告
- 时间：`5 分钟后` `半小时后` `两分钟后` `15:30` `15点半` `马上/立刻`；中文数字、全角数字自动归一化
- 条件：`在线跌破 1000` `人气超过 3000`（未开播时不做条件判断，避免 online≈0 误触发）
- 上限：单条延迟最多 1 小时；条件型最多等 30 分钟，超时 `expired`

### GET /api/commands

```json
{ "ok": true, "data": { "commands": [
  { "id": "cmd_x", "text": "5 分钟后发一个签到", "action": "checkin", "actionLabel": "签到",
    "dueAt": 1792738000000, "status": "pending", "condition": null, "source": "rule", "note": "我理解为：…" }
] } }
```

`status`：`pending / running / done / failed / cancelled / expired`。待执行按 `dueAt` 升序，历史按触发时间倒序，最多保留 40 条。

### DELETE /api/commands/:id

取消待执行指令；已执行/已取消返回 **404**（避免前端误以为撤销成功）。

### 执行语义

- 定时/条件到点后走 **`executeAction()`**（与引擎、手动触发同一条执行路径），因此同样享受：
  真实/模拟双通道、资源缺失自动降级、事件流留存、决策流可见、观众端可见；
- 决策的 `rule` 固定为 `人工指令`，`reason` 带上运营原话，复盘时能区分"AI 自主"与"人指挥"；
- 指令表是**进程内存**：重启即清空（演示场景不需要持久化，也避免幽灵任务）。
