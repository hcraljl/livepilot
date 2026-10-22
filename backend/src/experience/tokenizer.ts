/**
 * 零依赖中文分词：
 * 1) Intl.Segmenter 提供通用词边界（Node 自带 full-icu）
 * 2) CJK bigram 补足“在线/骤降/召回”这类被拆散的词
 * 3) 领域词典保证“留存保卫/福利抽奖/答题卡”等运营术语完整命中
 * 这样比引入原生 jieba 更稳，Windows 上无需编译。
 */

const SINGLE_CHAR_STOPWORDS = new Set([
  '的', '了', '在', '是', '和', '与', '及', '或', '而', '并', '就', '都',
  '也', '很', '更', '最', '这', '那', '又', '再', '才', '被', '把', '让',
  '给', '对', '从', '到', '为', '以', '于', '其', '之', '等', '吗', '呢',
  '吧', '啊', '呀', '哦', '嗯', '着', '过', '地', '得', '个', '上', '下',
]);

const MULTI_CHAR_STOPWORDS = new Set([
  '这个', '那个', '这些', '那些', '我们', '你们', '他们', '以及', '因为',
  '所以', '可以', '进行', '通过', '对于', '已经', '还是', '没有', '不是',
  '但是', '如果', '然后', '目前', '其中', '之后', '之前', '同时', '开始',
  '出现', '带来', '一个', '一种', '一场', '什么', '怎么', '如何', '非常',
  '比较', '明显', '需要', '建议', '并且', '而且', '或者', '不过', '其实',
  '就是', '这是', '那是', '一次', '一直', '一定', '可能', '应该', '主要',
]);

const DOMAIN_TERMS = [
  '留存保卫', '转化助推', '氛围激活', '异常兜底', '逼单',
  '在线人数', '商品点击率', '点击率', '互动率', '弹幕率',
  '成交额', '客单价', '成交增量', '增量', '下单', '成交',
  '无条件抽奖', '福利抽奖', '答题卡', '批量签到', '签到',
  '推送商品', '推商品', '商品弹层', '优惠券', '公告',
  '卡片召回', '召回卡片', '直播流异常', '直播流', '重连', '安抚',
  '冷场', '骤降', '下滑', '流失', '回流', '紧迫感', '转化',
  '开播', '下播', '复盘', '经验库', '历史案例', '知识库',
  '直播复盘', '复盘报告', '互动效果', '最佳时段', '下次优化',
  '商品讲解', '讲解节奏', '福利', '抽奖', '召回', '卡片',
].sort((a, b) => b.length - a.length);

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}

type SegmenterLike = {
  segment(input: string): Iterable<SegmentLike>;
};

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: 'word' },
) => SegmenterLike;

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
let segmenter: SegmenterLike | null = null;
if (Segmenter) {
  try {
    segmenter = new Segmenter('zh-CN', { granularity: 'word' });
  } catch {
    // 小 icu 构建不支持中文分词时，bigram + 领域词典仍可工作
    segmenter = null;
  }
}

function isUseful(token: string): boolean {
  if (!token) return false;
  if (token.length > 20) return false;
  if (/^\d+(?:[.,]\d+)?%?$/.test(token)) return false;
  if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
  if (token.length === 1) {
    if (SINGLE_CHAR_STOPWORDS.has(token)) return false;
    if (/^[a-z0-9]$/.test(token)) return false;
  }
  if (MULTI_CHAR_STOPWORDS.has(token)) return false;
  return true;
}

function pushDomainTerms(text: string, tokens: string[]): void {
  for (const term of DOMAIN_TERMS) {
    let from = 0;
    let index = text.indexOf(term, from);
    while (index !== -1) {
      tokens.push(term);
      from = index + term.length;
      index = text.indexOf(term, from);
    }
  }
}

function pushBigrams(text: string, tokens: string[]): void {
  const runs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    if (run.length >= 2 && run.length <= 6) tokens.push(run);
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      const [first, second] = bigram;
      if (
        SINGLE_CHAR_STOPWORDS.has(first) &&
        SINGLE_CHAR_STOPWORDS.has(second)
      ) {
        continue;
      }
      tokens.push(bigram);
    }
  }
}

export function tokenize(input: string): string[] {
  const text = input.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];

  pushDomainTerms(text, tokens);

  if (segmenter) {
    for (const part of segmenter.segment(text)) {
      if (part.isWordLike === false) continue;
      const token = part.segment.trim();
      if (isUseful(token)) tokens.push(token);
    }
  }

  pushBigrams(text, tokens);

  for (const match of text.match(/[a-z][a-z0-9_]{1,}/g) ?? []) {
    if (!MULTI_CHAR_STOPWORDS.has(match)) tokens.push(match);
  }

  return tokens;
}

export function termFrequencies(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}
