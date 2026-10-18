#!/usr/bin/env node
/* 给已经在跑的 WebView2 拍一张真实渲染的图：连它的调试端口，直接抓帧。
   用法：node tools/cdpshot.mjs <端口> <输出png> [选择器]
   给了选择器就只裁那块（看顶栏、弹窗这种局部改动），否则整窗。 */
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [portArg, out, sel] = process.argv.slice(2);
if (!portArg || !out) { console.error('用法：node tools/cdpshot.mjs <端口> <输出png> [选择器]'); process.exit(2); }
const port = Number(portArg);

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
await send('Page.enable');
let clip;
if (sel) {
  const r = await send('Runtime.evaluate', {
    expression: '(()=>{const e=document.querySelector(' + JSON.stringify(sel) + ');' +
      'if(!e)return "";const b=e.getBoundingClientRect();' +
      'return JSON.stringify({x:b.x,y:b.y,width:b.width,height:b.height});})()',
    returnByValue: true,
  });
  if (!r.result.value) throw new Error('选择器没找到元素：' + sel);
  clip = Object.assign(JSON.parse(r.result.value), { scale: 1 });
}
const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('已写出 ' + out);
ws.close();
process.exit(0);
