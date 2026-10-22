# Polyv 能力使用清单（加分项取证）

> 负责人：**成员 B（后端 / 集成）**
> 用途：逐条证明 LivePilot 真的用上了保利威的服务端 OpenAPI 与开源 SDK，而非"贴个 logo"。
> 代码位置均为仓库内相对路径，可直接点到实现。

---

## 一、服务端 OpenAPI（程序化发起互动）

统一入口：`backend/src/polyv/endpoints.ts`（官方契约真值表：路径 / 必填参数 / body 编码 / 签名范围）
执行层：`backend/src/polyv/client.ts`（`prepare()` 造请求 → `execute()` 发送 → 结构化回执）
签名：`backend/src/polyv/sign.ts`（官方算法：参数按 key 升序 → `key1value1key2value2` → 首尾拼 appSecret → MD5 大写）
调用开关：`USE_REAL_POLYV`（`false` 走模拟回执，`true` 且 appId/appSecret/channelId 齐备才真实打频道）

| # | 能力 | 官方接口 | 账号侧资源 | 触发方式 | 演示价值 |
| --- | --- | --- | --- | --- | --- |
| 1 | 发起抽奖（无条件） | `POST /live/v4/channel/lottery-activity/create` | 无（接口创建活动） | 规则「留存保卫」；运营手点 | 在线掉人时 AI 自动发福袋召回 |
| 2 | 福利抽奖（评论参与） | `POST /live/v4/channel/lottery-activity/create` | 无 | 规则「转化助推」 | 讲品点击低 → 评论抽奖拉互动 |
| 3 | 答题卡 | `POST /live/v4/channel/question/send` | `POLYV_QUESTION_ID` | 规则「氛围激活」 | 冷场时自动抛题，弹幕瞬间起来 |
| 4 | 批量签到 | `POST /live/v4/chat/batch-checkin` | 无 | 规则「氛围激活」（备选动作） | 开场/冷场仪式感，留存抓手 |
| 5 | 卡片推送 | `POST /live/v4/channel/card-push/push` | `POLYV_CARD_PUSH_ID` | 规则「留存保卫」组合动作 | 抽奖 + 卡片召回双打 |
| 6 | 商品推送 / 弹层 | `POST /live/v3/channel/product/push-product` | `POLYV_PRODUCT_ID` | 规则「转化助推」 | 自动把主推品怼到观众眼前 |
| 7 | 公告（跑马灯） | `POST /live/v4/chat/add-bullentin` | 无 | 规则「逼单」「异常兜底」 | 发券 + 公告逼单；推流抖动时安抚 |
| 8 | 优惠券 | `POST /live/v4/channel/coupon/create` | `POLYV_COUPON_IDS` | 规则「逼单」（红包雨降级方案） | 末段 GMV 未达标 → 发券收割 |

> **与官方文档逐字段核对时修正的三个坑**（旧实现会直接失败）：
> 1. 抽奖路径是全小写 + 连字符 `lottery-activity`，写成 `lottery_activity` 会 404；
> 2. 抽奖必填 `activityName / lotteryCondition / amount / prizeName`，旧实现发的是 `lotteryTitle / lotteryDuration`（不存在）；
> 3. `coupon` 与 `checkin` 的 body 是 **JSON**（不是 form），认证参数单独走 query 且**只对 query 签名**。

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

| SDK | 版本 | 用途 | 实际使用位置 |
| --- | --- | --- | --- |
| `@polyv/live-watch-sdk`（gitee: polyv-web-live-watch-sdk） | 2.20.0 | 真实观看页：创建播放器、拉真实频道流、播放事件、弹幕 | **已实装**：`frontend/watch/index.html` → 打开 `http://localhost:4000/watch/`，填频道号即可加入 |
| `@polyv/interactions-receive-sdk-ui-default`（gitee: polyv-web-interactions-receive-sdk-ui-default） | 1.29.0 | 互动接收端 UI：抽奖 / 答题卡 / 公告 / 卡片 / 商品 弹窗 | **已安装为 frontend 依赖**（`frontend/package.json`），用于自定义观看页的互动呈现；当前演示主链路由保利威官方观看页呈现互动 |

观看页用的是**官方 CDN 的 UMD 包**（`websdk.videocc.net/live-watch-sdk/latest/lib/polyv-live-watch-sdk.umd.js`），
初始化走官方 API：

```js
const watchCore = PolyvLiveWatchSDK.createWatchCore({ channelId });
await watchCore.player.setupPlayer({ container: el, autoplay: true });
watchCore.player.eventEmitter.on(PolyvLiveWatchSDK.PlayerEvents.PlayerInited, ...);
```

> 为什么"写"必须走 OpenAPI：gitee 上的两个开源 SDK 都是**接收端**（播放 + 互动呈现），
> 没有"服务端写入互动"的 SDK 能力。所以本项目是 **OpenAPI 写 + SDK 读** 两条腿：
> AI 决策 → 服务端 OpenAPI 下发 → 真实观看页（SDK 拉流）里立刻收到互动。

---

## 三、能力自证（现场可跑）

```bash
# 1. 能力清单：8 个动作 + 官方文档地址 + 当前真实模式下「哪些能打、缺什么资源」
curl http://localhost:4000/api/polyv/capabilities

# 2. 签名算法与官方样例逐字符比对（输出 ✅ 才算通过）
npm run sign:selftest -w backend

# 3. 预演 8 个动作的真实请求长什么样（不发送，连 sign 都算好）
npm run polyv:live -w backend -- --dry

# 4. 真机发送（会真的作用在频道上，慎用）
npm run polyv:live -w backend -- --fire

# 5. 只测某几个动作
npm run polyv:live -w backend -- --fire --only bulletin,coupon

# 6. 打开真实观看页（保利威观看 SDK）
open http://localhost:4000/watch/
```

真实模式下回执 `mock:false` 且 `endpoint` 为真实路径，可直接对照保利威后台的 API 调用记录核对。
账号侧资源（questionId / cardPushId / productId / couponIds）没配时，对应动作会**被拒绝发送并说明缺什么**，
不会把脏请求打到真实频道。
