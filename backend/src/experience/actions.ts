import type { ActionType, LiveState } from '../../../shared/types.js';

/** 复用历史经验时，用当前直播上下文实例化动作参数 */
export function buildActionPayload(
  action: ActionType,
  state: LiveState,
): Record<string, unknown> {
  const product = state.metrics.currentProduct || '当前商品';
  switch (action) {
    case 'lottery':
      return {
        title: '经验复用抽奖',
        prize: '品牌定制礼盒',
        lotteryTitle: '经验复用抽奖',
        lotteryDuration: 60,
      };
    case 'welfare_lottery':
      return {
        title: `${product}专属福利`,
        productName: product,
        prize: product,
        lotteryTitle: `${product}专属福利`,
        lotteryDuration: 90,
        conditionType: 'product',
      };
    case 'push_card':
      return {
        title: '经验复用卡片',
        text: '留在直播间参与福利',
        cardPushType: 'text',
      };
    case 'push_product':
      return { productName: product };
    case 'answer_card':
      return {
        title: '互动答题',
        text: '答对即可参与抽奖',
        duration: 60,
      };
    case 'checkin':
      return {
        title: '签到打卡',
        text: '签到领积分，活跃一下公屏',
        checkinDuration: 60,
      };
    case 'bulletin':
      return {
        title: '直播间公告',
        bulletin: '欢迎来到直播间，福利进行中',
        content: '欢迎来到直播间，福利进行中',
        duration: 60,
      };
    case 'coupon':
      return {
        title: '限时优惠券',
        couponName: '限时优惠券',
        couponValue: 20,
        couponAmount: 20,
      };
    default:
      return {};
  }
}
