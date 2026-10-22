/**
 * 保利威服务端 OpenAPI 封装层（执行层）
 *
 * 职责：把「AI 决策 → 8 个互动动作」翻译成真实的 Polyv 服务端调用。
 * - 默认 USE_REAL_POLYV=false：走模拟回执，演彩排绝不污染真实频道；
 * - true 且密钥齐备：真实打 channelId 对应频道，观看页（开源 SDK）能立刻收到互动。
 *
 * 安全：本文件是唯一读取 config.polyv.appSecret 的位置（交给 sign.ts 计算签名），
 *      密钥永不出现在返回值、日志、HTTP 响应里。
 */
import type { ActionType, PolyvCallResult } from '../../../shared/types.ts';
import { canUseRealPolyv, config } from '../config.ts';
import { signParams } from './sign.ts';
import { getPolyvApiOperation } from './api-catalog.ts';

export interface ExecuteOptions {
  channelId?: string;
  params?: Record<string, unknown>;
}

interface EndpointSpec {
  method: 'POST' | 'GET';
  path: string;
  /** 人类可读的动作名（能力清单 / 前端展示用） */
  label: string;
  /** 该动作需要的最小参数（缺省时补默认值，避免真实调用报参数错） */
  defaults?: Record<string, unknown>;
}

/**
 * 8 个动作 → 官方服务端接口映射（2026-10-22 按 help.polyv.net 核对）
 * 注意：questionId / cardPushId / productId / couponIds 是账号侧资源 ID，
 * 由 config 注入；defaults 只放官方参数名，避免再出现 couponName 这类无效字段。
 */
export const ACTION_ENDPOINTS: Record<ActionType, EndpointSpec> = {
  lottery: {
    method: 'POST',
    path: '/live/v4/channel/lottery-activity/create',
    label: '发起抽奖（无条件）',
    defaults: {
      activityName: '在线福利抽奖',
      lotteryCondition: 'none',
      amount: 1,
      prizeName: '品牌定制礼盒',
    },
  },
  welfare_lottery: {
    method: 'POST',
    path: '/live/v4/channel/lottery-activity/create',
    label: '发起互动福利抽奖',
    defaults: {
      activityName: '下单抽好礼',
      lotteryCondition: 'comment',
      amount: 1,
      prizeName: '品牌定制礼盒',
    },
  },
  answer_card: {
    method: 'POST',
    path: '/live/v4/channel/question/send',
    label: '发起答题卡',
    defaults: { duration: 60 },
  },
  checkin: {
    method: 'POST',
    path: '/live/v4/chat/batch-checkin',
    label: '批量签到',
    defaults: { message: '签到领积分' },
  },
  push_card: {
    method: 'POST',
    path: '/live/v4/channel/card-push/push',
    label: '推送卡片',
    defaults: {},
  },
  push_product: {
    method: 'POST',
    path: '/live/v3/channel/product/push-product',
    label: '推送商品弹层',
    defaults: {},
  },
  bulletin: {
    method: 'POST',
    path: '/live/v4/chat/add-bullentin',
    label: '发布公告',
    defaults: { content: '欢迎来到直播间，下单享专属福利 🎁' },
  },
  coupon: {
    method: 'POST',
    path: '/live/v4/channel/coupon/create',
    label: '发放优惠券',
    defaults: {},
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PolyvClient {
  /** 当前是否真实调用（任一条件不满足自动降级） */
  get isReal(): boolean {
    return canUseRealPolyv();
  }

  /** 能力清单：前端「Polyv 能力」面板直接消费，证明接口真的接上了 */
  capabilities() {
    return {
      useReal: this.isReal,
      channelId: config.polyv.channelId,
      apiBase: config.polyv.apiBase,
      actions: (Object.keys(ACTION_ENDPOINTS) as ActionType[]).map((action) => ({
        action,
        label: ACTION_ENDPOINTS[action].label,
        method: ACTION_ENDPOINTS[action].method,
        path: ACTION_ENDPOINTS[action].path,
        docUrl: getPolyvApiOperation(action)?.docUrl,
      })),
      webhook: '/polyv/webhook',
      statsPath: config.polyv.statsPath,
    };
  }

  /**
   * 执行一个动作。
   * 永远返回结构化回执（不抛异常），让引擎和看板都能继续跑。
   */
  async execute(action: ActionType, opts: ExecuteOptions = {}): Promise<PolyvCallResult> {
    const spec = ACTION_ENDPOINTS[action];
    if (!spec) {
      return { ok: false, mock: !this.isReal, code: 400, message: `未知动作：${action}` };
    }

    const channelId = opts.channelId || config.polyv.channelId;
    const params: Record<string, unknown> = { ...spec.defaults, ...(opts.params ?? {}) };
    if (channelId) params.channelId = channelId;

    // 账号侧资源 ID 只能来自配置，不能被模型编造
    switch (action) {
      case 'push_product':
        if (!params.productId && config.polyv.defaultProductId) {
          params.productId = config.polyv.defaultProductId;
        }
        break;
      case 'coupon':
        if (!params.couponIds && config.polyv.defaultCouponIds) {
          params.couponIds = config.polyv.defaultCouponIds
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        }
        break;
      case 'push_card':
        if (!params.cardPushId && config.polyv.defaultCardPushId) {
          params.cardPushId = config.polyv.defaultCardPushId;
        }
        break;
      case 'answer_card':
        if (!params.questionId && config.polyv.defaultQuestionId) {
          params.questionId = config.polyv.defaultQuestionId;
        }
        break;
      default:
        break;
    }

    if (!this.isReal) return this.mockExecute(action, spec, params);

    const started = Date.now();
    try {
      const body = signParams(this.flatten(params));
      const res = await fetch(`${config.polyv.apiBase}${spec.path}`, {
        method: spec.method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(config.polyv.timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        status?: string;
        message?: string;
        data?: unknown;
      };
      const ok = res.ok && (json.code === 200 || json.status === 'success');
      const result: PolyvCallResult = {
        ok,
        mock: false,
        code: json.code ?? res.status,
        message: json.message || (ok ? '保利威已受理' : `HTTP ${res.status}`),
        endpoint: `${spec.method} ${spec.path}`,
        latencyMs: Date.now() - started,
        data: json.data,
      };
      if (!ok) console.error(`[polyv] ${spec.path} 失败：`, result.code, result.message);
      return result;
    } catch (err) {
      const message = (err as Error).name === 'TimeoutError' ? '保利威接口超时（已降级为本地提示）' : (err as Error).message;
      console.error(`[polyv] ${spec.path} 异常：`, message);
      return {
        ok: false,
        mock: false,
        code: -1,
        message,
        endpoint: `${spec.method} ${spec.path}`,
        latencyMs: Date.now() - started,
      };
    }
  }

  /** 模拟执行：给演示一个稳定、可讲故事的回执（不产生任何真实副作用） */
  private async mockExecute(action: ActionType, spec: EndpointSpec, params: Record<string, unknown>): Promise<PolyvCallResult> {
    const started = Date.now();
    await sleep(40 + Math.floor(Math.random() * 90));
    return {
      ok: true,
      mock: true,
      code: 200,
      message: `模拟执行成功：${spec.label}（未调用真实频道）`,
      endpoint: `MOCK ${spec.method} ${spec.path}`,
      latencyMs: Date.now() - started,
      data: { ...params, simulated: true, action, note: 'USE_REAL_POLYV=false' },
    };
  }

  /**
   * 统计轮询：真实模式下取频道统计，模拟模式返回 undefined（由模拟器供数）。
   * 说明：统计接口在不同 Polyv API 版本路径略有差异，故路径做成可配置（POLYV_STATS_PATH）。
   */
  async pollStats(channelId = config.polyv.channelId): Promise<Partial<PolyvCallResult> | undefined> {
    if (!this.isReal) return undefined;
    try {
      const query = signParams({ channelId });
      const url = `${config.polyv.apiBase}${config.polyv.statsPath}?${new URLSearchParams(query).toString()}`;
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(config.polyv.timeoutMs) });
      const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: unknown };
      return {
        ok: res.ok && (json.code === 200 || json.code === 0 || json.code === undefined),
        mock: false,
        code: json.code ?? res.status,
        message: json.message ?? 'ok',
        endpoint: `GET ${config.polyv.statsPath}`,
        data: json.data,
      };
    } catch (err) {
      return { ok: false, mock: false, code: -1, message: (err as Error).message, endpoint: `GET ${config.polyv.statsPath}` };
    }
  }

  /** 表单只接受标量；对象/数组按官方约定序列化 */
  private flatten(params: Record<string, unknown>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') out[k] = JSON.stringify(v);
      else out[k] = v as string | number | boolean;
    }
    return out;
  }
}

/** 全局单例：路由层与引擎（C）共用 */
export const polyvClient = new PolyvClient();
