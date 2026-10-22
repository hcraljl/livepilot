/**
 * 保利威 Webhook 接收（真实账号接入时的数据入口）
 *
 * 演示默认走模拟器，本路由用于「接真实账号」的可选开关：
 *   - 按官方签名规则验签（与 OpenAPI 同一套算法，见 polyv/sign.ts）；
 *   - 把开播 / 下播 / 录制 / 在线人数等事件映射进 LiveStore，前端无需感知数据源切换；
 *   - 永远是"先响应 200 再处理"，避免保利威重推风暴把自己打挂。
 *
 * ⚠️ 不同产品的回调字段名略有差异（event / type / eventType，onLine / onlineNum），
 *    这里做的是**宽容解析**：只认能识别的字段，识别不了就原样留存到事件流，绝不瞎猜覆盖状态。
 *    正式接真实账号前请对照「保利威回调文档」核对字段，必要时只改本文件。
 */
import { Router } from 'express';
import { config } from '../config.ts';
import { store } from '../store/state.ts';
import { simulator } from '../simulator/simulator.ts';
import { verifySign } from '../polyv/sign.ts';

export const webhookRouter = Router();

type AnyBody = Record<string, unknown>;

const pickNumber = (body: AnyBody, keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = Number(body[k]);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
};

const pickString = (body: AnyBody, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
};

webhookRouter.post('/polyv/webhook', (req, res) => {
  // 1. 先回 200（保利威只看响应码，处理失败让它重推没意义）
  res.json({ code: 200, status: 'success', message: 'received' });

  const body = (req.body ?? {}) as AnyBody;
  const sign = pickString(body, ['sign', 'signature']) ?? String(req.query.sign ?? '');

  // 2. 验签：只有配置了 appSecret 才强制校验（本地模拟不配密钥时不拦截）
  if (config.polyv.appSecret) {
    const flat: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v === null || v === undefined) continue;
      flat[k] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number);
    }
    if (!verifySign(flat, sign)) {
      store.logEvent('webhook', 'Webhook 验签失败', `来源 IP ${req.ip ?? 'unknown'}，已丢弃`);
      console.warn('[webhook] 验签失败，已丢弃本次回调（请核对 POLYV_APP_SECRET）');
      return;
    }
  }

  // 3. 事件识别（宽容匹配：优先 event / type / eventType）
  const rawEvent = (
    pickString(body, ['event', 'type', 'eventType', 'msgType', 'action']) ?? 'unknown'
  ).toLowerCase();

  const kind: 'start' | 'end' | 'record' | 'online' | 'other' = rawEvent.includes('start')
    ? 'start'
    : rawEvent.includes('end') || rawEvent.includes('stop') || rawEvent.includes('close')
      ? 'end'
      : rawEvent.includes('record')
        ? 'record'
        : rawEvent.includes('online') || rawEvent.includes('viewer')
          ? 'online'
          : 'other';

  const channelId = pickString(body, ['channelId', 'channel_id']) ?? store.get().channelId;

  switch (kind) {
    case 'start': {
      store.setRunning(true);
      store.logEvent('webhook', '保利威回调：直播开始', `频道 ${channelId} · 原始事件 ${rawEvent}`);
      break;
    }
    case 'end': {
      store.logEvent('webhook', '保利威回调：直播结束', `频道 ${channelId} · 原始事件 ${rawEvent}`);
      // 必须连模拟器定时器一起停，否则会出现"下播后指标还在涨"的僵尸 tick
      if (simulator.running) simulator.stop('保利威回调：直播结束');
      else store.stopSession('保利威回调：直播结束');
      break;
    }
    case 'record': {
      const url = pickString(body, ['fileUrl', 'recordUrl', 'url', 'videoUrl']);
      store.logEvent('webhook', '保利威回调：录制文件生成', url ? `回放地址 ${url}` : `原始事件 ${rawEvent}`);
      break;
    }
    case 'online': {
      const online = pickNumber(body, ['online', 'onlineNum', 'onLine', 'viewerCount']);
      const total = pickNumber(body, ['totalViewers', 'viewerNum', 'pageView']);
      store.patchMetrics({
        ...(online !== undefined ? { online } : {}),
        ...(total !== undefined ? { totalViewers: total } : {}),
      });
      store.logEvent('webhook', '保利威回调：在线数据', `在线 ${online ?? '-'} · 累计 ${total ?? '-'}`);
      break;
    }
    default: {
      store.logEvent('webhook', `保利威回调：${rawEvent}`, JSON.stringify(body).slice(0, 500));
      break;
    }
  }
});
