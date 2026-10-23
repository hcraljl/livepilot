/**
 * 商品库接口 —— 让「推送商品」从必降级变成真能推
 *
 * 契约（见 API.md §八）：
 *   GET  /api/products        → { products, productId, dryRun, channelId }
 *   POST /api/products        → { product, created }  在频道商品库新建商品并回填 productId
 *   POST /api/products/ensure → { product, created }  确保有一个可推商品（有就复用，没有就建）
 *
 * 这三个接口存在的理由：push_product 需要 productId，而它是账号侧实体，
 * 不能像价格那样在请求里凭空编 —— 必须先有一个商品。
 * 有了这里，「互动 → 推送商品」才能真正打到 /live/v3/channel/product/push-product。
 *
 * 负责人：B · @since v1.1.0
 */
import { Router } from 'express';
import { polyvClient } from '../polyv/client.ts';
import { createProduct, currentProductId, DEMO_PRODUCTS, ensureProduct, listProducts } from '../services/products.ts';
import type { CreateProductReq } from '../../../shared/types.ts';

export const productsRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string, code = 400) => ({ ok: false, error, code });

/**
 * GET /api/products —— 频道商品库列表 + 当前生效的商品 ID
 *
 * 商品 ID 由服务端持有，但这里下发的只是列表用于界面选择；
 * 真正推送时由后端从 resources.productId 注入，避免前端伪造 ID 乱推。
 */
productsRouter.get('/products', async (_req, res) => {
  try {
    const products = await listProducts();
    res.json(
      ok({
        products,
        productId: currentProductId(),
        dryRun: polyvClient.dryRun,
        channelId: polyvClient.channelId,
        // 商品库为空时，界面用这批演示商品让用户一键建一个（与模拟器讲解的商品同源）
        presets: DEMO_PRODUCTS.map((p) => ({ name: p.name, realPrice: p.realPrice })),
      }),
    );
  } catch (err) {
    res.status(502).json(fail(`读取商品库失败：${(err as Error).message}`, 502));
  }
});

/** POST /api/products —— 新建商品（body: name / realPrice / cover? / link? / productDesc?） */
productsRouter.post('/products', async (req, res) => {
  const body = (req.body ?? {}) as Partial<CreateProductReq>;
  if (!body.name || String(body.name).trim() === '') {
    res.status(400).json(fail('缺少商品名称 name'));
    return;
  }
  try {
    const product = await createProduct({
      name: String(body.name),
      realPrice: Number(body.realPrice ?? 0),
      cover: body.cover,
      link: body.link,
      productDesc: body.productDesc,
    });
    res.json(ok({ product, created: true }));
  } catch (err) {
    res.status(502).json(fail(`创建商品失败：${(err as Error).message}`, 502));
  }
});

/**
 * POST /api/products/ensure —— 确保有可推商品
 *
 * 演示现场的兜底入口：不想先去后台手动建品，点一下就有。
 * 已配了 productId 就用它，没有就取商品库第一条，都找不到才建。
 * body 可传 { name, realPrice } 指定建哪个（缺省用第一个演示商品）。
 */
productsRouter.post('/products/ensure', async (req, res) => {
  const body = (req.body ?? {}) as Partial<CreateProductReq>;
  const input = body.name ? { name: String(body.name), realPrice: Number(body.realPrice ?? 0) } : undefined;
  try {
    const result = await ensureProduct(input);
    res.json(ok(result));
  } catch (err) {
    res.status(502).json(fail(`准备商品失败：${(err as Error).message}`, 502));
  }
});
