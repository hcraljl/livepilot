/**
 * 后端配置（唯一读取环境变量的地方）
 *
 * 铁律：appSecret / DeepSeek key 只在此进程内存里出现，绝不出现在任何 HTTP 响应或日志中。
 * 前端永远拿不到密钥 —— 所有保利威调用都由后端中转。
 */
import 'dotenv/config';
import type { StrategyConfig } from '../../shared/types.ts';

const str = (key: string, fallback = ''): string => {
  const v = process.env[key];
  return v === undefined || v === null ? fallback : String(v).trim();
};

const num = (key: string, fallback: number): number => {
  const v = Number(str(key));
  return Number.isFinite(v) && str(key) !== '' ? v : fallback;
};

const bool = (key: string, fallback = false): boolean => {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
};

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: num('PORT', 4000),

  /** 保利威（仅后端可见） */
  polyv: {
    appId: str('POLYV_APP_ID'),
    /** ⚠️ 只在 polyv/sign.ts 与 polyv/client.ts 内部被引用 */
    appSecret: str('POLYV_APP_SECRET'),
    userId: str('POLYV_USER_ID'),
    channelId: str('POLYV_CHANNEL_ID'),
    apiBase: str('POLYV_API_BASE', 'https://api.polyv.net').replace(/\/+$/, ''),
    /** 统计轮询接口路径（不同 API 版本路径有差异，可用环境变量覆盖） */
    statsPath: str('POLYV_STATS_PATH', '/live/v3/channels/statistics/view'),
    /** 单次请求超时（毫秒），演示现场网络抖动时快速降级 */
    timeoutMs: num('POLYV_TIMEOUT_MS', 6000),
    /**
     * 账号侧资源 ID —— 这些不是模型能编出来的，必须来自真实保利威账号后台。
     * 缺哪个，对应的动作在真实模式下会被拒绝发送（并给出明确提示），不会把脏请求打到频道。
     */
    resources: {
      questionId: str('POLYV_QUESTION_ID'),
      cardPushId: str('POLYV_CARD_PUSH_ID'),
      productId: str('POLYV_PRODUCT_ID'),
      // 优惠券（POLYV_COUPON_IDS）已随「不发券」的业务决定下线
    },
  },

  /**
   * 是否真正调用保利威 OpenAPI。
   * false（默认）= 模拟执行，绝不会污染真实频道，适合彩排；
   * true = 真实打频道，需要 appId/appSecret/channelId 齐备。
   */
  useRealPolyv: bool('USE_REAL_POLYV', false),

  /**
   * 真实模式下，若动作所需的账号侧资源（questionId / cardPushId / productId）
   * 未配置，是否自动降级为「同目的但不需要资源」的动作。
   *
   * 为什么默认开：不降级的话这些决策会必然失败（10001 参数为 null），
   * 演示现场会看到一串失败；降级后互动仍能真实下发，且决策理由里会写明降级原因，
   * 不会假装原本的动作成功了。资源配齐后不再触发降级。
   */
  autoDegrade: bool('POLYV_AUTO_DEGRADE', true),

  /** DeepSeek（C 的引擎层使用；此处只负责读取与透传，不参与逻辑） */
  deepseek: {
    apiKey: str('DEEPSEEK_API_KEY'),
    base: str('DEEPSEEK_BASE', 'https://api.deepseek.com'),
    model: str('DEEPSEEK_MODEL', 'deepseek-chat'),
  },

  /** 模拟器默认参数 */
  simulator: {
    totalMin: num('SIM_TOTAL_MIN', 30),
    /** 1 秒真实时间推进多少秒直播时间（越大演示越快） */
    speed: num('SIM_SPEED', 10),
    tickMs: num('SIM_TICK_MS', 800),
    seed: num('SIM_SEED', 20261024),
  },

  /** 默认策略阈值（前端策略面板可在线覆盖，见 POST /api/strategy） */
  defaultStrategy: {
    enabled: true,
    aiLevel: 'hybrid',
    experienceTopK: 5,
    retentionDropPct: 0.15,
    retentionWindowSec: 60,
    conversionCtrThreshold: 0.03,
    conversionWindowSec: 180,
    coldDanmakuRate: 0.12,
    coldWindowSec: 60,
    gmvTarget: 120000,
    pushWindowMin: 10,
    cooldownSec: 90,
  } satisfies StrategyConfig,
} as const;

/** 真实调用是否具备必要条件（缺一个都自动降级为模拟，保证演示不翻车） */
export const canUseRealPolyv = (): boolean =>
  config.useRealPolyv &&
  config.polyv.appId !== '' &&
  config.polyv.appSecret !== '' &&
  config.polyv.channelId !== '';

/** 启动自检信息（绝不打印密钥本身，只打印是否配置） */
export const describeEnv = (): Record<string, string> => ({
  nodeEnv: config.nodeEnv,
  port: String(config.port),
  useRealPolyv: String(config.useRealPolyv),
  polyvAppId: config.polyv.appId ? '已配置' : '未配置',
  polyvAppSecret: config.polyv.appSecret ? '已配置(已隐藏)' : '未配置',
  polyvChannelId: config.polyv.channelId || '未配置',
  deepseekKey: config.deepseek.apiKey ? '已配置(已隐藏)' : '未配置（引擎走模板兜底）',
  simulator: `${config.simulator.totalMin}min / speed x${config.simulator.speed}`,
});
