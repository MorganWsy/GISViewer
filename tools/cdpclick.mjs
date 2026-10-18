#!/usr/bin/env node
/* 在已经在跑的 WebView2 里点一下：坐标可以是屏幕像素，也可以是选择器（点它的中心）。
   地图那种只认事件的控件，用 evaluate 造出来的假事件它不接，得走 CDP 的真实输入。
   用法：node tools/cdpclick.mjs <端口> <x>|sel:<选择器> <y> [第二个点...]
   例：  node tools/cdpclick.mjs 9233 sel:#map 0            # 点地图中心
         node tools/cdpclick.mjs 9233 400 300 400 300       # 点两下（双击） */
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const port = Number(argv.shift());
if (!port || argv.length % 2) { console.error('用法：node tools/cdpclick.mjs <端口> <x>|sel:<选择器> <y> [...]'); process.exit(2); }

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 应用还没起来 */ }
    await sleep(250);
  }
  throw new Error('拿不到调试端口');
}

let id = 0;
const pending = new Map();
const page = await target();
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(page.webSocketDebuggerUrl);
  s.onopen = () => resolve(s);
  s.onerror = () => reject(new Error('CDP 连接失败'));
  s.onmessage = (m) => {
    const msg = JSON.parse(m.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
});
const send = (method, params) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params: params || {} }));
});

await send('Runtime.enable');

async function resolvePoint(raw, yRaw) {
  if (raw.indexOf('sel:') !== 0) return [Number(raw), Number(yRaw)];
  const r = await send('Runtime.evaluate', {
    expression: '(()=>{const e=document.querySelector(' + JSON.stringify(raw.slice(4)) + ');' +
      'if(!e)return "";const b=e.getBoundingClientRect();' +
      'return JSON.stringify([Math.round(b.left+b.width/2),Math.round(b.top+b.height/2)]);})()',
    returnByValue: true,
  });
  if (!r.result.value) throw new Error('选择器没找到元素：' + raw.slice(4));
  return JSON.parse(r.result.value);
}

for (let i = 0; i < argv.length; i += 2) {
  const [x, y] = await resolvePoint(argv[i], argv[i + 1]);
  const base = { x, y, button: 'left' };
  // clickCount 递增：第二下才算双击，浏览器才会派生 dblclick
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', clickCount: 1, buttons: 1 }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', clickCount: 1, buttons: 0 }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', clickCount: 2, buttons: 1 }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', clickCount: 2, buttons: 0 }, base));
  console.log('已双击 ' + x + ',' + y);
  await sleep(120);
}
ws.close();
process.exit(0);
