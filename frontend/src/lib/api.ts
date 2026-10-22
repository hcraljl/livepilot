/**
 * REST API 层 —— 统一处理 { ok, data } 响应信封与错误
 *
 * 契约依据：API.md v1.1（B 冻结）+ backend/src/routes/api.ts 实测形状
 * 负责人：A · @since v0.2.0
 *
 * 信封约定：POST 类统一 { ok: true, data } / { ok: false, error, code }；
 * 例外（直返业务对象）：GET /api/state、GET /api/stream、GET /api/replay。
 */
import type {
  ActionReq,
  ActionType,
  CopilotCandidatesResp,
  Decision,
  LiveEvent,
  LiveState,
  Mode,
  PolyvCallResult,
  ReplayResp,
  StartSimReq,
  StrategyConfig,
} from '@livepilot/shared';

/** 信封错误（服务端 ok:false 或结构异常） @since v0.2.0 */
export class ApiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

interface OkEnvelope {
  ok: true;
  data: unknown;
}
interface FailEnvelope {
  ok: false;
  error?: string;
  code?: number;
}
type Envelope = OkEnvelope | FailEnvelope;

const isEnvelope = (v: unknown): v is Envelope =>
  typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean';

/** 解析信封；非信封/失败均抛 ApiError @since v0.2.0 */
const unwrap = (raw: unknown, httpStatus: number): unknown => {
  if (!isEnvelope(raw)) throw new ApiError(httpStatus, `响应缺少信封结构（HTTP ${httpStatus}）`);
  if (!raw.ok) throw new ApiError(raw.code ?? httpStatus, raw.error ?? `请求失败（HTTP ${httpStatus}）`);
  return raw.data;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let r: Response;
  try {
    r = await fetch(path, init);
  } catch {
    throw new ApiError(0, '网络不可达：请确认后端已启动（npm run dev:backend）');
  }
  let raw: unknown;
  try {
    raw = await r.json();
  } catch {
    throw new ApiError(r.status, `响应非 JSON（HTTP ${r.status}）`);
  }
  return unwrap(raw, r.status) as T;
};

/**
 * 直返业务对象的 GET（契约例外：/api/state、/api/stream、/api/replay 不走信封）
 * @since v0.2.0（修复：复盘页曾按信封解析直返对象，导致 HTTP 200 也报错）
 */
const getRaw = async <T>(path: string): Promise<T> => {
  let r: Response;
  try {
    r = await fetch(path);
  } catch {
    throw new ApiError(0, '网络不可达：请确认后端已启动（npm run dev:backend）');
  }
  try {
    return (await r.json()) as T;
  } catch {
    throw new ApiError(r.status, `响应非 JSON（HTTP ${r.status}）`);
  }
};

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const get = <T>(path: string): Promise<T> => request<T>(path);

/** GET /api/state —— 首屏兜底（契约例外：直返 LiveState，无信封） @since v0.2.0 */
export const fetchState = (): Promise<LiveState> => getRaw<LiveState>('/api/state');

/** POST /api/sim/start —— 启动模拟器（演示固定 seed 保证可复现） @since v0.2.0 */
export const startSim = (req: StartSimReq = {}): Promise<LiveState> => post<LiveState>('/api/sim/start', req);

/** POST /api/sim/stop @since v0.2.0 */
export const stopSim = (): Promise<{ running: false }> => post<{ running: false }>('/api/sim/stop');

/** POST /api/sim/scenario —— 现场加戏（online_drop/cold_start/low_ctr/endgame/stream_stall） @since v0.2.0 */
export const injectScenario = (name: string): Promise<{ scenario: string }> =>
  post<{ scenario: string }>('/api/sim/scenario', { name });

/** POST /api/mode @since v0.2.0 */
export const setMode = (mode: Mode): Promise<{ mode: Mode }> => post<{ mode: Mode }>('/api/mode', { mode });

/** POST /api/strategy —— 阈值局部更新 @since v0.2.0 */
export const updateStrategy = (patch: Partial<StrategyConfig>): Promise<{ strategy: StrategyConfig }> =>
  post<{ strategy: StrategyConfig }>('/api/strategy', patch);

/** GET /api/decisions?status= @since v0.2.0 */
export const fetchDecisions = (status?: string): Promise<Decision[]> =>
  get<Decision[]>(`/api/decisions${status ? `?status=${encodeURIComponent(status)}` : ''}`);

/** POST /api/decision/confirm —— 半自动确认执行 @since v0.2.0 */
export const confirmDecision = (id: string): Promise<{ decision: Decision; result: PolyvCallResult }> =>
  post<{ decision: Decision; result: PolyvCallResult }>('/api/decision/confirm', { id });

/** POST /api/action —— 运营手点 @since v0.2.0 */
export const triggerAction = (req: ActionReq): Promise<{ decision: Decision; result: PolyvCallResult }> =>
  post<{ decision: Decision; result: PolyvCallResult }>('/api/action', req);

/** GET /api/events @since v0.2.0 */
export const fetchEvents = (since = 0, type?: string): Promise<LiveEvent[]> =>
  get<LiveEvent[]>(`/api/events?since=${since}${type ? `&type=${encodeURIComponent(type)}` : ''}`);

/** GET /api/replay —— 一键复盘（契约例外：直返 ReplayResp，无信封） @since v0.2.0 */
export const fetchReplay = (): Promise<ReplayResp> => getRaw<ReplayResp>('/api/replay');

/** GET /api/session/export?download=1 —— 本场全量导出（浏览器直接打开即下载） @since v0.2.0 */
export const sessionExportUrl = '/api/session/export?download=1';

/** GET /api/polyv/capabilities —— 路演能力清单 @since v0.2.0 */
export interface PolyvCapabilities {
  useReal: boolean;
  channelId: string;
  apiBase: string;
  actions: { action: string; label: string; method: string; path: string }[];
  webhook: string;
  statsPath: string;
}
export const fetchCapabilities = (): Promise<PolyvCapabilities> => get<PolyvCapabilities>('/api/polyv/capabilities');

/** GET /api/copilot/candidates —— 副驾经验候选 + AI 推荐（契约 v2，C 扩展） @since v0.3.0 */
export const fetchCopilotCandidates = (topK?: number): Promise<CopilotCandidatesResp> =>
  get<CopilotCandidatesResp>(`/api/copilot/candidates${topK ? `?topK=${topK}` : ''}`);

/** POST /api/copilot/apply —— 预览（confirm=false）/ 执行（confirm=true） @since v0.3.0
 *  注意两种返回形状（backend/src/routes/copilot.ts 实测）：
 *  预览 → { requiresConfirm: true, preview: {...} }（无 decision）
 *  执行 → { decision, result }
 */
export interface CopilotPreviewPayload {
  experienceId: string;
  experienceTitle: string;
  action: ActionType;
  label: string;
  payload: Record<string, unknown>;
  method?: string;
  path?: string;
  docUrl?: string;
  requiredParams: string[];
}
export type CopilotApplyResult =
  | { requiresConfirm: true; preview: CopilotPreviewPayload }
  | { decision: Decision; result: PolyvCallResult };

export const applyCopilot = (req: {
  experienceId: string;
  action: ActionType;
  confirm: boolean;
}): Promise<CopilotApplyResult> => post<CopilotApplyResult>('/api/copilot/apply', req);

/** GET /api/polyv/operations —— 官方 API 常量目录（路演展示，C 扩展） @since v0.3.0 */
export interface PolyvOperation {
  action: string;
  label: string;
  method: 'GET' | 'POST';
  path: string;
  docUrl?: string;
  requiredParams?: string[];
}
export const fetchPolyvOperations = (): Promise<{
  auth: string[];
  operations: PolyvOperation[];
}> => get<{ auth: string[]; operations: PolyvOperation[] }>('/api/polyv/operations');
