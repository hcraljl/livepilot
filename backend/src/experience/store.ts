import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExperienceEntry,
  ExperienceMatch,
  ReviewReport,
} from '../../../shared/types.js';
import type { EngineLogger } from '../engine/contracts.js';
import {
  createTfidfIndex,
  type MutableTfidfIndex,
} from './tfidf.js';
import { SEED_EXPERIENCES } from './seeds.js';

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL('../../data/experiences.json', import.meta.url),
);

export interface ExperienceLibrary {
  load(): Promise<void>;
  all(): ExperienceEntry[];
  search(query: string, topK?: number): Promise<ExperienceMatch[]>;
  addFromReport(report: ReviewReport): Promise<ExperienceEntry | null>;
  count(): number;
}

export interface ExperienceLibraryOptions {
  /** null = 纯内存（自测用）；不传 = backend/data/experiences.json */
  filePath?: string | null;
  /** 容量上限，默认 2000；超出后批量裁剪旧复盘，保留全部 playbook */
  maxEntries?: number;
  logger?: EngineLogger;
}

/** 低价值/测试场次不进入候选，避免污染 TopK */
export function isUsefulExperience(entry: ExperienceEntry): boolean {
  if (entry.source === 'playbook') return true;
  if (!entry.result) return true;
  return (
    entry.result.incrementalGmv >= 300 ||
    entry.result.incrementalOrders >= 5
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  );
}

function isExperienceEntry(value: unknown): value is ExperienceEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== 'string' ||
    typeof entry.title !== 'string' ||
    typeof entry.scenario !== 'string' ||
    typeof entry.createdAt !== 'number'
  ) {
    return false;
  }
  if (entry.source !== 'review' && entry.source !== 'playbook') return false;
  if (
    !isStringArray(entry.rules) ||
    !isStringArray(entry.actions) ||
    !isStringArray(entry.takeaways)
  ) {
    return false;
  }
  if (entry.result !== undefined) {
    if (!entry.result || typeof entry.result !== 'object') return false;
    const result = entry.result as Record<string, unknown>;
    if (
      typeof result.incrementalOrders !== 'number' ||
      typeof result.incrementalGmv !== 'number' ||
      typeof result.liftPct !== 'number'
    ) {
      return false;
    }
    if (
      result.confidence !== 'high' &&
      result.confidence !== 'medium' &&
      result.confidence !== 'low'
    ) {
      return false;
    }
  }
  return true;
}

const CONSOLE_LOGGER: EngineLogger = {
  info: (message, meta) =>
    console.log(`[experience] ${message}`, meta ?? ''),
  warn: (message, meta) =>
    console.warn(`[experience] ${message}`, meta ?? ''),
};

let defaultLibrary: ExperienceLibrary | null = null;

/** 引擎与 /api/replay 共用同一份经验库，避免重复加载种子 */
export function getDefaultExperienceLibrary(): ExperienceLibrary {
  if (!defaultLibrary) {
    defaultLibrary = createExperienceLibrary({ logger: CONSOLE_LOGGER });
  }
  return defaultLibrary;
}

export function createExperienceLibrary(
  options: ExperienceLibraryOptions = {},
): ExperienceLibrary {
  const filePath =
    options.filePath === undefined ? DEFAULT_FILE_PATH : options.filePath;
  const logger = options.logger;
  const maxEntries = Math.max(50, options.maxEntries ?? 2000);
  const pruneBatch = Math.max(20, Math.round(maxEntries * 0.1));

  let entries: ExperienceEntry[] = [...SEED_EXPERIENCES];
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let saveChain: Promise<void> = Promise.resolve();
  /** 首次搜索时构建，之后搜索复用；新增经验只做增量更新 */
  let cachedIndex: MutableTfidfIndex | null = null;

  function pruneIfNeeded(): boolean {
    if (entries.length <= maxEntries + pruneBatch) return false;
    const playbooks = entries.filter((entry) => entry.source === 'playbook');
    const reviews = entries
      .filter((entry) => entry.source !== 'playbook')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(0, maxEntries - playbooks.length));
    entries = [...playbooks, ...reviews].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    logger?.info('经验库达到容量上限，已裁剪旧复盘', {
      kept: entries.length,
      maxEntries,
    });
    return true;
  }

  async function persist(): Promise<void> {
    if (!filePath) return;
    const snapshot = JSON.stringify(entries, null, 2);
    saveChain = saveChain
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, snapshot, 'utf8');
      })
      .catch((error) => {
        logger?.warn('经验库写入失败', { error });
      });
    await saveChain;
  }

  async function load(): Promise<void> {
    if (loaded) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const merged = new Map(
        SEED_EXPERIENCES.map((entry) => [entry.id, entry]),
      );

      if (filePath) {
        try {
          const raw = await readFile(filePath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (isExperienceEntry(item)) merged.set(item.id, item);
            }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            logger?.warn('经验库读取失败，使用内置种子', { error });
          }
        }
      }

      entries = [...merged.values()];
      pruneIfNeeded();
      cachedIndex = null;
      loaded = true;
      if (filePath) await persist();
    })();

    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  return {
    load,

    all(): ExperienceEntry[] {
      return [...entries];
    },

    count(): number {
      return entries.length;
    },

    async search(query: string, topK = 3): Promise<ExperienceMatch[]> {
      await load();
      if (entries.length === 0) return [];
      cachedIndex ??= createTfidfIndex(entries);
      return cachedIndex.search(query, topK);
    },

    async addFromReport(report: ReviewReport): Promise<ExperienceEntry | null> {
      await load();
      const leaderboard = report.leaderboard.filter(
        (item) => item.incrementalGmv > 0,
      );
      if (leaderboard.length === 0) return null;
      // 直播太短 / 只有单个动作 / 增量太低，不足以沉淀为可复用经验
      if (report.live.totalMin < 3 || leaderboard.length < 2) return null;

      const best = leaderboard[0];
      const id = `review-${best.decisionId}`;
      if (entries.some((entry) => entry.id === id)) return null;

      const rules = [...new Set(leaderboard.map((item) => item.rule))];
      const actions = [...new Set(leaderboard.map((item) => item.action))];
      const totalOrders =
        Math.round(
          leaderboard.reduce(
            (sum, item) => sum + item.incrementalOrders,
            0,
          ) * 10,
        ) / 10;
      const totalGmv = Math.round(
        leaderboard.reduce((sum, item) => sum + item.incrementalGmv, 0),
      );
      if (totalGmv < 300) return null;

      const takeaways = report.suggestions.filter(
        (item) =>
          !item.startsWith('参考历史复盘') &&
          !item.startsWith('参考知识库'),
      );

      const entry: ExperienceEntry = {
        id,
        source: 'review',
        createdAt: report.generatedAt,
        sessionId: report.sessionId,
        title: `第 ${Math.round(best.startMin)} 分钟${best.ruleName}带来 ${best.incrementalOrders} 单增量`,
        scenario: [
          report.overview,
          report.conclusion,
          ...rules,
          ...actions,
          ...report.productRanking.slice(0, 3).map((item) => item.name),
        ].join(' '),
        rules,
        actions,
        result: {
          incrementalOrders: totalOrders,
          incrementalGmv: totalGmv,
          liftPct: best.liftPct,
          confidence: best.confidence,
        },
        takeaways:
          takeaways.length > 0 ? takeaways : report.suggestions,
      };

      entries.push(entry);
      const pruned = pruneIfNeeded();
      if (pruned) {
        cachedIndex = null;
      } else if (cachedIndex) {
        cachedIndex.add(entry);
      }
      await persist();
      logger?.info('经验库已写入本场复盘', { id });
      return entry;
    },
  };
}
