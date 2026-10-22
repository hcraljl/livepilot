/**
 * 保利威（Polyv）签名算法 —— 全仓库唯一允许接触 appSecret 的文件
 *
 * 官方规则（https://help.polyv.net/#/live/api/buildSign）：
 *  1. 取全部请求参数（剔除值为 null 的参数），按参数名 ASCII 字典序升序
 *  2. 拼成 key1value1key2value2...keyNvalueN（只拼 key 和 value，无分隔符）
 *  3. 拼接串首尾各加一次 appSecret（appSecret 不参与排序，也不随请求发送）
 *  4. UTF-8 编码后取 MD5，转大写，即 sign
 *
 * 示例（官方样例，可用于自测）：
 *   appSecret = fsq2k5weced1h8vui657xtdva66whf0g
 *   params = { appId:'g4rqgmmjuo', channelIds:'2477096,2272655', endDay:'2022-06-18',
 *              startDay:'2022-05-20', timestamp:'1660270926732', page:null, size:null }
 *   sign = 0D2BDA2FD04D93A2B8832B91FD973C4D
 */
import { createHash } from 'node:crypto';
import { config } from '../config.ts';

export type SignParams = Record<string, string | number | boolean | null | undefined>;

const normalizeValue = (v: string | number | boolean): string => {
  if (Array.isArray(v)) return v.join(',');
  return String(v);
};

/** 过滤空值 + 按 key 升序，返回稳定顺序的参数对 */
export const sortParams = (params: SignParams): [string, string][] =>
  Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k, normalizeValue(v as string | number | boolean)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** 待签名原文：key1value1key2value2...（不含 appSecret） */
export const buildSignString = (params: SignParams): string =>
  sortParams(params)
    .map(([k, v]) => `${k}${v}`)
    .join('');

const md5Upper = (input: string): string => createHash('md5').update(input, 'utf8').digest('hex').toUpperCase();

const sha256Upper = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex').toUpperCase();

/**
 * 生成 sign。
 * 默认 MD5；若参数里带 signatureMethod=SHA256 则使用 SHA256（官方可选算法）。
 * appSecret 缺省时从 config 读取（不落盘、不外传）。
 */
export const buildSign = (params: SignParams, appSecret: string = config.polyv.appSecret): string => {
  if (!appSecret) {
    throw new Error('[polyv/sign] 缺少 POLYV_APP_SECRET，无法生成签名（当前为模拟模式应避免走到这里）');
  }
  const raw = `${appSecret}${buildSignString(params)}${appSecret}`;
  const method = String(params.signatureMethod ?? '').toUpperCase();
  return method === 'SHA256' ? sha256Upper(raw) : md5Upper(raw);
};

/** 在参数上补 appId / timestamp / sign，返回可直接发送的表单对象 */
export const signParams = (
  params: SignParams,
  opts: { appId?: string; timestamp?: number } = {},
): Record<string, string> => {
  const appId = opts.appId ?? config.polyv.appId;
  const timestamp = opts.timestamp ?? Date.now();
  const base: SignParams = { ...params, appId, timestamp };
  const sign = buildSign(base);
  const out: Record<string, string> = {};
  for (const [k, v] of sortParams(base)) out[k] = v;
  out.sign = sign;
  return out;
};

/**
 * 校验回调 / 请求签名（Webhook 用）。
 * 兼容两种传法：sign 在参数内（标准）或头里（按需手动传入）。
 */
export const verifySign = (params: SignParams, sign: string | undefined, appSecret = config.polyv.appSecret): boolean => {
  if (!sign || !appSecret) return false;
  const { sign: _ignored, ...rest } = params as Record<string, unknown>;
  try {
    const expected = buildSign(rest as SignParams, appSecret);
    return timingSafeEqual(expected, String(sign).toUpperCase());
  } catch {
    return false;
  }
};

/** 常量时间比较，避免签名被时序攻击（赛题里更多是习惯） */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** 一键自测：node --import tsx backend/src/polyv/sign.ts --selftest */
const selftest = (): void => {
  const params: SignParams = {
    appId: 'g4rqgmmjuo',
    channelIds: '2477096,2272655',
    endDay: '2022-06-18',
    startDay: '2022-05-20',
    timestamp: '1660270926732',
    page: null,
    size: null,
  };
  const sign = buildSign(params, 'fsq2k5weced1h8vui657xtdva66whf0g');
  const expected = '0D2BDA2FD04D93A2B8832B91FD973C4D';
  console.log(`[sign] 本地计算 = ${sign}`);
  console.log(`[sign] 官方样例 = ${expected}`);
  console.log(sign === expected ? '[sign] ✅ 签名算法与官方一致' : '[sign] ❌ 与官方样例不一致，请检查拼接规则');
};

if (process.argv.includes('--selftest')) selftest();
