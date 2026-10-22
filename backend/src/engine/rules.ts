import type {
  ActionType,
  StrategyConfig,
} from '../../../shared/types.js';

export type RuleId =
  | 'retention_guard'
  | 'conversion_boost'
  | 'atmosphere_activate'
  | 'closing_push'
  | 'anomaly_fallback';

export const RULE_META: Record<
  RuleId,
  { name: string; priority: number; description: string }
> = {
  anomaly_fallback: {
    name: '异常兜底',
    priority: 110,
    description: '直播流异常时公告安抚',
  },
  retention_guard: {
    name: '留存保卫',
    priority: 100,
    description: '在线人数快速下滑时抽奖召回',
  },
  closing_push: {
    name: '逼单',
    priority: 90,
    description: '临近下播且 GMV 未达标时发券逼单',
  },
  conversion_boost: {
    name: '转化助推',
    priority: 80,
    description: '商品点击率低迷时推商品并绑定福利',
  },
  atmosphere_activate: {
    name: '氛围激活',
    priority: 60,
    description: '弹幕冷场时发起答题或签到',
  },
};

const WARMUP_SEC = 30;
const MIN_ONLINE_FOR_ATMOSPHERE = 200;

export interface PlannedAction {
  action: ActionType;
  label: string;
  payload?: Record<string, unknown>;
}

export interface RuleContext {
  now: number;
  elapsedSec: number;
  remainingSec: number;
  online: number;
  onlineChangePct: number | null;
  gmv: number;
  gmvTarget: number;
  orders: number;
  danmakuRate: number;
  productCtr: number | null;
  currentProduct: string;
  streamHealthy: boolean;
  recentActions: string[];
}

export interface RuleCandidate {
  rule: RuleId;
  priority: number;
  actions: PlannedAction[];
  triggerSummary: string;
  triggerData: Record<string, number | string>;
  cooldownSec: number;
  dedupeKey: string;
  expectedEffect: string;
}

function pct(value: number): number {
  return Math.round(value * 100);
}

function pct1(value: number): number {
  return Math.round(value * 1000) / 10;
}

function money(value: number): number {
  return Math.round(value);
}

export function evaluateRules(
  ctx: RuleContext,
  config: StrategyConfig,
): RuleCandidate[] {
  if (ctx.elapsedSec < WARMUP_SEC) return [];

  const remainingMin = Math.max(0, Math.ceil(ctx.remainingSec / 60));
  const cooldownSec = config.cooldownSec;

  // 推流异常时只做安抚，避免同时触发留存/冷场动作造成重复归因
  if (!ctx.streamHealthy) {
    return [
      {
        rule: 'anomaly_fallback',
        priority: RULE_META.anomaly_fallback.priority,
        actions: [
          {
            action: 'bulletin',
            label: '异常安抚公告',
            payload: {
              title: '直播信号恢复中',
              bulletin: '直播流正在恢复，请大家稍等片刻，马上回来。',
              content: '直播流正在恢复，请大家稍等片刻，马上回来。',
            },
          },
        ],
        triggerSummary: '检测到推流异常',
        triggerData: { online: ctx.online },
        cooldownSec,
        dedupeKey: 'anomaly_fallback',
        expectedEffect: '公告安抚观众，避免异常期间集中流失',
      },
    ];
  }

  const candidates: RuleCandidate[] = [];

  if (
    ctx.online > 0 &&
    ctx.onlineChangePct !== null &&
    ctx.onlineChangePct <= -config.retentionDropPct
  ) {
    const dropPct = pct(Math.abs(ctx.onlineChangePct));
    candidates.push({
      rule: 'retention_guard',
      priority: RULE_META.retention_guard.priority,
      actions: [
        {
          action: 'lottery',
          label: '无条件抽奖',
          payload: {
            title: '在线福利抽奖',
            prize: '品牌定制礼盒',
            lotteryTitle: '在线福利抽奖',
            lotteryDuration: 60,
          },
        },
        {
          action: 'push_card',
          label: '卡片召回',
          payload: {
            title: '别走，抽奖马上开',
            text: '留在直播间，30 秒后开奖',
          },
        },
      ],
      triggerSummary: `在线人数 ${dropPct}% 下滑`,
      triggerData: { dropPct, online: ctx.online },
      cooldownSec,
      dedupeKey: 'retention_guard',
      expectedEffect: '2 分钟内拉回在线人数，降低流失',
    });
  }

  if (
    config.gmvTarget > 0 &&
    ctx.remainingSec <= config.pushWindowMin * 60 &&
    ctx.remainingSec > 0 &&
    ctx.gmv < config.gmvTarget
  ) {
    candidates.push({
      rule: 'closing_push',
      priority: RULE_META.closing_push.priority,
      actions: [
        {
          action: 'coupon',
          label: '限时优惠券',
          payload: {
            title: '下播前限时优惠券',
            couponAmount: 20,
            couponName: '下播前限时优惠券',
            couponValue: 20,
          },
        },
        {
          action: 'bulletin',
          label: '逼单公告',
          payload: {
            title: '最后机会',
            bulletin: `最后 ${remainingMin} 分钟，下单立减，错过恢复原价。`,
            content: `最后 ${remainingMin} 分钟，下单立减，错过恢复原价。`,
          },
        },
      ],
      triggerSummary: `剩余 ${remainingMin} 分钟，GMV ¥${money(
        ctx.gmv,
      )} 未达目标 ¥${money(config.gmvTarget)}`,
      triggerData: {
        remainingMin,
        gmv: money(ctx.gmv),
        gmvTarget: money(config.gmvTarget),
      },
      cooldownSec,
      dedupeKey: 'closing_push',
      expectedEffect: '用限时优惠制造紧迫感，冲刺临门一脚',
    });
  }

  if (
    ctx.currentProduct &&
    ctx.productCtr !== null &&
    ctx.productCtr < config.conversionCtrThreshold
  ) {
    const ratePct = pct1(ctx.productCtr);
    const thresholdPct = pct1(config.conversionCtrThreshold);
    candidates.push({
      rule: 'conversion_boost',
      priority: RULE_META.conversion_boost.priority,
      actions: [
        {
          action: 'push_product',
          label: `推送商品：${ctx.currentProduct}`,
          payload: { productName: ctx.currentProduct },
        },
        {
          action: 'welfare_lottery',
          label: '商品福利抽奖',
          payload: {
            title: `${ctx.currentProduct}专属福利`,
            productName: ctx.currentProduct,
            prize: ctx.currentProduct,
            lotteryTitle: `${ctx.currentProduct}专属福利`,
            lotteryDuration: 90,
            conditionType: 'product',
          },
        },
      ],
      triggerSummary: `「${ctx.currentProduct}」点击率 ${ratePct}% 低于阈值 ${thresholdPct}%`,
      triggerData: {
        product: ctx.currentProduct,
        ctrPct: ratePct,
        thresholdPct,
      },
      cooldownSec,
      dedupeKey: `conversion_boost:${ctx.currentProduct}`,
      expectedEffect: '缩短下单路径，把商品兴趣转成成交',
    });
  }

  if (
    ctx.online >= MIN_ONLINE_FOR_ATMOSPHERE &&
    ctx.danmakuRate < config.coldDanmakuRate
  ) {
    const useCheckin = ctx.recentActions.includes('answer_card');
    const action: PlannedAction = useCheckin
      ? {
          action: 'checkin',
          label: '批量签到',
          payload: {
            title: '签到打卡',
            text: '签到领积分，活跃一下公屏',
          },
        }
      : {
          action: 'answer_card',
          label: '互动答题卡',
          payload: {
            title: '互动答题',
            text: '答对即可参与抽奖',
          },
        };
    candidates.push({
      rule: 'atmosphere_activate',
      priority: RULE_META.atmosphere_activate.priority,
      actions: [action],
      triggerSummary: `互动率 ${pct1(ctx.danmakuRate)}% 低于冷场阈值 ${pct1(
        config.coldDanmakuRate,
      )}%`,
      triggerData: {
        danmakuRatePct: pct1(ctx.danmakuRate),
        thresholdPct: pct1(config.coldDanmakuRate),
        online: ctx.online,
      },
      cooldownSec,
      dedupeKey: 'atmosphere_activate',
      expectedEffect: '60 秒内拉起弹幕互动，打断冷场',
    });
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}
