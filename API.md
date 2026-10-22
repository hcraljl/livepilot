# API 契约（前后端并行开发依据）

后端基础地址：`http://localhost:4000`，前端 Vite 已代理 `/api` → 后端。

## REST

### GET /api/state
返回完整 `LiveState`（见下方类型）。

### POST /api/sim/start
请求体：`{ "totalMin": 30 }`
开始直播模拟器，返回 `{ "ok": true }`。

### POST /api/sim/stop
停止模拟器，返回 `{ "ok": true }`。

### POST /api/mode
请求体：`{ "mode": "suggest" | "semiauto" | "auto" }`
切换 AI 副驾模式，返回 `{ "ok": true, "mode": "..." }`。

### POST /api/decision/confirm
请求体：`{ "id": "<decisionId>" }`
半自动模式下，确认执行某条待确认决策。

### GET /api/replay
返回 `{ "report": "<AI 生成的复盘文本>" }`。

### GET /health
健康检查：`{ "ok": true, "useReal": false }`。

## SSE（实时推送）

### GET /api/stream
`text/event-stream`，每次状态/决策变化推送一帧完整 `LiveState` JSON：
```
data: { ...LiveState... }

```

前端用 `EventSource('/api/stream')` 订阅。

## Webhook（真实账号接入时）

### POST /polyv/webhook
保利威事件回调（开播/结束/录制/互动等）。接入真实账号时在此验签并映射到 `state.metrics`，替代模拟器。当前为占位，需按官方算法严格验签。

---

## 数据结构（TypeScript）

```ts
type Mode = 'suggest' | 'semiauto' | 'auto';

interface Metrics {
  online: number;          // 在线人数
  totalViewers: number;    // 累计观看
  productClicks: number;   // 商品点击
  orders: number;          // 下单数
  gmv: number;             // 成交金额
  danmakuRate: number;     // 弹幕/互动率 0~1
  currentProduct: string;  // 当前讲解商品
  elapsedMin: number;      // 已播分钟
  totalMin: number;        // 总时长
}

type ActionType =
  | 'lottery' | 'welfare_lottery' | 'answer_card' | 'checkin'
  | 'push_card' | 'push_product' | 'bulletin' | 'coupon';

interface Decision {
  id: string;
  ts: number;
  rule: string;            // 触发规则名
  action: ActionType;
  reason: string;          // AI 生成的理由
  mode: Mode;
  status: 'suggested' | 'executed' | 'pending_confirm';
  channelId: string;
}

interface LiveState {
  running: boolean;
  mode: Mode;
  metrics: Metrics;
  decisions: Decision[];
  funnel: { view: number; interact: number; click: number; order: number };
  productRanking: { name: string; clicks: number; orders: number }[];
}
```
