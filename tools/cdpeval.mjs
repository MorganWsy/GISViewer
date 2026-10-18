#!/usr/bin/env node
/* 连到已经在跑的 WebView2（--remote-debugging-port）里问几句 DOM 现状。
   用法：node tools/_cdpeval.mjs <端口> "<表达式>" ["<表达式>" ...] */
import { setTimeout as sleep } from 'node:timers/promises';

const port = Number(process.argv[2] || 9222);
const exprs = process.argv.slice(3);

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 应用还没起来 */ }
    await sleep(250);
  }
  throw new Error('拿不到调试端口');
}

let id = 0;
const pending = new Map();

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('CDP 连接失败'));
    ws.onmessage = (msg) => {
      const m = JSON.parse(msg.data.toString());
      if (m.id && pending.has(m.id)) {
        const { resolve: r, reject: j } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) j(new Error(m.error.message)); else r(m.result);
      }
    };
  });
}

const page = await target();
const ws = await connect(page.webSocketDebuggerUrl);
const send = (method, params) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params: params || {} }));
});

await send('Runtime.enable');
for (const expr of exprs) {
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      console.log('EXCEPTION ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    } else {
      const v = r.result.value;
      console.log(expr.slice(0, 40) + ' => ' + (typeof v === 'string' ? v : JSON.stringify(v)));
    }
  } catch (e) {
    console.log('FAILED ' + expr.slice(0, 40) + ' : ' + e.message);
  }
}
ws.close();
process.exit(0);
