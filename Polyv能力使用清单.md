# Polyv 能力使用清单（加分项取证）

> 负责人：**成员 B（后端 / 集成）**
> 用途：逐条证明 LivePilot 真的用上了保利威的服务端 OpenAPI 与开源 SDK，而非"贴个 logo"。
> 代码位置均为仓库内相对路径，可直接点到实现。

---

## 一、服务端 OpenAPI（程序化发起互动）

统一入口：`backend/src/polyv/client.ts` 的 `ACTION_ENDPOINTS`（8 个动作）。
签名：`backend/src/polyv/sign.ts`（官方算法：参数按 key 升序 → `key1value1key2value2` → 首尾拼 appSecret → MD5 大写）。
调用开关：`USE_REAL_POLYV`（`false` 走模拟回执，`true` 且 appId/appSecret/channelId 齐备才真实打频道）。

| # | 能力 | 接口 | 代码位置 | 触发方式 | 演示价值 |
| --- | --- | --- | --- | --- | --- |
| 1 | 发起抽奖（无条件） | `POST /live/v4/channel/lottery_activity/create` | `polyv/client.ts` → `lottery` | 规则「留存保卫」；运营手点 | 在线掉人时 AI 自动发福袋召回 |
| 2 | 福利抽奖（绑定商品条件） | `POST /live/v4/channel/lottery_activity/create` | `polyv/client.ts` → `welfare_lottery` | 规则「转化助推」 | 讲品点击低 → 下单才可抽，直接拉转化 |
| 3 | 答题卡 | `POST /live/v4/channel/question/send` | `polyv/client.ts` → `answer_card` | 规则「氛围激活」 | 冷场时自动抛题，弹幕瞬间起来 |
| 4 | 批量签到 | `POST /live/v4/chat/batch-checkin` | `polyv/client.ts` → `checkin` | 规则「氛围激活」（备选动作） | 开场/冷场仪式感，留存抓手 |
| 5 | 卡片推送 | `POST /live/v4/channel/card-push/push` | `polyv/client.ts` → `push_card` | 规则「留存保卫」组合动作 | 抽奖 + 卡片召回双打 |
| 6 | 商品推送 / 弹层 | `POST /live/v3/channel/product/push-product` | `polyv/client.ts` → `push_product` | 规则「转化助推」 | 自动把主推品怼到观众眼前 |
| 7 | 公告（跑马灯） | `POST /live/v4/chat/add-bullentin` | `polyv/client.ts` → `bulletin` | 规则「逼单」「异常兜底」 | 发券 + 公告逼单；推流抖动时安抚 |
| 8 | 优惠券 | `POST /live/v4/channel/coupon/create` | `polyv/client.ts` → `coupon` | 规则「逼单」（红包雨降级方案） | 末段 GMV 未达标 → 发券收割 |

> **红包雨**：未检索到独立的服务端写入接口，已降级为「发券 + 公告逼单」，并在方案/设计树中如实标注，不假装支持。

### 统计与数据回流

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| 频道统计轮询 | `polyv/client.ts` → `pollStats()` | 路径可配（`POLYV_STATS_PATH`），不同 API 版本路径有差异，接入真实账号时按官方文档确认 |
| Webhook 回调 | `backend/src/routes/webhook.ts` | 开播 / 下播 / 录制完成 / 在线数据，按同一套算法验签，事件原样留存到事件流 |
| 真实/模拟双模 | `backend/src/config.ts` → `canUseRealPolyv()` | 缺任一密钥自动降级为模拟，彩排绝不误伤真实频道 |

### 安全

- `appSecret` 只在后端进程内使用（`config.ts` 读取 → `sign.ts` 计算），**永不出现在 HTTP 响应、日志、前端 bundle 中**；
- 启动日志只打印「已配置 / 未配置」，不打印值本身；
- Webhook 强制验签（配置了 appSecret 时），失败直接丢弃并记事件。

---

## 二、开源 SDK（观看端呈现）

| SDK | 用途 | 使用位置 | 说明 |
| --- | --- | --- | --- |
| `polyv-web-live-watch-sdk` | 真实观看页：直播/回放播放、聊天室/弹幕 | 前端右屏 `WatchEmbed`（iframe 嵌入频道观看页） | 让评委在右屏**亲眼看到** AI 发起的互动真的到达观众端 |
| `polyv-web-interactions-receive-sdk-ui-default` | 互动接收端 UI：签到 / 问卷 / 答题卡 / 公告 / 抽奖 / 商品库 | 观看页内由 SDK 自动渲染 | AI 的 OpenAPI 调用 → 服务端下发 → SDK UI 即时弹窗，全链路闭环 |

> 说明：gitee 上的开源仓库为**接收端** SDK（播放 + 互动呈现），没有"服务端写入互动"的 SDK，
> 所以"AI 主动发起互动"必须走服务端 OpenAPI —— 这也正是本项目的技术亮点：**OpenAPI 写 + SDK 读**，两条腿都用上了。

---

## 三、能力自证（现场可跑）

```bash
# 1. 查看已接入的能力清单（8 个动作 + 真实接口路径 + 当前是否真实模式）
curl http://localhost:4000/api/polyv/capabilities

# 2. 验证签名算法与官方样例一致（输出 ✅ 才算通过）
npm run sign:selftest -w backend

# 3. 手动触发一次动作，回执里能看到命中的接口路径
curl -X POST http://localhost:4000/api/action \
  -H "Content-Type: application/json" \
  -d '{"action":"bulletin","params":{"content":"AI 自动公告测试"}}'
```

真实模式下回执 `mock:false` 且 `endpoint` 为真实路径，可直接对照保利威后台的 API 调用记录核对。
