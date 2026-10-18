#!/usr/bin/env node
/* 开发期截图工具：无头 Edge + CDP，抓真实渲染结果。

   一次启动跑完所有检查项，别一个页面起一个浏览器：
     node tools/shot.mjs spec.json
   spec.json = [{ out, url, w, h, wait, script, click:[x,y], drag:[x1,y1,x2,y2,button], scrollSel }, ...]

   也保留单张的快速写法：
     node tools/shot.mjs <输出png> <url> [宽] [高] [等待毫秒] [滚动选择器] [脚本] [点击x,y] */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
  console.error('用法：node tools/shot.mjs <spec.json>  或  node tools/shot.mjs <输出png> <url> [宽] [高] [等待毫秒] [滚动选择器] [脚本] [点击x,y]');
  process.exit(2);
}

function toList() {
  if (!argv.length) usage();
  if (argv[0].endsWith('.json')) {
    const list = JSON.parse(readFileSync(argv[0], 'utf8'));
    return Array.isArray(list) ? list : [list];
  }
  if (!argv[1]) usage();
  const [, , w, h, waitMs, scrollSel, script, click] = argv;
  return [{ out: argv[0], url: argv[1], w, h, wait: waitMs, scrollSel, script,
    click: click ? click.split(',').map(Number) : null }];
}

const jobs = toList();
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'gisviewer-edge-'));
let browser = null;

// 上一轮崩溃会留下临时用户目录，一小时以上的直接收掉
function sweepProfiles() {
  const now = Date.now();
  for (const name of readdirSync(tmpdir())) {
    if (name.indexOf('gisviewer-edge-') !== 0) continue;
    const dir = join(tmpdir(), name);
    try {
      if (now - statSync(dir).mtimeMs > 3600e3) rmSync(dir, { recursive: true, force: true });
    } catch { /* 正被占用就留给下次 */ }
  }
}

// 只杀父进程会留下一串渲染/GPU 子进程：Edge 真正的浏览器进程未必是它的子进程，
// 所以按这一轮的 --user-data-dir 精确收掉整批
function killByProfile(dir) {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*" + dir + "*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
  if (r.error && browser && browser.pid) {
    spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

sweepProfiles();

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('拿不到调试端口');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
}

let id = 0;
function makeRpc(ws) {
  const pending = new Map();
  const events = [];
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  return { send, events };
}

function consoleOf(events) {
  return events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => e.params.type + ': ' + e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    .concat(events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => 'EXCEPTION: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)))
    .join('\n');
}

const MASK = { left: 1, middle: 4, right: 2 };

async function mouseDrag(send, box) {
  const [x1, y1, x2, y2, button = 'left'] = box;
  const buttons = MASK[button] || 1;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' });
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: x1, y: y1, button, buttons, clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, button, buttons,
    });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: x2, y: y2, button, buttons, clickCount: 1 });
}

async function mouseClick(send, xy) {
  const base = { x: xy[0], y: xy[1], button: 'left', clickCount: 1, buttons: 1 };
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
}

async function runJob(send, job) {
  const w = Number(job.w || 1440);
  const h = Number(job.h || 900);
  // 无头 Edge 的 --window-size 会受设备像素比影响，显式覆写视口才稳定
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: job.url });
  await sleep(Number(job.wait || 6000));
  if (job.scrollSel) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(job.scrollSel)})?.scrollIntoView({block:'start'})`,
    });
    await sleep(1200);
  }
  if (job.script) {
    await send('Runtime.evaluate', { expression: job.script });
    await sleep(Number(job.scriptWait || 1500));
  }
  if (job.drag) {
    await mouseDrag(send, job.drag);
    await sleep(1200);
  }
  if (job.click || job.clickSel) {
    let xy = job.click;
    if (job.clickSel) {
      // 地图中心点会随右栏宽度、属性表开合移动，让页面自己量，别照着屏幕硬猜
      const r = await send('Runtime.evaluate', {
        expression: `(() => {const b = document.querySelector(${JSON.stringify(job.clickSel)}).getBoundingClientRect();` +
          `return JSON.stringify([Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]);})()`,
        returnByValue: true,
      });
      xy = JSON.parse(r.result.value);
      console.log('点击 ' + job.clickSel + ' 中心 → ' + xy.join(','));
    }
    await mouseClick(send, xy);
    await sleep(Number(job.clickWait || 2200));
  }
  // 交互之后再跑一段脚本，用来把 DOM 现状写进可见位置
  if (job.script2) {
    await send('Runtime.evaluate', { expression: job.script2 });
    await sleep(500);
  }
  const shot = await send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: !job.scrollSel });
  writeFileSync(job.out, Buffer.from(shot.data, 'base64'));
  console.log('已写出 ' + job.out);
}

async function main() {
  browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', '--hide-scrollbars', '--no-first-run',
    '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: 'ignore' });

  const page = await findTarget();
  const ws = await connect(page.webSocketDebuggerUrl);
  const { send, events } = makeRpc(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  for (const job of jobs) await runJob(send, job);
  const logs = consoleOf(events);
  if (logs) console.log(logs);
  // 先让浏览器自己退出，子进程才会跟着散掉
  await send('Browser.close').catch(() => {});
  ws.close();
}

main()
  .catch((e) => { console.error('失败：' + e.message); process.exitCode = 1; })
  .finally(async () => {
    await sleep(600);
    killByProfile(profile);
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 留给下次清扫 */ }
  });
