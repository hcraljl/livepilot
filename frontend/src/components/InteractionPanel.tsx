/**
 * InteractionPanel —— 互动区：运营手动发起直播间互动（首个能力：推送商品）
 *
 * 用户诉求原话：「现在可以调用 API 推送商品吗？如果不行的话，增加这个功能。把它划分在互动里。」
 * 所以这一版把商品推送收进一个明确的「互动」区，而不是散落在控制条上，
 * 后续抽奖 / 答题卡 / 签到等手动入口也往这里加，保持"运营发起互动"这一件事的入口收敛。
 *
 * 界面刻意做成三态，避免演示时把降级讲成成功（这跟看板数据三态是同一个原则）：
 *   ① 有商品   → 直接「推送商品」，真实打到 POST /live/v3/channel/product/push-product
 *   ② 无商品   → 给「一键建品并推送」，由服务端用 POST /live/v3/channel/product/add 建
 *   ③ 账号未开通商品库 → 明确说明原因 + 提示会降级为公告，不做假装成功的按钮
 *
 * 为什么 ③ 必须单独呈现：实测这个账号（未做企业认证）调 add 会被官方拒绝
 *   code 400「商品库功能已被禁用」，而 list 接口照样返回 200 + 空数组 ——
 *   只看列表会误以为「只是还没加商品」，反复点就会反复撞同一堵墙。
 *
 * 契约：GET/POST /api/products、POST /api/action（API.md §八）
 * 负责人：B · @since v1.1.0
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChannelProduct, CreateProductReq, LiveState, PolyvCallResult } from '@livepilot/shared';
import { createProduct, ensureProduct, fetchProducts, triggerAction } from '../lib/api';

/** 推送卡片样式：bottomCard 贴底不挡画面，演示时最稳 */
const PUSH_CARD_TYPE = 'bottomCard';

type Phase = 'idle' | 'busy';

export function InteractionPanel({ state }: { state: LiveState | null }) {
  const [products, setProducts] = useState<ChannelProduct[]>([]);
  const [presets, setPresets] = useState<CreateProductReq[]>([]);
  const [productId, setProductId] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [receipt, setReceipt] = useState<PolyvCallResult | null>(null);
  /** 要建/推哪个演示商品（商品库为空时用它） */
  const [presetIdx, setPresetIdx] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await fetchProducts();
      setProducts(r.products);
      setPresets(r.presets);
      setProductId(r.productId);
      setDryRun(r.dryRun);
    } catch {
      /* 后端未起时静默，不打扰演播现场 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 走统一执行链路：会落决策、打时间轴、记事件，跟 AI 自动决策产生的效果一致 */
  const push = useCallback(
    async (name: string): Promise<void> => {
      setPhase('busy');
      setMsg(null);
      setIsError(false);
      setReceipt(null);
      try {
        const { decision, result } = await triggerAction({
          action: 'push_product',
          title: `推送商品：${name}`,
          reason: '运营手动推送（互动区）',
          params: { pushCardType: PUSH_CARD_TYPE },
        });
        setReceipt(result);
        // 降级会被如实标注：看决策的实际动作，而不是我请求时写的是什么
        const degraded = decision.action !== 'push_product';
        setMsg(
          result.ok
            ? degraded
              ? `已执行，但实际走的是「${decision.action}」（本次被降级）`
              : `已推送「${name}」，观众端右下角会弹出商品卡`
            : `推送失败：${result.message}`,
        );
        setIsError(!result.ok);
        void refresh();
      } catch (e) {
        setIsError(true);
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setPhase('idle');
      }
    },
    [refresh],
  );

  /**
   * 没有商品时：先确保有一个（复用或新建），拿到 ID 后立刻推。
   *
   * 建品失败要把官方口径原样透出来（多半是账号没开通商品库），
   * 否则按钮点了没反应，演示时最难排查。
   */
  const buildAndPush = useCallback(async (): Promise<void> => {
    setPhase('busy');
    setMsg(null);
    setIsError(false);
    setReceipt(null);
    try {
      const { product, created } = await ensureProduct(presets[presetIdx]);
      setMsg(created ? `已建品「${product.name}」，正在推送…` : `复用已有商品「${product.name}」，正在推送…`);
      await push(product.name);
    } catch (e) {
      setIsError(true);
      setMsg(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }, [push, presets, presetIdx]);

  /** 按选中的演示商品直接建一个（不推送）：先把商品备好，再单独点推送 */
  const buildPreset = useCallback(async (): Promise<void> => {
    const preset = presets[presetIdx];
    if (!preset) return;
    setPhase('busy');
    setMsg(null);
    setIsError(false);
    try {
      const { product } = await createProduct(preset);
      setMsg(`已建品「${product.name}」（¥${product.realPrice}），现在可以推送了`);
      void refresh();
    } catch (e) {
      setIsError(true);
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  }, [presets, presetIdx, refresh]);

  const busy = phase === 'busy';
  const running = state?.running === true;
  const hasProduct = productId !== '' || products.length > 0;
  const active = products.find((p) => p.productId === productId) ?? products[0] ?? null;

  return (
    <section aria-label="互动" className="rounded-lg border border-gray-200 bg-white p-4">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-medium text-gray-900">互动</h2>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">运营手动发起</span>
        {dryRun && (
          <span className="rounded bg-warn-50 px-1.5 py-0.5 text-[11px] text-warn-800">演练模式 · 不发真实请求</span>
        )}
        <span className="ml-auto text-[11px] text-gray-400">
          {hasProduct ? `频道商品 ${products.length} 件` : '频道暂无商品'}
        </span>
      </header>

      {/* 商品推送 —— 互动区的第一个能力 */}
      <div className="rounded-md border border-gray-200 bg-gray-50/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-800">推送商品</span>
          {active && (
            <span className="text-xs text-gray-500">
              {active.name}
              {active.realPrice > 0 && <span className="ml-1 text-gray-400">¥{active.realPrice}</span>}
            </span>
          )}

          {hasProduct ? (
            <button
              type="button"
              disabled={busy || !running}
              title={running ? '向观众端推送当前商品卡（真实调用保利威 push-product）' : '需先开始直播'}
              onClick={() => void push(active?.name ?? '商品')}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? '推送中…' : '推送商品'}
            </button>
          ) : (
            <>
              <select
                value={presetIdx}
                onChange={(e) => setPresetIdx(Number(e.target.value))}
                disabled={busy || presets.length === 0}
                title="选一个商品先建到频道商品库"
                className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 disabled:opacity-50"
              >
                {presets.map((p, i) => (
                  <option key={p.name} value={i}>
                    {p.name} ¥{p.realPrice}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || presets.length === 0}
                title="先建品到频道商品库（可不开播）"
                onClick={() => void buildPreset()}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy ? '处理中…' : '建商品'}
              </button>
              <button
                type="button"
                disabled={busy || !running}
                title={running ? '建好商品后立刻推送给观众' : '需先开始直播'}
                onClick={() => void buildAndPush()}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? '处理中…' : '建商品并推送'}
              </button>
            </>
          )}

          <span className="text-[11px] text-gray-400">
            {hasProduct
              ? '观众端右下角弹出商品卡'
              : presets.length > 0
                ? '先选一件商品建到频道商品库，再推送'
                : '需要账号已开通商品库，否则会降级为公告'}
          </span>
        </div>

        {!hasProduct && !dryRun && (
          <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
            频道商品库为空。点「建商品并推送」会先用服务端接口创建演示商品；
            <b className="font-medium text-gray-600">若账号未完成企业认证</b>
            ，保利威会拒绝建品（官方口径：商品库功能已被禁用），此时推送会自动降级为公告。
          </p>
        )}

        {msg && (
          <p className={`mt-2 text-xs leading-relaxed ${isError ? 'text-danger-700' : 'text-success-700'}`}>{msg}</p>
        )}
        {receipt && (
          <p className="mt-1 text-[11px] text-gray-400">
            回执：code {receipt.code} · {receipt.endpoint ?? '无 endpoint'}
            {receipt.mock && ' · 模拟回执'}
          </p>
        )}
      </div>
    </section>
  );
}
