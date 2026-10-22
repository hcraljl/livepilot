import type { ExperienceEntry } from '../../../shared/types.js';

/**
 * 首次启动的内置经验，保证空库也能演示“历史经验匹配”。
 * 后续真实复盘会追加到 backend/data/experiences.json，与种子合并使用。
 */
export const SEED_EXPERIENCES: ExperienceEntry[] = [
  {
    id: 'seed-retention-1',
    source: 'review',
    createdAt: 1750000000000,
    title: '在线骤降 25%：抽奖 + 卡片召回，3 分钟拉回 17 单',
    scenario:
      '直播间在线人数一分钟内下滑 25%，观众流失明显，弹幕互动同步转冷。AI 在 60 秒内发起无条件抽奖并推送召回卡片，在线人数回升，成交增量 17.2 单。',
    rules: ['retention_guard'],
    actions: ['lottery', 'push_card'],
    result: {
      incrementalOrders: 17.2,
      incrementalGmv: 1703,
      liftPct: 358,
      confidence: 'medium',
    },
    takeaways: [
      '开播前 5 分钟安排一次固定福利，缓冲突发掉线带来的流失。',
      '掉线 60 秒内先发无条件抽奖，再推卡片召回。',
    ],
  },
  {
    id: 'seed-conversion-1',
    source: 'review',
    createdAt: 1750100000000,
    title: '商品点击率 2.7%：推商品 + 福利抽奖，增量 23 单',
    scenario:
      '轻盈保温杯讲解 3 分钟点击率仅 2.7%，商品曝光充足但下单转化低。AI 推送商品弹层并绑定商品福利抽奖，缩短下单路径，成交增量 23.1 单。',
    rules: ['conversion_boost'],
    actions: ['push_product', 'welfare_lottery'],
    result: {
      incrementalOrders: 23.1,
      incrementalGmv: 2287,
      liftPct: 963,
      confidence: 'medium',
    },
    takeaways: [
      '商品讲解每 2 分钟补一次弹层，别等点击率跌穿阈值再推。',
      '福利抽奖绑定当前讲解商品，缩短下单路径。',
    ],
  },
  {
    id: 'seed-atmosphere-1',
    source: 'review',
    createdAt: 1750200000000,
    title: '冷场 60 秒：答题卡救场，互动率回升',
    scenario:
      '直播间弹幕率跌到 5%，公屏偏冷，在线人数稳定但互动低迷。AI 发起互动答题卡，60 秒内拉起弹幕互动，并带动成交增量 21.3 单。',
    rules: ['atmosphere_activate'],
    actions: ['answer_card'],
    result: {
      incrementalOrders: 21.3,
      incrementalGmv: 2109,
      liftPct: 1775,
      confidence: 'low',
    },
    takeaways: [
      '提前准备答题卡/签到素材，冷场 60 秒内接管公屏。',
      '答题卡之后接签到，避免连续同一种互动。',
    ],
  },
  {
    id: 'seed-closing-1',
    source: 'review',
    createdAt: 1750300000000,
    title: '剩余 5 分钟 GMV 不足：发券 + 公告逼单',
    scenario:
      '距离下播 5 分钟 GMV 仅达目标 45%，AI 自动发限时优惠券并推送逼单公告，制造紧迫感，冲刺成交增量 21.8 单。',
    rules: ['closing_push'],
    actions: ['coupon', 'bulletin'],
    result: {
      incrementalOrders: 21.8,
      incrementalGmv: 2158,
      liftPct: 1817,
      confidence: 'low',
    },
    takeaways: [
      '把优惠券前置到剩余 8 分钟，避免最后 5 分钟才逼单。',
      '公告写清截止时间和优惠力度。',
    ],
  },
  {
    id: 'seed-playbook-1',
    source: 'playbook',
    createdAt: 1750400000000,
    title: '开播前 5 分钟福利 SOP（知识库）',
    scenario:
      '开播前 5 分钟固定安排一次无条件福利，建立观众预期；开播 10 分钟内完成第一轮商品讲解和互动答题，降低前 10 分钟流失。',
    rules: ['retention_guard', 'atmosphere_activate'],
    actions: ['lottery', 'answer_card'],
    takeaways: [
      '开播前 5 分钟固定福利，降低前 10 分钟流失。',
      '第一轮讲解后立即接答题卡，把公屏热度带起来。',
    ],
  },
];
