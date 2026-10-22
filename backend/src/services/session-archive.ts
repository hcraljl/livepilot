/**
 * 场次留档（演示保险）
 *
 * 场景：现场演示直播结束后，评委想看复盘，但进程被重启 / 手滑刷新 / 网络抖动导致内存状态丢了。
 * 做法：每次场次结束把 exportSession() 的全量数据写一份 JSON 到 backend/data/sessions/。
 * 特性：失败只告警不抛错（留档是加分项，绝不能影响主流程）；目录不存在自动创建；已被 .gitignore 排除。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'sessions');

export const archiveSession = async (payload: { sessionId: string; [k: string]: unknown }): Promise<string | undefined> => {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `${payload.sessionId || `session-${Date.now()}`}.json`);
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[archive] 场次已留档：${file}`);
    return file;
  } catch (err) {
    console.warn('[archive] 场次留档失败（不影响主流程）：', (err as Error).message);
    return undefined;
  }
};
