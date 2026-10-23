/**
 * 保利威服务端 OpenAPI —— 官方契约真值表
 *
 * 每一行都对照官方文档逐字段核实（2026-10-22 抓取），字段名/大小写/连字符必须原样保留：
 *   lottery       https://help.polyv.net/live/api/v4/channel/lottery_activity/lottery_activity_create/
 *   question      https://help.polyv.net/live/api/live_interaction/send_question/
 *   checkin       https://help.polyv.net/live/api/v4/chat/checkin/batch_checkin/
 *   card-push     https://help.polyv.net/live/api/v4/channel/market/cardPush/push/
 *   push-product  https://help.polyv.net/live/api/channel/operate/push_channel_product/
 *   notice        https://help.polyv.net/live/api/v4/chat/notice_add/
 *   coupon        https://help.polyv.net/live/api/v4/channel/coupon/create/
 *
 * ⚠️ 三个高频踩坑点（已按官方示例规避）：
 *  1) 抽奖路径是全小写 + 连字符：lottery-activity，不是 lottery_activity（后者 404）；
 *  2) 认证参数 appId/timestamp/sign 走 query，且「只对 query 里的参数签名」——
 *     官方 coupon / checkin / card-push 的示例里，业务参数放在 body 且不参与签名；
 *  3) lottery / checkin 的 body 是 JSON（不是 form），push-product 的 body 是 form。
 */
import type { ActionType } from '../../../shared/types.ts';

/** 账号侧资源 ID：不是模型能编出来的，必须来自真实账号 */
export type ResourceKey = 'questionId' | 'cardPushId' | 'productId';

export type BodyKind = 'none' | 'form' | 'json-object' | 'json-array';

export interface BuildInput {
  channelId: string;
  resources: {
    questionId?: string;
    cardPushId?: string;
    productId?: string;
  };
  /** 引擎/手动传入的业务参数，优先级最高 */
  params: Record<string, unknown>;
}

export interface BuiltRequest {
  /** 参与签发并拼到 URL 上的参数（不含 appId/timestamp/sign，签名时补） */
  query: Record<string, string | number>;
  bodyKind: BodyKind;
  body?: unknown;
  /**
   * query  = 只签 query（官方「认证在 query、业务在 body」型）
   * all    = query + body 字段一起签（官方「全表单」型，如 push-product / notice）
   */
  signScope: 'query' | 'all';
}

export interface RealSpec {
  method: 'POST' | 'GET';
  path: string;
  label: string;
  docUrl: string;
  /** 该动作官方必填的账号侧资源，缺失时直接拒绝发送（避免把脏请求打到真实频道） */
  requires?: ResourceKey[];
  build: (input: BuildInput) => BuiltRequest;
}

const pick = (params: Record<string, unknown>, key: string, fallback: string): string => {
  const v = params[key];
  return v === undefined || v === null || v === '' ? fallback : String(v);
};

const pickNum = (params: Record<string, unknown>, key: string, fallback: number): number => {
  const v = Number(params[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const REAL_SPECS: Record<ActionType, RealSpec> = {
  lottery: {
    method: 'POST',
    path: '/live/v4/channel/lottery-activity/create',
    label: '发起抽奖（无条件）',
    docUrl: 'https://help.polyv.net/live/api/v4/channel/lottery_activity/lottery_activity_create/',
    build: ({ channelId, params }) => ({
      query: { channelId },
      // 实测：该接口只接受 JSON body，form-urlencoded 会被拒（code=10001 Content type not supported）
      bodyKind: 'json-object',
      body: {
        activityName: pick(params, 'activityName', 'AI 福袋抽奖'),
        lotteryCondition: 'none',
        amount: pickNum(params, 'amount', 3),
        prizeName: pick(params, 'prizeName', '直播间专属好礼'),
      },
      signScope: 'query',
    }),
  },

  welfare_lottery: {
    method: 'POST',
    path: '/live/v4/channel/lottery-activity/create',
    label: '发起福利抽奖（评论参与）',
    docUrl: 'https://help.polyv.net/live/api/v4/channel/lottery_activity/lottery_activity_create/',
    build: ({ channelId, params }) => ({
      query: { channelId },
      bodyKind: 'json-object',
      body: {
        activityName: pick(params, 'activityName', '下单抽好礼'),
        // 官方 lotteryCondition 没有「商品」类型，最接近的福利语义是评论抽奖
        lotteryCondition: 'comment',
        comment: pick(params, 'comment', '想要'),
        activityDuration: pickNum(params, 'activityDuration', 3),
        amount: pickNum(params, 'amount', 2),
        prizeName: pick(params, 'prizeName', '免单名额'),
        // 非无条件 / 非答题抽奖，acceptType 必填
        acceptType: 'link',
        prizeUrl: pick(params, 'prizeUrl', 'https://www.polyv.net'),
      },
      signScope: 'query',
    }),
  },

  answer_card: {
    method: 'POST',
    path: '/live/v4/channel/question/send',
    label: '发送答题卡',
    docUrl: 'https://help.polyv.net/live/api/live_interaction/send_question/',
    requires: ['questionId'],
    build: ({ channelId, resources, params }) => ({
      // 官方示例把全部参数放在 URL 上（含 questionId），签名覆盖全部
      query: {
        channelId,
        questionId: String(resources.questionId ?? ''),
        duration: pickNum(params, 'duration', 60),
      },
      bodyKind: 'none',
      signScope: 'all',
    }),
  },

  checkin: {
    method: 'POST',
    path: '/live/v4/chat/batch-checkin',
    label: '批量设置签到',
    docUrl: 'https://help.polyv.net/live/api/v4/chat/checkin/batch_checkin/',
    build: ({ channelId, params }) => ({
      query: {},
      bodyKind: 'json-array',
      // 官方 body 是「频道数组」，不是对象
      body: [
        {
          // 官方要求 Integer；占位符预览时保留原字符串，避免变成 null
          channelId: Number.isFinite(Number(channelId)) ? Number(channelId) : channelId,
          limitTime: pickNum(params, 'limitTime', 60),
          message: pick(params, 'message', '签到领券'),
        },
      ],
      signScope: 'query',
    }),
  },

  push_card: {
    method: 'POST',
    path: '/live/v4/channel/card-push/push',
    label: '推送频道卡片',
    docUrl: 'https://help.polyv.net/live/api/v4/channel/market/cardPush/push/',
    requires: ['cardPushId'],
    build: ({ channelId, resources }) => ({
      query: { channelId },
      bodyKind: 'form',
      body: { cardPushId: String(resources.cardPushId ?? '') },
      signScope: 'query',
    }),
  },

  push_product: {
    method: 'POST',
    path: '/live/v3/channel/product/push-product',
    label: '推送商品库商品',
    docUrl: 'https://help.polyv.net/live/api/channel/operate/push_channel_product/',
    requires: ['productId'],
    build: ({ channelId, resources, params }) => ({
      query: {},
      bodyKind: 'form',
      // 官方表单型：channelId / productId / appId / timestamp / sign 全在 form body 里，一起签名
      body: {
        channelId,
        productId: String(resources.productId ?? ''),
        pushCardType: pick(params, 'pushCardType', 'bottomCard'),
      },
      signScope: 'all',
    }),
  },

  bulletin: {
    method: 'POST',
    path: '/live/v4/chat/add-bullentin',
    label: '发布公告',
    docUrl: 'https://help.polyv.net/live/api/v4/chat/notice_add/',
    build: ({ channelId, params }) => ({
      query: {
        channelId,
        content: pick(params, 'content', '欢迎来到直播间，下单享专属福利 🎁'),
        isTop: pick(params, 'isTop', 'Y'),
        isPop: pick(params, 'isPop', 'Y'),
      },
      bodyKind: 'none',
      signScope: 'all',
    }),
  },
};
