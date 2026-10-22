import type { ExperienceEntry, ExperienceMatch } from '../../../shared/types.js';
import { termFrequencies, tokenize } from './tokenizer.js';

interface Vector {
  weights: Map<string, number>;
}

interface IndexedEntry {
  entry: ExperienceEntry;
  /** 缓存词频，新增文档时只做权重刷新，不重新分词旧文档 */
  frequencies: Map<string, number>;
  vector: Vector;
}

export interface TfidfIndex {
  readonly size: number;
  search(query: string, topK?: number): ExperienceMatch[];
}

export interface MutableTfidfIndex extends TfidfIndex {
  /** 增量加入一条经验：只对新文档分词，旧文档只刷新权重 */
  add(entry: ExperienceEntry): void;
}

function entryText(entry: ExperienceEntry): string {
  return [
    entry.title,
    entry.scenario,
    entry.rules.join(' '),
    entry.actions.join(' '),
    entry.takeaways.join(' '),
    entry.source === 'playbook' ? '知识库 playbook sop' : '复盘经验 review',
  ].join(' ');
}

function buildVector(
  frequencies: Map<string, number>,
  documentFrequency: Map<string, number>,
  documentCount: number,
): Vector {
  const weights = new Map<string, number>();
  let sumSquares = 0;

  for (const [term, count] of frequencies) {
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log((documentCount + 1) / (df + 1)) + 1;
    const weight = (1 + Math.log(count)) * idf;
    weights.set(term, weight);
    sumSquares += weight * weight;
  }

  const norm = Math.sqrt(sumSquares) || 1;
  for (const [term, weight] of weights) {
    weights.set(term, weight / norm);
  }
  return { weights };
}

function cosine(a: Vector, b: Vector): number {
  const [small, large] =
    a.weights.size <= b.weights.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small.weights) {
    dot += weight * (large.weights.get(term) ?? 0);
  }
  return dot;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function confidenceWeight(
  confidence: 'high' | 'medium' | 'low',
): number {
  if (confidence === 'high') return 1;
  if (confidence === 'medium') return 0.75;
  return 0.5;
}

function performanceScore(entry: ExperienceEntry, maxGmv: number): number {
  if (!entry.result) return 0.4;
  const gmvScore =
    maxGmv > 0
      ? Math.max(0, Math.min(1, entry.result.incrementalGmv / maxGmv))
      : 0;
  return gmvScore * confidenceWeight(entry.result.confidence);
}

/**
 * TF-IDF + 历史效果权重（可变索引）：
 * - 首次构建 / 加载后建一次，之后搜索复用；
 * - 新增经验只对新文档分词，DF 更新后刷新旧文档的权重（不重新分词）；
 * - IDF 本质上是全局统计，所以"完全零全局计算"做不到，但昂贵部分已经增量化了。
 */
export function createTfidfIndex(
  entries: ExperienceEntry[],
): MutableTfidfIndex {
  const docs: IndexedEntry[] = [];
  const documentFrequency = new Map<string, number>();
  let maxGmv = 0;

  function addDocument(entry: ExperienceEntry, refresh: boolean): void {
    const frequencies = termFrequencies(tokenize(entryText(entry)));
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    docs.push({ entry, frequencies, vector: { weights: new Map() } });
    maxGmv = Math.max(
      maxGmv,
      Math.max(0, entry.result?.incrementalGmv ?? 0),
    );
    if (refresh) refreshVectors();
  }

  function refreshVectors(): void {
    for (const doc of docs) {
      doc.vector = buildVector(
        doc.frequencies,
        documentFrequency,
        docs.length,
      );
    }
  }

  for (const entry of entries) addDocument(entry, false);
  refreshVectors();

  return {
    get size(): number {
      return docs.length;
    },

    add(entry: ExperienceEntry): void {
      addDocument(entry, true);
    },

    search(query: string, topK = 3): ExperienceMatch[] {
      if (docs.length === 0) return [];
      const queryVector = buildVector(
        termFrequencies(tokenize(query)),
        documentFrequency,
        docs.length,
      );
      if (queryVector.weights.size === 0) return [];

      const matches: ExperienceMatch[] = [];
      for (const doc of docs) {
        const similarity = cosine(queryVector, doc.vector);
        if (similarity < 0.02) continue;
        const priority =
          similarity * (0.7 + 0.3 * performanceScore(doc.entry, maxGmv));
        matches.push({
          ...doc.entry,
          similarity: round3(similarity),
          priority: round3(priority),
        });
      }

      return matches
        .sort(
          (a, b) => b.priority - a.priority || b.similarity - a.similarity,
        )
        .slice(0, Math.max(1, topK));
    },
  };
}

export function buildTfidfIndex(
  entries: ExperienceEntry[],
): MutableTfidfIndex {
  return createTfidfIndex(entries);
}
