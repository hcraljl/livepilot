/**
 * 保利威官方服务端 API 常量目录（不是经验数据）
 *
 * 约定：
 * - 这里只放官方接口事实：method / path / 必填参数 / 文档地址；
 * - 不写入 backend/data/experiences.json，也不参与 TF-IDF；
 * - 经验库只沉淀「哪场直播、什么场景、做了什么、效果如何」。
 *
 * 来源：https://help.polyv.net/live/api/（2026-10-22 抓取）
 * 注意：真实调用前必须准备 questionId / cardPushId / productId / couponIds，
 *       这些是账号侧资源 ID，不能由模型生成。
 */
import type { ActionType } from '../../../shared/types.ts';

export type PolyvOperationId = ActionType | 'stats' | 'webhook';

export interface PolyvApiOperation {
  action: PolyvOperationId;
  label: string;
  method: 'GET' | 'POST';
  /** 官方文档公开路径（客户可见；B 的内部执行路径不在此暴露） */
  path: string;
  docUrl: string;
  description: string;
  requiredParams: string[];
  optionalParams?: string[];
  notes?: string;
  source: 'official';
}

export const POLYV_COMMON_AUTH_PARAMS = ['appId', 'timestamp', 'sign'];

export const POLYV_API_OPERATIONS: PolyvApiOperation[] = [
  {
    action: 'lottery',
    label: '发起抽奖（无条件）',
    method: 'POST',
    path: '/live/v4/channel/lottery-activity/create',
    docUrl:
      'https://help.polyv.net/live/api/v4/channel/lottery_activity/lottery_activity_create/',
    description: '在频道内创建抽奖活动，可设置开奖条件、奖品与中奖人数。',
    requiredParams: [
      'channelId',
      'activityName',
      'lotteryCondition',
      'amount',
      'prizeName',
    ],
    optionalParams: [
      'receiveEnabled',
      'lotteryRange',
      'customGroupIds',
      'userLabels',
    ],
    notes:
      '公开目录展示官方文档路径；B 的内部执行路径只在 client.ts 维护，不通过 API 暴露。lotteryCondition 官方取值：none / invite / duration / comment / question / questionnaire。',
    source: 'official',
  },
  {
    action: 'welfare_lottery',
    label: '发起互动福利抽奖',
    method: 'POST',
    path: '/live/v4/channel/lottery-activity/create',
    docUrl:
      'https://help.polyv.net/live/api/v4/channel/lottery_activity/lottery_activity_create/',
    description:
      '与普通抽奖共用创建接口，用 lotteryCondition 要求评论/答题等互动；商品福利建议叠加优惠券。',
    requiredParams: [
      'channelId',
      'activityName',
      'lotteryCondition',
      'amount',
      'prizeName',
    ],
    optionalParams: [
      'receiveEnabled',
      'lotteryRange',
      'customGroupIds',
      'userLabels',
    ],
    notes:
      '公开目录展示官方路径；内部执行路径由 B 维护。官方抽奖条件不含“商品”类型，建议用 comment / question 等互动条件 + coupon 实现福利。',
    source: 'official',
  },
  {
    action: 'answer_card',
    label: '发起答题卡',
    method: 'POST',
    path: '/live/v4/channel/question/send',
    docUrl:
      'https://help.polyv.net/live/api/live_interaction/send_question/',
    description: '向频道推送已创建的题目，带动弹幕参与。',
    requiredParams: ['channelId', 'questionId'],
    optionalParams: ['duration'],
    notes: 'questionId 必须先在后台/题库创建，不能由模型生成。',
    source: 'official',
  },
  {
    action: 'checkin',
    label: '批量签到',
    method: 'POST',
    path: '/live/v4/chat/batch-checkin',
    docUrl:
      'https://help.polyv.net/live/api/v4/chat/checkin/batch_checkin/',
    description: '批量发起签到，单次最多 1000 人。',
    requiredParams: ['channelId'],
    optionalParams: [
      'limitTime',
      'delayTime',
      'message',
      'forceCheckInEnabled',
    ],
    source: 'official',
  },
  {
    action: 'push_card',
    label: '推送卡片',
    method: 'POST',
    path: '/live/v4/channel/card-push/push',
    docUrl:
      'https://help.polyv.net/live/api/v4/channel/market/cardPush/push/',
    description: '把已创建好的卡片推送到观看端。',
    requiredParams: ['channelId', 'cardPushId'],
    notes: 'cardPushId 是后台卡片资源 ID，不是卡片文案。',
    source: 'official',
  },
  {
    action: 'push_product',
    label: '推送商品弹层',
    method: 'POST',
    path: '/live/v3/channel/product/push-product',
    docUrl:
      'https://help.polyv.net/live/api/channel/operate/push_channel_product/',
    description: '在观看端弹出指定商品，配合讲解节奏促成点击。',
    requiredParams: ['channelId', 'productId'],
    optionalParams: ['pushCardType'],
    notes: 'productId 是商品库资源 ID，不是商品名称。',
    source: 'official',
  },
  {
    action: 'bulletin',
    label: '发布公告',
    method: 'POST',
    path: '/live/v4/chat/add-bullentin',
    docUrl: 'https://help.polyv.net/live/api/v4/chat/notice_add/',
    description: '发布频道公告，用于规则说明、逼单或异常安抚。',
    requiredParams: ['channelId', 'content'],
    optionalParams: ['isTop', 'isPop'],
    source: 'official',
  },
  {
    action: 'stats',
    label: '直播统计',
    method: 'GET',
    path: '/live/v3/channel/statistics/get-session-stats',
    docUrl:
      'https://help.polyv.net/live/api/channel/viewdata/get_session_stats/',
    description: '获取场次统计；也提供 v4 汇总列表接口用于分页查询。',
    requiredParams: ['channelId'],
    optionalParams: ['sessionIds', 'startTime', 'endTime'],
    notes:
      '公开目录展示官方路径；B 的统计轮询路径在 config.ts 内部维护，可用 POLYV_STATS_PATH 覆盖。v4 汇总接口：GET /live/v4/statistics/session-stats/summary/list。',
    source: 'official',
  },
  {
    action: 'webhook',
    label: '事件回调',
    method: 'POST',
    path: '/polyv/webhook',
    docUrl: 'https://help.polyv.net/live/api/callback/interaction_callback/',
    description: '接收开播/下播、互动、观看状态等回调。',
    requiredParams: [],
    notes:
      '回调分类：interaction / livestatus / record / playback 等；验签算法见官方 buildSign。',
    source: 'official',
  },
];

export function getPolyvApiOperation(
  action: PolyvOperationId,
): PolyvApiOperation | undefined {
  return POLYV_API_OPERATIONS.find((operation) => operation.action === action);
}
