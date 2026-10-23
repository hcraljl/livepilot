import type { ActionType, LiveState } from '../../../shared/types.js';

/**
 * 复用历史经验时，用当前直播上下文实例化官方动作参数。
 * 只生成官方参数名；资源 ID（productId/cardPushId/questionId）
 * 由 polyv/client.ts 从 .env 注入，模型不得生成。
 */
export function buildActionPayload(
  action: ActionType,
  state: LiveState,
): Record<string, unknown> {
  const product = state.metrics.currentProduct || '当前商品';
  switch (action) {
    case 'lottery':
      return {
        activityName: '经验复用抽奖',
        lotteryCondition: 'none',
        amount: 1,
        prizeName: '品牌定制礼盒',
      };
    case 'welfare_lottery':
      return {
        activityName: `${product}专属福利`,
        lotteryCondition: 'comment',
        amount: 1,
        prizeName: product,
      };
    case 'push_card':
      return {};
    case 'push_product':
      return {};
    case 'answer_card':
      return { duration: 60 };
    case 'checkin':
      return { message: '签到领积分' };
    case 'bulletin':
      return { content: '欢迎来到直播间，福利进行中' };
    default:
      return {};
  }
}
