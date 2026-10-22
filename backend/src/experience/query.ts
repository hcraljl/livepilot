import type {
  AttributionItem,
  Metrics,
  ProductRank,
} from '../../../shared/types.js';

export const ACTION_LABELS: Record<string, string> = {
  lottery: '抽奖',
  welfare_lottery: '福利抽奖',
  answer_card: '答题卡',
  checkin: '签到',
  push_card: '卡片召回',
  push_product: '推送商品',
  bulletin: '公告',
  coupon: '优惠券',
};

export interface ExperienceQueryInput {
  metrics: Metrics;
  leaderboard: AttributionItem[];
  productRanking: ProductRank[];
}

export function buildExperienceQuery(input: ExperienceQueryInput): string {
  const { metrics, leaderboard, productRanking } = input;
  const parts: string[] = [
    '直播复盘 历史案例 经验库',
    `在线${Math.round(metrics.online)}人`,
    `成交${Math.round(metrics.orders)}单`,
    `成交额${Math.round(metrics.gmv)}`,
    `互动率${Math.round(metrics.danmakuRate * 100)}%`,
    metrics.currentProduct,
  ];

  if (typeof metrics.productCtr === 'number') {
    parts.push(`点击率${Math.round(metrics.productCtr * 1000) / 10}%`);
  }

  for (const item of leaderboard.slice(0, 2)) {
    parts.push(item.ruleName, item.rule);
    parts.push(ACTION_LABELS[item.action] ?? item.action);
    parts.push(`${item.incrementalOrders}单增量`);
  }

  for (const product of productRanking.slice(0, 3)) {
    parts.push(product.name);
  }

  return parts.filter(Boolean).join(' ');
}
