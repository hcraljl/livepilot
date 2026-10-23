/**
 * 真实开播自检
 *
 * 默认（安全）：只查「本机 ffmpeg 可用 + 官方推流地址可取 + 当前状态」，
 *              不推流、不影响真实频道，CI / 彩排前随时可跑。
 * 加 --live：完整走一遍真实开播 → 官方回读 live → 查收流码率 → 停止 → 确认回落。
 *            会真的在频道里播一小会儿（约 30 秒），不要在正式直播期间跑。
 *
 * 用法：
 *   npm run broadcast:check -w backend            # 只做安全检查
 *   npm run broadcast:check -w backend -- --live  # 真实推流端到端
 */
import { broadcast } from '../services/broadcast.ts';
import { polyvClient } from '../polyv/client.ts';
import { signParams } from '../polyv/sign.ts';
import { config } from '../config.ts';

const LIVE = process.argv.includes('--live');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let warn = 0;
const check = (name: string, okFlag: boolean, detail = ''): void => {
  if (okFlag) pass += 1;
  else fail += 1;
  console.log(`${okFlag ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
};
/** 软检查：不满足不算失败（统计类接口有延迟，不能因此判定功能不可用） */
const soft = (name: string, okFlag: boolean, detail = ''): void => {
  if (okFlag) pass += 1;
  else warn += 1;
  console.log(`${okFlag ? '✅' : '⚠️ '} ${name}${detail ? ` —— ${detail}` : ''}`);
};

const getJson = async (path: string, params: Record<string, string | number>) => {
  const qs = new URLSearchParams(
    Object.entries(signParams(params) as Record<string, string>).map(([k, v]) => [k, String(v)]),
  ).toString();
  const r = await fetch(`${config.polyv.apiBase}${path}?${qs}`, { signal: AbortSignal.timeout(12000) });
  return (await r.json()) as { code?: number; data?: any; message?: string };
};

async function main(): Promise<void> {
  console.log('\n=== 真实开播自检 ===');
  console.log(`模式：${LIVE ? '完整推流（会真的播约 30 秒）' : '安全检查（不推流）'}`);
  console.log(`频道：${polyvClient.channelId || '(未配置)'}\n`);

  check('保利威凭据齐备（可切真实模式）', polyvClient.credentialsReady);
  check('ffmpeg 可用', await broadcast.ensureFfmpeg(), config.broadcast.ffmpegPath);
  check('真实推流未被配置禁用', config.broadcast.enabled);

  // 官方推流地址接口（只取不推：地址有时效，取完不用也不会造成任何影响）
  try {
    const qs = new URLSearchParams(
      Object.entries(signParams({ channelId: polyvClient.channelId }) as Record<string, string>).map(([k, v]) => [
        k,
        String(v),
      ]),
    ).toString();
    const r = await fetch(`${config.polyv.apiBase}/live/v3/channel/stream/get-push-url?${qs}`, {
      signal: AbortSignal.timeout(12000),
    });
    const j = (await r.json()) as { code?: number; data?: string };
    const pushOk = typeof j.data === 'string' && j.data.startsWith('rtmp://');
    // 只打印主机名，绝不打完整地址（含 txSecret）
    const host = pushOk ? new URL(j.data as string).host : '-';
    check('官方推流地址可取（get-push-url）', pushOk, host);
  } catch (e) {
    check('官方推流地址可取（get-push-url）', false, (e as Error).message);
  }

  const before = broadcast.status();
  check('当前未在推流（可安全开播）', !before.active, before.phase);

  if (!LIVE) {
    console.log('\n提示：加 --live 可完整验证「开播 → 官方判定 live → 停止」。\n');
    console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
    process.exit(fail === 0 ? 0 : 1);
  }

  // ---- 完整推流 ----
  const started = await broadcast.start({ waitMs: 20000 });
  check('开播返回非错误态', started.phase !== 'error', started.error ?? started.phase);
  check('推流进程存活', started.active);
  check('官方回读 channelLive = true', started.channelLive === true, `channelLive=${started.channelLive}`);

  if (started.active) {
    // 官方 get-stream-info 的码率/帧率统计比 live 标记刷新得慢（实测推流 3 分钟后才有值），
    // 所以这里重试，且只做「软检查」——live=true 本身已经是「服务端收到流」的强证据。
    let bw = 0;
    let fps = '-';
    for (let i = 0; i < 3; i += 1) {
      await sleep(6000);
      const info = await getJson('/live/v3/channel/monitor/get-stream-info', { channelId: polyvClient.channelId });
      bw = Number(info?.data?.inBandWidth ?? 0);
      fps = String(info?.data?.fps ?? '-');
      if (bw > 0) break;
    }
    soft(
      '服务端收到流（inBandWidth > 0，统计有延迟）',
      bw > 0,
      bw > 0 ? `${Math.round(bw / 1000)} kbps, fps=${fps}` : '统计尚未刷新，但官方已判定 live=true',
    );

    const stopped = await broadcast.stop();
    check('停止后进程已退出', !stopped.active, stopped.phase);
    await sleep(6000);
    const afterLive = await broadcast.refreshChannelLive(true);
    check('停止后官方回读 channelLive = false', afterLive === false, `channelLive=${afterLive}`);
  }

  const tail = warn > 0 ? ` / ${warn} 警告` : '';
  console.log(`\n=== 结果：${pass} 通过${tail} / ${fail} 失败 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
