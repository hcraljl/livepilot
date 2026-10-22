# Polyv 官方服务端 API 常量目录

> 来源：<https://help.polyv.net/live/api/>（2026-10-22 抓取核对）  
> 代码常量：`backend/src/polyv/api-catalog.ts`  
> 在线查看：`GET /api/polyv/operations`  
> **执行层路径以 B 的 `backend/src/polyv/client.ts` 为准**；本目录用于核对/展示，不直接改 B 的实现。

## 0. 和经验库的边界

- 本文 / `api-catalog.ts` 是**常量**：官方接口、路径、必填参数、文档地址；
- `backend/data/experiences.json` 是**经验**：哪场直播、什么场景、做了什么、增量多少；
- 官方操作**不写入经验库**，也不参与 TF-IDF 召回；经验条目只引用 `action` 类型；
- 副驾候选会把官方 `method / path / docUrl / requiredParams` 作为元数据展示，但不会把官方文档变成一条“经验”。

## 1. 认证与签名

所有服务端 OpenAPI 公共参数：

| 参数 | 说明 |
|---|---|
| `appId` | 保利威账号 appId |
| `timestamp` | 毫秒时间戳（官方部分接口要求 3 分钟内） |
| `sign` | `appSecret` 参与的 MD5 签名，见官方 `buildSign` |

`appSecret` 只允许出现在后端 `backend/src/polyv/sign.ts` / `client.ts`，绝不进前端、日志或经验库。签名自检：

```bash
npm run sign:selftest -w backend
```

## 2. 互动动作

| action | method | 官方 path | 必填（除公共参数） | 官方文档 |
|---|---|---|---|---|
| `lottery` | POST | `/live/v4/channel/lottery_activity/create`（B 执行路径；官方文档页写 `/lottery-activity/create`） | `channelId`、`activityName`、`lotteryCondition`、`amount`、`prizeName` | [创建抽奖](https://help.polyv.net/live/api/v4/channel/lottery_activity/lottery_activity_create/) |
| `welfare_lottery` | POST | `/live/v4/channel/lottery_activity/create`（同上） | 同上；用 `lotteryCondition` 设互动条件 | 同上 |
| `answer_card` | POST | `/live/v4/channel/question/send` | `channelId`、`questionId` | [发送答题](https://help.polyv.net/live/api/live_interaction/send_question/) |
| `checkin` | POST | `/live/v4/chat/batch-checkin` | `channelId` | [批量签到](https://help.polyv.net/live/api/v4/chat/checkin/batch_checkin/) |
| `push_card` | POST | `/live/v4/channel/card-push/push` | `channelId`、`cardPushId` | [推送卡片](https://help.polyv.net/live/api/v4/channel/market/cardPush/push/) |
| `push_product` | POST | `/live/v3/channel/product/push-product` | `channelId`、`productId` | [推送商品](https://help.polyv.net/live/api/channel/operate/push_channel_product/) |
| `bulletin` | POST | `/live/v4/chat/add-bullentin` | `channelId`、`content` | [发布公告](https://help.polyv.net/live/api/v4/chat/notice_add/) |
| `coupon` | POST | `/live/v4/channel/coupon/create` | `channelId`、`couponIds`（1~30 个） | [创建优惠券](https://help.polyv.net/live/api/v4/channel/coupon/create/) |

### 抽奖条件

官方 `lotteryCondition` 取值：

```text
none / invite / duration / comment / question / questionnaire
```

`lotteryRange`：`all / notWinning / customGroup / userLabel`。

**重要**：官方抽奖条件里没有“商品”类型。所谓“商品福利抽奖”不能用 `conditionType: product` 实现；可改为 `comment` / `question` 等互动条件，再叠加 `coupon` 和 `push_product`。代码里已把标签改为“互动福利抽奖”。

## 3. 统计与回调

| 用途 | method | path | 必填 | 文档 |
|---|---|---|---|---|
| 场次统计 | GET | `/live/v3/channels/statistics/view`（B 默认，可用 `POLYV_STATS_PATH` 覆盖；官方为 `/live/v3/channel/statistics/get-session-stats`） | `channelId` | [get-session-stats](https://help.polyv.net/live/api/channel/viewdata/get_session_stats/) |
| 统计汇总（v4） | GET | `/live/v4/statistics/session-stats/summary/list` | `channelId` 可选 | [summary_list](https://help.polyv.net/live/api/v4/statistics/summary_list/) |
| 事件回调 | POST | 本地 `/polyv/webhook` | — | [interaction_callback](https://help.polyv.net/live/api/callback/interaction_callback/) |

回调还包含 `livestatus` / `record` / `playback` 等分类，验签后再映射到 `store`。

## 4. 账号侧资源 ID（真实调用必填）

这些 ID 必须来自保利威后台/资源接口，**AI 不能生成**：

- `push_product` → `productId`
- `coupon` → `couponIds`（1~30 个）
- `push_card` → `cardPushId`
- `answer_card` → `questionId`

**实现归属**：资源 ID 的准备/注入由 B 在执行层完成，本目录只记录官方要求，不写经验库、不擅自改 `client.ts`。

当前 `USE_REAL_POLYV=false` 时 mock 可完整演示；切真实前由 B 先完成资源 ID 映射，再用 `/api/action` 手动验证公告/抽奖。

## 5. 本次核对结论（仅记录，执行层仍按 B）

- 抽奖：B 使用 `/lottery_activity/create`；官方文档页展示 `/lottery-activity/create`（连字符），**以 B 的现场验证为准**，本目录只记录差异；
- 优惠券：官方要求 `couponIds`；B 的 `couponName / couponValue` 默认值需要 B 真实联调时复核；
- 统计：B 默认 `/live/v3/channels/statistics/view`；官方提供 `/live/v3/channel/statistics/get-session-stats`，可用 `POLYV_STATS_PATH` 覆盖；
- 答题卡/卡片/商品推送：官方依赖 `questionId / cardPushId / productId`，这些资源 ID 由 B 在执行层准备；
- 抽奖条件官方不支持 product，福利抽奖建议 `comment` 条件 + 优惠券/商品推送；引擎侧标签已改为“互动福利抽奖”。

## 6. 真实演示前检查

- [ ] `POLYV_APP_ID / POLYV_APP_SECRET / POLYV_CHANNEL_ID` 已配置
- [ ] B 已完成 4 类资源 ID 的映射（product / coupon / card / question）
- [ ] `npm run sign:selftest -w backend` 通过
- [ ] `USE_REAL_POLYV=true` 后先用 `/api/action` 手动触发一次公告/抽奖
- [ ] 观看页 SDK 能收到互动
- [ ] 失败时自动降级为 mock 回执，演示流程不中断
