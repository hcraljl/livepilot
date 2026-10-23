/**
 * 真实开播（真推流）—— 把「点一下按钮」变成「保利威频道真的在直播」
 *
 * 官方链路（已实测打通，2026-10-23）：
 *   1) GET /live/v3/channel/stream/get-push-url  取带时效签名的 RTMP 推流地址
 *      → rtmp://push-xxx.videocc.net/recordf/<streamName>?txSecret=..&txTime=..
 *   2) 本地 ffmpeg 按实时速率推流（音视频编码后 -f flv 推到该地址）
 *   3) GET /live/v3/channel/monitor/get-streams?channelIds= 回读 live=true 确认开播成功
 *
 * 为什么不用「API 直接开播」：保利威没有「服务端一键开播」接口，
 * 开播的物理事实是「有流推到频道」。所以真实开播 = 官方 API 取地址 + 本地推流。
 *
 * 安全：推流地址里的 txSecret 是推流凭证，只在后端内存里存在，
 *      对外状态里只暴露主机名，绝不下发给前端。
 *
 * 负责人：B（后端/集成）· @since v0.8.0
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { BroadcastPhase, BroadcastSource, BroadcastStatus } from '../../../shared/types.ts';
import { config } from '../config.ts';
import { signParams } from '../polyv/sign.ts';
import { polyvClient } from '../polyv/client.ts';

export type { BroadcastPhase, BroadcastSource, BroadcastStatus };

const MAX_LOG = 4000;

const FONT_REGULAR = 'C\\:/Windows/Fonts/msyh.ttc';
const FONT_BOLD = 'C\\:/Windows/Fonts/msyhbd.ttc';

/** 合成演示画面：深色品牌底 + LIVE 角标 + 动态进度条 + 推流计时 */
const buildSceneFilter = (res: string, title: string, subtitle: string): string => {
  const [w, h] = res.split('x').map((n) => Number(n) || 0);
  const W = w > 0 ? w : 1280;
  const H = h > 0 ? h : 720;
  const barW = Math.round(W * 0.62);
  const barX = Math.round((W - barW) / 2);
  return [
    `drawbox=x=0:y=0:w=${W}:h=${H}:color=0x0b1220:t=fill`,
    `drawbox=x=0:y=${Math.round(H * 0.65)}:w=${W}:h=${H}:color=0x111c33:t=fill`,
    `drawbox=x=${barX}:y=${Math.round(H * 0.25)}:w=18:h=18:color=0xef4444:t=fill`,
    `drawtext=fontfile='${FONT_BOLD}':text='LIVE':fontsize=${Math.round(H * 0.036)}:fontcolor=0xef4444:x=${barX + 28}:y=${Math.round(H * 0.238)}`,
    `drawtext=fontfile='${FONT_BOLD}':text='${title}':fontsize=${Math.round(H * 0.12)}:fontcolor=0x60a5fa:x=(w-text_w)/2:y=${Math.round(H * 0.29)}`,
    `drawtext=fontfile='${FONT_REGULAR}':text='${subtitle}':fontsize=${Math.round(H * 0.05)}:fontcolor=0xcbd5e1:x=(w-text_w)/2:y=${Math.round(H * 0.44)}`,
    `drawtext=fontfile='${FONT_REGULAR}':text='AI 正在实时运营这个直播间':fontsize=${Math.round(H * 0.036)}:fontcolor=0x64748b:x=(w-text_w)/2:y=${Math.round(H * 0.53)}`,
    `drawbox=x=${barX}:y=${Math.round(H * 0.72)}:w=${barW}:h=6:color=0x1e293b:t=fill`,
    `drawbox=x=${barX}:y=${Math.round(H * 0.72)}:w='mod(t*60\\,${barW})':h=6:color=0x22d3ee:t=fill`,
    `drawtext=fontfile='${FONT_REGULAR}':text='已推流 %{pts\\:hms}':fontsize=${Math.round(H * 0.033)}:fontcolor=0x94a3b8:x=${barX}:y=${Math.round(H * 0.76)}`,
  ].join(',');
};

class BroadcastService {
  private child: ChildProcess | null = null;
  private phase: BroadcastPhase = 'idle';
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private source: BroadcastSource = 'synthetic';
  /** 本次实际推的文件路径（source=file 时用于展示） */
  private currentFile = '';
  private pushHost = '';
  private logTail = '';
  private channelLive: boolean | null = null;
  private channelLiveAt = 0;
  private ffmpegReady = false;
  private ffmpegChecked = false;

  /** 本机 ffmpeg 是否可用（结果缓存，失败会重试） */
  async ensureFfmpeg(): Promise<boolean> {
    if (this.ffmpegChecked) return this.ffmpegReady;
    this.ffmpegReady = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      try {
        const p = spawn(config.broadcast.ffmpegPath, ['-version'], { windowsHide: true });
        p.on('error', () => finish(false));
        p.on('exit', (code) => finish(code === 0));
        setTimeout(() => {
          p.kill('SIGKILL');
          finish(false);
        }, 4000).unref();
      } catch {
        finish(false);
      }
    });
    this.ffmpegChecked = true;
    return this.ffmpegReady;
  }

  /** 取官方推流地址（含时效签名；只在本进程内存中使用） */
  private async fetchPushUrl(): Promise<string> {
    const qs = new URLSearchParams(
      Object.entries(signParams({ channelId: polyvClient.channelId }) as Record<string, string>).map(([k, v]) => [
        k,
        String(v),
      ]),
    ).toString();
    const url = `${config.polyv.apiBase}/live/v3/channel/stream/get-push-url?${qs}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(config.polyv.timeoutMs + 4000) });
    const json = (await res.json()) as { code?: number; message?: string; data?: unknown };
    const data = typeof json?.data === 'string' ? json.data : '';
    if (!data.startsWith('rtmp://')) {
      throw new Error(`取推流地址失败：code=${json?.code ?? '?'} ${json?.message ?? '无推流地址返回'}`);
    }
    return data;
  }

  /** 回读频道是否真的在直播（官方 get-streams，带 5 秒缓存） */
  async refreshChannelLive(force = false): Promise<boolean | null> {
    if (!force && Date.now() - this.channelLiveAt < 5000) return this.channelLive;
    try {
      const qs = new URLSearchParams(
        Object.entries(signParams({ channelIds: polyvClient.channelId }) as Record<string, string>).map(([k, v]) => [
          k,
          String(v),
        ]),
      ).toString();
      const res = await fetch(`${config.polyv.apiBase}/live/v3/channel/monitor/get-streams?${qs}`, {
        signal: AbortSignal.timeout(config.polyv.timeoutMs),
      });
      const json = (await res.json()) as { data?: Array<{ live?: boolean }> };
      this.channelLive = Boolean(json?.data?.[0]?.live);
      this.channelLiveAt = Date.now();
      return this.channelLive;
    } catch {
      // 查询失败不改写上一次已知状态，避免网络抖动时前端疯狂闪烁
      return this.channelLive;
    }
  }

  private ffmpegArgs(pushUrl: string, file: string): string[] {
    const { width, height, fps, bitrate } = config.broadcast;
    const res = `${width}x${height}`;
    const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0b1220`;

    const videoIn =
      file !== ''
        ? ['-re', '-stream_loop', '-1', '-i', file]
        : ['-re', '-f', 'lavfi', '-i', `color=c=0x0b1220:s=${res}:r=${fps}`];

    const vf = file !== '' ? scale : buildSceneFilter(res, 'LivePilot', '智播副驾 · 演示直播信号');

    return [
      '-hide_banner',
      '-loglevel', 'warning',
      ...videoIn,
      // 静音轨：保证 flv 有音频流（部分播放器对纯视频流兼容性差），但不会有杂音
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-bufsize', `${parseInt(bitrate, 10) * 2}k`,
      '-g', String(fps * 2),
      '-keyint_min', String(fps * 2),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-shortest',
      // 3 小时硬上限：万一后端进程被强杀留下孤儿 ffmpeg，它也会自己收尾，
      // 不至于永久占着频道（演示场景远用不到 3 小时）
      '-t', '10800',
      '-f', 'flv',
      pushUrl,
    ];
  }

  /**
   * 真实开播：取地址 → 起 ffmpeg → 等官方确认 live。
   * 返回时 phase 可能为 live（成功）或 error（失败原因在 status.error）。
   */
  async start(opts: { file?: string; waitMs?: number } = {}): Promise<BroadcastStatus> {
    if (this.child && this.phase !== 'error') {
      return this.status(); // 已在推流，幂等返回
    }
    this.lastError = null;

    if (!polyvClient.credentialsReady) {
      this.phase = 'error';
      this.lastError = '保利威凭据未就绪（需要 USE_REAL_POLYV=true 且 appId/appSecret/channelId 齐全）';
      return this.status();
    }
    if (!config.broadcast.enabled) {
      this.phase = 'error';
      this.lastError = '真实推流已被配置关闭（POLYV_BROADCAST_ENABLED=false）';
      return this.status();
    }
    if (!(await this.ensureFfmpeg())) {
      this.phase = 'error';
      this.lastError = `本机找不到可用的 ffmpeg（当前路径：${config.broadcast.ffmpegPath}），无法推流`;
      return this.status();
    }

    this.phase = 'starting';
    // 本次请求指定文件 > 配置里的文件 > 合成画面
    const file = (opts.file ?? config.broadcast.file).trim();
    this.source = file !== '' ? 'file' : 'synthetic';
    this.currentFile = file;

    let pushUrl = '';
    try {
      pushUrl = await this.fetchPushUrl();
      this.pushHost = new URL(pushUrl).host;
    } catch (e) {
      this.phase = 'error';
      this.lastError = (e as Error).message;
      return this.status();
    }

    const args = this.ffmpegArgs(pushUrl, file);

    const child = spawn(config.broadcast.ffmpegPath, args, { windowsHide: true });
    this.child = child;
    this.startedAt = Date.now();
    this.logTail = '';

    child.stderr?.on('data', (d: Buffer) => {
      this.logTail = (this.logTail + String(d)).slice(-MAX_LOG);
    });
    child.on('error', (e) => {
      this.phase = 'error';
      this.lastError = `ffmpeg 启动失败：${e.message}`;
      this.child = null;
    });
    child.on('exit', (code) => {
      const wasStopping = this.phase === 'stopping';
      this.child = null;
      this.channelLive = null;
      this.channelLiveAt = 0;
      if (wasStopping) {
        this.phase = 'idle';
      } else if (code === 0) {
        this.phase = 'idle';
      } else {
        this.phase = 'error';
        this.lastError = `ffmpeg 异常退出 code=${code}${this.logTail ? `：${this.summarizeLog()}` : ''}`;
      }
    });

    // 等官方确认：ffmpeg 起流到 Polyv 判定 live 通常 5~15 秒
    const waitMs = opts.waitMs ?? 16000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && this.child) {
      await new Promise((r) => setTimeout(r, 2500));
      const live = await this.refreshChannelLive(true);
      if (live) {
        this.phase = 'live';
        return this.status();
      }
    }

    if (this.child) {
      // 进程活着但官方还没判定 live：保留推流，让前端继续轮询状态
      this.phase = 'starting';
      this.lastError = '推流已建立，但保利威尚未判定为直播中（通常还需几秒）';
    }
    return this.status();
  }

  /** 停止推流（先温和终止让 flv 正常收尾，2.5 秒后强杀） */
  async stop(): Promise<BroadcastStatus> {
    const child = this.child;
    if (!child) {
      this.phase = 'idle';
      return this.status();
    }
    this.phase = 'stopping';
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.child = null;
    this.phase = 'idle';
    this.startedAt = null;
    this.channelLive = null;
    this.channelLiveAt = 0;
    return this.status();
  }

  /** 只取日志尾部里最像原因的一行，避免把整段 ffmpeg 输出丢给前端 */
  private summarizeLog(): string {
    const lines = this.logTail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && /error|Error|invalid|Invalid|failed|Failed|refused|connection/i.test(l));
    return (lines[lines.length - 1] ?? this.logTail.trim().split(/\r?\n/).slice(-1)[0] ?? '').slice(0, 200);
  }

  status(): BroadcastStatus {
    const active = Boolean(this.child);
    return {
      active,
      phase: this.phase,
      channelId: polyvClient.channelId,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : 0,
      source: this.source,
      sourceLabel: this.source === 'file' ? `本地文件：${this.currentFile}` : '合成演示画面',
      channelLive: this.channelLive,
      pushHost: this.pushHost,
      error: this.phase === 'error' ? this.lastError : null,
      ffmpegReady: this.ffmpegReady,
      profile: `${config.broadcast.width}x${config.broadcast.height} @${config.broadcast.fps}fps ${config.broadcast.bitrate}`,
    };
  }
}

export const broadcast = new BroadcastService();
