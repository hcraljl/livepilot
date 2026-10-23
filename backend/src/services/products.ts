/**
 * 商品库服务 —— 频道商品的「查询 / 创建 / 回写」
 *
 * 为什么要有这个文件：
 *   push_product（推送商品）这个动作本身早就通了（/live/v3/channel/product/push-product），
 *   但它 requires productId —— 而这个账号的商品库实测是空的（0 条），
 *   于是 prepare() 判定缺资源 → 真实模式拒绝发送 → executor 按 DEGRADE_TO 降级成公告。
 *   也就是说：**链路没问题，缺的是「频道里得先有一个商品」**。
 *
 *   商品 ID 不像价格可以在请求里凭空编，它是账号侧的实体，必须先创建。
 *   官方提供服务端写入口 POST /live/v3/channel/product/add，所以这里补齐「建品」这一步，
 *   让 push_product 从「必降级」变成「真的能推」。
 *
 * 官方契约要点（add 接口与其它动作不一样，别套错）：
 *   - 只有 (appId, timestamp, channelId) 参与签名，且走 URL query
 *   - 商品字段走 JSON body，Content-Type: application/json，**不参与签名**
 *   - 普通商品（productType=normal）必传：name / cover / realPrice / status / linkType(+link)
 *   - 成功返回 data.productId
 *
 * 创建成功后会把 productId 写回两处：
 *   1. polyvClient 的运行时资源 —— 立即生效，下一次 push_product 就不再降级
 *   2. backend/.env 的 POLYV_PRODUCT_ID —— 进程重启后依然有效（.env 不入库，仅本机）
 *
 * 契约：GET/POST /api/products（API.md §八）
 * 负责人：B · @since v1.1.0
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { signParams } from '../polyv/sign.ts';
import { polyvClient } from '../polyv/client.ts';

/** backend/.env 的路径（本文件在 backend/src/services/ 下） */
const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));

/** 频道商品列表接口 */
const LIST_PATH = '/live/v3/channel/product/list';
/** 创建商品接口 */
const ADD_PATH = '/live/v3/channel/product/add';

export interface ChannelProduct {
  productId: string;
  name: string;
  /** 实际价格（元） */
  realPrice: number;
  cover: string;
  link: string;
  /** 1 上架 / 2 下架 */
  status: number;
}

export interface CreateProductInput {
  name: string;
  /** 实际价格（元） */
  realPrice: number;
  /** 商品封面链接（普通商品必传） */
  cover?: string;
  /** 跳转链接（linkType=10 通用链接时必传） */
  link?: string;
  productDesc?: string;
}

/**
 * 演示用默认商品：与模拟器 PRODUCTS 保持一致，
 * 这样「预置/模拟讲解的商品」和「真实能推的商品」是同一批，演示时不会串味。
 */
export const DEMO_PRODUCTS: CreateProductInput[] = [
  { name: '山野茶油 500ml', realPrice: 89 },
  { name: '手工红糖姜茶礼盒', realPrice: 59 },
  { name: '古法酿造酱油 2 瓶装', realPrice: 69 },
  { name: '农家土蜂蜜 500g', realPrice: 129 },
  { name: '现摘赣南脐橙 5 斤', realPrice: 49 },
  { name: '非遗手作腐竹 1kg', realPrice: 39 },
];

/** 封面占位图：add 接口对普通商品强制要 cover，演示时没有现成素材就用它 */
const DEMO_COVER = 'https://placehold.co/600x600/f5f5f4/1c1917?text=POLYV';
/** 跳转链接占位：私域自播演示阶段没有真实商详页，指向保利威官网 */
const DEMO_LINK = 'https://www.polyv.net/';

const log = (msg: string): void => console.log(`[products] ${msg}`);

/** query 签名 + GET：列表类接口（参数是 complex 的最小集，全部参与签名） */
async function signedGet<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
  const signed = signParams({ ...params }) as Record<string, string | number>;
  const qs = new URLSearchParams(Object.entries(signed).map(([k, v]) => [k, String(v)])).toString();
  const url = `${config.polyv.apiBase}${path}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.polyv.timeoutMs) });
  const json = (await res.json().catch(() => null)) as { code?: number; data?: T } | null;
  if (!json || json.code !== 200) return null;
  return (json.data ?? null) as T | null;
}

/**
 * query 签名 + JSON body：add 接口专用（somente appId/timestamp/channelId 签名，body 不签）
 *
 * 注意这里不能直接复用 polyvClient.prepare —— 那一层是按 ActionType 组织的，
 * 而「建品」不是一个直播互动动作，硬塞进 REAL_SPECS 会把「8 个动作」的语义搞乱。
 */
/**
 * 把保利威的业务性拒绝翻译成人话。
 *
 * 实测踩到的坑：账号未做企业认证时，add 接口返回 code 400「商品库功能已被禁用」，
 * 而 list 接口照样返回 200 + 空数组 —— 光看列表会以为「只是还没加商品」，
 * 反复重试只会不断撞同一堵墙。这里把官方口径翻译成可执行的下一步。
 */
function explainFailure(code: unknown, message: string): string {
  if (message.includes('已被禁用') || message.includes('未认证') || message.includes('认证')) {
    return (
      `当前账号未开通商品库（保利威原文：${message}）。` +
      `官方文档写明：未认证或个人认证的账号无法使用频道/平台商品库，需先在控制台完成企业认证。` +
      `开通后无需改代码，点「推送商品」即可直接生效。`
    );
  }
  return `创建失败（code ${String(code ?? '未知')}）：${message}`;
}

async function signedPostJson<T>(
  path: string,
  query: Record<string, string | number>,
  body: Record<string, unknown>,
): Promise<T | null> {
  const signed = signParams({ ...query }) as Record<string, string | number>;
  const qs = new URLSearchParams(Object.entries(signed).map(([k, v]) => [k, String(v)])).toString();
  const url = `${config.polyv.apiBase}${path}?${qs}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.polyv.timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  if (!json || json.code !== 200) {
    throw new Error(explainFailure(json?.code, json?.message ?? '无返回信息'));
  }
  return (json.data ?? null) as T | null;
}

/** 把 productId 写回运行时资源 + .env（幂等，重复写同一值不落盘） */
function persistProductId(productId: string): void {
  if (!productId) return;

  // ① 运行时立即生效：这一句决定下一次 push_product 还降不降级
  //    config 是只读对象，所以走 client 的 runtime 覆盖（与运行时频道号同一套机制）
  polyvClient.setResource('productId', productId);

  // ② 持久化到 .env：不写的话进程一重启又回到「缺资源」
  try {
    if (!existsSync(ENV_PATH)) {
      log(`⚠️ 未找到 ${ENV_PATH}，跳过持久化（本次会话内 productId 仍然有效）`);
      return;
    }
    const raw = readFileSync(ENV_PATH, 'utf8');
    if (raw.includes(`POLYV_PRODUCT_ID=${productId}`)) return; // 已是这个值，不动文件
    const next = /^POLYV_PRODUCT_ID=.*$/m.test(raw)
      ? raw.replace(/^POLYV_PRODUCT_ID=.*$/m, `POLYV_PRODUCT_ID=${productId}`)
      : `${raw.replace(/\s*$/, '')}\n\n# 由「互动 → 推送商品」自动写入（服务自动建品后回填）\nPOLYV_PRODUCT_ID=${productId}\n`;
    writeFileSync(ENV_PATH, next, 'utf8');
    log(`✅ productId ${productId} 已写入 backend/.env（重启后依然有效）`);
  } catch (err) {
    // 持久化失败不影响本次会话：内存里的值已经改了，只是重启会丢
    log(`⚠️ 写 .env 失败，productId 仅本次会话有效：${(err as Error).message}`);
  }
}

/** 当前生效的 productId（可能来自 .env，也可能是本次会话刚建的） */
export function currentProductId(): string {
  return polyvClient.resource('productId');
}

/** 查询频道商品库 */
export async function listProducts(): Promise<ChannelProduct[]> {
  // 演练模式：不碰真实账号，给一份虚拟商品供界面演示
  if (!polyvClient.isReal) {
    return DEMO_PRODUCTS.map((p, i) => ({
      productId: `demo-${i + 1}`,
      name: p.name,
      realPrice: p.realPrice,
      cover: DEMO_COVER,
      link: DEMO_LINK,
      status: 1,
    }));
  }

  const data = await signedGet<{ contents?: unknown[] } | unknown[]>(LIST_PATH, {
    // 用 polyvClient.channelId：频道号可以在运行时被 /api/polyv/channel 换掉，别读旧配置
    channelId: polyvClient.channelId,
    page: 1,
    pageSize: 50,
  });
  const arr = Array.isArray(data) ? data : (data?.contents ?? []);
  return arr.map((x) => {
    const o = x as Record<string, unknown>;
    return {
      productId: String(o.productId ?? o.id ?? ''),
      name: String(o.name ?? ''),
      realPrice: Number(o.realPrice ?? 0),
      cover: String(o.cover ?? ''),
      link: String(o.link ?? ''),
      status: Number(o.status ?? 1),
    };
  });
}

/** 在频道商品库里新建一个商品，并把 productId 回填 */
export async function createProduct(input: CreateProductInput): Promise<ChannelProduct> {
  const name = input.name?.trim();
  if (!name) throw new Error('商品名称不能为空');

  const body: Record<string, unknown> = {
    name,
    productType: 'normal',
    // 官方约束：普通商品必传 cover / realPrice / status / linkType，且 linkType=10 时还要 link
    cover: input.cover?.trim() || DEMO_COVER,
    priceType: 'AMOUNT',
    realPrice: Number(input.realPrice) || 0,
    status: 1,
    linkType: 10,
    link: input.link?.trim() || DEMO_LINK,
  };
  if (input.productDesc?.trim()) body.productDesc = input.productDesc.trim();

  // 演练模式：不发真实请求，返回一个假的 productId 让链路可演示
  if (!polyvClient.isReal) {
    const fake = `mock-${Date.now()}`;
    persistProductId(fake);
    log(`演练模式：跳过真实创建，返回占位商品 ${fake}（${name}）`);
    return {
      productId: fake,
      name,
      realPrice: body.realPrice as number,
      cover: body.cover as string,
      link: body.link as string,
      status: 1,
    };
  }

  const data = await signedPostJson<{ productId?: number | string }>(
    ADD_PATH,
    { channelId: polyvClient.channelId },
    body,
  );
  const productId = String(data?.productId ?? '');
  if (!productId) throw new Error('接口返回成功但没有 productId');

  persistProductId(productId);
  log(`✅ 已在频道 ${polyvClient.channelId} 建品：${name}（productId=${productId}）`);

  return {
    productId,
    name,
    realPrice: body.realPrice as number,
    cover: body.cover as string,
    link: body.link as string,
    status: 1,
  };
}

/**
 * 确保「有一个可推的商品」——一键兜底，演示现场不用先去后台手动建品。
 *
 * 优先复用已有：
 *   1. .env / 运行时已配的商品 ID → 直接用
 *   2. 频道商品库里第一条 → 用起来
 *   3. 都没有 → 用传入的商品（默认第一个演示商品）建一个
 */
export async function ensureProduct(
  input?: CreateProductInput,
): Promise<{ product: ChannelProduct; created: boolean }> {
  const preset = currentProductId();
  if (preset && polyvClient.isReal) {
    const list = await listProducts().catch(() => [] as ChannelProduct[]);
    const hit = list.find((p) => p.productId === preset);
    if (hit) return { product: hit, created: false };
    return {
      product: { productId: preset, name: '（已配置商品）', realPrice: 0, cover: '', link: '', status: 1 },
      created: false,
    };
  }

  const list = await listProducts().catch(() => [] as ChannelProduct[]);
  if (list.length > 0) {
    persistProductId(list[0].productId);
    return { product: list[0], created: false };
  }

  const product = await createProduct(input ?? DEMO_PRODUCTS[0]);
  return { product, created: true };
}
