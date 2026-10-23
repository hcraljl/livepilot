/**
 * 保利威服务端 OpenAPI 执行层
 *
 * 设计原则（2026-10-22 按官方文档逐接口核对后重写）：
 * 1. 路径 / 字段名 / body 编码全部照官方示例，不做「看起来合理」的猜测；
 * 2. 认证参数 appId/timestamp/sign 只签名「参与签名的参数集」：
 *      - signScope='query'：业务参数在 body 且不参与签名（coupon / checkin / card-push / lottery）
 *      - signScope='all'  ：全部字段一起签（notice / question / push-product）
 * 3. 账号侧资源 ID（questionId / cardPushId / productId / couponIds）缺失时**直接拒绝发送**，
 *    并返回可执行的修复提示 —— 绝不把脏请求打到真实频道；
 * 4. appSecret 只在本文件与 sign.ts 之间流动，永不出现在返回值 / 日志 / HTTP 响应里。
 */
import type { ActionType, PolyvCallResult } from '../../../shared/types.ts';
import { config } from '../config.ts';
import { REAL_SPECS, type BuiltRequest, type ResourceKey } from './endpoints.ts';
import { signParams } from './sign.ts';

export interface ExecuteOptions {
  channelId?: string;
  params?: Record<string, unknown>;
}

/** 资源缺失时给人看的修复指引 */
const RESOURCE_HINT: Record<ResourceKey, string> = {
  questionId: 'POLYV_QUESTION_ID（保利威后台「互动-答题」里创建的答题卡 ID）',
  cardPushId: 'POLYV_CARD_PUSH_ID（后台「营销-卡片」里推送卡片的数字 ID）',
  productId: 'POLYV_PRODUCT_ID（后台「商品库」里的商品 ID）',
  couponIds: 'POLYV_COUPON_IDS（后台「营销-优惠券」里的券 ID，多个用英文逗号分隔）',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一次真实请求的构造结果（live-test 也复用，保证「测的就是跑的」） */
export interface PreparedRequest {
  action: ActionType;
  method: 'POST' | 'GET';
  url: string;
  bodyKind: BuiltRequest['bodyKind'];
  /** 实际发送的请求体（已序列化）；none 时为 undefined */
  bodyText?: string;
  contentType?: string;
  /** 已签名参数（含 sign，仅内存可见；打印时会脱敏 sign） */
  signed: Record<string, string | number>;
  /** 调试用：脱敏后的请求预览 */
  preview: string;
  /** 预览模式下的说明（缺密钥 / 占位符等） */
  notes: string[];
}

export class PolyvClient {
  /**
   * 运行时「演练开关」：即使账号密钥全配好，也可以强制走模拟回执。
   * 用途：现场彩排 / 反复演示时不污染真实直播间的互动与优惠券库存。
   */
  private forceMock = false;

  /** 运行时指定的频道号（演示现场可临时切换，空 = 用 .env） */
  private runtimeChannelId = '';

  /** 生效的频道号：运行时指定优先，其次 .env */
  get channelId(): string {
    return this.runtimeChannelId || config.polyv.channelId;
  }

  /** 运行时切换频道（只影响「往哪个频道发互动」，与密钥无关） */
  setChannelId(channelId: string): string {
    this.runtimeChannelId = channelId.trim();
    return this.channelId;
  }

  get isReal(): boolean {
    return !this.forceMock && this.credentialsReady;
  }

  /** 是否处于强制演练（即使凭据齐备也不发真实请求） */
  get dryRun(): boolean {
    return this.forceMock;
  }

  /**
   * 账号侧凭据是否齐备（只决定"能不能"切真实，不代表当前就在真实）。
   * 频道号可用运行时值，方便现场换频道后立即生效。
   */
  get credentialsReady(): boolean {
    return config.useRealPolyv && Boolean(config.polyv.appId) && Boolean(config.polyv.appSecret) && Boolean(this.channelId);
  }

  /**
   * 切换演练/真实。切真实时如果凭据不全，返回 false 并保持演练，
   * 避免现场误切成"半真半假"的状态。
   */
  setDryRun(on: boolean): boolean {
    if (!on && !this.credentialsReady) {
      this.forceMock = true;
      return false;
    }
    this.forceMock = on;
    return true;
  }

  /**
   * 该动作在真实模式下缺哪些账号侧资源（空数组 = 可直接执行）。
   * 用于决策执行前预检，避免把注定 10001 的请求打出去。
   */
  missingResources(action: ActionType): ResourceKey[] {
    const spec = REAL_SPECS[action];
    if (!spec) return [];
    const status = this.resourceStatus();
    return (spec.requires ?? []).filter((k) => !status[k]);
  }

  /** 当前账号侧资源齐备情况：真实模式的能力边界一目了然 */
  resourceStatus() {
    const r = config.polyv.resources;
    return {
      questionId: Boolean(r.questionId),
      cardPushId: Boolean(r.cardPushId),
      productId: Boolean(r.productId),
      couponIds: r.couponIds.length > 0,
    };
  }

  /** 能力清单：前端可直接展示「这个动作到底打哪个官方接口、还真能不能打」 */
  capabilities() {
    const status = this.resourceStatus();
    return {
      useReal: this.isReal,
      /** 是否强制演练（凭据齐备也不真发） */
      dryRun: this.forceMock,
      /** 凭据是否齐备（决定能不能切真实） */
      credentialsReady: this.credentialsReady,
      channelId: this.channelId,
      apiBase: config.polyv.apiBase,
      actions: (Object.keys(REAL_SPECS) as ActionType[]).map((action) => {
        const spec = REAL_SPECS[action];
        const missing = (spec.requires ?? []).filter((k) => !status[k]);
        return {
          action,
          label: spec.label,
          method: spec.method,
          path: spec.path,
          docUrl: spec.docUrl,
          requires: spec.requires ?? [],
          /** 真实模式是否可直接执行（资源齐备） */
          ready: missing.length === 0,
          missing,
        };
      }),
      resources: status,
      webhook: '/polyv/webhook',
      statsPath: config.polyv.statsPath,
    };
  }

  /**
   * 构造真实请求（不发送）。
   * strict（默认）：缺频道 / 缺资源 / 缺密钥 → 抛错，execute 会转成结构化回执；
   * tolerant：用占位符拼出请求形状，供 --dry 预览（不会真的发送）。
   */
  prepare(action: ActionType, opts: ExecuteOptions & { tolerant?: boolean } = {}): PreparedRequest {
    const spec = REAL_SPECS[action];
    if (!spec) throw new Error(`未知动作：${action}`);
    const tolerant = opts.tolerant === true;
    const notes: string[] = [];

    if (!config.polyv.appId || !config.polyv.appSecret) {
      if (!tolerant) throw new Error('未配置 POLYV_APP_ID / POLYV_APP_SECRET，无法发起真实调用');
      notes.push('未签名（缺 appSecret）');
    }

    let channelId = opts.channelId || this.channelId;
    if (!channelId) {
      if (!tolerant) throw new Error('未配置 POLYV_CHANNEL_ID，真实模式下必须先指定频道号');
      channelId = '<CHANNEL_ID>';
      notes.push('频道号为占位符');
    }

    const status = this.resourceStatus();
    const resources = {
      questionId: config.polyv.resources.questionId || '<QUESTION_ID>',
      cardPushId: config.polyv.resources.cardPushId || '<CARD_PUSH_ID>',
      productId: config.polyv.resources.productId || '<PRODUCT_ID>',
      couponIds: config.polyv.resources.couponIds.length
        ? config.polyv.resources.couponIds
        : ['<COUPON_ID>'],
    };

    const missing = (spec.requires ?? []).filter((k) => !status[k]);
    if (missing.length) {
      const hint = missing.map((k) => RESOURCE_HINT[k]).join('；');
      if (!tolerant) {
        throw new Error(`缺少账号侧资源 ${missing.join(' / ')}（真实模式拒绝发送）。请在 backend/.env 配置：${hint}`);
      }
      notes.push(`资源占位：${missing.join(' / ')}`);
    }

    const built = spec.build({
      channelId,
      resources,
      params: opts.params ?? {},
    });

    // ---- 决定「谁参与签名、谁放进 URL、谁放进 body」 ----
    const bodyFields =
      built.bodyKind === 'form' && built.body && typeof built.body === 'object'
        ? (built.body as Record<string, string | number>)
        : {};

    let signBase: Record<string, string | number>;
    let urlQuery: Record<string, string | number> = {};
    let bodyText: string | undefined;
    let contentType: string | undefined;

    if (built.signScope === 'all') {
      signBase = { ...built.query, ...bodyFields };
      if (built.bodyKind === 'form') {
        // 全字段走 form body（官方 push-product / notice 示例就是这种）
        contentType = 'application/x-www-form-urlencoded;charset=UTF-8';
        bodyText = undefined; // 签名补完后统一序列化
      }
    } else {
      signBase = { ...built.query };
    }

    let signed: Record<string, string | number>;
    try {
      signed = signParams(signBase) as Record<string, string | number>;
    } catch (err) {
      if (!tolerant) throw err;
      // 预览模式：没有密钥就把原始参数原样列出，sign 留占位
      signed = { ...signBase, sign: '<SIGN>' };
    }

    if (built.signScope === 'all') {
      if (built.bodyKind === 'form') {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(signed)) form.append(k, String(v));
        bodyText = form.toString();
        contentType = 'application/x-www-form-urlencoded;charset=UTF-8';
      } else {
        // none：全部塞 URL（notice / question 官方示例即如此）
        urlQuery = signed;
      }
    } else {
      urlQuery = signed;
      if (built.bodyKind === 'form') {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(bodyFields)) form.append(k, String(v));
        bodyText = form.toString();
        contentType = 'application/x-www-form-urlencoded;charset=UTF-8';
      } else if (built.bodyKind === 'json-object' || built.bodyKind === 'json-array') {
        bodyText = JSON.stringify(built.body);
        contentType = 'application/json;charset=UTF-8';
      }
    }

    const qs = new URLSearchParams(
      Object.entries(urlQuery).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${config.polyv.apiBase}${spec.path}${qs ? `?${qs}` : ''}`;

    const maskedQs = new URLSearchParams(
      Object.entries(urlQuery).map(([k, v]) => [k, k === 'sign' ? `${String(v).slice(0, 6)}***` : String(v)]),
    ).toString();

    return {
      action,
      method: spec.method,
      url,
      bodyKind: built.bodyKind,
      bodyText,
      contentType,
      signed,
      notes,
      preview: `${spec.method} ${spec.path}${maskedQs ? `?${maskedQs}` : ''}${
        bodyText ? ` | body(${built.bodyKind}) ${bodyText.slice(0, 160)}` : ''
      }${notes.length ? `  ⚠️ ${notes.join('；')}` : ''}`,
    };
  }

  /** 执行一个动作：真实模式按官方契约发送；未开启真实模式则走模拟回执 */
  async execute(action: ActionType, opts: ExecuteOptions = {}): Promise<PolyvCallResult> {
    if (!REAL_SPECS[action]) {
      return { ok: false, mock: !this.isReal, code: 400, message: `未知动作：${action}` };
    }
    if (!this.isReal) return this.mockExecute(action, opts);

    const started = Date.now();
    const endpoint = `${REAL_SPECS[action].method} ${REAL_SPECS[action].path}`;

    let req: PreparedRequest;
    try {
      req = this.prepare(action, opts);
    } catch (err) {
      // 配置/资源问题：不发送，直接如实返回，前端能看见具体缺什么
      return {
        ok: false,
        mock: false,
        code: 400,
        message: (err as Error).message,
        endpoint,
        latencyMs: Date.now() - started,
      };
    }

    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.contentType ? { 'Content-Type': req.contentType } : undefined,
        body: req.bodyText,
        signal: AbortSignal.timeout(config.polyv.timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        status?: string;
        message?: string;
        error?: { code?: number; desc?: string };
        data?: unknown;
      };
      const ok = res.ok && (json.code === 200 || json.status === 'success');
      const result: PolyvCallResult = {
        ok,
        mock: false,
        code: json.error?.code ?? json.code ?? res.status,
        message:
          json.error?.desc ||
          json.message ||
          (ok ? '保利威已受理' : `HTTP ${res.status} ${json.status ?? ''}`.trim()),
        endpoint,
        latencyMs: Date.now() - started,
        data: json.data,
      };
      if (!ok) {
        console.error(`[polyv] ✗ ${endpoint} code=${result.code} ${result.message}`);
        console.error(`[polyv]   请求预览：${req.preview}`);
      } else {
        console.log(`[polyv] ✓ ${endpoint} ${result.latencyMs}ms`);
      }
      return result;
    } catch (err) {
      const message =
        (err as Error).name === 'TimeoutError'
          ? `保利威接口超时（>${config.polyv.timeoutMs}ms）`
          : (err as Error).message;
      console.error(`[polyv] ✗ ${endpoint} 异常：${message}`);
      return { ok: false, mock: false, code: -1, message, endpoint, latencyMs: Date.now() - started };
    }
  }

  /** 模拟执行：演示彩排时用，绝不产生真实副作用 */
  private async mockExecute(action: ActionType, opts: ExecuteOptions): Promise<PolyvCallResult> {
    const spec = REAL_SPECS[action];
    const started = Date.now();
    await sleep(40 + Math.floor(Math.random() * 90));
    const reason = this.forceMock
      ? 'dryRun=true（现场演练，强制不发真实请求）'
      : 'USE_REAL_POLYV=false 或 密钥/频道未配齐';
    return {
      ok: true,
      mock: true,
      code: 200,
      message: `模拟执行成功：${spec.label}（未调用真实频道）`,
      endpoint: `MOCK ${spec.method} ${spec.path}`,
      latencyMs: Date.now() - started,
      data: { ...(opts.params ?? {}), simulated: true, action, note: reason },
    };
  }

  /**
   * 统计轮询：真实模式下取频道统计，模拟模式返回 undefined（由模拟器供数）。
   * 路径可配（POLYV_STATS_PATH），不同 API 版本路径有差异。
   */
  async pollStats(channelId = this.channelId): Promise<Partial<PolyvCallResult> | undefined> {
    if (!this.isReal) return undefined;
    try {
      const query = signParams({ channelId }) as Record<string, string | number>;
      const url = `${config.polyv.apiBase}${config.polyv.statsPath}?${new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)]),
      ).toString()}`;
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
      return {
        ok: false,
        mock: false,
        code: -1,
        message: (err as Error).message,
        endpoint: `GET ${config.polyv.statsPath}`,
      };
    }
  }
}

/** 全局单例：路由层与引擎（C）共用 */
export const polyvClient = new PolyvClient();
