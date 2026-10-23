/**
 * 视觉验证脚本：用 Chrome DevTools Protocol 打开页面、等待若干秒、截图。
 *
 * 为什么不用 --screenshot：该模式下页面在 load 事件后立刻截图，
 * 而驾驶舱的数据来自 SSE，此时还没到第一帧；加 --virtual-time-budget
 * 又会让渲染进程崩溃（实测）。CDP 可以精确控制「等多久再截」。
 *
 * 用法：node scripts/shot.mjs <url> <输出文件> [等待毫秒]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , url, outFile, waitMsRaw] = process.argv;
if (!url || !outFile) {
  console.error('用法: node scripts/shot.mjs <url> <out.png> [waitMs]');
  process.exit(1);
}
const waitMs = Number(waitMsRaw ?? 6000);
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'lp-cdp-'));

const chromePath =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const chrome = spawn(
  chromePath,
  [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1600,950',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getTarget = async () => {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来，继续等 */
    }
    await sleep(250);
  }
  throw new Error('连不上 Chrome 调试端口');
};

const wsUrl = await getTarget();
const ws = new WebSocket(wsUrl);
let seq = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 950,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url });

// 等页面真正跑起来（SSE 首帧 + 数据渲染）
await sleep(waitMs);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'));
  console.log(`✅ 截图已保存：${outFile}`);
} else {
  console.error('❌ 截图失败', JSON.stringify(shot).slice(0, 300));
}

ws.close();
chrome.kill();
