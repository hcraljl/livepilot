import type { ExperienceEntry, ExperienceMatch } from '../../../shared/types.js';
import { termFrequencies, tokenize } from './tokenizer.js';

interface Vector {
  weights: Map<string, number>;
}

interface IndexedEntry {
  entry: ExperienceEntry;
  vector: Vector;
}

export interface TfidfIndex {
  size: number;
  search(query: string, topK?: number): ExperienceMatch[];
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
 * TF-IDF + 历史效果权重：
 * - 相似度负责“像不像当前场景”
 * - 历史增量与置信度负责“这条经验值不值得优先参考”
 * 最终优先级 = 相似度 * (0.7 + 0.3 * 效果分)，避免效果分压过场景匹配。
 */
export function buildTfidfIndex(entries: ExperienceEntry[]): TfidfIndex {
  const tokenized = entries.map((entry) =>
    termFrequencies(tokenize(entryText(entry))),
  );
  const documentFrequency = new Map<string, number>();
  for (const frequencies of tokenized) {
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const docs: IndexedEntry[] = entries.map((entry, index) => ({
    entry,
    vector: buildVector(tokenized[index], documentFrequency, entries.length),
  }));

  const maxGmv = entries.reduce(
    (max, entry) =>
      Math.max(max, Math.max(0, entry.result?.incrementalGmv ?? 0)),
    0,
  );

  return {
    size: entries.length,
    search(query: string, topK = 3): ExperienceMatch[] {
      if (entries.length === 0) return [];
      const queryVector = buildVector(
        termFrequencies(tokenize(query)),
        documentFrequency,
        entries.length,
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
