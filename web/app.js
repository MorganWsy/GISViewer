const $ = (id) => document.getElementById(id);

/* 只用于内置常量 SVG：用 Range 解析成节点，不把字符串当 HTML 塞进 DOM。
   用户可控文本一律 textContent，不走这里。 */
function setSVG(node, svg) {
  node.replaceChildren(document.createRange().createContextualFragment(svg));
}

/* 原生壳里才有窗口三键和系统对话框，浏览器版这两样都没有 */
const NATIVE = !!(window.chrome && window.chrome.webview);

/* 选择文件按钮走事件委托：不依赖后面那一长串初始化走到哪一步。
   页面脚本哪怕中间抛了错，这个按钮也照样能把系统的打开框叫出来。
   原生壳里点开先弹小菜单（文件/文件夹两条路），浏览器版没有目录通道，还是老样子 */
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('#filePickBtn') : null;
  if (!btn) return;
  if (NATIVE) togglePickPop();
  else {
    const input = $('filePick');
    if (input) input.click();
  }
});

/* 页面脚本出错时写进壳的日志，出问题时不用靠猜；用户看不到这些字 */
window.addEventListener('error', (e) => {
  try {
    const file = String(e.filename || '').split('/').pop();
    toShell('jserr:' + (e.message || '未知错误') + ' @' + file + ':' + (e.lineno || 0));
  } catch { /* 连报错都失败就安静 */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    toShell('jserr:未处理的异步错误 ' + ((r && (r.message || r)) || ''));
  } catch { /* 同上 */ }
});

let current = null;
let config = {
  theme: 'auto', basemap: 'tianditu_img', annotation: false, tianditu_key: '',
  ramp: 'viridis', class_count: 5, nodata_view: 'transparent', raster_default: 'composite',
  vector_color: '#d9781f', max_features: 500, restore_last: false, cache_dir: '', keep_hours: 12,
  ui_font: '', num_font: '', ui_zoom: 100, panel_alpha: 93, unit_lang: 'en',
  key_close: 'Esc', key_fit: 'F', key_find: 'Ctrl+F', draw_limit: 5000, vec_precision: 'auto',
  always_on_top: false,
  hk_mods: 3, hk_vk: 71, hk2_mods: 3, hk2_vk: 32, hk3_mods: 3, hk3_vk: 68,
  upd_freq: 'open', close_act: 'min', close_ask: true, recent: [], recent_max: 5,
};
const RAIL_MIN = 300;
const RAIL_MAX = 760;

/* 图标全部走 currentColor，深浅主题下自动跟着文字变色。
   一套配色一枚图标：明暗圆、太阳、月亮、卷轴、泼墨、山，各是一眼能认出来的形状，
   免得六套主题共用一个"调色盘"，点开才知道到哪一套了。
   卷轴与泼墨是外来图标（1024 视图框）：原图内容只占画布 87%，照原视图框摆 19px
   会比旁边小一圈，于是把视图框裁到 56..968 让内容满边，再按 20px 摆，
   视觉高度才跟那几颗 24 视图框的图标齐平 */
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v16.8"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2z"/></svg>',
  paper: '<svg viewBox="56 56 912 912" style="width:20px;height:20px" aria-hidden="true"><path d="M238.083955 154.140613c36.465516-1.677199 65.072041-23.213701 63.891146-48.105624-1.180895-24.891923-31.705096-43.711548-68.166519-42.034349-36.465516 1.675152-65.072041 23.210631-63.891146 48.106648C171.099355 136.995117 201.622532 155.815765 238.083955 154.140613z" fill="currentColor"></path><path d="M81.563132 886.693798A59.666 33.33 0 1 1 81.563132 887.717104Z" fill="currentColor"></path><path d="M150.54932 129.062448C134.998135 347.678514 63.965336 871.505887 63.965336 871.505887s32.758078-41.570791 74.456782-41.036625c41.698704 0.535189 62.270229 16.258289 79.601966 46.898123 17.330714 30.640857 86.034469-724.979696 86.034469-724.979696S202.925201 226.481198 150.54932 129.062448z" fill="currentColor"></path><path d="M451.730846 104.597243c0 0-2.220574-5.466502-121.06838 30.605042l-68.865437 661.314701c0 0 71.088058-61.2152 114.406656-71.053266L451.730846 104.597243z" fill="currentColor"></path><path d="M541.699927 712.348004l62.200644-621.960391c0 0-94.4133-1.093914-114.406656 5.463432L415.077042 712.348004C415.077042 712.348004 478.387973 695.951569 541.699927 712.348004z" fill="currentColor"></path><path d="M681.650353 796.516985l86.637196-701.756785c0 0-37.763069-12.163017-129.953747-4.442172l-69.976748 632.962979C568.357054 723.281007 648.329457 754.980987 681.650353 796.516985z" fill="currentColor"></path><path d="M856.037079 639.112026l58.865689-512.652869c0 0-15.546068-13.115716-117.736495-29.513174l-79.971379 615.402021C717.194894 712.348004 748.298286 613.973486 856.037079 639.112026z" fill="currentColor"></path><path d="M914.902768 751.698221c17.773805-95.097892-86.635149-94.007047-146.615219-51.771107-44.184315 31.115672-49.983391 99.867522 0 122.821303 49.984415 22.955828 72.199369-44.816718 47.76384-43.721781-24.436552 1.093914-27.771507-10.933003-27.771507-20.770046 0-9.838066 64.425312-58.3305 68.866461 38.259372 3.651157 79.371722-94.414323 66.675562-94.414323 66.675562-141.063783-47.00557-98.853425-57.932434-208.81484-103.84102-126.621862-49.189306-238.805898 37.164435-238.805898 37.164435 194.375989-85.260849 266.778996 42.042535 402.083611 130.075521 134.396943 87.442538 172.161035-27.330462 172.161035-27.330462C1030.418688 845.705268 914.902768 751.698221 914.902768 751.698221z" fill="currentColor"></path></svg>',
  /* 墨黑：泼墨，中心一团加四周飞溅的墨点；纸那枚是卷轴，竖纹加右下角的卷边 */
  ink: '<svg viewBox="56 56 912 912" style="width:20px;height:20px" aria-hidden="true"><path d="M815.5 309.6c-12.6-5-48.6 9-59.5 20.9-15.3 16.8-16.3 35.1-5.8 59.9-23.3-15.7-43.6-16.2-64.6-13.3-16.8 2.3-33.6 3.8-50.4 5.4-15 1.4-21.5-1.6-13.9-19 5.3-12.1 15.5-21.5 20.4-36.6-16.1 2-20.1 13.6-26.2 22.4-6.1 8.7-12 23.6-22.4 19.5-12.2-4.8-28.4-10.9-31.4-27.5-3.5-19.7-16.1-34.6-24.2-51.9-1.9-4.1-3.1-10.1-8.9-8.7-6.1 1.5-8.2 6.9-5.6 12.8 7.4 16.7-4.2 15.7-14.6 16-17.3 0.6-32.1-8.8-51.2-13.8 11.7 25.7-3 23.4-19.7 23.4-16.2 0.1-29.4-3.7-40.6-15.1-9.4-5.2-14.3-14.2-19.7-22.8-2.1-6.3-4.3-12.4-12.3-14.2-2.8 7.8 1.9 11.2 7.1 14.5 5.1 9.1 10.2 18.3 15.3 27.4 0.9 2 1.3 4.4 2.7 6 19.6 22.7 19.6 22.6-5.3 40.6-2.3 1.7-5.1 3.9-5.9 6.4-8.2 25.1-28.1 29.3-50.6 29.1-8.5-4.9-17.3-4.6-26.5-0.3 7.1 1.9 14.1 3.7 21.2 5.6 7.4 3.8 14.7 7.5 29.6 15.2-27.2 2.6-25.2 43.1-57.4 27-0.8-0.4-3.6 0.8-3.7 1.5-2.5 26.3-15.6 4.8-22.6 4.1-8.7-0.9-16.9-6.8-26.5-6.1-4.7 0.3-11-0.3-10.7-5.7 1.3-23-15-35.2-28.2-50-13.4-14.9-29.4-18.2-47-12.5-12.4 4-23.8 11.1-35.6 16.8-7.2-7.1-15-12-25.7-7.5 1.9 9.1 14.7 3.9 16.2 13-2 18.1-18.4 31.4-12.1 53.5 7 24.7 19.3 38.1 42 51.1 23.6 13.6 49.8 5.3 57.8-3.2 21.4-22.6 43.5-21.3 68.7-18.5 32.5 3.7 43 18.8 37.9 51.9-2.1 13.9-9.3 16.3-20.6 13.5-28-7.1-50.2 1.5-64.9 25-10.1 16.3-7.7 34.4 1 47.7 9.1 13.9 20.3 28.4 42.4 29.2 26.2 0.9 42.3-11.5 54-31.3 6.4-10.9 13.4-10.5 19.8-4.3 11.1 10.9 24 21.3 26.3 38.4-4.6 10.7-9.3 21.4-7.6 33.6-7.2 3.9-5.6 11.8-11.9 19.4 16.9-1.4 14.6-11.6 15.7-19.5 8.6-7.3 2.6-19.7 9.6-27.5 23.2-8.2 28.1-4.8 24.5 17.4 24.5 1.1 24.5 1 46.2 25.4 2.7 3.1 4.7 2.9 7.5 1 10.2-7.1 12.1 2.4 14.2 8 7.3 19.8 11.5 40 1.6 63.5-3.4-6.7-5.6-10.6-7.5-14.7-5-11.1-12.4-17.9-25.3-13.6-12.4 4.2-14.8 14.9-14.3 26 0.8 17.8 24.3 36 39.4 27.7 26.7-14.6 19.7 6.7 19.6 17.3-0.1 15.8-5.7 30.2-21.6 37.8-4.6 2.2-12 2.9-10.5 10 1.4 6.7 8.5 6.1 13.5 5.3 12.3-2 17.9 4.9 22.8 14.6 5.3 10.4-0.5 16.4-9 22.7 17.4-1.3 29.5 0 34.3 19.4 1.9 7.6 15.8 13.7 25.4 12.9 14.5-1.2 16.1 32.2 35.7 12.2 0.6 2.2 1.5 4.3 1.9 6.5 0.6 3.8 0.3 8.3 5.1 9.1 6.4 1.1 7.5-4.4 7.9-8.8 1-10.1 8.4-9.9 15.2-9.6 11.4 0.6 22.8 1.8 34.2 3.4 3.5 0.5 10.1 3.3 9.8 0.4-2.5-22.5 21.9-16.9 29.3-28.9 8.4-13.6 18.3-26.4 27.5-39.5 0.3-0.5 0.7-0.8 1.2-1.1-0.4 0.4-0.8 0.7-1.2 1.1 4.7-0.1 9.4-0.1 14.1-0.2 7 2.2 13.1 2.7 15.5-6.5 0.6-2.4 4.1-5.2-0.3-6.5-4-1.2-8.9-1.9-10.9 3.9-3.1 0.4-6.2 0.7-9.3 1.1-13.2-3.4-16.1-11-8-21.8 3.4-4.6 7.3-9.4 3.5-14.2-10.1-12.7 2.2-19.5 7.3-26.3-3.7-8.5-16.4-5.4-14.8-11.6 4.4-17.5-6.6-25.4-16.9-34.8-19.9-18.1-31.5-46.5-62.9-50.3l-4.5-7.2c24.1 1 32.2-9.3 27.4-33.5-2.3-11.4-7.1-30.1 17.5-27.2 5.5 0.7 3.9-7.2 5-7.6 13.2-5.4 0.4-17 6.1-23.7 14.4-17 32.8-14 51-9.1 13.3 3.6 26.1 9.8 39.5 12 9.5 1.5 23.6 7.1 28.4-6 5-13.6-5.2-23.1-16.6-29.4-6.7-3.7-14-6.2-21-9.3-9.8-4.4-19.8-8.3-29-13.6-6.9-4-11-11-10.2-19.4 1-9.5 8.6-11.8 16.4-13.4 4.3-0.9 8.6-1.7 12.9-2.5-2-7.9-7.6-7.8-13.1-8-6.1-0.2-14 0.4-15.5-6.6-1.4-6.5 4.8-10.8 10.9-13.1 14.4-5.2 12-23.5 24.4-30.9 5.3-3.2-0.1-8.2-4.5-9.6-20.4-6.4-10.2-16.1-4-27 11-19.4 29.4-16.2 44.8-13.1 44.2 9 59.3-0.3 65.6-44.9 2.8-20-13-49.8-30.1-56.7zM323.6 815.6c0.6-2.7 6-7.9-2.1-7.5-16.6 0.9-22.1-16.3-36.9-21.5-20.8-7.3-37.4-11.5-59.2-4.6-23.7 7.5-32.1 37.7-67.3 34.1 19.9 11.5 22.2 21.5 15.7 36.2-6.5 14.6 10.7 56.5 25.8 60 16.6 3.8 12.6 13.9 12.5 24 16.5-6.1 16.5-6 36.1 1.4 5 1.9 11.9 5 15.1 0.2 7.1-10.5 29.5 5.2 28.8-17.6-0.1-2.1 5-0.2 7.7 1.6 7.4 4.9 9.1 0.7 9.3-6 0.1-3.6-0.6-10.6 2.6-9.7 25.3 7.5 6.8-12.2 10.2-17.8 5.2-8.6-3.9-23.2 9.8-30.4 5.6 0.9 11.1 2.4 19.2-1.8-6.1-2.4-10.4-4.2-14.7-5.9-11-9.1-15.9-20.4-12.6-34.7zM876.9 169.8c-20.6-11.6-47.5-10.9-61.2 1.6-21 19.2-24.1 36.1-14.5 62.3 4.3 11.8 16.2 16 21.6 27.2-2.6 1.9-5.8 3.8-8.4 6.1-7.5 6.6-17.3 15-9 24.5 7.7 8.7 18.5 2.4 26.3-4.5 4.5-4.1 8.3-9 12.4-13.5 6.1-6.9 12.1-14.2 21.8-15.9 36.2-6.3 31.9-36.7 34-61 1-12.1-11.9-20.6-23-26.8zM502.3 193.1c13-0.5 42.7-35.5 42.2-49.8-2.3-31.2-22.6-55-54.9-55.8-21.7-0.6-53.5 33.5-54.3 56.9-0.8 23.9 35.1 50 67 48.7zM106.1 914.3c-9.5-5.1-18.8 3.6-17.4 13.8 1.3 9.8 7 22.7 18.1 23.1 18.3 0.5 15.1-19.7 23.4-29.5-3.5-16.8-16.1-3.1-24.1-7.4zM748.1 122.9c9.3-2.7 17.1-7.9 18.3-18.2 0.7-6.6-4.7-6.3-9.6-5.5-10.7 1.8-18.3 7.2-21.7 17.8 2.4 6.2 7.4 7.5 13 5.9z" fill="currentColor"></path><path d="M661.1 647.6c9.4 9 17.9 14.8 29.6 13.6-8.6-5.3-12.4-21-29.6-13.6zM720 807.3h36.9c-20.7-10.3-20.7-10.3-36.9 0zM927 505.4c-4.9 0.5-9.6 2.3-10.1 7.6-0.6 6.2 4.8 7.3 9.2 6.7 4.4-0.6 9.6-2.7 9.3-8.4-0.2-4.5-4.4-5.7-8.4-5.9zM401.7 851c-9.6-1.3-17.7-4.1-28.3 8.6 12.3-3.3 21.7 2.9 28.3-8.6zM376.3 872c9.7 1.7 19.5 3.4 33.8 5.9-11.9-13.2-21.9-10.4-33.8-5.9zM719.8 946.6c-2.9-1-6.3 0.1-6.5 3.9-0.3 5.3 4.3 5 7.9 5.7 1.9-1.3 7.1 0.4 5-4.6-0.9-2.2-3.9-4.1-6.4-5zM250.6 376.1c-3.3-4.7-7.1-8.1-12.9-5.7-1 0.4-1.8 4.6-1.1 5.2 4.2 3.6 9.1 3.8 14 0.5zM445.2 73.9c2.8 0.2 6.2 0 6.2-3.8 0-4.5-3.5-5.9-5.2-6-5.5-0.3-8 1.1-8.3 4.4-0.5 5.3 3.8 5.2 7.3 5.4zM430.5 721.3c-4.2 3-13.7 0.9-10.1 12.4 5.3-2.7 9.7-5.6 10.1-12.4z" fill="currentColor"></path></svg>',
  slate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M2.6 19.2l6-9.4 3.6 5.4 2.6-3.8 6.6 7.8z"/><circle cx="16.4" cy="6.6" r="2.2"/></svg>',
};
const THEME_LABELS = {
  auto: '跟随系统', light: '浅色', dark: '深色',
  paper: '暖纸', ink: '墨黑', slate: '青岩',
};
/* 每套配色是浅底还是深底：logo 换版、地图控件反色、color-scheme 这几处结构性的差别按它判断，
   不按具体是哪一套——否则每加一套深色主题都要再改一遍样式表 */
const THEME_TONE = { light: 'light', dark: 'dark', paper: 'light', ink: 'dark', slate: 'light' };
/* 顶栏那颗按钮的点击顺序：先跟随系统与两套常用的，再往后是新加的三套 */
const THEME_ORDER = ['auto', 'light', 'dark', 'paper', 'ink', 'slate'];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function num(value, digits) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return n.toExponential(3);
  // 一律不加千分位：数值要能直接抄进别的软件
  const d = Math.max(0, Math.min(10, digits === undefined ? 6 : digits));
  return String(parseFloat(n.toFixed(d)));
}

/* 属性值：整型常常是代码值，加千分位反而读错，只把浮点收到位 */
function valText(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  }
  return String(v);
}

function bytes(size) {
  const b = Number(size);
  if (!Number.isFinite(b)) return null;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(2) + ' KB';
  return b + ' 字节';
}

function count(n) {
  /* null/undefined 是"还没有数字"（快速打开时后台在补），不能当成 0 */
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return String(v);
}

/* ---------- 字段说明：名字后面一枚 ⓘ，悬停弹出气泡；属性表表头也共用 ---------- */

/* 图标沿用历书设置页那枚圆形提示符 */
const HINT_ICO = '<svg viewBox="-12 -12 1048 1048" fill="currentColor"><path d="M512 0.021489c-282.758945 0-511.978511 229.219565-511.978511 511.978511s229.219565 511.978511 511.978511 511.978511c282.752806 0 511.978511-229.219565 511.978511-511.978511S794.752806 0.021489 512 0.021489zM650.535193 799.341311c-30.110785 10.406001-53.770648 18.430768-71.779813 24.12035-17.759479 5.683443-38.609343 8.524141-62.269205 8.524141-36.280298 0-64.599274-8.057513-84.656075-23.679305-20.332071-16.089443-30.366611-35.953863-30.366611-60.573587 0-9.465582 0.76748-18.936281 2.297322-28.869514 1.567705-9.93221 4.121877-21.304212 7.225565-33.617655l37.547151-118.810966c3.353374-11.340279 1.453095-21.74628 3.78828-32.177863 2.316765-9.93221 3.333932-19.397792 3.333932-27.429723 0-15.647375 1.433652-26.053376-5.528923-31.742958-7.219425-6.15007-20.312628-4.383844-40.139186-4.383844-9.804297 0-19.832697 1.408069-29.854958 3.776-10.290367 2.847861-19.032472 0.607844-26.251897 3.455705l10.060123-36.926004c24.427342-8.997931 48.087205-16.562211 70.499657-22.719444 22.39301-6.617721 43.722804-9.458419 63.549362-9.458419 36.274158 0 64.09376 7.583722 83.631746 23.205515 19.551288 15.621792 41.169655 35.960003 41.169655 60.579727 0 5.215792-0.800225 14.213723-2.080382 27.461445-1.274016 12.773931-3.858888 24.613584-7.468089 35.486212L563.843762 673.880901c-2.847861 9.465582-5.65786 20.363793-7.986905 32.677237-2.585895 11.839653-3.858888 21.304212-3.858888 27.455305 0 15.621792 4.114714 26.494421 11.845793 32.184003 7.980765 5.65786 21.618367 8.498558 40.900525 8.498558 9.011234 0 19.321044-1.408069 30.878265-4.224208 11.564383-2.841721 19.800975-5.215792 24.946159-7.589862L650.535193 799.341311zM643.860167 319.355445c-17.240663 14.681374-38.315654 21.771863-62.768579 21.771863-24.434505 0-45.540196-7.090489-63.305815-21.771863-17.496489-14.213723-26.238594-31.710212-26.238594-52.547797 0-20.369933 8.742105-37.893029 26.238594-52.547797 17.765619-14.655791 38.872333-22.245653 63.305815-22.245653 24.421202 0 45.527916 7.55814 62.768579 22.245653 17.496489 14.681374 26.258037 32.209586 26.258037 52.547797C670.118204 287.644209 661.356656 305.141722 643.860167 319.355445z"/></svg>';

/* 每个字段一句人话：先说这是什么，再说看它有什么用；结尾不带句号。
   内容长、一口气说不完的写成数组——渲染时按行拆成圆点分点 */
const FIELD_TIPS = {
  '行列号': '影像网格的行数与列数，整幅数据就是由这些格子拼起来的',
  '像元总数': '行列相乘得到的格子总数，其中也包含没有数据的格子',
  '波段数量': '文件包含的波段个数；多波段常见于卫星影像与科学格网数据',
  '范围': ['数据覆盖地面的四至边界', '投影坐标后面括号里给出换算到经纬度后的同一圈边界'],
  '像元大小': '一个格子在地面上代表的实际尺寸，直接决定影像的精细程度',
  '左上角坐标': ['影像最上一行、最左一列的起始位置，与像元大小一起决定每个格子的坐标', '两行分别是西边界与北边界'],
  '坐标系': ['数据采用的坐标参考系统', '投影坐标系给出投影方式与参数，地理坐标系给出椭球与基准面，两者共同决定坐标怎样落到真实地球上'],
  'EPSG': ['坐标系在 EPSG 数据集里的统一编号（如 4326、4490）', '与别的软件核对坐标系时，看编号最快也最不会认错'],
  '类型': ['坐标系的投影方式，常见有高斯-克吕格、横轴墨卡托、兰勃特圆锥等', '不同投影对长度、角度、面积的变形规律不一样'],
  '中心纬度': '投影原点的纬度（Latitude of Origin）。圆锥类投影以它为基准建立坐标原点，同一投影带内所有要素都参照它换算',
  '中央经线': ['投影中央子午线的经度（Central Meridian）', '离它越远的点角度变形越大；我国常见 3° 或 6° 分带，每带一条中央经线'],
  '原点纬度': ['投影原点的纬度（Latitude of Origin），坐标换算的纬度基准', '与"中心纬度"含义相同，不同软件叫法不一'],
  '原点经线': '投影的起始经线（Longitude of Origin），斜轴投影用它确定坐标系的朝向',
  '比例因子': ['中央经线上的长度缩放系数（Scale Factor），1 表示不缩放', '0.9996 是通用横轴墨卡托（UTM）的典型值，用来减小分带边缘的长度变形'],
  '方位角': '斜轴投影中坐标轴相对正北方向偏转的角度（Azimuth）',
  '改正网格方位角': '斜轴投影里格网线相对正北的旋转角（Rectified Grid Angle），用于把斜轴坐标摆正到常用的图面方向',
  '第一/二标准纬线': ['圆锥投影指定的两条无变形纬线（Standard Parallel 1/2）', '两条之间变形最小，之外逐渐增大；只给一条时按单标准纬线处理'],
  '第一标准纬线': '圆锥投影两条无变形纬线中靠北的一条，详见"第一/二标准纬线"',
  '第二标准纬线': '圆锥投影两条无变形纬线中靠南的一条，详见"第一/二标准纬线"',
  '假东/北偏距': ['人为加在投影坐标上的向东、向北固定偏移（False Easting / False Northing），用来避免图面上出现负坐标', '高斯投影的东偏常用 500000 米'],
  '椭球': '用来逼近地球形状的旋转椭球体模型，如 WGS 84、CGCS2000、GRS 1980；一切坐标换算都以它为基准',
  '长/短半轴': ['椭球的长半轴（赤道半径）与短半轴（极半径），单位米', '两者之差反映地球扁的程度，WGS 84 相差约 21.4 千米'],
  '扁率倒数': '椭球扁平程度的倒数表示（1/f），由长短半轴之差与长半轴之比取倒数得到；数值越大越接近正球',
  '地理基准': ['该坐标系采用的大地基准名称与编码，描述椭球与真实地球的贴合关系', '两组数据叠加或换算时基准必须一致，否则要先做基准转换'],
  '单位': '平面坐标与距离使用的单位（米、度等）。读坐标、量算长度面积时都以它为准',
  '说明': '坐标系自带的一段备注文字',
  '有效值范围': ['全部有数据的像元里，数值最小和最大各是多少', '被标为无效值的像元不参与统计；按缩放系数换算过的，给的是换算后的真实值'],
  '平均值': '所有有数据像元的算术平均，无效值不计入',
  '中位数': '把有数据的像元从小到大排好，正中间那个值；比平均值更不怕极端值',
  '标准差': '数值偏离平均值的程度，越大说明这张图上的数值分布越散',
  '不同取值': '像元一共出现过多少种不同的值；分类图通常很少，连续影像会很多',
  'NoData像元': ['被标记为无效值的像元个数，这些位置没有真实观测数据', '最小值、平均值等统计默认不把它们算进去'],
  '有效像元占比': '有数据的像元占像元总数的比例，用来看这张图缺测多少',
  '统计来源': '这些统计数字是文件里自带的，还是软件现场算出来的',
  '名称': '波段自带的名字或描述',
  '数据类型': '存储类型指每个像元值在文件里的编码方式，它决定能表示的数值范围与每个像元占用的字节数',
  '色表': '文件内置的颜色对照表有多少项，分类图常带这一项',
  'NoData': '用来表示"这里没有数据"的那个特殊数值',
  '数值单位': ['文件给这个波段的数值写的物理单位，如 cm3/cm3、m、K', '有单位就能把数值和实际事物对上：0.27 说的是体积含水量，不是随便一个数'],
  '缩放系数': ['文件里存的是整数，真实值要靠它换算：真实值 = 原始值 × 缩放系数 + 偏移', '上面的统计值已经按它换算过；缩放系数为 1 说明文件直接存的就是真实值'],
  '数值偏移': '在缩放之后再加的固定量，与缩放系数一起构成"原始值 → 真实值"的换算关系；没有这一项时偏移为 0',
  '原始值范围': '文件里原样存着的数值范围，没做换算；别的软件显示的通常就是这一份',
  '压缩算法': '像元数据在文件里的压缩方式，决定体积与读取速度',
  '未压缩大小': '不压缩时这些数据要占多少空间',
  '压缩比': '压缩前后大小的比值，越大说明省得越多',
  '位深': ['每个像元值用多少个二进制位存储（8/16/32/64 位）', '位数越高能表达的数值层次越多，文件也越大；同一位深还有有符号与无符号之分，取值范围不同'],
  '颜色解释': ['波段在成图时扮演的角色（灰度、红/绿/蓝、Alpha 透明度、调色板索引等）', '做彩色合成或按颜色取波段时以它为准；多数科学数据没有指定角色'],
  '存储组织': '像元是按波段顺序排，还是按位置交错排；影响按窗口读取的快慢',
  '金字塔': '文件里预先算好的多级缩略图，有几级、用什么重采样方式生成',
  '波段排布': '同一位置上多个波段的排列顺序',
  '变量': '文件里每一个可以单独取值的科学变量',
  '尺寸': '这个变量的行列大小',
  '几何类型': '要素是点、线还是面，以及坐标里有没有 Z、M 分量',
  '要素数': '这个图层里一共有多少个要素',
  'Z 值坐标': '坐标里带不带高程（Z）',
  'M 值坐标': '坐标里带不带测量值（M）',
  '图层': '文件里的一个图层',
  '字段数': '这个图层有多少个属性字段',
  '属性表编码': ['属性表里文字的编码', '用代码读取同一份数据时按这个编码解码，例如 Python 里 open(..., encoding="gbk")、GDAL 里设 SHAPE_ENCODING'],
  '字段': '属性字段的名字',
  '单张要素数': '单张瓦片里最多装了多少个要素',
  '组织方式': '瓦片按什么结构组织存放',
  '缩放级别': '这份瓦片覆盖了哪些缩放级别',
  '瓦片总数': '所有级别加起来一共多少张瓦片',
  '单张大小': '抽样看一张瓦片大概占多少空间',
  '取样': '这些信息是从哪张瓦片里读出来的',
  '结构': '这份 JSON 最外层是什么形状',
  '是否地理数据': '内容里能不能认出地图坐标',
  '顶层字段': '最外层有哪些键名',
  '条目数': '顶层数组里有多少条记录',
  '读取情况': '解析过程中遇到的问题',
};

/* 存储类型对照表：界面只写 GDAL 的类型名（Int16、Float32 这些），气泡里再给出
   代码里实际要写的那两个标识符。用户拿 Python 读同一份数据时按这个写，
   不必再回头查文档。四元组＝GDAL 枚举 / NumPy 类型 / 位数 / 取值范围 */
const DTYPE_CODES = {
  Byte: ['GDT_Byte', 'uint8', 8, '0 ~ 255'],
  UInt8: ['GDT_Byte', 'uint8', 8, '0 ~ 255'],
  Int8: ['GDT_Int8', 'int8', 8, '-128 ~ 127'],
  UInt16: ['GDT_UInt16', 'uint16', 16, '0 ~ 65535'],
  Int16: ['GDT_Int16', 'int16', 16, '-32768 ~ 32767'],
  UInt32: ['GDT_UInt32', 'uint32', 32, '0 ~ 4294967295'],
  Int32: ['GDT_Int32', 'int32', 32, '-2147483648 ~ 2147483647'],
  Int64: ['GDT_Int64', 'int64', 64, '约 ±9.2e18'],
  UInt64: ['GDT_UInt64', 'uint64', 64, '0 ~ 1.8e19'],
  Float32: ['GDT_Float32', 'float32', 32, '约 ±3.4e38，7 位有效数字'],
  Float64: ['GDT_Float64', 'float64', 64, '约 ±1.8e308，15 位有效数字'],
  CInt16: ['GDT_CInt16', 'complex64', 32, '实部与虚部各一个 Int16'],
  CInt32: ['GDT_CInt32', 'complex128', 64, '实部与虚部各一个 Int32'],
  CFloat32: ['GDT_CFloat32', 'complex64', 64, '实部与虚部各一个 Float32'],
  CFloat64: ['GDT_CFloat64', 'complex128', 128, '实部与虚部各一个 Float64'],
};

/* 存储类型的气泡：类型名对得上就给代码标识符，对不上就只说事实，不硬猜 */
function dtypeTip(name, multi) {
  const c = DTYPE_CODES[name];
  const lines = [];
  if (c) {
    lines.push('存储类型为 ' + name + '，对应 GDAL 的 ' + c[0] + '、NumPy 的 ' + c[1] +
      '，每个像元占 ' + (c[2] / 8) + ' 字节，可表示 ' + c[3] + '。');
  } else {
    lines.push('存储类型为 ' + (name || '未知') + '。');
  }
  if (multi && multi.length) lines.push('这份数据各波段类型不一致：' + multi.join('、') + '。');
  lines.push('用代码读取时按此类型解码即可，例如 gdal.Open(路径).GetRasterBand(1).ReadAsArray()。');
  return lines;
}

const tipState = { box: null, anchor: null, timer: 0 };
function tipBubble() {
  if (!tipState.box) {
    tipState.box = el('div', 'tip-bubble');
    tipState.box.hidden = true;
    /* 鼠标可以移进气泡：里面的说明文字要能选中复制，链接要能点。
       移进来时取消"即将收起"的定时器，移出去再收起 */
    tipState.box.addEventListener('mouseenter', () => { clearTimeout(tipState.timer); tipState.timer = 0; });
    tipState.box.addEventListener('mouseleave', hideTipBox);
    document.body.appendChild(tipState.box);
  }
  return tipState.box;
}

/* 气泡文案里的 **重点** 画成强调色加粗：用节点拼，不走 innerHTML —— data-tip 是
   写死在标签上的文本，拼 HTML 迟早出事。半角星号在正文里几乎不出现，不会误伤 */
function fillTipText(node, text) {
  String(text).split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
    if (!part) return;
    if (part.length > 4 && part.slice(0, 2) === '**' && part.slice(-2) === '**') {
      node.appendChild(el('b', 'tip-strong', part.slice(2, -2)));
    } else {
      node.appendChild(document.createTextNode(part));
    }
  });
}

function showTipBox(anchor, text) {
  const box = tipBubble();
  clearTimeout(tipState.timer);
  tipState.timer = 0;
  box.textContent = '';
  // 文案里有换行就按行拆开。以"· "开头的行画圆点，其余行整段排：
  // 有的气泡是"一句总述 + 几条清单 + 一句收尾"，不能每行都挂圆点
  const raw = String(text).split('\n').filter((s) => s.length);
  if (raw.length > 1) {
    const marked = raw.some((s) => s.indexOf('· ') === 0);
    box.classList.add('tip-multi');
    raw.forEach((line) => {
      const bullet = marked ? line.indexOf('· ') === 0 : true;
      const row = el('div', 'tip-li' + (bullet ? '' : ' tip-plain'));
      if (bullet) row.appendChild(el('i', 'tip-dot'));
      const span = el('span', 'tip-txt');
      fillTipText(span, bullet && marked ? line.slice(2) : line);
      row.appendChild(span);
      box.appendChild(row);
    });
  } else {
    box.classList.remove('tip-multi');
    fillTipText(box, raw[0] || '');
  }
  // 提示气泡里可以带一条外链：锚点给 data-tip-href，链接文案给 data-tip-link。
  // target=_blank 会走壳里的 NewWindowRequested，用系统浏览器打开，不把页面导航走
  const href = anchor.getAttribute('data-tip-href');
  if (href) {
    const a = document.createElement('a');
    a.className = 'tip-link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = anchor.getAttribute('data-tip-link') || href;
    box.appendChild(a);
  }
  box.hidden = false;
  tipState.anchor = anchor;
  /* 上一次如果压过宽度或高度，这里先还原，否则会带着旧尺寸显示 */
  box.style.maxWidth = '';
  box.style.maxHeight = '';
  box.style.overflowY = '';
  /* 量之前先把 left 归零：气泡是 position:fixed 且只设了 left，宽度按收缩适配算，
     可用宽度 = 视口宽 - left。上一次若把气泡摆到了右边（left 很大），
     这里可用宽度会变成负数，浏览器只能收缩到最小内容宽（实测 46px），
     照着这个宽度定位，气泡就会被甩到窗口外面去。 */
  box.style.left = '0px';
  box.style.top = '0px';
  const r = anchor.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  /* 方向策略：顶栏（#bar）里的控件横着排一排，气泡摆左右会盖住旁边的按钮，
     所以顶栏一律上下展示；文件卡、图例、图层下拉这类窄卡里的控件同样横向排布，
     左右展开会压住邻座那颗按钮，也走上下。标了 data-tip-dir="up" 的锚点
     （信息窗标题栏、属性表表头这类贴近底部的浮层件）同样走上下、且优先向上；
     其余区域默认摆右侧，右边放不下翻左边，两边都放不下才退回上下方。
     箭头跟着方向换边，始终指向锚点。 */
  const GAP = 8, EDGE = 8;
  const inBar = !!(anchor.closest && anchor.closest('#bar'));
  const inCard = !!(anchor.closest && anchor.closest('#fileChip, #legend, .layer-pop'));
  const dirUp = anchor.getAttribute && anchor.getAttribute('data-tip-dir') === 'up';
  const spaceRight = window.innerWidth - r.right - GAP - EDGE;
  const spaceLeft = r.left - GAP - EDGE;
  let side = (inBar || inCard || dirUp) ? 'v' : 'right';
  let x;
  if (side !== 'v' && br.width <= spaceRight) {
    x = r.right + GAP;
  } else if (side !== 'v' && br.width <= spaceLeft) {
    side = 'left';
    x = r.left - GAP - br.width;
  } else {
    /* 竖向：左右放不下（或顶栏/上展锚点），把气泡宽度压到窗口能容下的尺寸，
       不然还是会溢出 */
    side = 'v';
    const fit = Math.max(160, window.innerWidth - EDGE * 2);
    if (br.width > fit) { box.style.maxWidth = fit + 'px'; }
    const b2 = box.getBoundingClientRect();
    x = Math.max(EDGE, Math.min(window.innerWidth - b2.width - EDGE, r.left + r.width / 2 - b2.width / 2));
  }
  let y = r.top + r.height / 2 - br.height / 2;
  let vert = 'below';
  if (side === 'v') {
    /* 竖向时贴着锚点那一侧摆：上展锚点先试上方，其余先试下方；
       放不下再翻另一侧。锚点自己可能在视口外（长列表里滚到一半的那种），
       这时不能跟着锚点走，得把气泡夹回窗口里。
       上方还得让开顶栏：紧贴窗口顶的锚点（文件信息卡的表头）往上展只会压在
       标题栏上，既难看又挡住拖动区，那种情况直接改走下方 */
    const barEl = document.getElementById('bar');
    const topSafe = Math.max(EDGE, (barEl ? barEl.getBoundingClientRect().bottom : 0) + 4);
    if ((dirUp || inCard) && r.top - GAP - br.height >= topSafe) y = r.top - GAP - br.height;
    else if (r.bottom + GAP + br.height <= window.innerHeight - EDGE) y = r.bottom + GAP;
    else if (r.top - GAP - br.height >= topSafe) y = r.top - GAP - br.height;
    y = Math.max(topSafe, Math.min(window.innerHeight - br.height - EDGE, y));
    /* 气泡整段落在锚点上沿之上才算 above：被夹回来卡在中间时仍按 below 画箭头 */
    if (y + br.height < r.top - 2) vert = 'above';
  } else {
    /* 横向时竖直居中对齐锚点，但不许顶出窗口 */
    y = Math.max(EDGE, Math.min(window.innerHeight - br.height - EDGE, y));
  }
  /* 气泡比窗口还高时（窄窗口 + 长文案），再怎么夹位置也会溢出。
     这时把高度压到窗口内，内容超出部分由气泡自己滚动。 */
  if (br.height > window.innerHeight - EDGE * 2) {
    box.style.maxHeight = (window.innerHeight - EDGE * 2) + 'px';
    box.style.overflowY = 'auto';
    const b3 = box.getBoundingClientRect();
    y = Math.max(EDGE, Math.min(window.innerHeight - b3.height - EDGE, y));
  }
  box.classList.remove('below', 'above', 'left', 'right');
  box.classList.add(side === 'v' ? vert : side);
  /* 箭头对准锚点中心：横向时按竖直位置定，竖向时按水平位置定，
     但不许贴到气泡的圆角外面 */
  if (side === 'v') {
    const arrow = Math.max(12, Math.min(br.width - 12, r.left + r.width / 2 - x));
    box.style.setProperty('--tip-arrow-x', Math.round(arrow) + 'px');
    box.style.removeProperty('--tip-arrow-y');
  } else {
    const arrow = Math.max(12, Math.min(br.height - 12, r.top + r.height / 2 - y));
    box.style.setProperty('--tip-arrow-y', Math.round(arrow) + 'px');
    box.style.removeProperty('--tip-arrow-x');
  }
  box.style.left = Math.round(x) + 'px';
  box.style.top = Math.round(y) + 'px';
}

/* 收起前留一小段：从锚点移到气泡上这一小段路不该让气泡先消失。
   200ms 够跨过 8px 的间隙，太长显拖泥带水，太短容易闪没 */
function scheduleHideTip() {
  clearTimeout(tipState.timer);
  tipState.timer = setTimeout(() => {
    tipState.timer = 0;     // 定时器已经烧掉：这个 id 留着会让下次"离开锚点"以为还有一条在等
    /* 有些情况下会收到一个"假"的 mouseout（元素被重画、气泡盖住光标），
       所以真正收起前再问一次：鼠标是不是还在锚点或气泡上 */
    const a = tipState.anchor;
    const b = tipState.box;
    try {
      if (a && a.matches(':hover')) return;
      if (b && !b.hidden && b.matches(':hover')) return;
    } catch { /* matches 不支持就算了 */ }
    hideTipBox();
  }, 200);
}

function hideTipBox() {
  clearTimeout(tipState.timer);
  tipState.timer = 0;
  if (tipState.box && !tipState.box.hidden) tipState.box.hidden = true;
  tipState.anchor = null;
}

/* 气泡按 DOM 原生 title 的语义来：指针进到带 data-tip 的元素上就出现，离开就消失，
   停着不动也一直在。三条额外规则：
   · 按着鼠标拖动时不出——拖分隔条、拖属性表高度，气泡跟着走只会碍事；
   · 已经打开的东西（菜单、体检浮层、设置弹窗）那颗按钮不出：这一下点的是"打开"，
     指针还停在原处，再飘一句说明是噪音；
   · 点击引起的重绘会补发 mouseover，那不是用户在悬停，所以显示改由 pointermove 驱动。
   关掉菜单之后要主动补看一次：指针没动过，浏览器不会再发 mouseover，
   不查一下那颗按钮就再也不出提示了。 */
let tipPointer = { x: -1, y: -1 };
let tipPressed = false;
let tipPress = null;          // { wasOn }：按下时这颗按钮是否正处于打开状态
let tipRetry = 0;

function tipRawAnchor(node) {
  if (!node || !node.closest) return null;
  const t = node.closest('[data-tip]');
  return t && t.getAttribute('data-tip') ? t : null;
}

function tipAnchorOf(node) {
  const t = tipRawAnchor(node);
  if (!t) return null;
  /* 打开状态的东西不提示：菜单弹出来了、面板开着了，指针还停在同一颗按钮上，
     再飘一句说明是噪音。
     判据只认两样——.on（按钮亮着），以及"真的会弹出东西"的展开态（带 aria-haspopup）。
     折叠按钮（收起文件信息、收起图例）长期是 aria-expanded="true"，它不弹任何浮层，
     拿 expanded 一概滤掉，这几颗就永远没有提示了——这正是"最小化按钮没气泡"的根子 */
  if (t.classList.contains('on')) return null;
  if (t.getAttribute('aria-expanded') === 'true' && t.hasAttribute('aria-haspopup')) return null;
  return t;
}

function tipInBubble(node) {
  return !!(node && node.closest && node.closest('.tip-bubble'));
}

document.addEventListener('pointermove', (e) => {
  tipPointer = { x: e.clientX, y: e.clientY };
  /* 指针在气泡里：选字要能拖动（拖动时 e.buttons 为真）、链接要能点，
     所以这一分支必须排在"拖动中一律收起"前面——排在后面，一按下去就没了 */
  if (tipInBubble(e.target)) { clearTimeout(tipState.timer); tipState.timer = 0; return; }
  if (e.buttons || tipPressed) { hideTipBox(); return; }   // 拖动中
  const t = tipAnchorOf(e.target);
  if (t) {
    if (t !== tipState.anchor) showTipBox(t, t.getAttribute('data-tip'));
  } else if (tipState.anchor && !tipState.timer) {
    /* 离开锚点不立刻收：锚点与气泡之间隔着 8px 的箭头缝，
       这一小段路上指针谁都不在，立刻收就永远走不进气泡。
       留 200ms，进到气泡里 mouseenter 会把定时器撤掉。
       加 !tipState.timer：指针在外头继续移动时不要一遍遍把定时器推后，否则永远收不掉 */
    scheduleHideTip();
  }
}, true);

document.addEventListener('pointerdown', (e) => {
  if (tipInBubble(e.target)) return;   // 按在气泡上（选字、点链接）不算
  /* 这里必须看原始锚点：按下时那颗按钮正开着，tipAnchorOf 会把它滤掉，
     于是永远记不到"刚才是打开的"，关掉之后就补不上那一次提示 */
  const raw = tipRawAnchor(e.target);
  tipPress = { wasOn: !!(raw && raw.classList.contains('on')) };
  tipPressed = true;
  hideTipBox();
}, true);

document.addEventListener('pointerup', () => {
  tipPressed = false;
  const wasOpen = !!(tipPress && tipPress.wasOn);
  tipPress = null;
  if (!wasOpen) return;
  /* 刚把菜单/浮层关掉：等重绘落定，再看一眼指针底下是谁 */
  clearTimeout(tipRetry);
  tipRetry = setTimeout(() => {
    if (tipPressed || tipPointer.x < 0) return;
    const el = document.elementFromPoint(tipPointer.x, tipPointer.y);
    if (tipInBubble(el)) return;
    const t = tipAnchorOf(el);
    if (t) showTipBox(t, t.getAttribute('data-tip'));
  }, 250);
}, true);

document.addEventListener('pointercancel', () => { tipPressed = false; tipPress = null; }, true);

document.addEventListener('mouseout', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t && t === tipState.anchor) scheduleHideTip();
});
window.addEventListener('scroll', hideTipBox, true);
/* 窗口一缩放，锚点在屏幕上的位置就全变了：开着的浮层（最近打开、打开菜单、
   体检）各自按新锚点重摆一遍，不然留在原地盖住别的东西 */
/* 窄窗口里左下角的图例与左上角的文件卡共用一条竖带：图例从地图底边往上长，
   长到文件卡下沿就得停，否则两块半透明面板叠在一起，字摞字。
   两边各让一半——图例至少留三行，不够就让文件卡自己收短、内容在里面滚动。
   量的是两者的实际位置，不按固定像素预留；卡片展开收起、换图层都会重算 */
const LEGEND_MIN = 66;   // 图例至少留三行（每行 22）
const CHIP_MIN = 72;     // 文件卡至少留标题行加两行
const LEGEND_GAP = 8;    // 文件卡下沿与图例之间留的空

function syncMapHeight() {
  const stage = document.querySelector('.map-stage');
  if (!stage) return;
  const sr = stage.getBoundingClientRect();
  if (!sr.height) return;
  const z = uiZoom() || 1;
  const legend = $('legend');
  const body = $('legendBody');
  const chip = $('fileChip');
  const chipBody = $('chipBody');
  /* 图例自己那一圈（标题行、内边距、下边距）先让出来，剩下的才是能给卡片与表体的 */
  let chrome = 0;
  let lmargin = 0;
  if (legend && body && !legend.hidden) {
    const lr = legend.getBoundingClientRect();
    chrome = lr.height - body.getBoundingClientRect().height;
    lmargin = Math.max(0, sr.bottom - lr.bottom);
  }
  const base = sr.height - chrome - lmargin;
  /* 卡片自然高度只能"解开封顶量一次"：封顶值若由封顶后的高度反推，两者会互相追着跑 */
  let natural = 0;      // 卡片不封顶时压到哪儿
  let chipTop = 0;
  let chipChrome = 0;
  if (chip && chipBody && !chip.hidden) {
    const prev = chipBody.style.maxHeight;
    chipBody.style.maxHeight = 'none';
    const cr = chip.getBoundingClientRect();
    chipTop = Math.max(0, cr.top - sr.top);
    natural = chipTop + cr.height + LEGEND_GAP;
    chipChrome = cr.height - chipBody.getBoundingClientRect().height;
    chipBody.style.maxHeight = prev;
  }
  /* 卡片最高能有多高：给图例留够三行 */
  const capLimit = base - LEGEND_GAP - chipTop - LEGEND_MIN;
  const cap = (chip && chipBody && base - natural < LEGEND_MIN)
    ? Math.max(CHIP_MIN, capLimit) : 0;
  if (chipBody) {
    chipBody.style.maxHeight = cap ? Math.max(0, Math.round((cap - chipChrome) / z)) + 'px' : '';
  }
  const used = cap ? chipTop + cap + LEGEND_GAP : natural;
  document.documentElement.style.setProperty(
    '--legend-max', Math.max(0, Math.round((base - used) / z)) + 'px');
}

let stackedBefore = stackedStage();
window.addEventListener('resize', () => {
  syncMapHeight();
  if (!$('recentPop').hidden) placeRecent();
  if (!$('pickPop').hidden) placePickPop();
  if (!$('checkPop').hidden) placeCheckPop();
  if (!$('convPop').hidden) placeConvPop();
  if (!$('updPop').hidden) placeUpdPop();
  /* 从宽屏切到竖排（地图在上、信息栏在下）时把属性表收起来。竖排的地图只剩两百来像素高，
     那张 260 高的表会把地图连同上面的按钮一起盖住；只在这一下收，之后用户自己点开的不干预 */
  const nowStacked = stackedStage();
  if (nowStacked && !stackedBefore && attrOpen()) closeAttr();
  stackedBefore = nowStacked;
});

/* 提示只挂在 i 图标上：别的页面hover到图标才出气泡（属性表表头例外，
   那里的 data-tip 直接挂在 th 上，整格都能触发）。箭头对准图标中心。
   第三个参数给"按这一份数据现写"的提示：同一个字段名在不同文件里值不一样，
   静态文案说不清时（比如存储类型、换算系数的属性名）由调用处传进来 */
function hintIcon(label, custom) {
  const tip = custom || FIELD_TIPS[label];
  if (!tip) return null;
  const i = el('i', 'tip-ico');
  // 数组文案＝分点说明：换行连接后交给 showTipBox 拆行画圆点
  i.setAttribute('data-tip', Array.isArray(tip) ? tip.join('\n') : tip);
  if (label === 'EPSG') {
    i.setAttribute('data-tip-href', 'https://epsg.org/');
    i.setAttribute('data-tip-link', '在 EPSG 官网（epsg.org）按编号查');
  }
  setSVG(i, HINT_ICO);
  return i;
}

/* 耗时超过一秒就换成秒：四位数毫秒既长又看不出快慢 */
function dur(ms) {
  const v = Number(ms);
  if (!v) return '';
  return v >= 1000 ? '读取 ' + (v / 1000).toFixed(1) + ' 秒' : '读取 ' + v + ' 毫秒';
}

/* ---------- 右栏：一张分节长表 ---------- */

function newRail() {
  const items = [];
  const api = {
    head(title, sub) { api._head = { title, sub }; return api; },
    sec(name) {
      const last = items[items.length - 1];
      if (!last || last.sec !== name) items.push({ sec: name });
      return api;
    },
    row(key, value, tip) {
      if (value === null || value === undefined || value === '') return api;
      items.push({ k: key, v: String(value), tip: tip || null });
      return api;
    },
    many(pairs) { pairs.forEach((p) => api.row(p[0], p[1], p[2])); return api; },
    node(n) { if (n) items.push({ node: n }); return api; },
    loading(key) { items.push({ k: key, busy: true }); return api; },
    render(host) {
      host.textContent = '';
      if (api._head) {
        const box = el('div', 'rail-head');
        box.appendChild(el('div', 'rail-name', api._head.title));
        if (api._head.sub) box.appendChild(el('div', 'rail-sub', api._head.sub));
        host.appendChild(box);
      }
      const table = el('table', 'rail-table');
      /* 列宽必须用 colgroup 定：table-layout: fixed 只看第一行，
         第一行是跨两列的分节标题，直接量出来就是对半开 */
      const cg = document.createElement('colgroup');
      cg.appendChild(el('col', 'col-k'));
      cg.appendChild(document.createElement('col'));
      table.appendChild(cg);
      const body = el('tbody');
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.sec) {
          const next = items[i + 1];
          if (!next || next.sec) continue;
          const tr = el('tr', 'sec');
          const th = el('th', null, it.sec);
          th.colSpan = 2;
          tr.appendChild(th);
          body.appendChild(tr);
        } else if (it.node) {
          const tr = el('tr', 'wide');
          const td = el('td');
          td.colSpan = 2;
          td.appendChild(it.node);
          tr.appendChild(td);
          body.appendChild(tr);
        } else {
          const tr = el('tr');
          const th = el('th');
          th.appendChild(el('span', 'rail-k', it.k));
          const ico = hintIcon(it.k, it.tip);
          if (ico) th.appendChild(ico);
          tr.appendChild(th);
          if (it.busy) {
            const td = el('td');
            td.appendChild(el('span', 'sk'));
            tr.appendChild(td);
          } else if (it.v.indexOf('\n') >= 0) {
            // 一个字段好几行值的时候（范围就是四个边），每行一个 div
            const td = el('td', 'v-lines');
            it.v.split('\n').forEach((line) => td.appendChild(el('div', null, line)));
            tr.appendChild(td);
          } else {
            tr.appendChild(el('td', null, it.v));
          }
          body.appendChild(tr);
        }
      }
      table.appendChild(body);
      host.appendChild(table);
      wireRailFolds(body);
      return api;
    },
  };
  return api;
}

/* 分节是手风琴：点标题收起或展开。收起状态记在会话里，切文件重画不丢 */
const railFolds = {};

function wireRailFolds(body) {
  const rows = Array.prototype.slice.call(body.children);
  let current = null;
  rows.forEach((tr) => {
    if (tr.classList.contains('sec')) {
      current = tr;
      const name = tr.textContent;
      tr.__fold = [];
      tr.setAttribute('role', 'button');
      tr.tabIndex = 0;
      if (railFolds[name]) tr.classList.add('folded');
      const flip = () => {
        const off = tr.classList.toggle('folded');
        railFolds[name] = off;
        tr.__fold.forEach((r) => r.classList.toggle('sec-off', off));
      };
      tr.addEventListener('click', flip);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
      });
    } else if (current) {
      current.__fold.push(tr);
    }
  });
  rows.forEach((tr) => {
    if (tr.classList.contains('sec') && railFolds[tr.textContent]) {
      tr.__fold.forEach((r) => r.classList.add('sec-off'));
    }
  });
}

function skeleton(nameText) {
  const rail = newRail();
  rail.head(nameText || '正在读取…', '元数据通常在一秒内到齐');
  rail.sec('概览');
  ['格式', '行列号', '波段数量'].forEach((k) => rail.loading(k));
  rail.sec('空间');
  ['范围', '经纬度范围'].forEach((k) => rail.loading(k));
  rail.sec('坐标');
  rail.loading('坐标系');
  rail.render($('rail'));
}

/* ---------- 通用行 ---------- */

/* 坐标一节按参数逐项列开：挤成一行时"第一标准纬线 25，第二标准纬线 47"这种根本读不完。
   成对的参数并成一行，值用逗号并列（不能用"~"，那是区间不是并列）：
   第一/二标准纬线 25，47、假东/北偏距 0 m，0 m */
/* GDAL 有时给出的是下划线拼的名字（China_Albers_Conic_Equal_Area），
   显示时换成空格，读起来才是正常的英文名称 */
function prettyCrsName(s) {
  return String(s || '').replace(/_/g, ' ').trim();
}

function crsRows(crs) {
  if (!crs || (!crs.name && !crs.label)) return [['坐标系', '未记录']];
  // 坐标系写完整名称（如 "China Geodetic Coordinate System 2000"），
  // EPSG 表示法单独一行放，一眼能对上号
  const rows = [['坐标系', prettyCrsName(crs.name || crs.label)]];
  rows.push(['EPSG', crs.code || (crs.is_custom ? '无标准编码（自定义坐标系）' : '未记录')]);
  const kind = [crs.kind_label, crs.method_label].filter(Boolean).join(' · ');
  if (kind) rows.push(['类型', kind]);
  const params = crs.parameters || [];
  const byLabel = {};
  params.forEach((p) => { byLabel[p.label] = p; });
  const used = {};
  if (byLabel['第一标准纬线'] && byLabel['第二标准纬线']) {
    used['第一标准纬线'] = used['第二标准纬线'] = 1;
    rows.push(['第一/二标准纬线', num(byLabel['第一标准纬线'].value, 6) + '，' +
      num(byLabel['第二标准纬线'].value, 6)]);
  }
  if (byLabel['假东偏距'] && byLabel['假北偏距']) {
    used['假东偏距'] = used['假北偏距'] = 1;
    const unit = unitText(crs.unit_label);
    const suf = unit ? ' ' + unit : '';
    rows.push(['假东/北偏距', num(byLabel['假东偏距'].value, 6) + suf + '，' +
      num(byLabel['假北偏距'].value, 6) + suf]);
  }
  params.forEach((p) => {
    if (!used[p.label]) rows.push([p.label, num(p.value, 6)]);
  });
  const e = crs.ellipsoid;
  if (e && (e.name || e.semi_major_m)) rows.push(['椭球', prettyCrsName(e.name) || '未记录']);
  if (e && e.semi_major_m) {
    const m = unitText('m');
    if (e.semi_minor_m) {
      rows.push(['长/短半轴', num(e.semi_major_m, 3) + ' ' + m + '，' + num(e.semi_minor_m, 3) + ' ' + m]);
    } else {
      rows.push(['长半轴', num(e.semi_major_m, 3) + ' ' + m]);
    }
    if (e.inverse_flattening) rows.push(['扁率倒数', '1 / ' + num(e.inverse_flattening, 4)]);
  }
  if (crs.geographic_crs && crs.geographic_crs.name) {
    const g = crs.geographic_crs;
    rows.push(['地理基准', prettyCrsName(g.name) + (g.epsg ? '（EPSG:' + g.epsg + '）' : '（无标准编码）')]);
  }
  if (crs.unit_label) rows.push(['单位', unitText(crs.unit_label)]);
  if (crs.note) rows.push(['说明', crs.note]);
  return rows;
}

/* 单位写法跟着设置走：默认英文符号，想读中文的在设置里换 */
const UNIT_ZH = {
  m: '米', km: '千米', '°': '度', ft: '英尺', yd: '码', nmi: '海里', mi: '英里',
  chain: '链', in: '英寸', mm: '毫米', cm: '厘米',
};

function unitEn(label) {
  const s = String(label || '');
  if (!s) return '';
  if (s.indexOf('千米') >= 0 || s.indexOf('公里') >= 0) return 'km';
  if (s.indexOf('米') >= 0) return 'm';
  if (s.indexOf('度') >= 0) return '°';
  return s;
}

function unitText(label) {
  const en = unitEn(label);
  if (!en) return '';
  return config.unit_lang === 'zh' ? (UNIT_ZH[en] || en) : en;
}

/* 引擎给的读数里带着单位，界面上按设置换一种写法 */
function unitSwap(text) {
  const s = String(text || '');
  if (config.unit_lang !== 'zh') return s;
  return s.replace(/(\d)\s?(km|m|°|ft|yd|nmi)\b/g, (all, d, u) => d + ' ' + (UNIT_ZH[u] || u));
}

function degText(v, isLon) {
  const h = isLon ? (v >= 0 ? 'E' : 'W') : (v >= 0 ? 'N' : 'S');
  return Math.abs(v).toFixed(6) + '°' + h;
}

/* 范围按四个边排，每个边一行；投影坐标后面括号里跟一份经纬度，
   原来"范围"和"经纬度范围"两行写的是同一圈边界，读的人得自己对 */
const EXT_EDGES = [['西', 'left', 0, true], ['东', 'right', 2, true],
  ['南', 'bottom', 1, false], ['北', 'top', 3, false]];

function extentRows(extent, wgs, unitLabel, local) {
  const unit = unitText(unitLabel);
  // local：有范围但没有经纬度范围——本地坐标图层（多为 CAD），数值不是度，别按经纬度格式化
  const geo = !local && (!unit || unit === '°' || unit === '度');
  const lines = [];
  EXT_EDGES.forEach((e) => {
    const v = extent ? extent[e[1]] : null;
    const g = wgs ? wgs[e[2]] : null;
    if (v === null || v === undefined) {
      if (g !== null && g !== undefined) lines.push(e[0] + ' ' + degText(g, e[3]));
      return;
    }
    if (geo) { lines.push(e[0] + ' ' + degText(v, e[3])); return; }
    lines.push(e[0] + ' ' + num(v) + (unit ? ' ' + unit : '') +
      (g !== null && g !== undefined ? ' (' + degText(g, e[3]) + ')' : ''));
  });
  if (!lines.length) return [];
  return [['范围', lines.join('\n') + (local ? '\n（本地坐标，非经纬度）' : '')]];
}

/* 波段的物理量换算。源数据常把真实值压成整数另存一份缩放系数与偏移
   （土壤湿度那种 ×0.001 + 0），不换算的话看到的 270 其实是 0.27。
   scale 未填按 1、offset 未填按 0，两者都是缺省值时 phys.on 为假，一律照原样显示 */
function bandPhys(band) {
  const b = band || {};
  const rawScale = b.scale === null || b.scale === undefined ? null : Number(b.scale);
  const rawOffset = b.offset === null || b.offset === undefined ? null : Number(b.offset);
  const scale = Number.isFinite(rawScale) ? rawScale : 1;
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  return {
    on: scale !== 1 || offset !== 0,
    scale: scale,
    offset: offset,
    unit: b.unit_type || '',
    rawScale: rawScale,
    rawOffset: rawOffset,
  };
}

/* 换算后该留几位小数：整数源数据乘上 0.001，相邻整数之间就差 0.001，
   所以要留到千分位才分得开，再多给一位为止；系数更小就按数量级往下加。
   不带换算的照原来的四位 */
function physDigits(phys) {
  if (!phys || !phys.on) return 4;
  const tiny = Math.abs(phys.scale) > 0 && Math.abs(phys.scale) < 1
    ? Math.ceil(-Math.log(Math.abs(phys.scale)) / Math.LN10) + 1 : 4;
  return Math.max(4, Math.min(9, tiny));
}

function physVal(phys, v) {
  if (v === null || v === undefined || v === '') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (!phys || !phys.on) return n;
  return n * phys.scale + phys.offset;
}

function physText(phys, v, digits) {
  const got = physVal(phys, v);
  if (got === null || got === undefined || got === '') return null;
  return num(got, digits === undefined ? physDigits(phys) : digits);
}

/* 数值后面缀上单位：没有单位就只给数，不留一个空格 */
function withUnit(text, unit) {
  if (!text) return text;
  return unit ? text + ' ' + unit : text;
}

function statRows(st, phys) {
  if (!st) return [];
  const digits = physDigits(phys);
  const rows = [];
  if (st.minimum !== null && st.minimum !== undefined) {
    // 这组值只统计有效像元（跳过 NoData），"最小/最大值"容易让人以为全图都算了
    rows.push(['有效值范围', withUnit(physText(phys, st.minimum, digits) + ' ~ ' +
      physText(phys, st.maximum, digits), phys && phys.unit)]);
  }
  rows.push(['平均值', physText(phys, st.mean, digits)]);
  // 中位数、不同取值、NoData 像元这几项要等值分布算出来才补得上
  if (st.median !== null && st.median !== undefined) {
    rows.push(['中位数', physText(phys, st.median, digits)]);
  }
  rows.push(['标准差', physText(phys, st.stddev, digits)]);
  if (st.unique_count !== null && st.unique_count !== undefined) {
    rows.push(['不同取值', count(st.unique_count) + ' 种']);
  }
  if (st.nodata_count !== null && st.nodata_count !== undefined) {
    rows.push(['NoData像元', count(st.nodata_count)]);
  }
  rows.push(['有效像元占比', (st.valid_percent === null || st.valid_percent === undefined)
    ? null : num(st.valid_percent, 2) + '%']);
  rows.push(['统计来源', st.source_label]);
  /* 换算过的统计另起一行给出原始数：别的软件多半显示文件里那一份，
     对不上数的时候要有个地方能核对 */
  if (phys && phys.on && st.minimum !== null && st.minimum !== undefined) {
    rows.push(['原始值范围', num(st.minimum, 4) + ' ~ ' + num(st.maximum, 4) +
      '（未换算）']);
  }
  return rows;
}

/* cls 是可选的额外类名：图层表靠它套"列宽固定"的规则，别的表不受影响 */
function gridTable(headers, rows, cls) {
  const table = el('table', cls ? 'grid ' + cls : 'grid');
  const hr = el('tr');
  headers.forEach((t) => {
    const th = el('th');
    th.appendChild(el('span', null, t));
    const ico = hintIcon(t);
    if (ico) th.appendChild(ico);
    hr.appendChild(th);
  });
  const head = el('thead');
  head.appendChild(hr);
  const body = el('tbody');
  rows.forEach((cells) => {
    const tr = el('tr');
    cells.forEach((cell) => {
      const pair = Array.isArray(cell);
      const text = pair ? cell[0] : cell;
      const cls = pair ? cell[1] : null;
      tr.appendChild(el('td', cls, text === null || text === undefined ? '—' : text));
    });
    body.appendChild(tr);
  });
  table.appendChild(head);
  table.appendChild(body);
  return table;
}

/* NoData 那一格：文件里没设就留空，是 NaN 就照写 NaN，别用"非数"这种没人说的词 */
function nodataText(b) {
  if (b.nodata_is_nan) return 'NaN';
  if (!b.has_nodata) return '';
  return num(b.nodata, 6);
}

function bandTable(bands) {
  // 这一表全部左对齐：数字列右对齐会让六列看起来像三列
  return gridTable(['波段', '名称', '数据类型', '位深', '颜色解释', 'NoData'],
    bands.map((b) => [b.index, b.description || '', b.type_label || '',
      b.bits === null || b.bits === undefined ? '' : b.bits,
      b.color_interp && b.color_interp !== 'Undefined' ? (b.color_interp_label || '') : '',
      nodataText(b)]), 'band-table');
}

function layerTable(layers) {
  // 每一列都左对齐：要素数是字符串混排里的数字，右对齐会把四列推得参差
  return gridTable(['图层', '要素数', '几何类型', '坐标系'],
    layers.map((l, i) => [l.name || ('图层 ' + (i + 1)), count(l.feature_count),
      l.error ? '读取失败' : (l.geometry_type_label || '—'),
      prettyCrsName(l.crs && (l.crs.name || l.crs.label)) || '未记录']), 'layer-table');
}

function variableTable(d) {
  return gridTable(['变量', '尺寸', '数据类型', '最小值', '最大值', '平均值'],
    (d.variables || []).map((v) => {
      const s = v.summary || {};
      const st = s.statistics || {};
      /* 每个变量各自带单位与缩放系数：单位缀在类型后面，数字按它换算，
         与单波段那一节同一套口径 */
      const phys = bandPhys(s);
      const dg = physDigits(phys);
      return [v.label, [s.height ? '行 ' + num(s.height) + ' · 列 ' + num(s.width) : '—', 'num'],
        (s.type_label || '—') + (phys.unit ? ' · ' + phys.unit : ''),
        physText(phys, st.minimum, dg),
        physText(phys, st.maximum, dg), physText(phys, st.mean, dg)];
    }), 'var-table');
}

function tileLayerTable(layers) {
  return gridTable(['图层', '几何类型', '字段数', '字段', '单张要素数'],
    layers.map((l) => [l.name || '默认', l.geometry_type_label || '—', [l.field_count, 'num'],
      (l.fields || []).slice(0, 6).join('、') || '—', [count(l.features_in_tile), 'num']]),
    'tile-table');
}

/* ---------- 各格式的分节：只放数据本身的信息，文件级的都在地图胶囊里 ---------- */

function railRaster(rail, d) {
  const crs = d.crs || {};
  const band = (d.bands || [])[0] || {};
  const phys = bandPhys(band);

  if (d.multi_variable) {
    rail.sec('变量');
    rail.row('变量数', (d.variables || []).length);
    rail.node(variableTable(d));
    rail.sec('坐标');
    rail.many(crsRows(crs));
    return;
  }

  const space = extentRows(d.extent, d.extent_wgs84, crs.unit_label);
  if (d.pixel_size_label) {
    space.push(['像元大小', unitSwap(d.pixel_size_label) +
      (d.pixel_size_deg ? '（约 ' + num(d.pixel_size_deg, 6) + '°）' : '')]);
  }
  if (d.origin) {
    const unit = unitText(crs.unit_label);
    const geoUnit = !unit || unit === '°' || unit === '度';
    /* 起始点的两个值分两行写：一行西边界、一行北边界，和"范围"那四条边同一套说法；
       挤在一行时读的人分不清哪个是经度哪个是纬度 */
    const lines = geoUnit
      ? ['西 ' + degText(d.origin[0], true), '北 ' + degText(d.origin[1], false)]
      : d.extent_wgs84
        ? ['西 ' + num(d.origin[0]) + ' ' + unit + ' (' + degText(d.extent_wgs84[0], true) + ')',
          '北 ' + num(d.origin[1]) + ' ' + unit + ' (' + degText(d.extent_wgs84[3], false) + ')']
        : ['西 ' + num(d.origin[0]), '北 ' + num(d.origin[1])];
    space.push(['左上角坐标', lines.join('\n')]);
  }
  if (d.no_georeference) {
    /* 缺哪一样只说在地图区底栏那一句里：信息栏再列一遍，同一件事要在两个地方读，
       而且底下那段话比"无坐标原因"四个字更说得清 */
    space.push(['范围', '无地理坐标']);
  }

  rail.sec('空间');
  rail.many([
    ['行列号', '行 ' + num(d.rows) + ' · 列 ' + num(d.cols)],
    ['像元总数', count(d.pixels)],
    ['波段数量', d.band_count],
  ]);
  rail.many(space);

  rail.sec('坐标');
  rail.many(crsRows(crs));

  /* 统计是整层的数，波段是它的细分：先看数再看逐波段的属性 */
  rail.sec('统计');
  if (band.statistics) rail.many(statRows(band.statistics, phys));
  else rail.loading('统计值');
  if (band.statistics_mismatch) {
    showErrToast('统计值与实测分布不一致', band.statistics_mismatch);
  }

  rail.sec('波段');
  rail.row('名称', (d.bands || []).map((b) => b.description).filter(Boolean).slice(0, 8).join('、'));
  /* 类型名用 GDAL 的叫法（Int16、Float32）。前面再挂"16 位"是同一件事说两遍，
     两个写法并排反而让人怀疑自己看错；位数、取值范围与代码里的写法都放进气泡 */
  const multiTypes = (d.data_types || []).length > 1 ? d.data_types : null;
  rail.row('数据类型', d.type_label + (multiTypes ? '（多类型）' : ''),
    dtypeTip(d.type_label, multiTypes));
  /* 单位与换算系数是文件自己写的，原样给出：缩放系数乘上偏移就是物理值，
     上面"统计"那一段已经按它换算了。来自文件属性时，气泡里写出属性名，
     用户拿 Python 读同一份数据时按这个名字取 */
  rail.row('数值单位', phys.unit, band.unit_key
    ? ['单位取自文件属性 ' + band.unit_key + '。', '用代码读同一个属性就能拿到同样的单位。']
    : null);
  if (phys.rawScale !== null && Number.isFinite(phys.rawScale)) {
    rail.row('缩放系数', '× ' + num(phys.rawScale, 10), band.scale_key
      ? ['换算关系为 真实值 = 原始值 × 缩放系数 + 偏移，系数取自文件属性 ' + band.scale_key + '。']
      : null);
  }
  if (phys.rawOffset !== null && Number.isFinite(phys.rawOffset)) {
    rail.row('数值偏移', '+ ' + num(phys.rawOffset, 10), band.offset_key
      ? ['偏移取自文件属性 ' + band.offset_key + '，换算时加在缩放之后。']
      : null);
  }
  const palette = band.palette_count || d.palette_count || 0;
  rail.row('色表', palette ? palette + ' 项' : '无');
  rail.row('NoData', nodataText(band) || '未设置', band.nodata_key
    ? ['无效值标记取自文件属性 ' + band.nodata_key + '。', '读数据时应先按它做掩膜，否则统计会被填充值带偏。']
    : null);
  if (d.bands && d.bands.length > 1) rail.node(bandTable(d.bands));

  rail.sec('存储');
  rail.many([
    ['压缩算法', d.compression_label],
    ['未压缩大小', bytes(d.uncompressed_bytes)],
    ['压缩比', d.compression_ratio_label],
    ['存储组织', d.storage_layout],
    ['金字塔', band.overviews ? band.overviews + ' 级' +
      (band.overview_resampling ? ' · 重采样 ' + band.overview_resampling : '') : '无'],
    ['波段排布', { BAND: '波段顺序存放', PIXEL: '像元顺序存放' }[d.interleave]],
  ]);
}

function railVector(rail, d) {
  const layers = d.layers || [];
  const primary = layers.find((l) => !l.error) || layers[0] || {};

  rail.sec('空间');
  rail.row('数据类型', (d.driver_label || '矢量数据') + ' 要素类');
  if (primary.geometry_type_label) {
    /* 中文给人读，英文是 OGR 那一套的名字，两边对得上才知道说的是同一种几何；
       Z/M 单独列出（下面两行），几何类型这里不再缀一遍 */
    const geomLabel = primary.geometry_type_label.replace('·含 Z 值', '').replace('·含 M 值', '');
    if (geomLabel.indexOf('混合') >= 0) {
      /* 先把类型本身写出来，"各类型各有多少个"交给后台数——大文件要几秒，
         不能让人盯着一句"正在统计…"干等。数完把这一格换成明细 */
      rail.row('几何类型', primary.geometry_counts_text || geomLabel);
      if (!primary.geometry_counts_text) fillGeomTypes(primary, geomLabel);
    } else {
      rail.row('几何类型', geomLabel +
        (primary.geometry_type ? '（' + primary.geometry_type + '）' : ''));
    }
  }
  rail.row('要素数', count(primary.feature_count) ||
    (primary.quick ? '统计中…' : null));
  rail.row('Z 值坐标', primary.has_z ? '有' : '无');
  rail.row('M 值坐标', primary.has_m ? '有' : '无');
  if (primary.attr_encoding && primary.field_count) rail.row('属性表编码', primary.attr_encoding);
  rail.many(extentRows(primary.extent, primary.extent_wgs84,
    (primary.crs || {}).unit_label, !primary.extent_wgs84 && !!primary.extent));
  if (primary.quick && !primary.extent) rail.row('范围', '统计中…');

  rail.sec('坐标');
  rail.many(crsRows(primary.crs || {}));

  if (layers.length > 1) {
    rail.sec('图层');
    rail.node(layerTable(layers));
  }  /* 字段清单不再单列一张表：类型和宽度直接挂在属性表的表头上，
     示例值那一列属性表里本来就有 */
}

/* 混合几何类型的图层：各类型有多少个由引擎后台数（大文件要几秒），
   数完只改这一格文字，地图和别的行都不动。
   统计期间每秒把秒数写出来——一直挂着"正在统计…"看不出它是在干活还是卡死了 */
const geomTypeAsked = {};
/* 已经数出来的结果按"路径|图层"存一份：同一个文件第二次打开时直接拿来用。
   只靠 geomTypeAsked 不够——它只记"问过"，重新打开后新的数据对象上没有结果文字，
   于是永远停在"类型混合"（这一版自检时发现的） */
const geomTypeText = {};

/* 右栏里按字段名找值那一格；找不到（已经重画或换了文件）返回 null */
function railValueCell(key) {
  const rows = document.querySelectorAll('#rail .rail-table tbody tr');
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i].querySelector('.rail-k');
    if (k && k.textContent.trim() === key) return rows[i].querySelector('td');
  }
  return null;
}

/* 几何统计要问的是"这个图层实际是从哪个文件读的"：
   压缩包里的图层是 /vsizip/... 那种路径，普通文件就是文件本身；
   顶层数据对象没有 target 字段，早先按 d.target 取，一直是 undefined，
   于是这一行永远停在"正在统计…"——这就是它卡住的根因 */
function geomTypesTarget(d) {
  const layers = d.layers || [];
  const layer = layers[d.layerIndex || 0] || layers[0] || {};
  return layer.read_path || (d.file && d.file.path) || (current && current.path) || '';
}

function fillGeomTypes(primary, base) {
  const d = current && current.data;
  const target = d ? geomTypesTarget(d) : '';
  if (!target) return;
  const layerIndex = d.layerIndex || 0;
  const key = target + '|' + layerIndex;
  if (geomTypeText[key]) {
    // 这个文件本会话已经数过：直接填回去，不再问引擎
    primary.geometry_counts_text = geomTypeText[key];
    putText(geomTypeText[key]);
    return;
  }
  if (geomTypeAsked[key]) return;   // 请求还在路上，别重复发
  geomTypeAsked[key] = 1;
  const started = Date.now();
  const label = base || '几何类型混合';
  /* 结果可能比右栏先到（缓存命中时几十毫秒就回来了），也可能晚到几秒。
     所以两件事都要做：填字时找不到那一格就隔一会儿再试；统计期间每秒报一次秒数。
     写成函数声明（而不是 const 箭头函数），上面"本会话已数过"那条分支才能提前调用 */
  function putText(text) {
    let tries = 0;
    const put = () => {
      const cell = railValueCell('几何类型');
      if (cell) { cell.textContent = text; return; }
      if (tries++ < 30) setTimeout(put, 100);   // 最多等 3 秒，等右栏画出来
    };
    put();
  }
  function putZText(text) {
    let tries = 0;
    const put = () => {
      const cell = railValueCell('Z 值坐标');
      if (cell) { cell.textContent = text; return; }
      if (tries++ < 30) setTimeout(put, 100);
    };
    put();
  }
  const tick = setInterval(() => {
    const cell = railValueCell('几何类型');
    if (!cell) return;                          // 右栏还没画好，这一拍先跳过，别把钟停了
    cell.textContent = label + '（已统计 ' + Math.round((Date.now() - started) / 1000) + ' 秒）';
  }, 1000);
  fetch('/api/geomtypes?path=' + encodeURIComponent(target) + '&layer=' + layerIndex)
    .then((r) => r.json())
    .then((res) => {
      clearInterval(tick);
      if (!res || !res.ok) {
        delete geomTypeAsked[key];      // 允许下次重画再试
        putText((res && res.error && res.error.title) || '统计没成功');
        return;
      }
      // 服务端给好的成品文本（已按基础类型归并、Z 值单独汇总），直接用
      const text = res.counts_text ||
        (res.types || []).map((t) => t.label + ' ' + num(t.count)).join(' · ') ||
        '类型混合';
      geomTypeText[key] = text;              // 本会话再打开同一个文件直接用
      primary.geometry_counts_text = text;   // 重画右栏时也直接复用
      if (res.has_z !== undefined && primary.has_z !== res.has_z) {
        // 图层声明报不出 Z 的情况（CAD 混合类型常报 Unknown）：
        // 逐要素数出来有就是有，顺手把"Z 值坐标"那行改过来
        primary.has_z = res.has_z;
        putZText(res.has_z ? '有' : '无');
      }
      putText(text);
    })
    .catch(() => {
      clearInterval(tick);
      delete geomTypeAsked[key];
      putText('统计没成功，重新打开这个文件再试');
    });
}

function railTileset(rail, d) {
  const zooms = d.zooms || [];
  rail.sec('切片');
  rail.many([
    ['组织方式', '瓦片金字塔 ' + (d.scheme || 'z/x/y') + '，后缀 ' + (d.tile_ext || '')],
    ['缩放级别', zooms.length ? zooms[0] + ' ~ ' + zooms[zooms.length - 1] +
      '（共 ' + zooms.length + ' 级：' + zooms.join('、') + '）' : null],
    ['瓦片总数', count(d.tile_count)],
    ['单张大小', d.tile_bytes_sample ? bytes(d.tile_bytes_sample) : null],
  ]);
  rail.sec('空间');
  rail.many(extentRows(null, d.extent_wgs84));
  rail.sec('属性');
  if (d.layers && d.layers.length) {
    const s = d.sample_tile || {};
    rail.node(tileLayerTable(d.layers));
    rail.row('取样', '第 ' + s.z + ' 级第 ' + s.x + ',' + s.y + ' 张');
  }
}

function railArchive(rail, d) {
  const members = (d.layers || []).filter((l) => l.ok !== false);
  (d.layers || []).forEach((layer) => {
    if (layer.ok === false) {
      rail.node(notice('error', (layer.member || '包内文件') + '：' + layer.error.title,
        layer.error.detail, layer.error.hint));
      return;
    }
    // 一份数据时不必再标成员名，用这个软件的人看得懂下面就是包内那份数据
    if (members.length > 1) rail.sec(layer.member || '包内数据');
    if (layer.kind === 'raster') railRaster(rail, layer);
    else railVector(rail, layer);
  });
}

function railJson(rail, d) {
  rail.sec('内容');
  rail.many([
    ['结构', d.top_level],
    ['是否地理数据', d.is_geographic ? '是' : '否'],
    ['顶层字段', (d.keys || []).join('、')],
    ['条目数', d.item_count !== undefined ? count(d.item_count) : null],
    ['要素数', d.feature_count_estimate !== undefined ? count(d.feature_count_estimate) : null],
    ['说明', d.note],
    ['读取情况', d.parse_error],
  ]);
}

function sidecarText(side) {
  const missingReq = side.missing_required || [];
  const missingImp = side.missing_important || [];
  if (missingReq.length) return '缺少 ' + missingReq.join('、') + '，属性表可能读不出来';
  if (missingImp.length) return '缺少 ' + missingImp.map((m) => m.suffix + '（' + m.purpose + '）').join('、');
  return '齐全';
}

/* ---------- 主渲染 ---------- */

/* 上一条错误由打开入口（inspectPath/uploadFiles）在开始新一次读取时收掉；
   这里不能再收——"已开图层 + 新文件打不开"的回滚也走这个函数，
   在这儿收会把刚弹出来的错误卡片又立刻抹掉 */
async function renderResult(data, path, opts) {
  /* notes：这次渲染要不要把文件自带的提示/警告弹出来。打开新文件要，重新渲染
     （切波段、改单位、打不开时回滚到上一个文件）不要——同一条提示用户已经看过一遍 */
  renderRail(data, !(opts && opts.quiet));
  if (window.GisMap) GisMap.closePopup();   // 换文件时上一个识别弹窗别留着

  if (!data.ok) {
    const err = data.error || {};
    renderError(err.title || '读取失败', err.detail, err.hint);
    return;
  }

  $('empty').hidden = true;
  $('panels').hidden = false;
  attrAuto = (data.kind === 'vector' || data.kind === 'archive') && !stackedStage();
  attrLayer = 0;
  attrCache = {};   // 换了文件，属性表的缓存全部作废
  attrShown = null;

  setChip(data);
  // 缓存命中时耗时是 0，dur() 会返回空；直接说"缓存命中"比留白清楚
  if (window.GisMap) GisMap.setElapsed(data.cached ? '缓存命中' : dur(data.elapsed_ms));
  /* DWG 这类"先转换成 DXF 再读取"的说明走浮层卡片：它是对这次打开的一条提醒，
     看一眼知道就行，不放在信息栏里长期占一行（re-render 时也不会重复弹） */
  if (data.conversion) {
    showErrToast('转换后读取' +
      (data.conversion.version ? '（' + data.conversion.version + ' 格式）' : ''),
      data.conversion.note);
  }

  /* deferMap：快速打开的大矢量先不画地图——这时还没有范围，取数会按当前视野过滤，
     十有八九取回来 0 个，而且永远等不到自动聚焦。等全量检查（带范围）到了再画 */
  if (opts && opts.deferMap) return;
  if (window.GisMap) GisMap.clear();
  if (data.kind === 'raster' && !data.multi_variable) await setupRaster(data);
  else resetRasterView();
  // 地图聚焦时要把即将弹出的属性表高度让出来（drawVector 里读这个标志）
  data.reserveAttr = attrAuto;
  if (window.GisMap) GisMap.setDrawLimit(config.draw_limit || 5000);
  if (window.GisMap) GisMap.show(data);
}

/* 右栏那张长表：单位写法之类的设置一改，只重画这一块，地图不动 */
function renderRail(data, notes) {
  const rail = newRail();
  const f = (data && data.file) || {};
  const path = (current && current.path) || '';
  rail.head(f.name || path || '数据');
  unfoldPanels();

  if (!data || !data.ok) { rail.render($('rail')); return; }

  if (data.kind === 'raster') railRaster(rail, data);
  else if (data.kind === 'vector') railVector(rail, data);
  else if (data.kind === 'tileset') railTileset(rail, data);
  else if (data.kind === 'archive') railArchive(rail, data);
  else if (data.kind === 'json') railJson(rail, data);
  else rail.row('格式', data.driver_label || '未知');
  if (notes) {
    if (data.kind === 'vector' && (data.layers || []).some((l) => l.error)) {
      data.layers.filter((l) => l.error).forEach((l) => {
        showErrToast('图层 ' + (l.name || '未命名') + ' 读取失败', l.error);
      });
    }
    /* 提示、警告一律走全局浮层：信息栏只放数据本身，不留说明性文字 */
    if (data.warning) showErrToast(data.warning, '', '', 'info');
    if (data.kind === 'vector' && (data.layers || [])[0] && data.layers[0].warning) {
      showErrToast(data.layers[0].warning, '', '', 'info');
    }
    if (data.kind === 'tileset') {
      showErrToast('这是切片缓存不是单一数据文件',
        '瓦片按视野需要逐张读取，已在地图上按级显示；要素的精确统计请回到原始矢量数据查看。');
    }
  }
  rail.render($('rail'));
}

/* 文件级的信息只在这里出现一次，右栏不再重复一遍 */
/* ---------- 图层切换：文件信息标题就是入口 ---------- */

let layerItems = [];
let layerActive = 0;

function chipBaseName() {
  const d = current && current.data;
  return (d && d.file && d.file.name) || '数据';
}

function hideLayerPop() {
  const pop = $('layerPop');
  const btn = $('chipLayerBtn');
  if (pop) pop.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function paintChipTitle() {
  const btn = $('chipLayerBtn');
  const name = $('chipName');
  if (!btn || !name) return;
  const sub = $('chipSub');
  const active = layerItems[layerActive];
  const multi = layerItems.length > 1;
  /* 多图层：大字是正在看的图层名（这才是画面上的主角），
     小字写它从哪来（文件 · 第几层）；单文件还是原来的一行文件名 */
  if (multi && active) {
    name.textContent = active.label || chipBaseName();
    if (sub) {
      sub.textContent = chipBaseName() + ' · 第 ' + (layerActive + 1) + '/' + layerItems.length + ' 层';
      sub.hidden = false;
    }
  } else {
    name.textContent = chipBaseName();
    if (sub) {
      sub.textContent = '';
      sub.hidden = true;
    }
  }
  btn.classList.toggle('no-switch', !multi);
  const layerTip = multi
    ? '切换图层（当前：' + (active.label || '') + '）'
    : '这份文件只有一个可以画到地图上的图层';
  btn.setAttribute('data-tip', layerTip);
  btn.setAttribute('aria-label', layerTip);
}

function showLayerPop() {
  const pop = $('layerPop');
  const btn = $('chipLayerBtn');
  const stage = document.querySelector('.map-stage');
  if (!pop || !btn || !stage || layerItems.length < 2) return;
  pop.textContent = '';
  layerItems.forEach((it, i) => {
    const b = el('button', i === layerActive ? 'on' : '');
    b.type = 'button';
    b.setAttribute('data-tip', it.full || it.label || '');
    b.setAttribute('aria-label', it.full || it.label || '');
    setSVG(b, '<svg class="lp-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2 6.2l2.6 2.6L10 3.4"/></svg>');
    b.appendChild(el('span', null, it.full || it.label || ('图层 ' + (i + 1))));
    b.addEventListener('click', () => {
      hideLayerPop();
      if (window.GisMap) window.GisMap.selectLayer(i);
    });
    pop.appendChild(b);
  });
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const w = pop.offsetWidth;
  let left = r.left - sr.left;
  if (left + w > sr.width - 6) left = Math.max(6, sr.width - w - 6);
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom - sr.top + 4) + 'px';
  btn.setAttribute('aria-expanded', 'true');
}

function applyLayerState(d) {
  layerItems = (d && d.items) || [];
  layerActive = Math.max(0, Number(d && d.active) || 0);
  paintChipTitle();
  hideLayerPop();
  const item = layerItems[layerActive];
  if (!item) return;
  /* 属性和地图共用一次选择：切到哪一层，属性表也跟着切到那一层的表 */
  if (item.kind === 'vector') {
    const layers = attrLayers();
    let at = -1;
    layers.forEach((L, i) => {
      if ((L.target + '\u0000' + L.index) === item.key) at = i;
    });
    if (at >= 0 && at !== attrLayer) {
      attrLayer = at;
      if (attrOpen()) refreshAttr();
    }
  } else if (item.kind === 'raster' && attrOpen()) {
    closeAttr();
  }
}

function setChip(d) {
  const chip = $('fileChip');
  if (!d) { chip.hidden = true; hideLayerPop(); return; }
  layerItems = [];
  layerActive = 0;
  const f = d.file || {};
  const kindLabel = { archive: '压缩包', json: 'JSON 文本' };
  const rows = [
    [f.is_dir ? '总大小' : '大小', f.size_label],
    ['格式', d.driver_label || kindLabel[d.kind] || '未知'],
    ['修改时间', f.modified],
  ];
  if (f.is_dir) rows.push(['内含文件', count(f.item_count) + ' 个']);
  if (d.kind === 'vector') {
    rows.push(['图层数', count(d.layer_count) + (d.layers_truncated ? '（仅显示前 ' + (d.layer_limit || 60) + ' 层）' : '')],
      ['要素总数', count(d.feature_count_total)]);
  }
  if (d.kind === 'archive') {
    rows.push(['成员数', d.member_count], ['解压后大小', d.uncompressed_label]);
  }
  if (d.opened_from) rows.push(['来自文件夹', d.opened_from]);
  if (d.sidecars) rows.push(['伴生文件', sidecarText(d.sidecars)]);

  const body = $('chipBody');
  body.textContent = '';
  const table = el('table', 'chip-table');
  const tb = el('tbody');
  rows.forEach((pair) => {
    if (pair[1] === null || pair[1] === undefined || pair[1] === '') return;
    const tr = el('tr');
    tr.appendChild(el('th', null, pair[0]));
    tr.appendChild(el('td', null, String(pair[1])));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  body.appendChild(table);
  if (f.path) {
    const p = el('div', 'chip-path', f.path);
    body.appendChild(p);
  } else if (f.temp_copy || d.temp_copy) {
    body.appendChild(el('div', 'chip-path', '网页版读不到拖进来文件的原始位置，先复制了一份临时副本，退出即删'));
  }
  paintChipTitle();
  chip.hidden = false;
}

/* ---------- 波段显示：图例、值分布和影像样式共用同一份分级 ---------- */

let raster = null;
/* 图层带属性时打开文件就自动展开属性表，用户手动关过就不再自动弹 */
let attrAuto = false;

/* 与样式里的断点一致：窄到这个宽度，舞台是"地图在上、信息栏在下"的竖排。
   竖排时地图本来就不高，再弹一张 260 起高的属性表就把它压没了，所以不自动开 */
function stackedStage() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 1120px)').matches);
}

function resetRasterView() {
  raster = null;
  $('histBtn').hidden = true;
  $('attrBtn').hidden = true;
  closeHist();
  closeAttr();
  hideLegend();
}

/* 加载指示：所有格式共用一个，文案跟着阶段走 */
function loadTip(on, text) {
  if (text) $('loadText').textContent = text;
  $('loadTip').hidden = !on;
  // 读文件的时候给地图蒙一层，免得看不清是"没数据"还是"还在读"
  document.querySelector('.map-stage').classList.toggle('busy', !!on);
}

/* DWG 要先转 DXF；正常几十毫秒，超大图纸可能几十秒。转换期间显示已用时间，
   并允许取消（取消会杀掉 dwg2dxf，而不是只把界面关掉）。 */
let dwgWatchTimer = 0;
let dwgWatchPath = '';
let openAbort = null;

function stopDwgWatch() {
  if (dwgWatchTimer) clearInterval(dwgWatchTimer);
  dwgWatchTimer = 0;
  dwgWatchPath = '';
  $('loadBar').hidden = true;
  $('loadCancel').hidden = true;
}

function startDwgWatch(path) {
  stopDwgWatch();
  dwgWatchPath = path;
  const tick = async () => {
    if (!dwgWatchPath) return;
    try {
      const res = await fetch('/api/dwg/status?path=' + encodeURIComponent(path));
      const st = await res.json();
      if (!st.running || !dwgWatchPath) return;
      $('loadBar').hidden = false;
      $('loadCancel').hidden = false;
      $('loadText').textContent = '正在转换 DWG… ' + Math.max(0, Math.round(st.elapsed)) + ' 秒';
    } catch { /* 状态轮询失败不打断打开流程 */ }
  };
  tick();
  dwgWatchTimer = setInterval(tick, 500);
}

async function cancelDwgWatch() {
  const path = dwgWatchPath;
  if (!path) return;
  stopDwgWatch();
  try {
    await fetch('/api/dwg/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch { /* 服务已退出也当取消成功 */ }
  if (openAbort) openAbort.abort();
  loadTip(false);
}
$('loadCancel').addEventListener('click', () => { if (pyrPath) cancelPyramid(); else cancelDwgWatch(); });

/* 首屏先把配色算完再画，避免先出一帧灰图再跳成彩色 */
async function setupRaster(d) {
  const path = d.read_path || (d.file || {}).path;
  const total = d.band_count || (d.bands || []).length || 1;
  if (!path) { resetRasterView(); return; }
  raster = { path, count: total, cache: {}, band: null, style: null };
  const choice = (total >= 3 && config.raster_default !== 'single') ? 'rgb' : 1;
  raster.band = choice;
  buildBandSelector();
  $('histBtn').hidden = choice === 'rgb';
  if (choice === 'rgb') {
    renderLegend(null);
  } else {
    loadTip(true, '正在准备影像配色…');
    const res = await loadBandStats(1);
    if (res) raster.style = styleOf(res);
    renderLegend(res);
  }
  d.style = raster.style;
  /* 单波段首屏要算一遍值分布，等待期间挂过指示。正常打开时遮罩流程（veilHold）
     负责收；回滚重画没有那一层，这里自己收，不然它会一直转下去 */
  if (!veilHold) loadTip(false);
}

function bandLabel(v) {
  return v === 'rgb' ? '三波段合成' : '波段' + v;
}

function buildBandSelector() {
  const sel = $('legendBand');
  sel.textContent = '';
  if (raster.count >= 3) sel.appendChild(new Option('三波段合成', 'rgb'));
  for (let i = 1; i <= raster.count; i++) sel.appendChild(new Option(bandLabel(i), String(i)));
  sel.value = String(raster.band);
  sel.onchange = () => selectBand(sel.value === 'rgb' ? 'rgb' : Number(sel.value));
  if (window.syncSelect) window.syncSelect(sel);
}

async function selectBand(choice, force) {
  if (!raster || (!force && raster.band === choice)) return;
  raster.band = choice;
  // 波段可能是代码切过来的，下拉框得跟着走，不然显示的和画出来的不是一回事
  const sel = $('legendBand');
  if (sel.value !== String(choice)) {
    sel.value = String(choice);
    if (window.syncSelect) window.syncSelect(sel);
  }
  paintHistTitle();
  $('histBtn').hidden = choice === 'rgb';
  if (choice === 'rgb') {
    renderLegend(null);
    GisMap.restyle({ band: null, bands: 3, edges: null, colors: null, scheme: null });
    return;
  }
  renderLegendLoading();
  loadTip(true);
  const res = await loadBandStats(Number(choice));
  if (!res || raster.band !== choice) { loadTip(false); return; }
  applyBandStyle(res);
}

async function loadBandStats(index) {
  if (raster.cache[index]) return raster.cache[index];
  let res;
  try {
    res = await fetch('/api/histogram?path=' + encodeURIComponent(raster.path) + '&band=' + index);
    res = await res.json();
  } catch (err) {
    renderLegendError('值分布读取失败：' + err.message);
    return null;
  }
  if (!res.ok) {
    renderLegendError((res.error && res.error.title) || '值分布计算失败');
    return null;
  }
  raster.cache[index] = res;
  // 值分布里还藏着中位数这类文件里没存着的统计项，算出来顺手补进信息栏
  if (mergeHistStats(res)) renderRail(current.data);
  return res;
}

/* 从分箱计数里数出中位数；整数栅格是逐值分箱，还能数出不同取值的种数 */
function medianOfHist(h) {
  const counts = h.counts || [];
  let total = 0;
  counts.forEach((c) => { total += c; });
  if (!total) return null;
  const half = total / 2;
  const lo = Number(h.min);
  const w = Number(h.bin_width) || 0;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    acc += counts[i];
    if (acc >= half) {
      // 逐值分箱时箱左缘就是这个值；普通分箱取区间中点
      return h.per_value_bins ? lo + i * w : lo + (i + 0.5) * w;
    }
  }
  return null;
}

function mergeHistStats(res) {
  const d = current && current.data;
  const h = res && res.histogram;
  if (!h || !d || d.kind !== 'raster' || d.multi_variable || res.band !== 1) return false;
  const band0 = (d.bands || [])[0];
  const st = band0 && band0.index === 1 ? band0.statistics : null;
  if (!st) return false;
  let changed = false;
  if (st.median === null || st.median === undefined) {
    const m = medianOfHist(h);
    if (m !== null && Number.isFinite(m)) { st.median = m; changed = true; }
  }
  if ((st.unique_count === null || st.unique_count === undefined) && h.per_value_bins) {
    st.unique_count = (h.counts || []).filter((c) => c > 0).length;
    changed = true;
  }
  if ((st.nodata_count === null || st.nodata_count === undefined) &&
      d.pixels && h.valid_percent !== null && h.valid_percent !== undefined) {
    const n = Math.round(d.pixels * (1 - h.valid_percent / 100));
    if (n > 0) { st.nodata_count = n; changed = true; }
  }
  return changed;
}

/* 分级界值和颜色：图例、影像出图共用这一份。
   fill 只是给影像 URL 用的记号，让"无数据处"一改就绕开浏览器缓存 */
function styleOf(res) {
  const fill = config.nodata_view || 'transparent';
  if (res.discrete) {
    return {
      band: res.band, edges: res.discrete.edges, colors: res.discrete.colors,
      scheme: '调色板分类', fill: fill,
    };
  }
  const items = res.classes || [];
  if (!items.length) return { band: res.band, edges: null, colors: null, scheme: null, fill: fill };
  return {
    band: res.band,
    edges: [items[0].lo].concat(items.map((c) => c.hi)),
    colors: items.map((c) => c.color),
    scheme: null,
    fill: fill,
  };
}

function applyBandStyle(res) {
  const style = styleOf(res);
  raster.style = style;
  GisMap.restyle(style);
  renderLegend(res);
  fillHistogram(res);
  loadTip(false);
}

function paintHistTitle() {
  // 标题就是纯文本：切波段用图例那颗下拉（两处下拉重复，留一处就够）
  $('histTitle').textContent = bandLabel(raster ? raster.band : 1);
}

function fillHistogram(res) {
  paintHistTitle();
  if (!res || !res.histogram) {
    // 三波段合成没有单一值分布：说清楚为什么是空的，别留个空白气泡
    $('histBody').textContent = '';
    $('histNote').textContent = '三波段合成没有值分布，切到单个波段可看';
    return;
  }
  const hist = res.histogram || {};
  const phys = physOfBand(res.band);
  $('histBody').textContent = '';
  $('histBody').appendChild(drawHistogram(hist, phys));
  $('histNote').textContent = hist.source_label + ' · ' + hist.bins + ' 个分箱' +
    (phys && phys.unit ? ' · 单位 ' + phys.unit : '');
}

/* 当前文件里某个波段的换算关系（缩放/偏移/单位）。波段对不上时退回第一个：
   三波段合成这类情况也给个能用的，不至于整段读数为空 */
function physOfBand(index) {
  const d = current && current.data;
  if (!d || d.kind !== 'raster') return null;
  const bands = d.bands || [];
  if (!bands.length) return null;
  const hit = bands.find((b) => b.index === index);
  return bandPhys(hit || (raster ? bands.find((b) => b.index === raster.band) : bands[0]));
}

/* 线性刻度：0 到峰值四等分，档距取整到 1/2/5×10^n。
   对数轴的标签会全挤在顶上（1/2/5 之间差一个数量级），直方图要看的是相对高低，线性才对 */
function linTicks(peak, parts) {
  const n = parts || 4;
  if (!(peak > 0)) return [0, 1];
  const raw = peak / n;
  const mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  const k = raw / mag;
  const step = (k >= 5 ? 5 : k >= 2 ? 2 : 1) * mag;
  const list = [];
  for (let i = 0; i <= n; i++) list.push(step * i);
  return list;
}


/* 刻度数字太长就换成万/亿，单位写在轴标题里，不跟着每个刻度重复 */
function tickUnit(top) {
  if (top >= 1e8) return [1e8, '亿'];
  if (top >= 1e4) return [1e4, '万'];
  return [1, ''];
}

let histChart = null;
let _histLast = null;   // 换主题时照着这份数据重画一次

function destroyHistChart() {
  if (histChart) { histChart.destroy(); histChart = null; }
}

function drawHistogram(hist, phys) {
  const wrap = el('div', 'hist-canvas');
  const counts = (hist && hist.counts) || [];
  if (!counts.length) return wrap;
  const peak = Math.max.apply(null, counts.concat([1]));
  const unit = tickUnit(peak);
  // 先按万/亿缩一遍再取整，刻度才是 0 2.5 5 7.5 10 这样均匀的一串
  const ticks = linTicks(peak / unit[0]);
  const top = ticks[ticks.length - 1] || 1;
  const shown = (v) => String(Math.round(v * 10) / 10);
  const lo = Number(hist.min);
  const step = Number(hist.bin_width) || 0;
  /* 横轴刻度跟着信息栏那份换算走：一边显示 0.001~0.598、一边显示 1~598 会让人以为看了两份数据 */
  const on = !!(phys && phys.on);
  const pd = physDigits(phys);
  const at = (v) => (on ? physVal(phys, v) : v);
  const xd = on ? pd : (step >= 1 ? 0 : 3);
  const labels = counts.map((c, i) => num(at(lo + i * step), xd));
  const rs = getComputedStyle(document.documentElement);
  const bar = (rs.getPropertyValue('--bar') || '').trim() || '#4b8ec4';
  const dim = (rs.getPropertyValue('--text-dim') || '').trim() || '#777';
  const grid = (rs.getPropertyValue('--line') || '').trim() || 'rgba(0,0,0,.1)';

  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  destroyHistChart();
  const tipBg = (rs.getPropertyValue('--panel') || '').trim() || '#fff';
  const tipTx = (rs.getPropertyValue('--text') || '').trim() || '#222';
  histChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: counts.map((c) => c / unit[0]),
        backgroundColor: bar,
        hoverBackgroundColor: bar,
        borderWidth: 0,
        barPercentage: 1,
        categoryPercentage: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 0, right: 4, bottom: 0, left: 0 } },
      scales: {
        x: {
          grid: { display: false },
          border: { color: grid },
          // 标签再贴近轴线一点，给绘图区多留高度
          ticks: { maxTicksLimit: 6, color: dim, font: { size: 13 }, autoSkip: true, padding: 0 },
        },
        y: {
          beginAtZero: true,
          max: top,
          grid: { color: grid, drawTicks: false },
          border: { display: false },
          ticks: {
            stepSize: top / 4, color: dim, font: { size: 13 }, padding: 2,
            callback: (v) => shown(v),
          },
          // 轴标题竖着写在轴左侧，不占顶上那条位置
          title: {
            display: true,
            text: '像元数' + (unit[1] ? '（' + unit[1] + '）' : ''),
            color: dim,
            font: { size: 13 },
            padding: { top: 0, bottom: 0 },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          // 气泡跟着主题走：浅色底上不再是默认那块深灰
          backgroundColor: tipBg,
          titleColor: tipTx,
          bodyColor: tipTx,
          borderColor: grid,
          borderWidth: 1,
          cornerRadius: 6,
          padding: 8,
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              const a = lo + i * step;
              const d = on ? pd : 4;
              return num(at(a), d) + ' ~ ' + num(at(a + step), d);
            },
            label: (ctx) => count(counts[ctx.dataIndex]) + ' 像元',
          },
        },
      },
    },
  });
  _histLast = hist;
  return wrap;
}

function legendBody(open) {
  const body = $('legendBody');
  body.textContent = '';
  $('legend').hidden = !open;
  syncMapHeight();   // 图例一露头就要重算能长多高：藏着的时候量不到它自己的那一截
  return body;
}

function legendRow(color, text) {
  const row = el('div', 'legend-row');
  const sw = el('i', 'legend-swatch');
  sw.style.background = color;
  row.appendChild(sw);
  row.appendChild(el('span', 'legend-val', text));
  return row;
}

function legendBlank(text) {
  legendBody(true).appendChild(el('div', 'legend-blank', text));
}

function renderLegendLoading() {
  legendBlank('正在逐像元统计值分布…');
}

function renderLegendError(msg) {
  legendBlank(msg);
}

function renderLegend(res) {
  if (!res) {
    legendBlank('三波段合成没有分级图例，切到单个波段可看');
    return;
  }
  // 分级界值跟着信息栏换算，与直方图横轴同一套数
  const phys = physOfBand(res.band);
  const digits = physDigits(phys);
  const at = (v) => physVal(phys, v);
  if (res.discrete) {
    const table = res.discrete;
    const body = legendBody(true);
    (table.colors || []).forEach((color, i) => {
      const v = table.edges[i] === undefined ? i : table.edges[i];
      body.appendChild(legendRow(color, phys && phys.on
        ? num(at(v), digits) : String(Math.round(v))));
    });
    return;
  }
  const items = res.classes || [];
  if (!items.length) {
    legendBlank('值域过窄 · 不分级显示');
    return;
  }
  const body = legendBody(true);
  items.forEach((c) => body.appendChild(legendRow(c.color,
    num(at(c.lo), digits) + ' ~ ' + num(at(c.hi), digits))));
}

function hideLegend() {
  legendBody(false);
}

/* ---------- 属性表：浮在地图里的一块，字段多时横向滚动，往下滚自动续读 ---------- */

let attrLayer = 0;     // 图层下拉里选中的项
let attrCol = -1;      // 选中的列（0 是行号列），Ctrl+C 复制它
let localCoords = false;  // 当前图层是不是本地坐标（多为 CAD），底部读数跟着换显示
let attrShown = null;  // 当前正显示的那份缓存
let attrCache = {};    // 键：路径+图层序号。收起再打开直接从这份里画，不再问服务端

function attrOpen() {
  return !$('attrPanel').hidden;
}

/* 开合是两段动画：展开时先建元素再撤 .shrunk，收起时先加 .shrunk 再延时藏。
   收起那段如果只看"定时器到点时还有没有 .shrunk"，会踩到一个坑：切图层的瞬间
   先 closeAttr() 再 showAttr(true)，可主线程正忙着画新图层，请求到的两帧回调迟迟
   不跑，.shrunk 还在，定时器到点就把刚打开的面板又藏了——而 attr-on 已经加上，
   于是位置组件往上让了位、属性表却不见。改成记住"现在到底开着没有"，
   定时器到点只看这个状态 */
let attrWantOpen = false;
let attrHideTimer = 0;

function showAttr(on) {
  const panel = $('attrPanel');
  const stage = document.querySelector('.map-stage');
  attrWantOpen = on;
  $('attrBtn').classList.toggle('on', on);
  $('attrBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
  if (on) {
    clearTimeout(attrHideTimer);
    if (stage) stage.classList.add('attr-on');
    panel.hidden = false;
    panel.classList.add('shrunk');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (attrWantOpen) panel.classList.remove('shrunk');
    }));
    return;
  }
  if (panel.hidden) {
    /* 已经收着了：顺手把残留的 attr-on 清掉，别让地图上的位置组件一直悬在半空 */
    if (stage) stage.classList.remove('attr-on');
    clearTimeout(attrHideTimer);
    return;
  }
  panel.classList.add('shrunk');
  if (stage) stage.classList.remove('attr-on');
  clearTimeout(attrHideTimer);
  attrHideTimer = setTimeout(() => {
    if (!attrWantOpen) panel.hidden = true;
  }, 200);
}

/* 收起只是藏起来：缓存不动，再打开是瞬时的 */
function closeAttr() {
  showAttr(false);
  attrCol = -1;
  // 表收起来了，那一行的定位标记也就没意义了；地图上的高亮留着不动
  markLocateRow(null);
}

/* 这份文件里所有能画到地图上的矢量图层（压缩包成员也算一层） */
function attrLayers() {
  const d = (current && current.data) || {};
  const out = [];
  if (d.kind === 'vector') {
    const path = d.read_path || (d.file || {}).path;
    (d.layers || []).forEach((L, i) => {
      if (L.has_geometry === false) return;
      out.push({ index: i, target: path, name: L.name || ('图层 ' + (i + 1)), fields: L.fields || [] });
    });
  } else if (d.kind === 'archive') {
    const members = (d.layers || []).filter((p) => (p.layers || []).some((L) => L.has_geometry !== false));
    let total = 0;
    members.forEach((p) => { total += (p.layers || []).filter((L) => L.has_geometry !== false).length; });
    members.forEach((p) => {
      const file = String(p.member || '').split('/').pop();
      (p.layers || []).forEach((L, i) => {
        if (L.has_geometry === false) return;
        const name = L.name || ('图层 ' + (i + 1));
        out.push({
          index: i, target: p.read_path, fields: L.fields || [], name: name,
          tab: total > 1 ? file + ' · ' + name : file,
        });
      });
    });
  }
  return out;
}

/* 一行能取多少条：设置里的那个数就是翻页大小 */
function pageSize() {
  return Math.max(20, Number(config.max_features) || 500);
}

function attrKeyOf(L) {
  return L.target + '\u0000' + L.index;
}

/* 属性表里的提示统一走全局浮层：面板里另挂一条小气泡时，
   字号、位置、停留时间都跟全局提示不一致，同一件事在两处出现还容易看漏 */
function attrToast(text, sticky) {
  showErrToast(text, null, null, 'info', sticky);
}

/* 表头那格：字段名 + 类型宽度；悬停时气泡解释类型和长度的含义 */
function kindText(f) {
  return [f.type_label || f.type, f.width || null]
    .filter((v) => v !== null && v !== '').join(' · ');
}

/* 字段类型的说明：把引擎读到的类型名对上 GIS 里的通用叫法，不说"小数型"这种含糊话 */
function typeExplain(f) {
  const t = String(f.type || '');
  const w = f.width ? Number(f.width) : 0;
  const p = f.precision ? Number(f.precision) : 0;
  if (t.indexOf('StringList') === 0) return '文本列表（StringList）：一个字段里存多段文字';
  if (t.indexOf('String') === 0 || t === 'WideString') {
    return '文本（String）：存名称、编号、备注这类文字内容。' +
      (w ? '每个值最多 ' + w + ' 个字符，超出即截断' : '长度上限由数据源定义');
  }
  if (t.indexOf('IntegerList') === 0) return '整数列表（IntegerList）：一个字段里存一组整数';
  if (t.indexOf('RealList') === 0) return '浮点列表（RealList）：一个字段里存一组带小数点的数值';
  if (t === 'Integer') {
    return '整数（Integer，32 位）：不含小数位，常用于编号、计数、年份。' +
      (w ? '最多 ' + w + ' 位数字' : '取值范围约 ±21.5 亿');
  }
  if (t === 'Integer64') {
    return '长整数（Integer64，64 位）：取值范围远大于 32 位整数' +
      (w ? '，最多 ' + w + ' 位数字' : '') + '，常用于大编号与时间戳';
  }
  if (t === 'Real') {
    return '双精度浮点（Real，即 Double）：存带小数点的连续数值，如面积、人口、降水量。' +
      (p ? '小数位 ' + p + ' 位' : '按双精度存储，约 15 位有效数字');
  }
  if (t === 'Date') return '日期（Date）：只记年月日，不含时刻';
  if (t === 'DateTime') return '日期时间（DateTime）：年月日与时刻一起记';
  if (t === 'Time') return '时间（Time）：只记时刻，不含日期';
  if (t.indexOf('Binary') === 0) return '二进制（Binary）：存字节流，如图片、附件，表格里读不出内容';
  return t ? '存储类型：' + t : '';
}

function copyText(text, note) {
  const done = () => attrToast(note || '已复制');
  /* 窗口没有焦点时 clipboard.writeText 可能既不成功也不报错（一直挂着），
     所以 600 毫秒没结果就退回 execCommand，别让"已复制"永远等不到 */
  if (navigator.clipboard && navigator.clipboard.writeText && document.hasFocus()) {
    let settled = false;
    navigator.clipboard.writeText(text).then(() => { settled = true; done(); },
      () => { settled = true; fallbackCopy(text, done); });
    setTimeout(() => { if (!settled) fallbackCopy(text, done); }, 600);
    return;
  }
  fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* 复制不了就给个安静的结果 */ }
  document.body.removeChild(ta);
  done();
}

const COPY_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2"/><path d="M5.2 15.6V6.6a1.6 1.6 0 0 1 1.6-1.6h9"/></svg>';

/* 复制整列：把没加载的那些行也取回来再复制。
   之前只复制已展示的部分——1000 行只加载了 500 行时，复制出来就只有 500 行。
   补数据走 /api/column：只取这一列，不碰几何，10 万行几秒就回来 */
function copyAttrCol(c, colIdx) {
  const keys = c.keys || [];
  const loaded = c.rows || [];
  const total = Number(c.total) || loaded.length;
  const key = colIdx === 0 ? null : keys[colIdx - 1];
  if (colIdx !== 0 && key === undefined) return;
  const emit = (values) => {
    if (key === null) {
      const lines = ['行号'];
      values.forEach((v, i) => lines.push(String(i + 1)));
      copyText(lines.join('\n'), '已复制行号列 ' + values.length + ' 行');
      return;
    }
    const lines = [key];
    values.forEach((v) => lines.push(valText(v)));
    copyText(lines.join('\n'), '已复制「' + key + '」列 ' + values.length + ' 行');
  };
  const loadedValues = key === null ? loaded : loaded.map((props) => props[key]);
  if (loaded.length >= total || !c.target || !key) { emit(loadedValues); return; }
  attrToast('正在读取整列 ' + total + ' 行，稍等…', true);
  const url = '/api/column?path=' + encodeURIComponent(c.target) + '&layer=' + c.index +
    '&field=' + encodeURIComponent(key);
  fetch(url).then((r) => r.json()).then((res) => {
    if (!res.ok) { attrToast((res.error && res.error.title) || '整列读取失败'); return; }
    emit(res.values || []);
  }).catch(() => attrToast('整列读取失败'));
}

/* 表头点一下选中整列；再点一下取消。复制走 Ctrl+C 或列上的复制图标 */
function selectAttrCol(c, idx) {
  const t = c.table;
  if (!t) return;
  t.querySelectorAll('.col-sel').forEach((n) => n.classList.remove('col-sel'));
  if (attrCol === idx) { attrCol = -1; return; }
  attrCol = idx;
  t.querySelectorAll('tr').forEach((tr) => {
    const cell = tr.children[idx];
    if (cell && cell.colSpan === 1) cell.classList.add('col-sel');
  });
}

let attrResizing = false;

function bindAttrResize(c, th) {
  const handle = th.querySelector('.attr-rsz');
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try { handle.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有真实指针，忽略 */ }
    attrResizing = true;
    const startX = ev.clientX;
    const startW = th.getBoundingClientRect().width;
    th.classList.add('resizing');
    const move = (e) => {
      const w = Math.max(56, Math.round(startW + (e.clientX - startX)));
      const cols = c.table.querySelectorAll('colgroup col');
      if (cols[th.cellIndex]) cols[th.cellIndex].style.width = w + 'px';
    };
    const up = () => {
      attrResizing = false;
      th.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/* 没字段信息时，从第一页行数据里认列名 */
function keysFromRows(feats, layer) {
  const fromFields = ((layer && layer.fields) || []).map((f) => f.name);
  if (fromFields.length) return fromFields;
  const keys = [];
  feats.forEach((f) => {
    Object.keys(f.properties || {}).forEach((k) => { if (keys.indexOf(k) < 0) keys.push(k); });
  });
  return keys;
}

/* 搭出一张空表：列头、行号列、续读提示行；之后每页只往 tbody 里追加 */
function attrShell(c) {
  const table = el('table', 'attr-table');
  const cg = document.createElement('colgroup');
  cg.appendChild(el('col', 'col-idx'));
  c.keys.forEach(() => cg.appendChild(document.createElement('col')));
  table.appendChild(cg);

  const head = el('tr');
  head.appendChild(el('th', 'attr-idx', '#'));
  (c.fields || []).forEach((f) => {
    const th = el('th');
    th.appendChild(el('div', 'attr-col', f.name));
    const kind = kindText(f);
    if (kind) th.appendChild(el('div', 'attr-kind', kind));
    const tip = typeExplain(f);
    if (tip) { th.setAttribute('data-tip', tip); th.setAttribute('data-tip-dir', 'up'); }
    th.appendChild(el('i', 'attr-rsz'));
    const cp = el('button', 'attr-copy');
    cp.type = 'button';
    cp.setAttribute('data-tip', '复制整列');
    cp.setAttribute('aria-label', '复制整列');
    setSVG(cp, COPY_ICO);
    cp.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAttrCol(c, th.cellIndex);
    });
    th.appendChild(cp);
    bindAttrResize(c, th);
    head.appendChild(th);
  });
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const tb = el('tbody');
  table.appendChild(tb);
  /* 双击某一行定位到那个要素：整行就是入口，不用先选中 */
  tb.addEventListener('dblclick', (e) => {
    const tr = e.target && e.target.closest ? e.target.closest('tr') : null;
    if (!tr || tr.parentNode !== tb) return;
    /* 浏览器双击会顺手选中一个词，留下一条蓝底：这不是选词操作，立刻撤掉。
       真要复制单元格文字，按住拖动或点表头选整列都行 */
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
    markLocateRow(tr);
    locateAttrRow(c, Array.prototype.indexOf.call(tb.children, tr));
  });

  c.table = table;
  c.tbody = tb;
  c.built = true;

  const body = $('attrBody');
  body.textContent = '';
  body.appendChild(table);
  // 先把浏览器按内容排出来的默认列宽钉住，之后拖动改的就是这份
  requestAnimationFrame(() => {
    if (!c.built) return;
    const ths = table.querySelectorAll('thead th');
    const cols = table.querySelectorAll('colgroup col');
    if (!ths.length || ths.length !== cols.length) return;
    ths.forEach((th, i) => {
      cols[i].style.width = Math.round(th.getBoundingClientRect().width) + 'px';
    });
    table.classList.add('fixed');
  });
}

function appendAttrRows(c, feats) {
  const start = c.rows.length;
  const frag = document.createDocumentFragment();
  feats.forEach((f, i) => {
    const props = f.properties || {};
    const tr = el('tr');
    tr.appendChild(el('td', 'attr-idx', String(start + i + 1)));
    c.keys.forEach((k, ci) => {
      const td = el('td', null, valText(props[k]));
      if (td.textContent.length > 40) {
        td.setAttribute('data-tip', td.textContent);
        td.setAttribute('aria-label', td.textContent);
      }
      if (ci === attrCol - 1) td.classList.add('col-sel');
      tr.appendChild(td);
    });
    frag.appendChild(tr);
    c.rows.push(props);
    // 双击某一行要能定位回要素，得把要素号按行存着
    if (c.ids) c.ids[start + i] = f.fid === undefined ? null : f.fid;
    /* 要素范围也在取数时一并带回来（服务端读这一行时几何已经解析过，
       顺手取个包络几乎不花时间）。双击定位就不必再回原文件按编号找一遍——
       十万要素的 GeoJSON 上，那一下要扫好几秒 */
    if (c.boxes) c.boxes[start + i] = f.bbox || null;
  });
  c.tbody.appendChild(frag);
  applyAttrFind();   // 续读进来的新行也要跟着当前的查找条件
}

/* 查找：只筛已经加载进来的这些行（整层几万个要素不适合边滚边筛） */
function applyAttrFind() {
  const box = $('attrFind');
  const count = $('attrFindCount');
  const c = attrShown;
  if (!box) return;
  const q = box.value.trim().toLowerCase();
  if (!c || !c.tbody) { if (count) count.hidden = true; return; }
  const rows = Array.prototype.slice.call(c.tbody.children);
  if (!q) {
    rows.forEach((tr) => tr.classList.remove('find-off'));
    if (count) count.hidden = true;
    return;
  }
  let hit = 0;
  rows.forEach((tr) => {
    const on = String(tr.textContent).toLowerCase().indexOf(q) >= 0;
    tr.classList.toggle('find-off', !on);
    if (on) hit++;
  });
  if (count) { count.textContent = '命中 ' + hit + ' / ' + rows.length; count.hidden = false; }
}

/* 属性表双击定位的收尾：刚双击的那一行如果当时还没画出来，
   等地图画完这一批再弹一句"高亮好了"。中间又双击了别的行就只认最后一次 */
let locateFid = null;

/* 表里"正在定位的那一行"：和地图上的要素高亮同生同灭。
   地图那边每次换高亮都会发 gis:highlight，带着被描到的要素编号，
   这一行据此亮起或撤掉——点地图空白处、按 Esc 收弹窗，两边一起收 */
let locateRowEl = null;

function markLocateRow(tr) {
  const next = tr || null;
  if (locateRowEl === next) return;
  if (locateRowEl) locateRowEl.classList.remove('row-focus');
  locateRowEl = next;
  if (locateRowEl) locateRowEl.classList.add('row-focus');
}

/* 双击某一行：把地图框到这要素的范围上，再把它描一圈高亮。
   范围读表时就已经拿到了（服务端随行带回 bbox），这一下是瞬时的，
   不再为了一个包围盒回原文件按编号扫一遍——wuningGEP.json 十万要素，那一下要等七八秒。
   要素还没画出来时（绘制未完成、或超出单次绘制上限）先框住范围、用范围框代替高亮，
   绘制一结束自动补成要素高亮，不用再双击第二次 */
function locateAttrRow(c, i) {
  const fid = c && c.ids ? c.ids[i] : null;
  const box = c && c.boxes ? c.boxes[i] : null;
  if (!window.GisMap) return;
  if (!box) {
    attrToast(fid === null || fid === undefined ? '这一行定位不了' : '这一行没有可定位的几何范围');
    return;
  }
  locateFid = fid === null || fid === undefined ? null : Number(fid);
  const state = GisMap.focusFid(fid, box);
  if (state === 'none') { markLocateRow(null); attrToast('地图还没准备好，稍后再试'); return; }
  if (state === 'feature') { attrToast('已定位并高亮该要素'); return; }
  /* 要素不在已画出来的那批里：地图正往那儿去，画完由 gis:focus 收尾。
     这一条挂着不自动走——它说的是"正在进行"，不是"已经完成" */
  toastNote('正在定位到该要素', '地图正把视图移过去，画完会自动高亮', null, true);
}

function setAttrMore(c, busy) {
  const chip = $('attrLoad');
  if (chip) chip.hidden = !(busy && attrShown === c);
}

/* 键盘上的 shortcuts：Esc 一层层往回收，F 回全图，Ctrl+F 跳到属性表查找框。
   正在打字的时候除了 Esc 都不抢键 */
function wireQuickKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = !!(t && t.closest && t.closest('input, textarea, select, .combo'));
    const combo = comboOf(e);
    if (combo && combo === keyOf('key_close')) {
      if (!$('closeAsk').hidden) { hideCloseAsk(); toShell('closechoice:cancel'); return; }
      if (!$('updPop').hidden) { closeUpdPop(); return; }
      if (!$('recentPop').hidden) { hideRecent(); return; }
      if (!$('pickPop').hidden) { hidePickPop(); return; }
      if (!$('checkPop').hidden) { hideCheckPop(); return; }
      if (!$('convPop').hidden) { hideConvPop(); return; }
      if (!$('layerPop').hidden) { hideLayerPop(); return; }
      if (!$('settings').hidden) { $('cfgClose').click(); return; }
      if (!$('errToast').hidden) { hideErrToast(); return; }
      if (t === $('attrFind')) { $('attrFind').value = ''; applyAttrFind(); $('attrFind').blur(); return; }
      if (typing) return;
      if (window.GisMap && GisMap.closePopup()) return;
      return;   // 属性表不归 Esc 管：点右上角的 × 关，别让按键误伤
    }
    if (combo && combo === keyOf('key_find')) {
      e.preventDefault();
      if (!attrOpen()) { attrAuto = false; toggleAttr(); }
      const box = $('attrFind');
      if (box) { box.focus(); box.select(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (combo && combo === keyOf('key_fit')) {
      if (window.GisMap && GisMap.hasLayer && GisMap.hasLayer()) GisMap.fullExtent();
    }
  });
}

/* 整列选中的取消挂在整个属性表面板上：挂在表格上时，最后一行下面的空白属于表体容器、
   挂在表体上时，标题栏和抓手那两条又不在表体里——点这些地方同样该取消选中 */
function wireAttrBody() {
  $('attrPanel').addEventListener('click', (e) => {
    if (attrResizing) return;
    const c = attrShown;
    if (!c || !c.table) return;
    const th = e.target && e.target.closest ? e.target.closest('th') : null;
    if (!th || !c.table.contains(th)) {
      if (attrCol >= 0) selectAttrCol(c, attrCol);
      return;
    }
    if (e.target.closest('.attr-rsz') || e.target.closest('.attr-copy')) return;
    selectAttrCol(c, th.cellIndex);
  });
}

function failAttr(c) {
  if (attrShown !== c) return;
  setAttrMore(c, false);
  const body = $('attrBody');
  body.textContent = '';
  body.appendChild(el('div', 'attr-empty', c.error || '要素读取失败'));
}

/* 逐页取：不带视野范围，整层的要素按序读，避免"只有视野内"那种半截表 */
function loadAttrPage(c) {
  if (c.done || c.loading || c.error) return;
  c.loading = true;
  if (attrShown === c) setAttrMore(c, true);
  const n = pageSize();
  const url = '/api/vector?path=' + encodeURIComponent(c.target) + '&layer=' + c.index +
    '&limit=' + n + '&offset=' + c.rows.length + '&geom=0';
  const tok = c.tok;
  fetch(url).then((r) => r.json()).then((res) => {
    if (tok !== c.tok) return;   // 期间切过图层或换了文件
    c.loading = false;
    if (!res.ok) {
      c.error = (res.error && res.error.title) || '要素读取失败';
      failAttr(c);
      return;
    }
    const m = res.gisviewer || {};
    const got = res.features || [];
    if (m.deep_page && !got.length) {
      toastNote('翻页较慢', '这个格式没有空间索引，已在后台建索引；等几秒再翻会快很多。', '', false);
    }
    if (m.layer_total !== null && m.layer_total !== undefined) c.total = m.layer_total;
    if (!c.built) {
      if (!(c.keys && c.keys.length)) c.keys = keysFromRows(got, c.layer);
      if (!c.keys.length) {
        if (attrShown === c) {
          setAttrMore(c, false);
          const body = $('attrBody');
          body.textContent = '';
          body.appendChild(el('div', 'attr-empty', '这个图层没有可展示的属性字段'));
        }
        c.done = true;
        return;
      }
      attrShell(c);
    }
    appendAttrRows(c, got);
    c.done = !got.length || (c.total !== null && c.rows.length >= c.total) || got.length < n;
    if (attrShown === c) {
      setAttrMore(c, false);
      // 一页没铺满一屏就接着要，用户滚不动就触发不了下一页
      requestAnimationFrame(() => {
        const body = $('attrBody');
        if (attrShown === c && !c.done && body.scrollHeight <= body.clientHeight + 40) loadAttrPage(c);
      });
    }
  }).catch((err) => {
    if (tok !== c.tok) return;
    c.loading = false;
    c.error = '要素读取失败：' + err.message;
    failAttr(c);
  });
}

function refreshAttr() {
  if (!attrOpen()) return;
  const body = $('attrBody');
  const layers = attrLayers();
  if (attrLayer >= layers.length) attrLayer = 0;
  attrCol = -1;
  // 表要重建，旧的行元素马上就不在文档里了，定位标记一并清掉
  markLocateRow(null);
  if (!layers.length) {
    attrShown = null;
    body.textContent = '';
    body.appendChild(el('div', 'attr-empty', '这份文件里没有可以画到地图上的要素'));
    const t0 = document.querySelector('.attr-title');
    if (t0) t0.textContent = '属性表';
    return;
  }
  const L = layers[attrLayer];
  // 标题带上图层名：多图层文件里一眼知道这张表是谁的属性
  const titleEl = document.querySelector('.attr-title');
  if (titleEl) titleEl.textContent = '属性表 · ' + (L.name || ('图层 ' + (attrLayer + 1)));
  const key = attrKeyOf(L);
  let c = attrCache[key];
  if (!c) {
    c = {
      key: key, target: L.target, index: L.index, layer: L, fields: L.fields || [],
      keys: (L.fields || []).map((f) => f.name), rows: [], ids: [], boxes: [], total: null,
      done: false, loading: false, built: false, error: '', tok: 0,
    };
    attrCache[key] = c;
  }
  c.tok++;
  attrShown = c;
  if (c.built) {
    body.textContent = '';
    body.appendChild(c.table);
    setAttrMore(c, c.loading);
    return;
  }
  if (c.error) { failAttr(c); return; }
  body.textContent = '';
  // 首屏也只留表体中间那一枚加载提示，不再往表格里插一行文字
  setAttrMore(c, true);
  loadAttrPage(c);
}

function toggleAttr() {
  if (attrOpen()) { closeAttr(); return; }
  showAttr(true);
  refreshAttr();
}

/* ---------- 值分布气泡：跟着按钮的开关态 ---------- */

function showHist(on) {
  const pop = $('histPop');
  $('histBtn').classList.toggle('on', on);
  $('histBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
  if (on) {
    pop.hidden = false;
    pop.classList.add('shrunk');
    // 下一帧再放开，气泡从按钮那一侧滑进来
    requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.remove('shrunk')));
    return;
  }
  if (pop.hidden) return;
  pop.classList.add('shrunk');
  setTimeout(() => { if (pop.classList.contains('shrunk')) pop.hidden = true; }, 200);
}

function histOpen() {
  const pop = $('histPop');
  return !pop.hidden && !pop.classList.contains('shrunk');
}

function closeHist() {
  showHist(false);
  // 内容等收缩放完再清，不然先空一块再缩下去，看着像闪一下
  setTimeout(() => {
    if (!$('histPop').hidden) return;
    paintHistTitle();
    $('histBody').textContent = '';
    $('histNote').textContent = '';
  }, 220);
}

function toggleHist() {
  if (histOpen()) { closeHist(); return; }
  fillHistogram(raster && raster.cache[raster.band]);
  showHist(true);
}

/* ---------- 地图底部那一条：比例尺 + 位置读数 ---------- */

let mouseOn = false;
let lastView = {};

function paintPos(e) {
  const d = e.detail;
  mouseOn = !!d;
  if (mouseOn) {
    if (localCoords) {
      // 本地坐标的图层（多为 CAD）：坐标不是经纬度，照实显示原始数值
      $('posLngLab').textContent = 'X';
      $('posLatLab').textContent = 'Y';
      $('posLng').textContent = num(d.lng, 1) || '—';
      $('posLat').textContent = num(d.lat, 1) || '—';
    } else {
      $('posLngLab').textContent = '经度';
      $('posLatLab').textContent = '纬度';
      $('posLng').textContent = num(d.lng, 5) || '—';
      $('posLat').textContent = num(d.lat, 5) || '—';
    }
  }
  $('statusBox').hidden = false;
}

/* 比例尺自己画：MapLibre 那一条会跟图例抢位置，而且没法和读数并成一条 */
function paintView(e) {
  if (e) lastView = e.detail || {};
  const d = lastView;
  $('posZoom').textContent = num(d.zoom, 1) || '—';
  $('posCrs').textContent = d.epsg ? 'EPSG:' + d.epsg : '—';
  // 鼠标还没上过地图时，经纬度就是画面中心——刚打开图层时看到的正是它的中心位置
  if (!mouseOn) {
    $('posLng').textContent = num(d.lng, 5) || '—';
    $('posLat').textContent = num(d.lat, 5) || '—';
  }
  if (!d.metersPerPixel) return;
  const max = 96;
  const target = d.metersPerPixel * max;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  let nice = pow;
  [1, 2, 5, 10].forEach((m) => {
    if (m * pow <= target) nice = m * pow;
  });
  // 条长是地图上量出来的屏幕像素，而这一格被界面字号放大过，除回去才对得上实地距离
  const px = nice / d.metersPerPixel / uiZoom();
  $('statusBox').hidden = false;
  $('scaleBar').style.width = px.toFixed(1) + 'px';
  $('scaleText').textContent = nice >= 1000
    ? num(nice / 1000, 3) + ' ' + unitText('km') : num(nice, 1) + ' ' + unitText('m');
}

/* ---------- 属性表浮窗上沿的拖动条 ---------- */

const ATTR_MIN = 120;

function attrStage() {
  return document.querySelector('.map-stage');
}

function wireAttrGrip() {
  const handle = $('attrGrip');
  const stage = attrStage();
  const saved = parseInt(localStorage.getItem('gisviewer.attr_h') || '', 10);
  // 面板整块被界面字号放大过，拖出来的是屏幕像素，写回 CSS 前要除回去
  if (saved >= ATTR_MIN) {
    stage.style.setProperty('--attr-h', Math.round(saved / uiZoom()) + 'px');
  }
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    hideTipBox();   // 拖动过程中不要那条"拖动调整高度"的气泡跟着走
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add('dragging');
    const move = (e) => {
      const box = stage.getBoundingClientRect();
      const max = Math.max(ATTR_MIN, box.height - 140);
      const h = Math.min(max, Math.max(ATTR_MIN, Math.round(box.bottom - 8 - e.clientY)));
      stage.style.setProperty('--attr-h', Math.round(h / uiZoom()) + 'px');
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      const css = parseInt(getComputedStyle(stage).getPropertyValue('--attr-h'), 10);
      const now = Math.round(css * uiZoom());
      if (now >= ATTR_MIN) localStorage.setItem('gisviewer.attr_h', String(now));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/* 收起/展开：grid-template-rows 过渡。收起后整块只剩一枚胶囊（加号 + 名字），点它展开 */
const folds = [];

function wireFold(btn, tab, hostId, foldTitle, unfoldTitle) {
  const host = $(hostId);
  const paint = (folded) => {
    btn.setAttribute('data-tip', (folded ? unfoldTitle : foldTitle));
    btn.setAttribute('aria-label', (folded ? unfoldTitle : foldTitle));
    btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  };
  btn.addEventListener('click', () => { paint(host.classList.toggle('folded')); });
  tab.addEventListener('click', () => { host.classList.remove('folded'); paint(false); });
  folds.push({ host, btn, tab, foldTitle, unfoldTitle });
}

/* 换图层时回到展开态：浮板自己记住上一次收着没意义，用户要看的是新图层 */
function unfoldPanels() {
  folds.forEach((f) => {
    f.host.classList.remove('folded');
    f.btn.setAttribute('data-tip', f.foldTitle);
    f.btn.setAttribute('aria-label', f.foldTitle);
    f.btn.setAttribute('aria-expanded', 'true');
  });
}

/* ---------- 无边框窗口的标题栏 ---------- */

function wireChrome() {
  if (!NATIVE) return;
  $('winBtns').hidden = false;
  $('winMin').addEventListener('click', () => toShell('win:min'));
  $('winMax').addEventListener('click', () => toShell('win:max'));
  $('winClose').addEventListener('click', () => toShell('win:close'));
  /* 窗口置顶：顶栏那颗按钮和设置里那个勾选是同一件事的两种入口，
     值只存在 config.always_on_top 里，两边都照着它画 */
  applyTopMost(config.always_on_top, false);
  $('winTop').addEventListener('click', () => applyTopMost(!config.always_on_top, true));
  const bar = $('bar');
  /* 顶栏空白处：按住能拖窗口，连点两下最大化/还原。
     双击不能等 dblclick——第一次按下就把窗口交给了系统拖动循环，
     第二个 click 根本回不到页面里，只能自己数这两下 */
  let barTap = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    /* 最近打开和"打开"菜单都挂在顶栏里：点它们时不能去拖窗口，
       否则这一下被系统拖动循环接走，列表项的 click 永远回不来（点不开就是这个原因） */
    if (e.target.closest('input, button, label, select, .combo, .no-drag, #recentPop, #pickPop, #checkPop, #convPop')) return;
    /* 顶栏空白处一按下，窗口就交给系统拖动循环了，这一下之后的 click 再也回不到页面，
       所以浮窗只能在这里主动收掉，不能等外面的 document click */
    hideRecent();
    hidePickPop();
    hideCheckPop();
    const now = Date.now();
    if (now - barTap < 450) { barTap = 0; toShell('win:max'); return; }
    barTap = now;
    toShell('titlebar:drag');
  });
}

/* 关掉图层：地图、右栏、浮层全收干净，回到刚打开时的投放界面 */
function closeLayer() {
  current = null;
  mouseOn = false;
  resetRasterView();
  /* 文件都关了，属性表不能还挂着一份旧行；缓存留着，同一个文件再打开是瞬时的 */
  closeAttr();
  attrShown = null;
  watchStale('');   // 文件关了就不必再盯着它的改动
  syncCheckInput('');   // 体检输入框里那份已经不存在了，跟着清掉
  if (window.GisMap) GisMap.clear();
  $('rail').textContent = '';
  $('panels').hidden = true;
  $('empty').hidden = false;
  hideErrToast();
  $('statusBox').hidden = true;
  $('mapNote').textContent = '';
  $('pathInput').value = '';
  setChip(null);
}

/* ---------- 读取入口 ---------- */

/* 浮窗停留多久由设置页决定（默认 5 秒）：错误卡片和地图上那条"已定位到…"共用同一个数 */
function toastMs() {
  const n = Number(config.toast_sec);
  const sec = isFinite(n) && n > 0 ? Math.min(30, Math.max(1, Math.round(n))) : 5;
  return sec * 1000;
}

/* 错误/警告浮层卡片：加载失败这类事都从这里报。
   它是浮层不是模态——不占版面，也不把正开着的图层清掉。
   没有关闭按钮：点卡片本身就关，不点的话到设定时间自己收走 */
let errToastTimer = 0;

/* 提示卡的水平中心跟着地图元素走：右侧还有信息栏，按整个窗口居中会落在偏右的位置。
   地图还没立起来（初始界面、图层已关）就退回窗口中心 */
function placeErrToast() {
  const box = $('errToast');
  if (!box || box.hidden) return;
  const map = $('map');
  const r = map ? map.getBoundingClientRect() : null;
  const cx = (r && r.width > 120)
    ? Math.round(r.left + r.width / 2)
    : Math.round(window.innerWidth / 2);
  box.style.left = cx + 'px';
}

/* 全局提示只有"标题 + 一句说明 + 一句建议"：
   想分点讲清一件事的地方是设置项那枚 ⓘ 的气泡（见 showTipBox），不是这里 */
function fillToastText(box, value) {
  if (!box) return;
  const one = value == null ? '' : String(value);
  box.textContent = '';
  // 与气泡同一套标记：**重点** 画成强调色加粗，设置项名字就靠它区分
  fillTipText(box, one);
  box.hidden = !one;
}

/* sticky：正在做的事（定位、整列复制）不该到点自己消失，
   做完再换成结果那一条；默认按设置里的秒数自动收走 */
function showErrToast(title, detail, hint, kind, sticky) {
  const box = $('errToast');
  if (!box) return;
  box.classList.toggle('info', kind === 'info');
  $('errTitle').textContent = title || '出了点问题';
  /* 固定两行：第一行结论，第二行建议。同时给了 detail 与 hint 时，第二行取 hint——
     用户要的是"接下来怎么办"，技术细节留在信息栏里 */
  fillToastText($('errDetail'), '');
  fillToastText($('errHint'), hint || detail || '');
  box.hidden = false;
  placeErrToast();
  // 连着弹同一条时也要有"又来了"的动静：去掉类、强制重排、再加回去
  box.classList.remove('pop');
  void box.offsetWidth;
  box.classList.add('pop');
  // 每次弹出来都把自动收走的钟重新拨一遍，新消息不会刚出现就被上一条的钟收走
  clearTimeout(errToastTimer);
  if (!sticky) errToastTimer = setTimeout(hideErrToast, toastMs());
}

/* 只是说一句发生了什么：不挂警告图标，也不打断手上的事 */
function toastNote(title, detail, hint, sticky) {
  showErrToast(title, detail, hint, 'info', sticky);
}

function hideErrToast() {
  clearTimeout(errToastTimer);
  const box = $('errToast');
  if (box) box.hidden = true;
}

function renderError(title, detail, hint) {
  $('panels').hidden = true;
  $('empty').hidden = false;
  setChip(null);
  if (window.GisMap) GisMap.clear();
  showErrToast(title, detail, hint);
}

/* ---------- 关闭确认：点右上角 × 时先问一句"继续运行吗" ---------- */

function showCloseAsk() {
  const box = $('closeAsk');
  if (!box) return;
  $('caRemember').checked = false;
  box.hidden = false;
}

function hideCloseAsk() {
  const box = $('closeAsk');
  if (box) box.hidden = true;
}

function wireCloseAsk() {
  const cancel = () => { hideCloseAsk(); toShell('closechoice:cancel'); };
  const act = async (choice, closeAct) => {
    /* 勾了"不再询问"：这次的选法就是以后的默认，写进配置再让壳动手。
       退出要把配置先落盘，不然壳一关，请求还没到引擎 */
    if ($('caRemember').checked) {
      config.close_ask = false;
      config.close_act = closeAct;
      $('cfgCloseAsk').checked = false;
      segSet('cfgCloseAct', closeAct);
      await commitConfig();
      /* 壳只认自己手里那份开关（closeask:<on|off>），配置写盘不会自动同步过去。
         少了这两行，勾了"不再询问"、选了驻留托盘之后，下次点 × 照样弹这个框 */
      toShell('closeask:off');
      toShell('closeact:' + closeAct);
    }
    hideCloseAsk();
    toShell('closechoice:' + choice);
  };
  $('caCancel').addEventListener('click', cancel);
  $('caExit').addEventListener('click', () => act('exit', 'exit'));
  $('caTray').addEventListener('click', () => act('tray', 'min'));
  $('closeAsk').addEventListener('click', (e) => { if (e.target === $('closeAsk')) cancel(); });
}

/* 遮罩不能只等元数据：矢量还要再取一次要素才算真画完，那一步在几十万要素的文件上要十几秒。
   地图每画完一次报一个数，遮罩只认比自己挂起更晚的那一次——栅格是同步画完的，
   挂晚了就永远等不到下一次绘制，只能等兜底 */
let veilTimer = 0;
let veilHold = false;
let drawTick = 0;
let veilAt = 0;
let openFrom = 0;
// 这些格式要等地图画完才算真的打开；其余的出完元数据就算完
const VEIL_KINDS = ['vector', 'raster', 'archive', 'tileset'];

function holdVeil(text) {
  veilHold = true;
  veilAt = drawTick;
  clearTimeout(veilTimer);
  veilTimer = setTimeout(releaseVeil, 30000);
  loadTip(true, text);
}

function releaseVeil() {
  if (!veilHold) return;
  veilHold = false;
  clearTimeout(veilTimer);
  loadTip(false);
  if (openFrom && window.GisMap) GisMap.setElapsed(dur(Date.now() - openFrom));
  openFrom = 0;
}

async function inspectPath(path) {
  const prev = current;
  const hadLayer = !!prev && !!prev.data && prev.data.ok;
  /* 开始打开新文件就把浮窗收掉：快捷键/拖放/最近打开都会走到这里，
     路径框那边不该还挂着一块"最近打开"盖在地图上 */
  hideRecent();
  hidePickPop();
  hideCheckPop();
  /* 快捷键/拖放开门时，顶栏输入框往往还是上一次留下的焦点：
     从托盘唤回窗口时浏览器会把焦点还给上次那个控件，光标就一直闪在路径框里。
     打开动作本身就是"输入结束"，这里统一交还焦点（没焦点时 blur 是空操作） */
  const pIn = $('pathInput');
  if (pIn) pIn.blur();
  current = { path, data: null };
  mouseOn = false;
  openFrom = Date.now();
  openAbort = new AbortController();
  $('empty').hidden = true;
  $('panels').hidden = false;
  hideErrToast();
  loadTip(true, '正在读取…');
  if (/\.dwg$/i.test(String(path))) startDwgWatch(String(path));
  skeleton(String(path).split(/[\\/]/).pop());
  let data;
  try {
    const res = await fetch('/api/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, fast: true }),   // 先立界面，个数范围后台补
      signal: openAbort.signal,
    });
    data = await res.json();
  } catch (err) {
    stopDwgWatch();
    loadTip(false);
    if (err && err.name === 'AbortError') return;   // 用户取消 DWG 转换
    renderError('本地服务没有响应', err.message, '请确认服务已启动。');
    return;
  }
  /* 已经开着图层时又拖进来一个读不出来的东西（比如文件夹）：
     浮层卡片说明原因，眼前这块原样留着，不能顺手把人正在看的东西清了 */
  /* 最近打开里的路径可能已经不在（文件被移走、改名）：顺手从清单里删掉，
     否则这一条以后每次点都会失败一次 */
  if (!data.ok && (config.recent || []).indexOf(path) >= 0 &&
      /找不到|不存在/.test((data.error && data.error.title) || '')) {
    config.recent = config.recent.filter((x) => x !== path);
    renderRecent();
    commitConfig();
  }
  if (!data.ok && hadLayer) {
    const err = data.error || {};
    loadTip(false);
    showErrToast(err.title || '这个文件打不开', err.detail, err.hint);
    current = prev;
    /* 回滚重画走的是正常渲染路径，没有下面那个 finally 管它：栅格首屏算配色时
       会把加载指示重新挂起来，收尾必须自己收，否则屏幕上一直转圈、看着像还在读 */
    renderResult(prev.data, prev.path, { quiet: true })
      .catch(() => { /* 回滚渲染不出来也就算了，浮层已经说明原因 */ })
      .finally(() => { loadTip(false); });
    return;
  }
  current = { path, data };
  /* 地图换了数据，格式互转的输入文件跟着换（用户没手填过才跟） */
  syncConvSource();
  const staged = !!data.ok && VEIL_KINDS.indexOf(data.kind) >= 0;
  /* 先挂遮罩再渲染：栅格是同步画完的，等渲染返回时完成事件早发过了 */
  if (staged) holdVeil('正在画图层…');
  /* 大矢量走快速元数据：信息栏立刻立起来，地图等全量检查（带范围）到了再画 */
  const deferMap = !!data.ok && data.quick && data.kind === 'vector';
  try {
    await renderResult(data, path, { deferMap });
    if (deferMap && data.ok) {
      /* 先出图，再补统计：统计会拿 GDAL 读锁，和首屏取数抢锁会把首屏拖慢。
         等这一批要素画完（gis:drawn）再发全量请求；取数失败也会发这个事件，
         15 秒兜底，避免统计永远不补 */
      const drawn = new Promise((resolve) => {
        const mapEl = $('map');
        const timer = setTimeout(done, 15000);
        function done() {
          clearTimeout(timer);
          mapEl.removeEventListener('gis:drawn', done);
          resolve();
        }
        mapEl.addEventListener('gis:drawn', done);
      });
      loadTip(true, '补齐要素数量与范围…');
      await renderResult(data, path);   // 先出图（范围由取数响应补）
      await drawn;
      const fullPromise = fetch('/api/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, fast: false }),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const full = await fullPromise;
      if (current && current.data === data && full && full.ok) {
        current.data = full;
        data = full;
        const ly = (full.layers || [])[data.layerIndex || 0];
        if (ly && ly.extent_wgs84 && window.GisMap) {
          /* 首屏是拿这一批要素的包围盒临时对上的；全量范围到了，
             用户还没动过地图就补一次真正的全图 */
          GisMap.setExtent(ly.extent_wgs84);
        }
        renderRail(data, false);        // 只换右栏，地图保持已画好的状态
        setChip(data);                  // 左上角文件卡片也要从“0”补成真实数量
        if (window.GisMap) GisMap.setElapsed(dur(data.elapsed_ms));
      }
      if (data.ok) noteOpened(path, data);
      return;
    }
    if (data.ok) noteOpened(path, data);
  } catch (err) {
    releaseVeil();
    renderError('界面渲染出错', (err && err.message) || String(err));
  } finally {
    stopDwgWatch();
    openAbort = null;
    if (!staged) { releaseVeil(); loadTip(false); }
  }
}

/* ---------- 外部改动监测 ---------- */

/* 数据打开后可能被别的软件改、被同步盘替换、被删掉，而画面停在打开那一刻。
   这里每 10 秒问一句服务端"这个文件还是不是原样"，变了就出一条横幅给一键重读。
   只在页面可见时问：切到后台就停，回来补一次。临时副本不盯（它本来就在我们自己手里）。 */
let stalePath = '';
let staleSize = null;
let staleMtime = null;
let staleIgnored = '';     // 用户点过"×"的那个路径：重新打开前不再提示
let staleBusy = false;
let staleTimer = 0;

function staleBarEl() {
  return $('staleBar');
}

function hideStale() {
  const bar = staleBarEl();
  if (bar && !bar.hidden) bar.hidden = true;
}

function showStale(kind) {
  const bar = staleBarEl();
  if (!bar || !stalePath) return;
  const name = String(stalePath).split(/[\\/]/).pop();
  const text = $('staleText');
  if (text) {
    text.textContent = kind === 'gone'
      ? '「' + name + '」已被移走或删除，画面还是打开时的样子。'
      : '「' + name + '」已在别处被修改，画面还是打开时的样子。';
  }
  const btn = $('staleReload');
  if (btn) btn.textContent = kind === 'gone' ? '重新检查' : '重新载入';
  bar.dataset.kind = kind;
  bar.hidden = false;
}

async function checkStale() {
  if (!stalePath || staleBusy || stalePath === staleIgnored || document.hidden) return;
  staleBusy = true;
  const mine = stalePath;
  try {
    const res = await fetch('/api/stamp?path=' + encodeURIComponent(mine));
    const data = await res.json();
    const s = (data && data.stamp) || {};
    if (stalePath !== mine) return;      // 这中间换了文件，这一拍的结果作废
    if (!s.exists) { showStale('gone'); return; }
    if (staleSize === null) { staleSize = s.size; staleMtime = s.mtime_ns; return; }
    if (s.size !== staleSize || s.mtime_ns !== staleMtime) showStale('changed');
  } catch {
    /* 服务端忙或刚重启：下一拍再问，不必打扰用户 */
  } finally {
    staleBusy = false;
  }
}

function watchStale(path, data) {
  const temp = !!(data && (data.temp_copy || (data.file && data.file.temp_copy)));
  stalePath = temp ? '' : String(path || '');
  staleSize = null;
  staleMtime = null;
  staleIgnored = '';
  hideStale();
  if (!stalePath) return;
  if (!staleTimer) staleTimer = setInterval(checkStale, 10000);
  checkStale();   // 立刻取一次基准，省得"刚打开就被改"这一段落在空档里
}

/* 打开一份数据之后要一起做的三件事：记进最近打开、盯住外部改动、
   把体检输入框换到这一份（用户自己敲过别的路径时不换，见 syncCheckInput） */
function noteOpened(path, data) {
  rememberLast(path, data);
  watchStale(path, data);
  syncCheckInput(path);
  schedulePrebuild(path, data);
  /* 等首屏画完再问：先让人看见图，再问要不要为它多花点时间 */
  setTimeout(() => { askPyramid(path, data); }, 900);
}

/* 大文件首屏出来后，趁用户还在看，后台把索引建了；下一次拖动/翻页就是毫秒级。
   只在矢量文件上叫一次，服务端会按大小和“是否已有索引”决定做不做。 */
let prebuildKey = '';
function schedulePrebuild(path, data) {
  if (!data || !data.ok || data.kind !== 'vector') return;
  const k = path + '#' + (data.layerIndex || 0);
  if (prebuildKey === k) return;
  prebuildKey = k;
  setTimeout(() => {
    fetch('/api/vindex/prebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, layer: data.layerIndex || 0 }),
    }).catch(() => {});
  }, 1500);
}

/* ---------- 金字塔：首次打开大影像时问一句 ---------- */

/* 金字塔副本存放在本机缓存里（`pyramid/` 分片），原文件一个字节都不动。
   建一次之后往外拉视野只读副本，不再把原图整片读一遍。 */
const PYR_NEVER = 'tulan.pyramid.never';
let pyrTimer = 0;
let pyrPath = '';

function pyrNeverAsked() {
  try { return localStorage.getItem(PYR_NEVER) === '1'; } catch { return false; }
}

/* 「以后不再询问」是全局开关，勾了就不再问任何文件。
   所以设置页要有一个同名的开关，否则勾完就再没有入口能打开它 */
function paintPyrAskTip() {
  const ico = $('tipPyrAsk');
  if (!ico) return;
  ico.setAttribute('data-tip', [
    '打开大影像时，如果原文件还没有金字塔，会先问一次要不要建。',
    '当前：' + (pyrNeverAsked() ? '不再询问（可在上面勾选恢复）' : '每次询问'),
    '金字塔是缓存里的显示副本，原文件不会被改动。',
  ].join(String.fromCharCode(10)));
}

function askPyramid(path, data) {
  /* 压缩包里的临时副本不建：它下次打开就是另一个路径了，副本白建 */
  if (!data || !data.ok || data.kind !== 'raster' || data.temp_copy) return Promise.resolve();
  if (pyrNeverAsked()) return Promise.resolve();
  return fetch('/api/pyramid/status?path=' + encodeURIComponent(path))
    .then((r) => r.json())
    .then((st) => {
      if (!st || !st.ok || !st.recommend || st.running) return;
      if (st.pyramid && st.pyramid.exists) return;
      if (!current || current.path !== path) return;   // 这期间换了文件就别问了
      pyrPath = path;
      $('paText').textContent = st.reason;
      $('paSize').textContent = st.width ? st.width.toLocaleString() + '×' + st.height.toLocaleString() : '—';
      $('paBytes').textContent = st.size ? fmtBytes(st.size) : '—';
      $('paLevels').textContent = (st.levels || []).length ? (st.levels || []).length + ' 级（1/' + (st.levels || [])[(st.levels || []).length - 1] + '）' : '—';
      /* 默认值按数据类型定：带调色板的就是分类图，必须最近邻；
         其余按连续数据处理，给平均值（ArcGIS Pro、QGIS 对连续数据的建议） */
      pyrRecommend = st.colortable ? 'nearest' : 'average';
      setPyramidMethod(pyrRecommend);
      $('paNever').checked = false;
      $('pyrAsk').hidden = false;
    })
    .catch(() => { /* 问不出来就当没这回事，不影响看文件 */ });
}

/* 采样方法下面那段说明：换一项就换一段，只讲这一步具体怎么做、代价是什么。
   哪类数据用哪张卡片，卡片上的标签已经写了，这里不再重复 */
const PYR_HINTS = {
  average: '按参与降采样的全部像元求算术平均，等权汇总。副本中的数值不会超出原文件的取值范围，'
    + '区域均值与总量保持稳定；代价是细节被抹平，纹理显得柔和。',
  bilinear: '以 2×2 邻域像元按距离加权插值。过渡带比等权平均更连续，降采样后仍能保留较多的'
    + '位置关系；边缘会被平滑，极值也会被轻微拉低。',
  cubic: '以 4×4 邻域像元作三次多项式拟合，锐度与细节保留最好。代价是边缘两侧可能出现振铃，'
    + '副本中会生成原文件里并不存在的数值。',
  nearest: '直接取距离中心最近的像元原值，不参与任何加权运算。副本中的每个数值都来自原文件，'
    + '位置对应关系严格一致，不会产生新的取值。',
};

let pyrRecommend = 'average';

function pyramidMethod() {
  const el = document.querySelector('input[name="paMethod"]:checked');
  return (el && el.value) || 'average';
}

function setPyramidMethod(v) {
  document.querySelectorAll('input[name="paMethod"]').forEach((el) => {
    el.checked = el.value === v;
    const card = el.closest('.pyr-m');
    if (card) card.classList.toggle('on', el.checked);
  });
  paintPyramidHint();
}

function paintPyramidHint() {
  const el = $('paHint');
  if (el) el.textContent = PYR_HINTS[pyramidMethod()] || '';
  /* 「推荐」只挂在按数据类型选出来的那一张上：分类图是最近邻，其余是平均值 */
  document.querySelectorAll('.pyr-m').forEach((card) => {
    const input = card.querySelector('input[name="paMethod"]');
    const rec = card.querySelector('.pyr-rec');
    if (rec) rec.hidden = !input || input.value !== pyrRecommend;
  });
}

function fmtBytes(n) {
  if (!n) return '—';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' 字节';
}

const VEC_PREC_HINTS = {
  auto: '小于 12 MB 的数据按原始顶点绘制，更大的数据按当前缩放简化，保证拖动跟得上。某一层想临时看全精度，点底栏那枚「看全精度」即可。',
  accurate: '一律按原始顶点绘制，不自动退回简化。数据大时这一屏会明显变慢，底栏会在重画期间给出提示。',
  fast: '一律按当前缩放简化几何，平移缩放最快。边界会随缩放略有变化，量测仍按原始几何计算。',
};

function paintVecPrecHint() {
  const ico = $('tipVecPrecision');
  if (!ico) return;
  const pick = ($('cfgVecPrecision') || {}).value || 'auto';
  ico.setAttribute('data-tip', [
    '几何精度决定边界要不要按当前缩放抽稀：',
    '· 自动：小文件按原始顶点，大文件抽稀；',
    '· 精确优先：一律原始顶点，不自动退回；',
    '· 速度优先：一律抽稀，拖动最快。',
    '当前：' + (VEC_PREC_HINTS[pick] || ''),
  ].join('\n'));
}

function hidePyramidAsk() {
  $('pyrAsk').hidden = true;
}

function stopPyramidWatch() {
  if (pyrTimer) clearInterval(pyrTimer);
  pyrTimer = 0;
  pyrPath = '';
}

async function buildPyramid(path, resample) {
  try {
    await fetch('/api/pyramid/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, resample }),
    });
  } catch { return; }
  pyrPath = path;
  if (pyrTimer) clearInterval(pyrTimer);
  loadTip(true, '正在建金字塔…');
  $('loadBar').hidden = false;
  $('loadCancel').hidden = false;
  pyrTimer = setInterval(async () => {
    const target = pyrPath;
    if (!target) { stopPyramidWatch(); return; }
    let st = null;
    try {
      st = await (await fetch('/api/pyramid/status?path=' + encodeURIComponent(target))).json();
    } catch { return; }
    if (!st || !st.ok) return;
    if (st.running) {
      $('loadText').textContent = '正在建金字塔… ' + Math.round((st.progress || 0) * 100) + '%';
      return;
    }
    stopPyramidWatch();
    $('loadBar').hidden = true;
    $('loadCancel').hidden = true;
    loadTip(false);
    if (st.pyramid && st.pyramid.exists) {
      toastNote('金字塔建好了', '往外拉视野时会快一些；副本在本机缓存里，原文件没动。');
    } else if (st.error) {
      toastNote('金字塔没建成', st.error);
    }
  }, 500);
}

async function cancelPyramid() {
  const target = pyrPath;
  stopPyramidWatch();
  $('loadBar').hidden = true;
  $('loadCancel').hidden = true;
  loadTip(false);
  if (!target) return;
  try {
    await fetch('/api/pyramid/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
  } catch { /* 服务已经停了也算取消 */ }
}

$('cfgVecPrecision').addEventListener('change', paintVecPrecHint);
$('cfgTopMost').addEventListener('change', () => applyTopMost($('cfgTopMost').checked, true));
if ($('cfgPyrAsk')) {
  $('cfgPyrAsk').addEventListener('change', () => {
    try { localStorage.setItem(PYR_NEVER, $('cfgPyrAsk').checked ? '0' : '1'); } catch { /* 隐私模式 */ }
    paintPyrAskTip();
  });
}
document.querySelectorAll('input[name="paMethod"]').forEach((el) => {
  el.addEventListener('change', paintPyramidHint);
});

$('paSkip').addEventListener('click', () => {
  if ($('paNever').checked) {
    try { localStorage.setItem(PYR_NEVER, '1'); } catch { /* 隐私模式就每次都问 */ }
  }
  hidePyramidAsk();
});
$('paBuild').addEventListener('click', () => {
  const path = pyrPath;
  const method = pyramidMethod();
  if ($('paNever').checked) {
    try { localStorage.setItem(PYR_NEVER, '1'); } catch { /* 同上 */ }
  }
  hidePyramidAsk();
  if (path) buildPyramid(path, method);
});
$('pyrAsk').addEventListener('click', (e) => {
  if (e.target === $('pyrAsk')) hidePyramidAsk();
});

/* 记住这次打开的是哪个文件：一条给"启动时恢复上次的文件"，
   一份最近的清单给路径框下拉；临时副本两处都不记 */
function rememberLast(path, data) {
  const p = String(path || '');
  if (!p || (data && (data.temp_copy || data.file && data.file.temp_copy))) return;
  toShell('lastdir:' + p);   // 告诉壳"最近一次打开的是这里"，文件框下次从这儿起步
  // 先记形态、格式、大小，再重排清单：renderRecent 在 rememberRecent 里跑，
  // 反过来的话这一条第一次画出来还没有图标与附注
  rememberRecentMeta(p, data);
  rememberRecent(p);
  if ((config.last_paths || [])[0] === p) return;
  config.last_paths = [p];
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_paths: config.last_paths, recent: config.recent }),
  }).catch(() => { /* 记不上不影响看文件 */ });
}

/* ---------- 设置页的提示图标：每一项标签后面那枚圆形叹号 ---------- */

/* 按控件 id 挂提示；一两句话把"这是什么、调了会怎样"说清楚。
   这些内容原来是各设置项下面的小字说明，统一改挂在气泡里，措辞从简、从正式 */
const SETTING_TIPS = {
  cfgBasemap: '地图底层使用的地图服务\n**天地图影像**、**天地图矢量**需要 **天地图密钥**\n**Esri 影像**、**OpenStreetMap**、**高德影像**都不要密钥\n选 **无底图** 时背景为纯色',
  cfgAnnotation: '在**底图**上叠地名、路名等**注记**\n**天地图**两种底图自带注记层，可单独开关\n**Esri 影像**本身没有注记，勾选后叠天地图的，要 **天地图密钥**\n**OpenStreetMap** 瓦片自带注记、**高德**是 GCJ-02 基准，这两项不显示本条',
  cfgKey: '**天地图密钥**只保存在本机配置里\n到天地图开放平台申请"浏览器端"类型\n软件以本机网页方式运行，与授权域名无关',
  cfgRamp: '单色分级显示影像时用的颜色系列\n由低值到高值依次取色\n下拉选项就是实际配色',
  cfgClassCount: '分级上色把数值范围分成几档\n档数越多层次越细\n过密时画面容易显得破碎',
  cfgNodata: '数值等于 NoData 的像元怎么画\n透出**底图**、涂黑或涂白\n只影响显示，不动源文件',
  cfgRasterDefault: '打开多波段文件的默认显示方式\n取前三个波段合成彩色画面\n或取第一个波段做单色分级',
  cfgVectorColor: '矢量要素的填充、描边与数据范围框用的颜色\n只影响显示',
  cfgDrawLimit: '视野里一次最多画多少个要素\n调大能看到更多细节\n移动、缩放后每次重画会更慢\n超过上限会弹提示，动一下地图继续加载',
  cfgMaxFeatures: '**属性表** 向下滚动时每次续读的行数\n调大单次读得多，大图层上滚动更重',
  cfgFontUi: '界面文字用的字体\n列表里只有本机已安装的字体',
  cfgFontNum: '数字、坐标与表格内容用的字体\n可以和 **界面字体** 分开设',
  cfgUnitLang: '量算结果与坐标读数用哪种单位写法\n符号（m、km）或中文（米、千米）',
  cfgZoom: '只缩放界面文字与面板\n地图画布不参与缩放\n所以不影响坐标取点的精度',
  cfgAlpha: '浮在地图上的面板的不透明度\n顶栏与右侧信息栏始终不透明',
  cfgToastSec: '错误与提示浮层停留多久自动收起\n定位、整列复制这类进行中的提示不会中途消失\n点一下浮层可以立即关掉',
  cfgOpenDir: '点 **打开文件**、**打开文件夹** 时从哪个目录起步\n留空就用上次打开文件所在的位置\n也可以点 **选择…** 固定一个目录',
  cachePath: '打开过的文件的元数据、直方图、缩略图与矢量索引都放在这里\n点右侧按钮可以换到别的盘；换过之后旧缓存会被清理\n清空缓存只影响下次读取的速度，不动源文件',
  cfgCloseAct: '点窗口右上角关闭按钮时的行为\n驻留托盘：任务栏不再保留按钮，可从托盘或快捷键唤回\n直接退出：进程结束',
  cfgCloseAsk: '勾选后每次点关闭都先问一句：驻留托盘还是直接退出\n不勾选就按上面选的行为直接执行',
  cfgAutoStart: '开机后自动启动并驻留托盘\n不弹窗口，任务栏也不显示按钮\n通过托盘图标或快捷键唤出',
  cfgDeskLnk: '在桌面放一个"图览"快捷方式',
  cfgUpdFreq: '检查新版本的频率\n检查时只访问发布页一次\n其余时间不联网',
  cfgRestore: '启动时自动打开上次查看的文件',
  cfgRecentMax: '顶栏路径框点开时 **最近打开** 最多显示几条\n记录池最多留 20 条，调小不用重新攒',
  cfgCache: '从别处拖进来的文件会先复制一份到这里供读取\n软件退出后自动删除\n读取结果的缓存在 **缓存位置** 那一栏，不是这个目录',
  cfgKeepHours: '软件异常退出时临时副本保留多久\n超过后自动清理',
};

/* 标签上没有 for 的两处快捷键，按标签文字挂提示 */
const SETTING_LABEL_TIPS = {
  '唤出快捷键': '在任何程序中按下都能把窗口唤到前台\n点按钮后按下新的组合键即可修改',
  '选中即开快捷键': '在资源管理器或桌面上选中文件后按下，直接在图览中打开\n空格单独按下被系统占用，要搭配修饰键',
};

/* ---------- 设置卡片：按住标题条拖动 ---------- */

/* 拖的是卡片本身，不是软件窗口。卡片 620 宽、七成屏高，把顶栏和地图都盖住，
   想把它挪开看看后面的地图时得有个地方能抓。
   这一版之前用的是壳的窗口拖动（titlebar:drag），一拖整个软件跟着走，那是另一回事 */
function resetSetPos() {
  const card = document.querySelector('.set-card');
  if (!card) return;
  card.style.position = '';
  card.style.left = '';
  card.style.top = '';
  card.style.margin = '';
}

function wireSetDrag() {
  const card = document.querySelector('.set-card');
  if (!card) return;
  const head = card.querySelector('.card-title');
  if (!head) return;
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 标题右边那颗关闭按钮（以后可能还有别的控件）：按下时仍然是它们的事
    if (e.target.closest('button, a, input, label, select')) return;
    const r = card.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    // 改成 fixed 才跟手：卡片平时是弹性居中的，没有可写的坐标
    card.style.position = 'fixed';
    card.style.margin = '0';
    card.style.left = r.left + 'px';
    card.style.top = r.top + 'px';
    card.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch { /* 捕获不上也照样能拖 */ }
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // 至少留 8 像素在视野里：拖出屏幕回不来的卡片，比不能拖更麻烦
    const left = Math.min(Math.max(8, e.clientX - drag.dx), Math.max(8, window.innerWidth - drag.w - 8));
    const top = Math.min(Math.max(8, e.clientY - drag.dy), Math.max(8, window.innerHeight - drag.h - 8));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    card.classList.remove('dragging');
    try { head.releasePointerCapture(e.pointerId); } catch { /* 已经松开了 */ }
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

function mountSettingTips() {
  const root = $('settings');
  if (!root) return;
  const put = (lab, tip) => {
    if (!lab || !tip || lab.querySelector('.tip-ico')) return;
    const i = el('i', 'tip-ico');
    i.setAttribute('data-tip', tip);
    setSVG(i, HINT_ICO);
    lab.appendChild(i);
  };
  Object.keys(SETTING_TIPS).forEach((id) => {
    /* 控件不是可标注元素时（两态开关那样的 div），标签用 <id>Lab 认领 */
    put(root.querySelector('label[for="' + id + '"]') || document.getElementById(id + 'Lab'),
      SETTING_TIPS[id]);
  });
  root.querySelectorAll('.field > label, .field.inline > label').forEach((lab) => {
    put(lab, SETTING_LABEL_TIPS[lab.textContent.trim()]);
  });
}

/* ---------- 最近打开：路径框一点就出来，选一条直接重开 ---------- */

/* 存的时候多留一些（20 条封顶），显示几条由设置里的"最近打开显示条数"说了算；
   用户把条数调大调小时不用重新攒记录 */
const RECENT_KEEP = 20;

function recentMax() {
  const n = Number(config.recent_max);
  return Math.max(1, Math.min(RECENT_KEEP, isFinite(n) && n > 0 ? Math.round(n) : 5));
}

function rememberRecent(p) {
  p = tidyPath(p);
  /* 同一条路径换个写法（斜杠、大小写）不该重复出现：按归一化后的形式去重 */
  const key = (x) => String(x).replace(/[\\/]+/g, '/').toLowerCase();
  const list = (config.recent || []).filter((x) => x && key(x) !== key(p));
  list.unshift(p);
  config.recent = list.slice(0, RECENT_KEEP);
  renderRecent();
}

function baseName(p) { return String(p).split(/[\\/]/).pop(); }

/* 最近打开每条前面那枚小图标：按数据形态分。16px、单色描边，
   与顶栏那排图标同一套画法；形态看不清时退回"文件" */
const RECENT_ICO = {
  /* 形状取自 Lucide（ISC 许可，可随软件分发），统一 24 格、描边绘制；
     点、线、面三个保持同一笔粗细，缩到 18px 也分得清 */
  point: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="1.9"/>',
  line: '<path d="M3.2 17.6 9.4 7l4.4 6 6.8-9.4"/>',
  polygon: '<path d="M10.9 2.9a2 2 0 0 1 2.2 0l7.4 5.4a2 2 0 0 1 .7 1.9l-2.3 8.6a2 2 0 0 1-1.9 1.5H7a2 2 0 0 1-1.9-1.5L2.8 10.2a2 2 0 0 1 .7-1.9z"/>',
  mixed: '<path d="M12.8 2.2a2 2 0 0 0-1.7 0L2.6 6.1a1 1 0 0 0 0 1.8l8.5 3.9a2 2 0 0 0 1.7 0l8.6-3.9a1 1 0 0 0 0-1.8z"/><path d="m22 12.2-9.2 4.2a2 2 0 0 1-1.7 0L2 12.2"/><path d="m22 17.2-9.2 4.2a2 2 0 0 1-1.7 0L2 17.2"/>',
  raster: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.8" cy="8.8" r="1.8"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  archive: '<path d="m7.5 4.3 9 5.2"/><path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M12 3v18"/>',
  globe: '<circle cx="12" cy="12" r="9.4"/><path d="M12 2.6a14.5 14.5 0 0 0 0 18.8 14.5 14.5 0 0 0 0-18.8"/><path d="M2.6 12h18.8"/>',
  code: '<path d="M8 3.2H7a2 2 0 0 0-2 2v4.3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4.3a2 2 0 0 0 2 2h1"/><path d="M16 20.8h1a2 2 0 0 0 2-2v-4.3a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5.2a2 2 0 0 0-2-2h-1"/>',
  cad: '<path d="M13.7 4a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/>',
  file: '<path d="M15 2.6H6.6a2 2 0 0 0-2 2v14.8a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2V7.4z"/><path d="M14.4 2.6v4.8h5"/>',
};

/* 先按格式认（数据库、表格、地球、结构化文本、CAD），认不出来的再按几何认 */
function recentIconKey(m) {
  if (!m) return 'file';
  const kind = m.kind || '';
  const fmt = m.fmt || '';
  if (kind === 'archive') return 'archive';
  // 驱动名有中文（文件地理数据库）也有英文，两套都得认
  if (/Geodatabase|GeoPackage|SQLite|SpatiaLite|地理数据库|空间数据库/i.test(fmt)) return 'db';
  if (/表格|CSV|XLSX/i.test(fmt)) return 'table';
  if (/^KML|^GPX/i.test(fmt)) return 'globe';
  if (/GeoJSON|GML|TopoJSON|JSON/i.test(fmt)) return 'code';
  if (/^DXF|^DWG/i.test(fmt)) return 'cad';
  if (kind === 'raster') return 'raster';
  const g = (m.geom || '').toLowerCase();
  if (g.indexOf('point') === 0) return 'point';
  if (g.indexOf('line') === 0) return 'line';
  if (g.indexOf('polygon') === 0) return 'polygon';
  if (g === 'mixed' || g === 'geometrycollection') return 'mixed';
  return 'file';
}

let recentFilling = null;

/* 加图标之前留下的老记录没有形态信息，图标会全变成"文件"：补问一次引擎，
   问到的存进同一个表。只补看得见的几条，问过的记在 recentFilling 里不重复问 */
function fillRecentMeta(paths) {
  const map = recentMetaMap();
  const missing = paths.filter((p) => !map[p]);
  if (!missing.length) return;
  if (!recentFilling) recentFilling = new Set();
  missing.slice(0, 6).forEach((p) => {
    if (recentFilling.has(p)) return;
    recentFilling.add(p);
    fetch('/api/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, fast: true }),
    }).then((r) => r.json()).then((d) => {
      if (!d || !d.ok) return;
      const layer = (d.layers || [])[0] || {};
      const m = recentMetaMap();
      m[p] = {
        kind: d.kind || '',
        geom: String(layer.geometry_type || '').toLowerCase(),
        fmt: d.driver_label || '',
        size: (d.file && d.file.size_label) || '',
      };
      saveRecentMeta(m);
      const pop = $('recentPop');
      if (pop && !pop.hidden) renderRecent();
    }).catch(() => { /* 补不上就退回默认图标 */ })
      .finally(() => { recentFilling.delete(p); });
  });
}

/* 形态信息存在 config 里，不能放 localStorage：引擎每次启动换一个端口，
   而 localStorage 按 origin 隔离，一重启就全丢（最近打开的图标全变回默认就是这个原因） */
function recentMetaMap() {
  const raw = config.recent_meta;
  return raw && typeof raw === 'object' ? raw : {};
}

let metaCommitTimer = 0;

function saveRecentMeta(map) {
  config.recent_meta = map;
  /* 只提这一项，不发整份 config：整份发的话，页面上任何临时改动（比如调试时把密钥
     置空）都会被顺手写进配置文件。攒 400 毫秒，补历史记录时不会一条一发 */
  clearTimeout(metaCommitTimer);
  metaCommitTimer = setTimeout(() => {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recent_meta: config.recent_meta }),
    }).catch(() => { /* 记不上不影响打开文件 */ });
  }, 400);
}

/* 打开成功后顺手记一条：形态、格式、大小。只记还在"最近打开"清单里的那些，
   这个表不会越攒越长；丢了也只是图标退回默认，不影响打开文件 */
function rememberRecentMeta(path, data) {
  if (!path || !data || !data.ok) return;
  const layer = (data.layers || [])[0] || {};
  const map = recentMetaMap();
  map[tidyPath(path)] = {
    kind: data.kind || '',
    geom: String(layer.geometry_type || '').toLowerCase(),
    fmt: data.driver_label || '',
    size: (data.file && data.file.size_label) || '',
  };
  const keep = {};
  // 刚打开的这一条还没进 config.recent，先一起算进去，否则记完立刻被清掉
  (config.recent || []).concat([tidyPath(path)]).forEach((p) => {
    if (map[p]) keep[p] = map[p];
  });
  saveRecentMeta(keep);
}

/* 一条路径在界面上只该有一种写法：斜杠统一成反斜杠、连续分隔符压成一个、
   从 Git Bash 粘来的 /d/xxx 折回 D:\。拖放、粘贴、命令行传参的写法各不相同，
   不收敛的话同一个文件会以 D:////a////b.tif 这种样子留在路径框和最近打开里。
   GDAL 的 /vsi 虚拟路径内部本来就用正斜杠，原样留着 */
function tidyPath(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/^["']+|["']+$/g, '');
  if (!s) return '';
  if (s.toLowerCase().startsWith('file://')) s = s.slice(7);
  if (/^\/vsi/i.test(s)) return s;
  /* /d/data/x.tif：Git Bash、MSYS 的写法，先折成盘符，否则下面的反斜杠替换会把它变成 \d\data */
  if (/^\/[A-Za-z](\/|$)/.test(s)) s = s[1].toUpperCase() + ':' + s.slice(2);
  const unc = /^[\\/]{2}[^\\/]/.test(s);   // \\server\share 的前导双斜杠要留住
  s = s.replace(/[\\/]+/g, '\\');
  if (unc) s = '\\' + s;
  return s;
}

function renderRecent() {
  const pop = $('recentPop');
  if (!pop) return;
  const all = (config.recent || []).filter(Boolean);
  const list = all.slice(0, recentMax());
  const metas = recentMetaMap();
  pop.textContent = '';
  if (!list.length) { pop.hidden = true; return; }
  const head = el('div', 'rp-head');
  /* 标题后面缀一枚计数："列着几条/设置里的上限"。写成分数形式，
     一眼能看出还没到上限还是已经满了；悬停时说明记录池里还存着多少 */
  const title = el('span', 'rp-title', '最近打开');
  title.appendChild(el('b', 'rp-num', list.length + '/' + recentMax()));
  const recentTip = all.length > list.length
    ? '这里显示最近 ' + list.length + ' 条，共用上限 ' + recentMax() + ' 条，记录池里存着 ' + all.length + ' 条'
    : '这里显示 ' + list.length + ' 条，上限 ' + recentMax() + ' 条';
  title.setAttribute('data-tip', recentTip);
  title.setAttribute('aria-label', recentTip);
  head.appendChild(title);
  const clear = el('button', 'rp-clear');
  clear.type = 'button';
  clear.textContent = '清空';
  clear.addEventListener('click', (e) => {
    e.stopPropagation();
    config.recent = [];
    saveRecentMeta({});
    renderRecent();
    commitConfig();
  });
  head.appendChild(clear);
  pop.appendChild(head);
  list.forEach((p) => {
    const meta = metas[p] || null;
    const item = el('div', 'rp-item');
    const ico = el('span', 'rp-ico');
    setSVG(ico, '<svg viewBox="0 0 24 24" aria-hidden="true">' + RECENT_ICO[recentIconKey(meta)] + '</svg>');
    item.appendChild(ico);
    const text = el('div', 'rp-text');
    text.appendChild(el('div', 'rp-name', baseName(p)));
    text.appendChild(el('div', 'rp-path', p));
    item.appendChild(text);
    // 压缩包没有驱动名，给个"压缩包"，不然只剩一个体积看不出是什么
    const fmtLabel = meta ? (meta.fmt || (meta.kind === 'archive' ? '压缩包' : '')) : '';
    const bits = meta ? [fmtLabel, meta.size].filter(Boolean) : [];
    if (bits.length) item.appendChild(el('div', 'rp-meta', bits.join(' · ')));
    const del = el('button', 'rp-del');
    del.type = 'button';
    setSVG(del, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>');
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      config.recent = (config.recent || []).filter((x) => x !== p);
      const keepMeta = recentMetaMap();
      delete keepMeta[p];
      saveRecentMeta(keepMeta);
      renderRecent();
      commitConfig();
    });
    item.appendChild(del);
    // 按下不抢焦点，否则路径框先失焦、下拉被收掉，这一下就点不着
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      hideRecent();
      $('pathInput').value = p;
      $('pathInput').blur();   // 选完就交还焦点，输入框不该一直亮着
      inspectPath(p);
    });
    pop.appendChild(item);
  });
  // 老记录没有形态信息时顺手补一次，图标才不会一片相同
  fillRecentMeta(list);
}

function showRecent() {
  const pop = $('recentPop');
  const input = $('pathInput');
  if (!pop || !input || !(config.recent || []).length) return;
  // 有弹窗开着就不凑热闹：这时候点不到路径框，别在弹窗后面露出一块列表
  if (!$('settings').hidden) return;
  hidePickPop();
  placeRecent();
  pop.hidden = false;
}

/* 定位与显示分开：窗口一缩放，锚点（路径框、按钮）的屏幕位置就变了，
   开着的浮层得按新位置重摆一遍，不然留在原地盖住别的 */
function placeRecent() {
  const pop = $('recentPop');
  const input = $('pathInput');
  if (!pop || !input) return;
  const r = input.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  pop.style.width = Math.round(Math.max(r.width, 340)) + 'px';
}

function hideRecent() {
  const pop = $('recentPop');
  if (pop) pop.hidden = true;
}

/* ---------- 顶栏"打开"菜单：文件框和文件夹框的分岔口 ---------- */

/* .gdb 这类数据在资源管理器里是文件夹，系统的"打开文件"框根本选不了它，
   所以按钮点开先让用户选路：打开文件…（一次一个）/ 打开文件夹…（.gdb、瓦片目录等）。
   软件一次只画一个图层，文件框也设成单选，省得用户以为多选能一起打开 */
function showPickPop() {
  const pop = $('pickPop');
  const btn = $('filePickBtn');
  if (!pop || !btn) return;
  hideRecent();
  pop.textContent = '';
  const mk = (label, note, action) => {
    const item = el('button');
    item.type = 'button';
    item.appendChild(el('span', 'pp-label', label));
    item.appendChild(el('span', 'pp-note', note));
    // 按下不抢焦点，否则按钮按住的一瞬间菜单先被收掉，这一下点不着
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      hidePickPop();
      action();
    });
    pop.appendChild(item);
  };
  mk('打开文件…', '本地数据文件，一次看一个', () => toShell('pickfile'));
  mk('打开文件夹…', '.gdb、瓦片目录等以文件夹形式的数据', () => toShell('pickfolder'));
  placePickPop();
  pop.hidden = false;
  markBtn('filePickBtn', true);
}

function placePickPop() {
  const pop = $('pickPop');
  const btn = $('filePickBtn');
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
}

function hidePickPop() {
  const pop = $('pickPop');
  if (pop) pop.hidden = true;
  markBtn('filePickBtn', false);
}

function togglePickPop() {
  const pop = $('pickPop');
  if (pop && !pop.hidden) hidePickPop();
  else showPickPop();
}

/* ---------- 路径框也能当"转到指定坐标"用 ---------- */

/* 认 "116.4, 39.9"、"116.4 39.9"、"116.4E 39.9N" 这一类写法，顺序按 X,Y（经度在前）；
   带了路径符号或结尾像扩展名的，一律不当坐标 */
function parseLonLat(text) {
  const s = String(text || '').trim().replace(/，/g, ',').replace(/；/g, ';').replace(/\s+/g, ' ');
  if (!s || /[\\/:*?"<>|]/.test(s)) return null;
  if (/\.[A-Za-z]{2,5}$/.test(s)) return null;
  const parts = s.split(/[,; ]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const got = [];
  for (let i = 0; i < 2; i++) {
    const m = /^([-+]?[\d.]+)\s*(?:°|deg)?([NSEWnsew])?$/.exec(parts[i]);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (!isFinite(v)) return null;
    const h = (m[2] || '').toUpperCase();
    if (h === 'S' || h === 'W') v = -v;
    got.push({ v: v, axis: h === 'N' || h === 'S' ? 'lat' : (h === 'E' || h === 'W' ? 'lon' : '') });
  }
  let lon = got[0].v;
  let lat = got[1].v;
  // 写了 N/S 在前（39.9N 116.4E 这类），按字母把两数换回来
  if (got[0].axis === 'lat' || got[1].axis === 'lon') { lon = got[1].v; lat = got[0].v; }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

function gotoLonLat(ll) {
  hideRecent();
  if (!window.GisMap || !GisMap.goTo(ll)) {
    showErrToast('地图还没准备好', '等界面右下角出现地图之后，再在顶栏输入经纬度定位。');
    return;
  }
  /* 地图底下那行说明会被视野变化刷掉，所以定位结果用一枚一闪而过的小提示报出来 */
  mapToast('已定位到 ' + ll[0].toFixed(5) + '，' + ll[1].toFixed(5));
}

function mapToast(text) {
  const box = $('mapToast');
  if (!box) return;
  box.textContent = text;
  box.hidden = false;
  clearTimeout(box.__timer);
  box.__timer = setTimeout(() => { box.hidden = true; }, toastMs());
}

async function uploadFiles(files) {
  const group = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  let lastPath = null;
  let primaryPath = null;
  skeleton(files[0] ? files[0].name : '');
  $('empty').hidden = true;
  $('panels').hidden = false;
  for (const file of files) {
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Group': encodeURIComponent(group),
        },
        body: file,
      });
      const data = await res.json();
      if (!data.ok) {
        renderError(data.error.title, data.error.detail, data.error.hint);
        return;
      }
      lastPath = data.path;
      if (data.primary) primaryPath = data.path;
    } catch (err) {
      renderError('上传失败', err.message);
      return;
    }
  }
  const target = primaryPath || lastPath;
  if (target) await inspectPath(target);
}

/* ---------- 主题与设置 ---------- */

/* 配置里存的是"跟随系统"还是某一套配色；跟随系统时按系统偏好落到 light / dark */
function themeName(mode) {
  const m = THEME_LABELS[mode] ? mode : 'auto';
  if (m !== 'auto') return m;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode) {
  const name = themeName(mode);
  const root = document.documentElement;
  root.dataset.theme = name;
  root.dataset.tone = THEME_TONE[name] || 'light';
  if (window.GisMap) GisMap.themeChanged();
  /* 原生壳要跟页面同一个底色，否则首帧和拖动缩放时会闪过一条别的颜色。
     几套主题各有各的底，所以发的是算出来的真实背景色，壳那边按十六进制认；
     万一取不到就退回明暗两个字，老壳也认 */
  if (window.chrome && window.chrome.webview) {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    window.chrome.webview.postMessage('theme:' + (/^#[0-9a-fA-F]{6}$/.test(bg)
      ? bg
      : (THEME_TONE[name] === 'dark' ? '#12151a' : '#f6f7f9')));
  }
}

/* 壳那边从资源管理器拿到的就是原始路径，不用像浏览器那样先上传一份副本。
   界面自己还没初始化完（配置没读到、地图没建）就先攒着，等就绪了再打开——
   启动头一秒里拖进来的文件就是这么处理的，不然那一下会画不出来还没人吭声 */
let pageReady = false;
let pendingPaths = [];

window.GisDropPaths = function (paths) {
  const first = (paths || [])[0];
  if (!first) return;
  if (!pageReady) { pendingPaths.push(first); return; }
  openDropped(first);
};

function openDropped(path) {
  path = tidyPath(path);
  $('pathInput').value = path;
  inspectPath(path);
}

function syncControls() {
  if (window.enhanceAll) window.enhanceAll();
}

function paintThemeBtn() {
  const btn = $('themeBtn');
  const mode = THEME_LABELS[config.theme] ? config.theme : 'auto';
  btn.dataset.mode = mode;
  setSVG(btn, '<span class="btn-ico">' + (THEME_ICONS[mode] || THEME_ICONS.auto) + '</span>');
  const tip = '当前主题：' + THEME_LABELS[mode] + '，点击切换';
  btn.setAttribute('data-tip', tip);
  btn.setAttribute('aria-label', tip);
}

/* 色带下拉：整张清单由引擎给（20 条，含连续与分类），界面不维护第二份。
   每条都带一条真实渐变，选中哪条，画出来就是哪条 */
function paintRampSwatches(ramps) {
  const sel = $('cfgRamp');
  if (!sel || !ramps || !ramps.length) return;
  const keep = sel.value || config.ramp;
  sel.textContent = '';
  ramps.forEach((r) => {
    if (!r || !r.value) return;
    const o = document.createElement('option');
    o.value = r.value;
    o.textContent = r.label || r.value;
    o.setAttribute('data-grad', (r.colors || []).join(','));
    sel.appendChild(o);
  });
  sel.value = keep;
  if (!sel.value) sel.value = ramps[0].value;
  if (window.syncSelect) window.syncSelect(sel);
}

let configReady = false;   // 配置读回来之前，凡是要看配置的提示都先不弹

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.ok) config = Object.assign(config, data.config);
    /* 早先版本可能把 D:////a////b.tif 这种写法存进了最近打开，读配置时统一洗一遍，
       顺带按归一化后的形式去重 */
    if (Array.isArray(config.recent)) {
      const seen = new Set();
      config.recent = config.recent.filter(Boolean).map(tidyPath).filter((p) => {
        const k = p.replace(/[\\/]+/g, '/').toLowerCase();
        if (!p || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (data.ramps) paintRampSwatches(data.ramps);
    if (data.version) {
      // 版本号不在界面上露脸了，只留给标题栏和更新检查
      document.title = '图览 ' + data.version;
      toShell('ver:' + data.version);
    }
  } catch { /* 用默认值 */ }
  // 右键菜单挂哪些后缀由引擎定，取回来备着；页面没起在壳里时这一步失败也无所谓
  try {
    const fr = await fetch('/api/formats');
    const fd = await fr.json();
    if (fd && fd.ok && Array.isArray(fd.menu)) host.menuExt = fd.menu;
  } catch { /* 壳那边收到空清单就不注册 */ }
  applyTheme(config.theme);
  paintThemeBtn();
  applyDataColor();
  applyLook();
  fillSettings();
  syncControls();
  /* 最近打开必须在配置读回来之后画一次：初始化那时 config 还是空的，
     早画一次的结果是空列表，之后没人再画，点开路径框就是一片空白 */
  renderRecent();
  configLoaded = true;
  trySyncHotkey();
}

/* 两态开关（.seg）：值写在哪个按钮带 .on 上，读写的接口跟原来的下拉一样简单 */
function segGet(id) {
  const box = $(id);
  const on = box && box.querySelector('button.on');
  return on ? on.dataset.val : '';
}

function segSet(id, val) {
  const box = $(id);
  if (!box) return;
  box.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.val === val);
    b.setAttribute('aria-pressed', b.dataset.val === val ? 'true' : 'false');
  });
}

/* 底图这几项跟着底图变：密钥只对用得上的底图出现，注记开关只对能叠注记的底图出现。
   底下那行小字说明当前底图要不要密钥、注记从哪来——换底图后为什么少了两项，看这行就明白 */
const BM_NOTES = {
  none: '不用在线底图，背景为纯色，只显示数据本身',
  tianditu_img: '天地图影像需要密钥。影像与注记是两层，注记可以单独开关',
  tianditu_vec: '天地图矢量需要密钥。地图文字本身就是注记，另有独立的注记图层可叠加',
  esri: 'Esri 卫星影像不需要密钥，影像本身没有地名注记；可勾选天地图注记叠上去（需要天地图密钥）',
  osm: 'OpenStreetMap 不需要密钥，瓦片自带地名与路网注记',
  amap: '高德影像不需要密钥；瓦片是 GCJ-02 基准，叠天地图注记会整体偏移，所以没有注记开关',
};

const BASE_MEM_KEY = 'gisviewer.basemap_mem';

/* 底图开关按钮与设置页的"底图"是同一份配置：按钮关掉时记下原来那一份，
   再点回来恢复它；设置页换底图，按钮的亮灭也跟着变。 */
function basemapOn() { return String(config.basemap || '') !== 'none'; }

function rememberedBasemap() {
  let v = '';
  try { v = localStorage.getItem(BASE_MEM_KEY) || ''; } catch { v = ''; }
  return v && v !== 'none' ? v : 'tianditu_img';
}

function updateBaseBtn() {
  const btn = $('baseBtn');
  if (!btn) return;
  const on = basemapOn();
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const tip = on ? '底图：已显示，点一下隐藏' : '底图：已隐藏，点一下显示';
  btn.setAttribute('data-tip', tip);
  btn.setAttribute('aria-label', tip);
}

window.updateBaseBtn = updateBaseBtn;

function toggleBasemap() {
  if (basemapOn()) {
    const cur = String(config.basemap || '');
    try { if (cur && cur !== 'none') localStorage.setItem(BASE_MEM_KEY, cur); } catch { /* 存不了就本次生效 */ }
    config.basemap = 'none';
  } else {
    config.basemap = rememberedBasemap();
  }
  const sel = $('cfgBasemap');
  if (sel) sel.value = config.basemap;   // 设置页跟着一起变
  paintBasemapFields();
  if (window.GisMap) GisMap.refresh(config);
  updateBaseBtn();
  commitConfig();
}

/* 天地图密钥是 32 位字母数字：格式不对先提醒，格式对且落盘了给一枚绿勾 */
const TDT_KEY_RE = /^[A-Za-z0-9]{32}$/;

let keyTouched = false;   // 用户手动动过密钥栏：只有这时才允许把空值写进配置
let cachePickIntent = null;    // 用户选的缓存父目录；null＝跟随数据目录（框里显示父目录，实际生效的 TulanCache 在状态行）

/* 输入控件下方那行状态：ok=绿勾，warn=黄三角，空=整行收起 */
function paintFieldStatus(id, kind, text) {
  const box = $(id);
  if (!box) return;
  const label = box.querySelector('span');
  if (!kind) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle('ok', kind === 'ok');
  box.classList.toggle('warn', kind !== 'ok');
  if (label) label.textContent = text || '';
}

function paintKeyStatus(kind, text) { paintFieldStatus('keyStatus', kind, text); }

/* 起始目录：填了就报出来，空着就说清楚会跟随哪儿 */
/* 目录行里那枚"清除"只在框里有内容时出现 */
function syncDirClearBtns() {
  const pairs = [['cfgOpenDir', 'cfgOpenDirClear'], ['cfgCache', 'cfgCacheClear'], ['cachePath', 'cachePathClear']];
  pairs.forEach(([input, btn]) => {
    const i = $(input);
    const b = $(btn);
    if (i && b) b.hidden = !(i.value || '').trim();
  });
}

function paintOpenDirStatus() {
  const v = ($('cfgOpenDir').value || '').trim();
  paintFieldStatus('cfgOpenDirStatus', 'ok',
    v ? '起始目录：' + v : '起始目录未指定，打开文件框时停在上次打开文件所在的文件夹。');
}

/* 缓存位置：设置里没指就跟随数据目录，指了但用不了要说清 */
/* 缓存位置只有两种结论：服务端说行，就说"当前使用 …"；服务端说不行（回带说明），
   就把说明原样给出来。生效目录是所选位置下的 TulanCache 子目录，和用户选的
   父目录天然不是同一条路径，所以不能再靠比对两条路径判断有没有回退。 */
function paintCachePathStatus() {
  const eff = config.cache_effective || cacheDirShown || '';
  const note = config.cache_root_note || '';
  const fellBack = !!config.cache_fallback;
  if (fellBack && note) { paintFieldStatus('cachePathStatus', 'warn', note); return; }
  paintFieldStatus('cachePathStatus', 'ok',
    eff ? '缓存目录：' + eff + (config.cache_root && !fellBack ? '（专用子目录）' : '') : '');
}

/* 副本目录：空着时用系统临时目录，这里直接把实际用的路径写出来 */
function paintCacheDirStatus() {
  const v = ($('cfgCache').value || '').trim();
  const tmp = config.temp_dir || '';
  const note = config.cache_note || '';
  if (note) { paintFieldStatus('cfgCacheStatus', 'warn', note); return; }
  if (!v) {
    paintFieldStatus('cfgCacheStatus', 'ok',
      tmp ? '副本目录：' + tmp + '（系统临时目录）' : '副本目录：系统临时目录');
    return;
  }
  paintFieldStatus('cfgCacheStatus', 'ok',
    tmp && samePath(v, tmp) ? '副本目录：' + v + '（系统临时目录）' : '副本目录：' + v);
}

/* 保存结果的确认：面板开着就一直留着，关面板时收起。
   限时消失会让人以为自己看漏了，反而要再试一次 */
function flashKeySaved() {
  const v = ($('cfgKey').value || '').trim();
  if (!v) { paintKeyStatus('', ''); return; }
  if (!TDT_KEY_RE.test(v)) {
    paintKeyStatus('warn', '天地图密钥无效。请到天地图开放平台申请"浏览器端"密钥后重新填写。');
    return;
  }
  paintKeyStatus('ok', '天地图密钥有效。');
}

function paintBasemapFields() {
  const sel = $('cfgBasemap');
  const bm = String((sel && sel.value) || config.basemap || 'none');
  const tdt = bm === 'tianditu_img' || bm === 'tianditu_vec';
  const noteBox = $('cfgAnnotation');
  const noteOn = noteBox ? noteBox.checked : config.annotation === true;
  // 能叠注记的：天地图两种（自带注记层）、Esri 影像（本身无注记）
  const canNote = tdt || bm === 'esri';
  const noteField = $('cfgAnnotationField');
  const keyField = $('cfgKeyField');
  if (noteField) noteField.hidden = !canNote;
  // 密钥：天地图必须；Esri 只在要叠天地图注记时才需要
  if (keyField) keyField.hidden = !(tdt || (bm === 'esri' && noteOn));
  const hint = $('bmHint');
  if (hint) hint.textContent = BM_NOTES[bm] || '';
}

/* 把 config 摊到设置页的各控件上；控件都是自绘的，摊完要再同步一次 */
/* 滑块的"已走过"一段要涂主色：CSS 那条渐变按 --pct 变色，这里只负责把百分比写进去 */
function paintRange(el) {
  if (!el) return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const v = Number(el.value || 0);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', Math.max(0, Math.min(100, pct)).toFixed(1) + '%');
}

function fillSettings() {
  $('cfgBasemap').value = config.basemap || 'tianditu_img';
  $('cfgAnnotation').checked = config.annotation === true;
  $('cfgKey').value = config.tianditu_key || '';
  keyTouched = false;
  paintBasemapFields();
  $('cfgRamp').value = config.ramp || 'viridis';
  $('cfgClassCount').value = String(config.class_count || 5);
  $('cfgNodata').value = config.nodata_view || 'transparent';
  $('cfgRasterDefault').value = config.raster_default || 'composite';
  if (!/^#[0-9a-fA-F]{6}$/.test(config.vector_color)) config.vector_color = '#d9781f';
  $('cfgVectorColor').value = config.vector_color;
  $('cfgMaxFeatures').value = String(config.max_features || 500);
  $('cfgDrawLimit').value = String(config.draw_limit || 5000);
  $('cfgVecPrecision').value = config.vec_precision || 'auto';
  paintVecPrecHint();
  $('cfgTopMost').checked = !!config.always_on_top;
  if ($('cfgPyrAsk')) $('cfgPyrAsk').checked = !pyrNeverAsked();
  $('cfgRestore').checked = !!config.restore_last;
  $('cfgOpenDir').value = config.open_dir || '';
  $('cfgRecentMax').value = String(recentMax());
  /* 副本存放位置留空时直接填上系统临时目录：让用户看见实际用的是哪，
     而不是对着一个"留空则用临时目录"的占位符去猜 */
  $('cfgCache').value = config.cache_dir || config.temp_dir || '';
  cachePickIntent = config.cache_root || null;
  // 框里给"用户选的位置"；实际生效的目录（所选位置 / TulanCache）在下方状态行
  $('cachePath').value = config.cache_root || config.cache_effective || cacheDirShown || '';
  $('cfgKeepHours').value = String(config.keep_hours || 12);
  $('cfgZoom').value = String(config.ui_zoom || 100);
  $('cfgAlpha').value = String(config.panel_alpha || 93);
  $('cfgAlphaOut').textContent = ($('cfgAlpha').value || '93') + '%';
  paintRange($('cfgAlpha'));
  $('cfgTheme').value = THEME_LABELS[config.theme] ? config.theme : 'auto';
  $('aboutVer').textContent = 'v' + ((document.title || '图览').replace('图览', '').trim() || '0.1');
  $('cfgToastSec').value = String(Math.round(toastMs() / 1000));
  $('cfgUnitLang').value = config.unit_lang === 'zh' ? 'zh' : 'en';
  segSet('cfgCloseAct', config.close_act === 'exit' ? 'exit' : 'min');
  $('cfgCloseAsk').checked = config.close_ask !== false;
  // 早先存过 "boot"（开机就查），这一版改成打开后延迟查，读到老值直接换算过去
  $('cfgUpdFreq').value = config.upd_freq === 'boot' ? 'open' : (config.upd_freq || 'open');
  fillFontSelects();
  paintHotkeys();
  $('cfgAutoStart').checked = host.autoStart === true;
  $('cfgDeskLnk').checked = host.deskLnk === true;
  // 上次停在哪个分组
  showSettingPane(config.set_sec || 'base');
  // 文件框的起始位置由壳执行，这里把当前设置同步过去（含首次加载；留空＝上次的文件夹）
  toShell('opendir:' + String(config.open_dir || ''));
  // 快捷键那几行提示平时留空，只在改键过程中显示操作反馈
  $('hkHint').textContent = '';
  $('hk2Hint').textContent = '';
  $('hk3Hint').textContent = '';
  sysNote('');
  paintCacheHint();
  paintOpenDirStatus();
  paintCacheDirStatus();
  paintCachePathStatus();
  syncDirClearBtns();
  refreshCacheSize();
  document.querySelectorAll('#settings select').forEach((s) => window.syncSelect(s));
}

/* 副本目录用不了的时候引擎会退回系统临时目录，原因得自己说出来。
   这段说明现在并进"副本存放位置"下方的状态行，不再单独占一行 */
function paintCacheHint() {
  paintCacheDirStatus();
}

/* ---------- 数据缓存：显示占用 + 一键清空 ---------- */

/* dir 是引擎报上来的缓存目录（数据目录下的 cache），第一次拿到就写进提示气泡；
   用户问过"缓存到底存在哪"，这里把话说明白，不再只是一句"记在本地" */
let cacheDirShown = '';

/* 壳的选目录框只有一个回传口（GisHost('dir')），谁点的就填回谁的框。
   点"选择…"之前先记下目标，收到回传时按这个分发 */
let dirPickTarget = '';
let filePickTarget = '';   // 壳的选文件框回传填给谁：'conv' 或默认给体检

function paintCacheSize(info, dir) {
  if (dir) cacheDirShown = dir;
  const where = $('cachePath');
  // 输入框里放"用户设置的位置"，空着表示跟随数据目录；实际生效的目录在状态行
  // 没自定义就显示实际生效的目录：让用户看见"现在到底用哪儿"
  if (where) where.value = config.cache_root || config.cache_effective || cacheDirShown || '';
  paintCachePathStatus();
  const hint = $('cacheSizeHint');
  if (!hint) return;
  if (!info) { hint.textContent = '统计不了缓存占用'; return; }
  hint.textContent = info.count
    ? '当前占用 ' + bytes(info.bytes) + '（' + count(info.count) + ' 项）'
    : '还没有缓存内容';
}

/* ---------- 数据体检：批量体检、两次对比、诊断包 ----------
   命令行 --check / --diff / --diagnose 能做的，界面上也得能做：
   选一个文件或文件夹 → 开结论清单，自动和上一次的报告比，诊断包一键导出。
   报告由引擎存在配置目录的 checks/last.json，下一次体检自动拿它当对照 */

/* 体检结论的三档：有问题 / 要留意 / 未发现问题。文字给分组标题，图标标在分组前。
   形状各不同（圆叹号 / 三角 / 对勾），缩成一行也分得清。
   早先还有一档"提一句"，实操里和"要留意"分不开，合并成三档 */
const LEVEL_TEXT = { bad: '有问题', warn: '要留意', ok: '未发现问题' };
/* 档位图标：一律实心填充，勾与感叹号是"挖掉"的负空间（fill-rule=evenodd）。
   原来那套是描边，15px 下 1.5px 的线糊成一团，三角形里到底画了什么看不清——
   挖空的做法在深浅两种底色上都清楚 */
const LEVEL_ICON = {
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.85 3.4h1.7v5.1h-1.7zm.85 6.3a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M7.26 2.5a.86.86 0 0 1 1.48 0l5.9 10.5a.86.86 0 0 1-.74 1.3H2.1a.86.86 0 0 1-.74-1.3zM7.3 5.6h1.4v4.2H7.3zm.7 5a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z"/></svg>',
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.6 4.2l1.2 1.2-5.4 5.5-3.3-3.3 1.2-1.2 2.1 2.1z"/></svg>',
};
const LEVEL_ORDER = ['bad', 'warn', 'ok'];

/* 顶栏按钮的激活态：哪个面板开着，对应的按钮就亮着，关掉自动落回原样。
   三颗按钮共用这一条，免得各写各的 class 名 */
function markBtn(id, on) {
  const b = $(id);
  if (b) b.classList.toggle('on', !!on);
}

/* 体检输入框跟着当前文件走：换了图层/换了文件，框里就该是这一份。
   只在用户没动过它的时候跟着换——空着，或者还是上次自动填的那个路径；
   自己敲过别的路径说明是有意要查别处，不能替他改掉 */
let checkPrefill = '';

function samePath(a, b) {
  return tidyPath(a).replace(/\\+$/, '').toLowerCase() === tidyPath(b).replace(/\\+$/, '').toLowerCase();
}

function syncCheckInput(path) {
  const input = $('checkPath');
  if (!input) return;
  const typed = input.value.trim();
  if (typed && typed !== checkPrefill) return;
  input.value = String(path || '');
  checkPrefill = input.value;
}

/* 体检浮层：顶栏那颗按钮点开。输入和结果在同一块里——
   结果直接长在输入框下面，换个文件接着查时不用先关一个窗口再开一个 */
function showCheckPop() {
  const pop = $('checkPop');
  const btn = $('checkBtn');
  if (!pop || !btn) return;
  if (convBusy) return;   // 互转跑着不让换台，两块浮层叠着点不准
  hideRecent();
  hidePickPop();
  hideConvPop();
  placeCheckPop();
  pop.hidden = false;
  markBtn('checkBtn', true);
  const input = $('checkPath');
  if (input) input.focus();
  /* 关掉即清空，所以每次打开都得重新查一遍才有东西看。
     框里是当前这一份（空着，或者刚才自动填的、或者手敲的同一个路径）就直接查；
     手敲的是别处，就只给一句"回车重查"，不替用户决定要不要再扫一遍大目录 */
  const cur = (current && current.path) || '';
  const typed = input ? input.value.trim() : '';
  if (!typed) {
    if (cur) {
      input.value = cur;
      checkPrefill = cur;
      runCheck();
    }
  } else if (cur && samePath(typed, cur)) {
    checkPrefill = cur;
    runCheck();
  } else {
    setHint('按回车键重新体检');
  }
}

/* 体检浮层的定位：贴着顶栏"数据体检"按钮下方，左右夹回窗口内。
   显示与重摆共用：窗口缩放时开着的话按新锚点重摆一遍 */
function placeCheckPop() {
  const pop = $('checkPop');
  const btn = $('checkBtn');
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 560;
  pop.style.left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
}

/* 壳那边按"对选中项体检"的快捷键：把资源管理器里选中的路径整批发过来，
   开浮层直接查。选中的是文件夹就按文件夹查——与在输入框里填路径是同一件事。
   界面还没初始化完就先攒着，等就绪了再跑 */
let pendingCheck = [];

function checkPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  const input = $('checkPath');
  if (input) input.value = list[0];
  // 先开浮层再查：showCheckPop 看到输入框非空只会给一句"回车重查"，
  // 不会自己再跑一遍，省得同一次体检跑两回
  showCheckPop();
  runCheck(list);
}

window.GisCheckPaths = function (paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  if (!pageReady) { pendingCheck = list; return; }
  checkPaths(list);
};



/* 体检在跑的时候：盖上薄幕、转圈、关不掉。忙完自动撤掉 */
let checkBusy = false;

function setCheckBusy(on) {
  checkBusy = !!on;
  const mask = $('checkBusy');
  if (mask) mask.hidden = !on;
}

/* 关掉就把上一次的结论一起收掉：留着会让人以为那是刚查的。
   输入框里的路径留着，同一个位置再查一次不用重新粘。
   体检进行中不允许关：结果还没回来就关掉，用户会以为白跑一趟 */
function hideCheckPop() {
  if (checkBusy) return;
  const pop = $('checkPop');
  if (pop) pop.hidden = true;
  markBtn('checkBtn', false);
  const list = $('chkList');
  const res = $('checkResult');
  const dg = $('diagBtn');
  if (list) list.textContent = '';
  if (res) res.hidden = true;
  if (dg) dg.hidden = true;
  setHint('');
}

/* 浮层标题行左侧那句提示：导出完成、体检失败都走这里。
   单行显示，超长省略；只有真被省略号截掉了才挂气泡——"按回车键重新体检"这类短句
   本来就看得全，再悬停出来一遍只是重复。 */
function setHint(text) {
  const hint = $('checkHint');
  if (!hint) return;
  hint.textContent = text || '';
  hint.removeAttribute('data-tip');
  if (text) hint.setAttribute('aria-label', text);
  else hint.removeAttribute('aria-label');
  if (!text) return;
  /* 量一下有没有被省略号截掉：读 scrollWidth 会强制排版，当场就能判断，不必等下一帧
     （窗口最小化时 requestAnimationFrame 会被挂起，等帧那一套在这里靠不住）。
     浮层关着时宽度是 0，这时也不挂——看不见也就悬停不到 */
  if (hint.clientWidth > 0 && hint.scrollWidth > hint.clientWidth + 1) {
    hint.setAttribute('data-tip', text);
  }
}

function toggleCheckPop() {
  const pop = $('checkPop');
  if (pop && !pop.hidden) hideCheckPop();
  else showCheckPop();
}

/* 结果区两种形态，按查了几个数据自动切：
   查一个文件 → 完整体检表（逐项都列，通过的也写清楚）；
   查文件夹 → 按档位分组的手风琴，没问题的整组收起。
   摘要在两种形态里都没有：分组标题自带条数，再写一行"要留意 4"就是重复 */
function renderCheck(d) {
  const list = $('chkList');
  list.textContent = '';
  const files = d.files || [];
  if (files.length === 1 && (files[0].rows || []).length) renderReport(files[0], list);
  else renderGroups(files, list);
}

/* ---- 形态一：文件夹，按档位分组 ---- */
function renderGroups(files, host) {
  const buckets = { bad: [], warn: [], ok: [] };
  files.forEach((f) => { (buckets[f.level] || buckets.ok).push(f); });
  LEVEL_ORDER.forEach((lv) => {
    const rows = buckets[lv];
    if (!rows.length) return;
    const grp = document.createElement('div');
    grp.className = 'chk-grp';
    // 没问题的默认收起：几百条通过的条目铺开，只会把真问题冲得看不见
    if (lv === 'ok') grp.classList.add('folded');

    const hd = document.createElement('div');
    hd.className = 'chk-grp-hd';
    hd.setAttribute('role', 'button');
    hd.tabIndex = 0;
    hd.setAttribute('aria-label', '收起或展开这一组');
    const ico = document.createElement('i');
    // 档位色由 lv- 前缀决定（红 / 橙 / 绿）。早先只写 chk-ico，图标只好继承标题的
    // 强调色，三种档位在列表里长得一模一样
    ico.className = 'chk-ico lv-' + lv;
    setSVG(ico, LEVEL_ICON[lv]);
    hd.appendChild(ico);
    hd.appendChild(el('span', 'chk-grp-name', LEVEL_TEXT[lv]));
    hd.appendChild(el('span', 'chk-grp-n', String(rows.length)));
    hd.appendChild(el('span', 'chk-caret'));

    const body = document.createElement('div');
    body.className = 'chk-grp-body';
    rows.forEach((f) => body.appendChild(fileRow(f)));

    const flip = () => grp.classList.toggle('folded');
    hd.addEventListener('click', flip);
    hd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
    grp.appendChild(hd);
    grp.appendChild(body);
    host.appendChild(grp);
  });
}

/* 一个数据在列表里：先是名字，再是几行"项目 + 结论"。
   名字前面不再挂图标——档位已经由分组标题说过了，每行再挂一遍只是重复 */
function fileRow(f) {
  const box = el('div', 'chk-file');
  box.appendChild(el('div', 'chk-name', f.name));
  if (f.level === 'ok') return box;
  const items = (f.items || []).filter((it) => it.level !== 'ok');
  if (!items.length) return box;
  const wrap = el('div', 'chk-items');
  items.forEach((it) => {
    const row = el('div', 'chk-item');
    // 项目名固定成短标签（坐标系、图层结构……），结论跟在后面：
    // 早先把整句结论放在标签位上，"一个图层里混着多种几何类型"占掉 156px，说明只剩一半宽
    row.appendChild(el('span', 't', it.cat_label || ''));
    row.appendChild(el('span', '', it.title || ''));
    wrap.appendChild(row);
  });
  box.appendChild(wrap);
  return box;
}

/* ---- 形态二：单个文件，完整体检表 ---- */
function renderReport(f, host) {
  const facts = (f.facts || []).join(' · ');
  if (facts) host.appendChild(el('div', 'chk-meta', facts));
  (f.rows || []).forEach((r) => {
    const row = el('div', 'chk-row');
    const lab = el('div', 'chk-row-lab');
    const ico = el('i', 'chk-ico lv-' + r.level);
    setSVG(ico, LEVEL_ICON[r.level] || LEVEL_ICON.ok);
    lab.appendChild(ico);
    lab.appendChild(el('span', '', r.label || ''));
    const val = el('div', 'chk-row-val');
    val.appendChild(el('div', 'chk-row-t', r.title || ''));
    if (r.detail) val.appendChild(el('div', 'chk-row-d', r.detail));
    if (r.hint) val.appendChild(el('div', 'chk-row-h', '建议：' + r.hint));
    row.appendChild(lab);
    row.appendChild(val);
    host.appendChild(row);
  });
}

/* 体检要查哪个：输入框优先，留空则查当前打开的那份。
   快捷键送进来的多选路径走 batch，一次把选中的几个都查了——
   资源管理器里框住三个文件按快捷键，只查第一个等于丢了两份 */
function checkTarget() {
  const input = $('checkPath');
  return (input && input.value.trim()) || (current && current.path) || '';
}

function runCheck(batch) {
  const many = (Array.isArray(batch) ? batch : []).filter(Boolean);
  const path = many.length ? many[0] : checkTarget();
  if (!path) { setHint('请先填写文件或文件夹路径'); return; }
  const input = $('checkPath');
  if (input) input.value = path;
  setHint('');
  const dg = $('diagBtn');
  if (dg) dg.hidden = true;
  setCheckBusy(true);
  fetch('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: many.length ? many : [path] }),
  }).then((r) => r.json()).then((d) => {
    setCheckBusy(false);
    /* 体检跑着的时候浮层可能已经被关掉了：结果不再往关闭的浮层里写，
       否则下次打开会冒出一份"上一次的结论"，跟"关掉即清空"就矛盾了 */
    const pop = $('checkPop');
    if (!pop || pop.hidden) return;
    if (!d || !d.ok) {
      setHint((d && d.error && d.error.title) || '体检未能完成');
      return;
    }
    const n = (d.files || []).length;
    renderCheck(d);
    $('checkResult').hidden = !n;
    if (!n) setHint('该位置未找到可体检的数据');
    // 有结论了才给"导出诊断包"：它导出的就是这一份
    if (dg) dg.hidden = !n;
  }).catch(() => {
    setCheckBusy(false);
    const pop = $('checkPop');
    if (!pop || pop.hidden) return;
    setHint('体检未能完成，请稍后重试');
  });
}

/* 诊断包：环境信息与"刚跑完的这份体检结论"打成 zip，反馈问题时发出去。
   服务端直接取上一次体检落盘的结果，不重新扫一遍，导出的就是屏幕上这份 */
function runDiagnose() {
  setHint('正在生成诊断包…');
  fetch('/api/diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json()).then((d) => {
    if (!d || !d.ok) {
      setHint((d && d.error && d.error.title) || '诊断包未能生成');
      return;
    }
    setHint('已导出 ' + (d.size_label || '') + '，已在资源管理器中选中');
    toShell('revealfile:' + d.path);
  }).catch(() => setHint('诊断包未能生成，请稍后重试'));
}

/* ---------- 矢量格式互转浮层 ----------
   输入文件、待转图层、输出格式、文件后缀、输出目录五件事都在一块浮层里。
   转换前先跑一遍预检（dry）：给格式的已知代价、这份数据的警告、转换前概况；
   转换后给出要素数、字段数、几何、坐标系的前后对比。 */

let convFormats = null;   // [{key,label,note}]，问一次引擎就缓存
let convDryTimer = 0;
let convBusy = false;
let convPathDirty = false;   // 用户在浮层里手填过输入文件：这时不再跟着地图走
let convOutPicked = false;   // 用户自己选过输出目录：之后不再跟着输入文件走
let convDrySig = '';         // 上一次预检的参数指纹
let convDryDone = false;     // 指纹对应的结果已经拿到
let convDrySeq = 0;          // 请求序号：晚到的旧响应直接丢弃
let convReady = false;       // 预检通过才允许点"开始转换"（栅格、路径不存在都算没通过）

function convDefaultTarget() {
  const d = current && current.data;
  // 压缩包里的图层是 /vsizip/... 那种成员路径：转换要针对成员，不能拿包本身去转
  return (d && geomTypesTarget(d)) || (current && current.path) || '';
}

/* 输入文件给人看的是压缩包本身，包里的哪一份交给「待转图层」选。
   引擎那边 .zip + 图层序号 与 /vsizip/包/成员 两条路都认 */
function convDisplayPath(p) {
  const s = String(p || '');
  const i = s.toLowerCase().indexOf('.zip/');
  return (i > 0 && s.toLowerCase().startsWith('/vsizip/')) ? s.slice(8, i + 4) : s;
}

/* 地图换了数据（开了新文件、改看压缩包里的另一个成员）就让输入文件跟过去。
   用户正在浮层里手填时不抢——那条路径是他自己挑的 */
function syncConvSource() {
  const input = $('convPath');
  if (!input || convPathDirty) return;
  const cur = convDisplayPath(convDefaultTarget());
  if (!cur || input.value === cur) return;
  input.value = cur;
  clearConvResult();
  const pop = $('convPop');
  if (pop && !pop.hidden) convLoadLayers(true);
}

function convTargetPath() {
  const input = $('convPath');
  return (input && input.value.trim()) || convDefaultTarget();
}

/* 文件后缀：直接接在输入文件名后面，留空由引擎按 _转出 处理 */
/* 落点就是那一行路径本身：预检中、未通过都留空（状态行已经说明原因了） */
function paintConvOutHint(text) {
  const box = $('convOutHint');
  if (!box) return;
  const one = text || '';
  box.textContent = one;
  // 悬停用软件自己的气泡（data-tip 是全局代理的，动态改也立刻生效）
  if (one) box.setAttribute('data-tip', one);
  else box.removeAttribute('data-tip');
}

/* 输出目录默认就是输入文件所在目录：直接填进框里，比留一句"默认与输入文件相同"清楚 */
function convDefaultOutDir() {
  const p = convTargetPath();
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i > 0 ? norm.slice(0, i).replace(/\//g, '\\') : '';
}

function syncConvOutDir() {
  if (convOutPicked) return;
  const box = $('convOut');
  const dir = convDefaultOutDir();
  if (box && dir && box.value !== dir) box.value = dir;
}

/* 后缀只能是文件名里能出现的字符：路径分隔符、通配符、冒号之类一律不收 */
const CONV_SUFFIX_RE = /^[\w\-.\u4e00-\u9fa5]{0,40}$/;

function convSuffixValid() {
  return CONV_SUFFIX_RE.test(convSuffixValue());
}

function convSuffixValue() {
  const box = $('convSuffix');
  return (box && box.value.trim()) || '';
}

/* 允许覆盖：勾上之后引擎先删旧的连伴生文件一起，再写新的 */
function convOverwrite() {
  const box = $('convOver');
  return !!(box && box.checked);
}

function convLayerIndex() {
  const sel = $('convLayer');
  const v = sel && sel.value ? parseInt(sel.value, 10) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function convFmtKey() {
  const sel = $('convFmt');
  return (sel && sel.value) || 'geojson';
}

const CONV_WARN_ICO = 'M13.27 3.33c-.56-.97-1.98-.97-2.54 0l-9.2 15.94C.97 20.24 1.68 21.5 2.8 21.5h18.4c1.12 0 1.83-1.26 1.27-2.23l-9.2-15.94zM12 8.4c-.46 0-.82.4-.79.85l.28 4.6c.03.53.47.95 1 .95h.02c.53 0 .97-.42 1-.95l.28-4.6c.03-.45-.33-.85-.79-.85h-1zm.5 8.05a1.15 1.15 0 110 2.3 1.15 1.15 0 010-2.3z';
const CONV_ERR_ICO = 'M12 2a10 10 0 100 20 10 10 0 000-20zm-1.1 4.6h2.2v7.2h-2.2V6.6zm0 9h2.2v2.2h-2.2v-2.2z';

/* 一条说明：与地图底栏同一套写法——一枚 13px 图标加一行字，不套底色、不单靠颜色分辨 */
/* 一条提示/错误：图标 + 标题，可选第二行说明。类名别叫 err —— 全局 .err
   带底色与描边，套上去会画成一整块红框（第一版就是这么翻的） */
function convMsg(kind, text, detail) {
  const row = el('div', 'cv-msg' + (kind === 'err' ? ' cv-bad' : ''));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'mn-ico');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill-rule', 'evenodd');
  p.setAttribute('clip-rule', 'evenodd');
  p.setAttribute('d', kind === 'err' ? CONV_ERR_ICO : CONV_WARN_ICO);
  svg.appendChild(p);
  row.appendChild(svg);
  const body = el('div', 'cv-msg-body');
  body.appendChild(el('div', 'cv-msg-t', text));
  if (detail) body.appendChild(el('div', 'cv-msg-d', detail));
  row.appendChild(body);
  return row;
}

function convStatusBox() { return $('convStatus'); }

function clearConvStatus() {
  const box = convStatusBox();
  if (box) box.textContent = '';
}

/* 错误：一句结论加一句该怎么办，都落在输出目录下方，不往标题旁边挤 */
function convError(title, hint) {
  const box = convStatusBox();
  if (!box) return;
  box.textContent = '';
  // 标题与说明同在一张块里：以前说明另起一行灰字，跟标题隔着半屏，读着是两件事
  if (title) box.appendChild(convMsg('err', title, hint || ''));
}

/* 与体检浮层同一套定位：贴着"格式互转"按钮下方，左右夹回窗口内 */
function placeConvPop() {
  const pop = $('convPop');
  const btn = $('convBtn');
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 520;
  pop.style.left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
}

function showConvPop() {
  const pop = $('convPop');
  const btn = $('convBtn');
  if (!pop || !btn) return;
  if (checkBusy) return;   // 体检跑着不让换台
  hideRecent();
  hidePickPop();
  hideCheckPop();
  placeConvPop();
  // 格式说明先画好再露出来：不然浮层先按"没有说明"的高度出现，紧接着长高两行
  loadConvFormats();
  pop.hidden = false;
  markBtn('convBtn', true);
  // 输入文件默认跟地图走：手填过就尊重手填，没填过就同步成当前数据
  const input = $('convPath');
  if (input && !convPathDirty) {
    const cur = convDisplayPath(convDefaultTarget());
    if (cur) input.value = cur;
  }
  syncConvOutDir();
  updateConvRun();
  /* 格式清单就绪后再预检：清单没到之前只能猜一个默认格式，猜错会先闪一张错误卡片 */
  loadConvFormats().then((ready) => {
    if (!ready || !pop || pop.hidden) return;
    convLoadLayers(true);
  });
}

function hideConvPop() {
  if (convBusy) return;
  const pop = $('convPop');
  if (pop) pop.hidden = true;
  markBtn('convBtn', false);
  /* 关掉浮层就把"手填过"的标记清掉：不然用户在浮层里改过一次路径，
     之后开任何文件它都不再跟着地图走了，直到重启 */
  convPathDirty = false;
}

function toggleConvPop() {
  const pop = $('convPop');
  if (pop && !pop.hidden) hideConvPop();
  else showConvPop();
}

function loadConvFormats() {
  const sel = $('convFmt');
  if (!sel) return Promise.resolve(false);
  if (convFormats) { paintConvFmt(); return Promise.resolve(true); }
  return fetch('/api/convert_formats').then((r) => r.json()).then((d) => {
    convFormats = (d && d.ok && d.formats) || [];
    paintConvFmt();
    convScheduleDry();
    return true;
  }).catch(() => {
    convError('无法读取格式清单。', '请关闭浮层后重试。');
    return false;
  });
}

function paintConvFmt() {
  const sel = $('convFmt');
  sel.textContent = '';
  let last = '';
  try { last = localStorage.getItem('gisviewer.conv_fmt') || ''; } catch { /* 存不了就用默认 */ }
  (convFormats || []).forEach((f) => {
    const o = el('option', null, f.label);
    o.value = f.key;
    sel.appendChild(o);
  });
  if (last && (convFormats || []).some((f) => f.key === last)) sel.value = last;
  // 下拉的可见部分是 combo 按钮，换完 options 得让它把标签重画一遍
  if (window.syncSelect) window.syncSelect(sel);
  const fmt = (convFormats || []).find((f) => f.key === sel.value);
  const note = $('convFmtNote');
  if (note) note.textContent = (fmt && fmt.note) || '';
}

/* 压缩包里的每一项是包内的一个文件，用文件名比用图层名更好认 */
function convLayerName(l, i) {
  return (l && (l.member || l.name)) || ('图层 ' + (i + 1));
}

/* 图层清单：源就是当前打开的这份就直接用内存里的；换了个路径再问引擎。
   immediate=true 表示这是刚打开浮层，预检不用等防抖（否则浮层会先矮后高抖一下） */
function convLoadLayers(immediate) {
  const sel = $('convLayer');
  if (!sel) return;
  const path = convTargetPath();
  const cur = current || {};
  const layers = cur.data && cur.data.ok ? (cur.data.layers || []) : [];
  if (cur.path && samePath(path, cur.path) && layers.length) {
    fillConvLayers(layers.map((l, i) => ({ index: i, name: convLayerName(l, i) })), immediate);
    return;
  }
  if (!path) { fillConvLayers([], immediate); return; }
  fetch('/api/path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, fast: true }),
  }).then((r) => r.json()).then((d) => {
    const list = (d && d.ok && d.layers) || [];
    fillConvLayers(list.map((l, i) => ({ index: i, name: convLayerName(l, i) })), immediate);
  }).catch(() => fillConvLayers([], immediate));
}

function fillConvLayers(items, immediate) {
  const sel = $('convLayer');
  if (!sel) return;
  sel.textContent = '';
  const list = items || [];
  if (!list.length) {
    const o = el('option', null, '默认图层');
    o.value = '0';
    sel.appendChild(o);
  } else {
    list.forEach((l) => {
      const o = el('option', null, l.name);
      o.value = String(l.index);
      sel.appendChild(o);
    });
  }
  if (window.syncSelect) window.syncSelect(sel);
  if (immediate) {
    clearTimeout(convDryTimer);
    runConvDry();
  } else {
    convScheduleDry();
  }
}

function convScheduleDry() {
  clearTimeout(convDryTimer);
  convDryTimer = setTimeout(runConvDry, 250);
}

/* 预检的参数指纹：一模一样的输入不重算——每次开浮层都重跑一遍，
   界面就会先清空再填回来，看着就是闪 */
function convSignature() {
  return [convTargetPath(), convLayerIndex(), convFmtKey(), convSuffixValue(),
    ($('convOut') || {}).value || '', convOverwrite() ? '1' : '0'].join('\u0001');
}

/* 换了输入文件、图层、格式、后缀、覆盖开关或输出目录，上一次的结果就对不上当前设置 */
function clearConvResult() {
  convDryDone = false;
  clearConvStatus();
  paintConvOutHint('');
  updateConvRun();
}

/* 预检：数据概况跟着输入文件，格式说明跟着输出格式，落点路径与警告跟着输出目录 */
function runConvDry() {
  const sum = $('convSrcSum');
  const box = convStatusBox();
  if (!sum || !box) return;
  // 格式清单还没到：此时无从判断"能不能转"，先不算，免得先弹一张错误的卡片
  if (!convFormats) return;
  const sig = convSignature();
  if (sig === convDrySig && convDryDone) return;
  const path = convTargetPath();
  const fmtKey = convFmtKey();
  const fmt = (convFormats || []).find((f) => f.key === fmtKey);
  const note = $('convFmtNote');
  if (note) note.textContent = (fmt && fmt.note) || '';
  /* 不清空上一次的概况与状态：清空会让浮层先缩一下、结果回来再长回去，看着就是抖两下。
     新结果到了原地替换即可；这里只把按钮先按下去，防止趁预检间隙点下去 */
  convReady = false;
  updateConvRun();
  if (!path) {
    if (sum.textContent) sum.textContent = '';
    clearConvStatus();
    paintConvOutHint('');
    sum.textContent = '尚未选择输入文件。';
    return;
  }
  /* 后缀不合法就别问引擎了：文件名都拼不出来，落点自然也没有 */
  if (!convSuffixValid()) {
    paintConvOutHint('');
    convError('文件后缀不合法', '只能包含字母、数字、汉字、下划线、连字符与点，不能带路径分隔符或通配符。');
    return;
  }
  const seq = ++convDrySeq;
  fetch('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path, layer: convLayerIndex(), fmt: fmtKey, dry: true,
      suffix: convSuffixValue(), overwrite: convOverwrite(),
    }),
  }).then((r) => r.json()).then((d) => {
    if (seq !== convDrySeq) return;                 // 已经有更新的一次预检在跑，这次作废
    if (sig !== convSignature()) return;            // 参数在等待期间变了，结果对不上
    if ($('convPop') && $('convPop').hidden) return;
    convDrySig = sig;
    convDryDone = true;
    const box2 = convStatusBox();
    const sum2 = $('convSrcSum');
    if (!box2 || !sum2) return;
    box2.textContent = '';
    if (!d || !d.ok) {
      const err = (d && d.error) || {};
      sum2.textContent = '';
      convReady = false;
      updateConvRun();
      paintConvOutHint('');
      convError(err.title || '预检未通过。', err.hint);
      return;
    }
    const b = d.before || {};
    convReady = true;
    updateConvRun();
    sum2.textContent = [
      b.feature_count + ' 个要素',
      b.field_count + ' 个字段',
      b.geometry || '几何未知',
      b.crs || '坐标系未记录',
    ].join(' · ');
    // 落点直接给完整路径，就在页脚那一行的最左侧
    paintConvOutHint(d.out_path || '');
    (d.warnings || []).forEach((w) => box2.appendChild(convMsg('warn', w)));
  }).catch(() => {
    const sum2 = $('convSrcSum');
    if (sum2) sum2.textContent = '';
    convReady = false;
    updateConvRun();
    convError('预检没能完成。', '请确认引擎在运行，然后重试。');
  });
}

/* 主按钮只有"输入文件填了"才亮：空着点它没有任何意义，置灰比点完弹一句提示好 */
function updateConvRun() {
  const btn = $('convRun');
  if (!btn) return;
  // 有路径还不够：预检得真的通过。自动填进来的栅格文件就不会亮起来
  const hasPath = !!convTargetPath();
  const ready = hasPath && convReady;
  btn.disabled = convBusy || !ready;
  // 气泡挂在外面那层 span 上：禁用的按钮收不到 hover，自己带 data-tip 也弹不出来
  const wrap = $('convRunWrap');
  if (wrap) {
    if (ready) wrap.removeAttribute('data-tip');
    else wrap.setAttribute('data-tip', hasPath
      ? '预检未通过：先按上面的提示处理，才能开始转换'
      : '先选一个输入文件：输入文件是唯一的必填项');
  }
}

function setConvBusy(on) {
  convBusy = !!on;
  const mask = $('convBusy');
  if (mask) mask.hidden = !on;
  updateConvRun();
}

function runConv() {
  const path = convTargetPath();
  if (!path) { convError('未填写输入文件。', '请先选择要转换的文件。'); return; }
  const out = $('convOut');
  setConvBusy(true);
  fetch('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      layer: convLayerIndex(),
      fmt: convFmtKey(),
      out_dir: (out && out.value.trim()) || null,
      suffix: convSuffixValue(),
      overwrite: convOverwrite(),
    }),
  }).then((r) => r.json()).then((d) => {
    setConvBusy(false);
    if ($('convPop') && $('convPop').hidden) return;
    if (!d || !d.ok) {
      renderConvError(d && d.error);
      return;
    }
    renderConvResult(d);
  }).catch(() => {
    setConvBusy(false);
    convError('转换未完成。', '请重试。');
  });
}

function renderConvError(err) {
  convError((err && err.title) || '转换未完成。', err && err.hint);
}

/* 输出文件后面那两枚按钮：用默认程序打开、在资源管理器中显示。
   只在转换成功、拿到真实路径之后才建，失败时压根没有 */
function convOpenBtns(path) {
  const wrap = el('span', 'cv-out-acts');
  if (!path) return wrap;
  const mk = (cls, tip, svg, msg) => {
    const b = el('button', 'cv-out-btn ' + cls);
    b.type = 'button';
    b.setAttribute('data-tip', tip);
    b.setAttribute('aria-label', tip);
    setSVG(b, svg);
    b.addEventListener('click', () => toShell(msg + path));
    return b;
  };
  wrap.appendChild(mk('open', '用默认程序打开',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18.5 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
    'openfile:'));
  wrap.appendChild(mk('reveal', '在资源管理器中显示',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h9A1.5 1.5 0 0 1 21 9.5v7A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5z"/></svg>',
    'revealfile:'));
  return wrap;
}

function renderConvResult(d) {
  const box = convStatusBox();
  if (!box) return;
  box.textContent = '';
  // 结果行里已经给了完整路径，底栏那行再写一遍就是重复
  paintConvOutHint('');
  const table = el('table', 'cv-cmp');
  const head = el('tr');
  ['项目', '转换前', '转换后'].forEach((t) => head.appendChild(el('th', null, t)));
  table.appendChild(head);
  (d.compare || []).forEach((row) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, row.name));
    const a = el('td', typeof row.before === 'number' ? 'num' : null, row.before);
    const cls = row.same ? 'cv-same' : 'cv-diff';
    const b = el('td', (typeof row.after === 'number' ? 'num ' : '') + cls, row.after);
    tr.appendChild(a);
    tr.appendChild(b);
    table.appendChild(tr);
  });
  box.appendChild(table);
  const outs = (d.out_paths && d.out_paths.length) ? d.out_paths : (d.out_path ? [d.out_path] : []);
  const out = el('div', 'cv-line');
  out.appendChild(el('b', null, outs.length > 1 ? '输出文件（按几何类型分开）：' : '输出文件：'));
  out.appendChild(document.createTextNode(outs[0] || ''));
  out.appendChild(convOpenBtns(outs[0]));
  box.appendChild(out);
  outs.slice(1).forEach((pth) => {
    const row = el('div', 'cv-line cv-indent');
    row.appendChild(document.createTextNode(pth));
    row.appendChild(convOpenBtns(pth));
    box.appendChild(row);
  });
  (d.warnings || []).forEach((w) => box.appendChild(convMsg('warn', w)));
}

function refreshCacheSize() {
  const hint = $('cacheSizeHint');
  if (hint) hint.textContent = '正在统计…';
  fetch('/api/cache').then((r) => r.json()).then((d) => {
    if (d && d.ok) paintCacheSize(d.cache, d.cache_dir || d.data_dir);
    else paintCacheSize(null);
  }).catch(() => paintCacheSize(null));
}

/* 矢量与范围线的颜色走 CSS 变量，改完让地图重取一次调色板 */
function applyDataColor() {
  const hex = /^#[0-9a-fA-F]{6}$/.test(config.vector_color) ? config.vector_color : '#d9781f';
  const rgb = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16)).join(', ');
  const root = document.documentElement.style;
  root.setProperty('--map-data', hex);
  root.setProperty('--map-extent', hex);
  root.setProperty('--map-fill', 'rgba(' + rgb + ', 0.18)');
  const swatch = $('cfgColorSwatch');
  if (swatch) swatch.style.background = hex;
  if (window.GisMap) GisMap.themeChanged();
}

/* ---------- 外观：字体、字号、面板不透明度 ---------- */

const UI_TAIL = '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif';
const NUM_TAIL = 'Arial, "Noto Sans SC", sans-serif';

function uiZoom() {
  const z = Number(config.ui_zoom) || 100;
  return z >= 80 && z <= 150 ? z / 100 : 1;
}

/* 字体名里的引号和逗号会打乱 CSS 的族列表，先剔掉再拼回退链 */
function fontFace(name, tail) {
  const clean = String(name || '').replace(/["'\\;,]/g, '').trim();
  return clean ? '"' + clean + '", ' + tail : tail;
}

function applyLook() {
  const root = document.documentElement.style;
  const alpha = Number(config.panel_alpha) || 93;
  root.setProperty('--panel-alpha', (Math.min(100, Math.max(60, alpha)) / 100).toFixed(2));
  root.setProperty('--ui-zoom', String(uiZoom()));
  root.setProperty('--font-ui', fontFace(config.ui_font, UI_TAIL));
  root.setProperty('--font-num', fontFace(config.num_font, NUM_TAIL));
  syncMapHeight();   // 界面缩放改了，图例能长多高要按新缩放重算
  paintView();   // 比例尺的条长跟字号有关，改完立刻重画一次
}

/* ---------- 和原生壳之间的那根线 ---------- */

function toShell(msg) {
  if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg);
}

/* 置顶只有一个来源：config.always_on_top。
   顶栏那颗按钮、设置里那个勾选、壳的窗口状态，三处都照它画。
   改完要告诉壳（tell=true），开机读配置那次也要告诉，否则壳不知道要置顶 */
function applyTopMost(on, tell) {
  config.always_on_top = !!on;
  const btn = $('winTop');
  const box = $('cfgTopMost');
  if (btn) {
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const tip = on ? '窗口已置顶：再点一下取消' : '窗口置顶：始终显示在其他窗口之上';
    btn.setAttribute('data-tip', tip);
    btn.setAttribute('aria-label', tip);
  }
  if (box) box.checked = !!on;
  if (tell) toShell('ontop:' + (on ? '1' : '0'));
}

/* 字体、自启状态、快捷键、有没有新版，这四件事只有壳知道 */
const host = { fonts: null, autoStart: null, deskLnk: null, hotkey: '', hotkey2: '', hotkey3: '', menuExt: [] };
let hkSynced = false;
let configLoaded = false;

window.GisHost = function (name, value) {
  if (name === 'fonts') {
    host.fonts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    fillFontSelects();
    return;
  }
  if (name === 'dir') {
    // 壳那边选完文件夹回传的路径：看是谁发起的，填进对应的输入框
    const where = dirPickTarget === 'check' ? $('checkPath')
      : dirPickTarget === 'conv' ? $('convOut')
      : dirPickTarget === 'cache' ? $('cfgCache')
      : dirPickTarget === 'cachedir' ? $('cachePath') : $('cfgOpenDir');
    const fromCheck = dirPickTarget === 'check';
    dirPickTarget = '';
    if (where) {
      where.value = String(value || '');
      if (where.id === 'cfgOpenDir' || where.id === 'cfgCache' || where.id === 'cachePath') {
        if (where.id === 'cachePath') cachePickIntent = where.value.trim();
        applySettings();
        if (where.id === 'cfgOpenDir') paintOpenDirStatus();
        else if (where.id === 'cfgCache') paintCacheDirStatus();
        else paintCachePathStatus();
        syncDirClearBtns();
      }
    }
    if (fromCheck && where && where.value.trim()) runCheck();
    return;
  }
  // 体检里"选择文件"回传：填进路径框，接着就查。互转的选文件共用这一条回传，
  // 按谁发起的分路（pickcheck 只是"挑一个数据文件"，跟用途无关）
  if (name === 'checkpath') {
    const toConv = filePickTarget === 'conv';
    filePickTarget = '';
    const where = toConv ? $('convPath') : $('checkPath');
    if (where) {
      where.value = String(value || '');
      if (toConv) { convLoadLayers(); }
      else if (where.value.trim()) runCheck();
    }
    return;
  }
  if (name === 'autoStart') { host.autoStart = value === 'on'; $('cfgAutoStart').checked = host.autoStart; return; }
  if (name === 'deskLnk') { host.deskLnk = value === 'on'; $('cfgDeskLnk').checked = host.deskLnk; return; }
  // 壳回报右键菜单现在是不是挂着：开关要跟着注册表走，不能只信本地配置
  if (name === 'ctxmenu') {
    const on = value === 'on';
    const box = $('cfgCtxMenu');
    if (box) box.checked = on;
    return;
  }
  /* 三套全局快捷键的回报：hotkey / hotkey2 / hotkey3 是当前值，
     带 Ok 是刚改成功，带 Failed 是新组合键被占了、壳已经退回旧的 */
  const hotNo = { hotkey: 1, hotkeyOk: 1, hotkeyFailed: 1,
    hotkey2: 2, hotkey2Ok: 2, hotkey2Failed: 2,
    hotkey3: 3, hotkey3Ok: 3, hotkey3Failed: 3 }[name];
  if (hotNo) {
    const row = HK_ROWS[hotNo];
    if (name.indexOf('Ok') > 0) {
      host[row.host] = String(value || '');
      paintHotkey(hotNo);
      $(row.hint).textContent = row.ok.replace('%s', host[row.host]);
      return;
    }
    if (name.indexOf('Failed') > 0) {
      $(row.hint).textContent = value + ' 被别的软件占着，已经退回 ' +
        host[row.host] + '，换一组试试。';
      return;
    }
    host[row.host] = String(value || '');
    paintHotkey(hotNo);
    trySyncHotkey();
    return;
  }
  if (name === 'autoStartState' || name === 'deskLnkState') {
    const auto = name === 'autoStartState';
    const box = auto ? $('cfgAutoStart') : $('cfgDeskLnk');
    const bad = String(value).indexOf('error') === 0;
    const on = !bad && value === 'on';
    box.checked = on;
    if (auto) host.autoStart = on; else host.deskLnk = on;
    sysNote(bad ? (auto ? '开机自启没改成：' : '桌面上的快捷方式没改成：') +
      (String(value).slice(6) || '系统不让写这个位置') : '');
    return;
  }
  if (name === 'update') { onUpdateMessage(value); return; }
  if (name === 'notice') { showErrToast((value && value.title) || '提示', (value && value.detail) || '', '', 'info'); return; }
  if (name === 'askClose') { showCloseAsk(); return; }
  if (name === 'drag') { showDropVeil(value === 'true'); return; }
  if (name === 'maximized') { document.body.classList.toggle('maxed', value === 'on'); return; }
};

/* 浏览器里没有壳来报字体，给一份常见名单顶住 */
const FONT_FALLBACK = ['Microsoft YaHei', 'Noto Sans SC', 'SimHei', 'SimSun', 'KaiTi',
  'FangSong', 'Arial', 'Arial Black', 'Georgia', 'Tahoma', 'Verdana', 'Times New Roman'];

function fillFontSelects() {
  const names = (host.fonts && host.fonts.length) ? host.fonts : FONT_FALLBACK;
  [['cfgFontUi', config.ui_font], ['cfgFontNum', config.num_font]].forEach((pair) => {
    const sel = $(pair[0]);
    if (!sel) return;
    sel.textContent = '';
    const dflt = document.createElement('option');
    dflt.value = '';
    dflt.textContent = pair[0] === 'cfgFontUi' ? '默认（思源 / 霞鹜优先）' : '默认（Arial）';
    sel.appendChild(dflt);
    names.forEach((n) => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    // 存过的字体没出现在名单里时也要留着选项，不然一保存就被悄悄改掉
    const chosen = pair[1] || '';
    if (chosen && names.indexOf(chosen) < 0) {
      const extra = document.createElement('option');
      extra.value = chosen;
      extra.textContent = chosen;
      sel.appendChild(extra);
    }
    sel.value = chosen;
    if (window.syncSelect) window.syncSelect(sel);
  });
}

/* 修饰键的先后顺序和壳里 Describe 保持一致，两边算出的字面不一样会白重注册一次 */
const HK_MODS = [[2, 'Ctrl'], [1, 'Alt'], [4, 'Shift'], [8, 'Win']];

function hkText(mods, vk) {
  mods = Number(mods) || 0;
  vk = Number(vk) || 0;
  if (!vk) return '';
  let text = '';
  HK_MODS.forEach((m) => { if ((mods & m[0]) !== 0) text += m[1] + '+'; });
  return text + hkKeyName(vk);
}

function hkKeyName(vk) {
  if (vk >= 0x70 && vk <= 0x87) return 'F' + (vk - 0x6F);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);
  return HK_NAMED[vk] || ('键 ' + vk);
}

const HK_NAMED = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x1D: '菜单键',
  0x20: '空格', 0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
  0x25: '左箭头', 0x26: '上箭头', 0x27: '右箭头', 0x28: '下箭头',
  0x2D: 'Insert', 0x2E: 'Delete',
  0x6A: '小键盘*', 0x6B: '小键盘+', 0x6D: '小键盘-', 0x6F: '小键盘/',
};

/* 壳先起来、配置后到：等两边都齐了再比一次，存过的组合键覆盖壳的默认值。
   三条快捷键各管各的，哪一条不同就只重注册哪一条 */
function trySyncHotkey() {
  if (hkSynced || !configLoaded) return;
  hkSynced = true;
  [1, 2, 3].forEach((no) => {
    const row = HK_ROWS[no];
    const want = hkText(config[row.cfg[0]], config[row.cfg[1]]);
    if (!want || want === host[row.host]) return;
    host[row.host] = want;
    paintHotkey(no);
    toShell((no === 1 ? 'hk' : 'hk' + no) + ':' +
      Number(config[row.cfg[0]]) + ',' + Number(config[row.cfg[1]]));
  });
}

/* ---------- 页内快捷键（Esc / F / Ctrl+F 这类不经过系统注册的） ---------- */
const PAGE_KEY_DEFAULTS = { key_close: 'Esc', key_fit: 'F', key_find: 'Ctrl+F' };
let keyArming = null;   // 正在等用户按键的那一行：'Close' | 'Fit' | 'Find'

/* 把键盘事件换算成配置里的写法：Ctrl+F、F、Esc、Space……
   单个字符一律大写，Shift 只在按键本身带名字时才写出来（Shift+f 就是 F） */
function comboOf(e) {
  let key = String(e.key || '');
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Esc';
  else if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && key.length > 1) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/* 空串表示停用这个快捷键 */
function keyOf(name) {
  return config[name] == null ? '' : String(config[name]);
}

function paintPageKeys() {
  const map = { pageKeyClose: 'key_close', pageKeyFit: 'key_fit', pageKeyFind: 'key_find' };
  Object.keys(map).forEach((id) => {
    const btn = $(id);
    if (!btn || keyArming === id.slice(7)) return;
    btn.textContent = keyOf(map[id]) || '停用';
    btn.setAttribute('data-tip', (keyOf(map[id]) ? '点击后按下新的组合键' : '当前停用，点击设置'));
    btn.setAttribute('aria-label', (keyOf(map[id]) ? '点击后按下新的组合键' : '当前停用，点击设置'));
  });
}

function armPageKey(name) {
  if (keyArming === name) { settlePageKey(); return; }
  settlePageKey();
  keyArming = name;
  const btn = $('pageKey' + name);
  if (btn) { btn.classList.add('arming'); btn.textContent = '按下组合键…'; }
}

function settlePageKey() {
  if (!keyArming) return;
  keyArming = null;
  paintPageKeys();
}

document.addEventListener('keydown', (e) => {
  if (!keyArming) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { settlePageKey(); return; }   // Esc 只用来取消，不当成新键
  const combo = comboOf(e);
  if (combo === 'Ctrl' || combo === 'Alt' || combo === 'Shift' || combo === 'Ctrl+Alt') return;
  const map = { Close: 'key_close', Fit: 'key_fit', Find: 'key_find' };
  config[map[keyArming]] = combo;
  commitConfig();
  settlePageKey();
}, true);

/* 三套全局快捷键都由壳注册：1 唤出窗口、2 打开选中项、3 体检选中项。
   一行一个按钮，改键时只有一套在"待按"状态，用序号记着是哪一套 */
const HK_ROWS = {
  1: { btn: 'hkBtn', reset: 'hkReset', hint: 'hkHint', host: 'hotkey',
       cfg: ['hk_mods', 'hk_vk'], def: [3, 71], ph: 'Ctrl+Alt+G',
       ok: '快捷键已生效：%s。软件收进托盘后也能用它叫出来。' },
  2: { btn: 'hk2Btn', reset: 'hk2Reset', hint: 'hk2Hint', host: 'hotkey2',
       cfg: ['hk2_mods', 'hk2_vk'], def: [3, 32], ph: 'Ctrl+Alt+空格',
       ok: '已生效：在资源管理器里选中文件后按 %s。' },
  3: { btn: 'hk3Btn', reset: 'hk3Reset', hint: 'hk3Hint', host: 'hotkey3',
       cfg: ['hk3_mods', 'hk3_vk'], def: [3, 68], ph: 'Ctrl+Alt+D',
       ok: '已生效：在资源管理器里选中文件后按 %s，直接开始体检。' },
};
let armingHot = 0;

/* 按钮上显示哪个键：壳报回来的优先，其次是配置里存的，最后是出厂默认 */
function hkValue(no) {
  const row = HK_ROWS[no];
  return host[row.host] || hkText(config[row.cfg[0]], config[row.cfg[1]]) || row.ph;
}

function paintHotkey(no) {
  const row = HK_ROWS[no];
  const btn = $(row.btn);
  if (!btn || armingHot === no) return;
  btn.textContent = hkValue(no);
}

function paintHotkeys() {
  [1, 2, 3].forEach(paintHotkey);
}

function armHotkey(no) {
  if (armingHot === no) { settleHotkey(); return; }
  settleHotkey();
  armingHot = no;
  const btn = $(HK_ROWS[no].btn);
  if (btn) { btn.classList.add('arming'); btn.textContent = '按下组合键…'; }
  $(HK_ROWS[no].hint).textContent =
    '按下想要的组合键，也可以按 Esc 取消。建议带上 Ctrl 或 Alt，免得和系统或别的软件抢键。';
}

function settleHotkey() {
  armingHot = 0;
  [1, 2, 3].forEach((no) => {
    const row = HK_ROWS[no];
    const btn = $(row.btn);
    if (btn) btn.classList.remove('arming');
    // 改键过程结束后先清掉操作提示，成功/被占用会各自再写一条
    const hint = $(row.hint);
    if (hint) hint.textContent = '';
  });
  paintHotkeys();
}

function vkOf(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (f) return 0x6F + Number(f[1]);
  const named = {
    Space: 0x20, Enter: 0x0D, Tab: 0x09, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    Insert: 0x2D, Delete: 0x2E, Backspace: 0x08, ContextMenu: 0x1D,
    NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadMultiply: 0x6A, NumpadDivide: 0x6F,
  };
  return named[code] || 0;
}

function onArmKeydown(e) {
  if (!armingHot) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { settleHotkey(); return; }
  const mods = (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  const vk = e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' ||
    e.key === 'Meta' || e.key === 'CapsLock' ? 0 : vkOf(e);
  if (!vk || (mods === 0 && !(vk >= 0x70 && vk <= 0x7B))) {
    $(HK_ROWS[armingHot].hint).textContent =
      '至少要按下一个修饰键（Ctrl、Alt、Shift、Win），单按 F1~F12 也可以。';
    return;
  }
  const no = armingHot;
  settleHotkey();
  applyHotkeyChoice(no, mods, vk);
}

/* 快捷键归壳管，界面只负责把选择递过去并立刻把按钮上的字改掉 */
function applyHotkeyChoice(no, mods, vk) {
  const row = HK_ROWS[no];
  config[row.cfg[0]] = mods;
  config[row.cfg[1]] = vk;
  host[row.host] = hkText(mods, vk);
  paintHotkey(no);
  // 壳认得 hk / hk2 / hk3 三种前缀，第一条没有数字
  toShell((no === 1 ? 'hk' : 'hk' + no) + ':' + mods + ',' + vk);
  const body = {};
  body[row.cfg[0]] = mods;
  body[row.cfg[1]] = vk;
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function sysNote(text) {
  const hint = $('sysHint');
  if (hint) hint.textContent = text;
}

/* ---------- 更新：顶栏那颗按钮 + 弹层 + 设置页那一行 ----------
   壳里读发布清单，把"有没有新版、改了什么"整体发过来；下载与替换也由壳做
   （页面在 WebView 里，碰不到 exe 和 dll）。这里只管显示与三个动作。 */
let updInfo = null;      // 清单里最新一版：{latest, date, notes, size, page, current}
let updStage = null;     // 下载阶段：{state:'progress'|'done'|'error', percent, error}
let updLater = '';       // 点过"稍后"的版本号：本次运行不再弹，但设置页里仍能看到

function onUpdateMessage(v) {
  if (!v || typeof v !== 'object') return;
  if (v.kind === 'fetch') { onFetchMessage(v); return; }
  if (v.kind === 'apply') { onApplyMessage(v); return; }
  onCheckMessage(v);
}

function onCheckMessage(v) {
  if (!v.ok || v.error) {
    paintUpdBadge(false);
    paintUpdOpen(false);
    paintUpdateHint(v.error || '未能完成更新检查');
    return;
  }
  /* 问到了就记一笔"这次检查的时间"，不管有没有新版：设置里的"每 3 天/每周/每月"
     要按这个算间隔。早先只在"发现新版"时记，选了三天的其实每次启动都问 */
  localStorage.setItem('gisviewer.upd_last', String(Date.now()));
  if (!v.found) {
    updInfo = null;
    paintUpdBadge(false);
    paintUpdOpen(false);
    paintUpdateHint(v.current ? ('当前 v' + v.current + ' 已是最新版本。') : '当前已是最新版本。');
    closeUpdPop();
    return;
  }
  updInfo = {
    latest: v.latest, date: v.date, notes: v.notes || [], size: v.size,
    page: v.page, current: v.current,
  };
  updStage = null;
  paintUpdateHint('有新版本 v' + v.latest + '，当前 v' + v.current + '。');
  paintUpdBadge(updLater !== v.latest);
  paintUpdOpen(true);
  if (!$('updPop').hidden) paintUpdPop();
}

function onFetchMessage(v) {
  if (v.state === 'progress') {
    updStage = { state: 'progress', percent: v.percent || 0 };
    paintUpdateHint('正在下载 v' + (updInfo ? updInfo.latest : '') + ' 更新包：' + (v.percent || 0) + '%');
  } else if (v.ok) {
    updStage = { state: 'done' };
    paintUpdateHint('v' + (updInfo ? updInfo.latest : '') + ' 更新包已下载完成，重新打开软件后完成替换。');
  } else {
    updStage = { state: 'error', error: v.error || '下载失败' };
    paintUpdateHint(v.error || '下载失败');
  }
  if (!$('updPop').hidden) paintUpdPop();
}

function onApplyMessage(v) {
  if (v.ok) {
    if (!$('updPop').hidden) {
      setUpdState('正在关闭软件并替换文件，完成后将自动重新打开…');
      const now = $('updPop').querySelector('.up-now');
      if (now) now.disabled = true;
    }
    return;
  }
  updStage = { state: 'error', error: v.error || '更新组件未能启动' };
  if (!$('updPop').hidden) paintUpdPop();
}

/* 设置页"更新"那一行：一处状态两种读法，别让两处说法打架 */
function paintUpdateHint(text) {
  const hint = $('updHint');
  if (hint) hint.textContent = text;
}

/* 有新版时设置页里给一颗"查看更新"：腿短的人习惯从设置里找，别只留顶栏那一处 */
function paintUpdOpen(on) {
  const open = $('updOpen');
  if (open) open.hidden = !on;
}

function paintUpdBadge(on) {
  const btn = $('updBadge');
  if (btn) btn.hidden = !on;
}

/* 弹层内容每次重画：状态就那几种（可下载 / 下载中 / 已下载 / 出错），
   与其逐处改文字，不如整块换掉，省得旧按钮留着还能点 */
function paintUpdPop() {
  const pop = $('updPop');
  if (!pop || !updInfo) return;
  pop.textContent = '';

  const head = el('div', 'up-head');
  head.appendChild(el('span', 'up-ver', 'v' + updInfo.latest));
  head.appendChild(el('span', 'up-tag', '新版本'));
  if (updInfo.date) head.appendChild(el('span', 'up-date', updInfo.date));
  pop.appendChild(head);

  const sub = el('div', 'up-sub', '当前 v' + updInfo.current +
    (updInfo.size ? ' · 更新包 ' + bytes(updInfo.size) : ''));
  pop.appendChild(sub);

  const list = el('ul');
  (updInfo.notes || []).forEach((line) => list.appendChild(el('li', null, line)));
  if (!list.childElementCount) list.appendChild(el('li', null, '本版本未提供更新说明。'));
  pop.appendChild(list);

  const state = el('div', 'up-state');
  if (!updStage) {
    state.textContent = '下载完成后将自动替换程序文件，随后软件重新打开。';
  } else if (updStage.state === 'progress') {
    state.textContent = '正在下载更新包：' + updStage.percent + '%';
  } else if (updStage.state === 'done') {
    state.textContent = '更新包已下载完成，重新打开软件后即生效。';
  } else {
    state.className = 'up-state warn';
    state.textContent = updStage.error || '更新未完成，请稍后重试。';
  }
  state.classList.add('up-state-mark');
  pop.appendChild(state);

  /* 三颗按钮统一靠右：「完整说明」在最左，「稍后」「立即更新」依次向右 */
  const foot = el('div', 'up-foot');
  const now = el('button', 'btn up-now', '');
  now.type = 'button';
  if (!updStage) {
    now.textContent = '立即更新';
    now.onclick = () => {
      now.disabled = true;
      now.textContent = '正在准备…';
      setUpdState('正在下载更新包…');
      toShell('upd:get');
    };
  } else if (updStage.state === 'progress') {
    now.textContent = '下载中 ' + updStage.percent + '%';
    now.disabled = true;
  } else if (updStage.state === 'done') {
    now.textContent = '重启并完成更新';
    now.onclick = () => { now.disabled = true; now.textContent = '正在重启…'; toShell('upd:apply'); };
  } else {
    now.textContent = '重试';
    now.onclick = () => { updStage = null; paintUpdPop(); toShell('upd:get'); };
  }

  if (updInfo.page) {
    const page = el('button', 'btn ghost up-page', '完整说明');
    page.type = 'button';
    // 说明页在浏览器里打开：软件里没有第二个页面可跳
    page.onclick = () => { window.open(updInfo.page); };
    foot.appendChild(page);
  }

  const later = el('button', 'btn ghost up-later', '稍后');
  later.type = 'button';
  later.onclick = () => {
    updLater = updInfo ? updInfo.latest : '';
    try { sessionStorage.setItem('gisviewer.upd_later', updLater); } catch { /* 存不下就只在本次生效 */ }
    closeUpdPop();
    paintUpdBadge(false);
  };
  foot.appendChild(later);
  foot.appendChild(now);

  pop.appendChild(foot);
}

function setUpdState(text) {
  const box = $('updPop') && $('updPop').querySelector('.up-state');
  if (box) { box.className = 'up-state'; box.textContent = text; }
}

function placeUpdPop() {
  const pop = $('updPop');
  const btn = $('updBadge');
  if (!pop || !btn || pop.hidden) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 348;
  // 按钮在标题右边，弹层默认与按钮左缘对齐，靠右越界时往回挪
  pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
}

function showUpdPop() {
  const pop = $('updPop');
  if (!pop || !updInfo) return;
  paintUpdPop();
  pop.hidden = false;
  placeUpdPop();
  const btn = $('updBadge');
  if (btn) btn.classList.add('on');
}

function closeUpdPop() {
  const pop = $('updPop');
  if (pop) pop.hidden = true;
  const btn = $('updBadge');
  if (btn) btn.classList.remove('on');
}

function toggleUpdPop() {
  const pop = $('updPop');
  if (pop && !pop.hidden) closeUpdPop();
  else showUpdPop();
}

/* 打开后过 15 秒再问更新：首屏和引擎正忙，这时候抢网络的检查结果多半也不准。
   设置页选的就是这个节奏（"每次打开后 15 秒"），两处必须是同一个数 */
function maybeCheckUpdate() {
  const freq = config.upd_freq || 'open';
  if (freq === 'off') return;
  const days = { '3d': 3, week: 7, month: 30 }[freq];
  const last = Number(localStorage.getItem('gisviewer.upd_last') || 0);
  if (days && Date.now() - last < days * 86400000) return;
  setTimeout(() => toShell('upd:check'), 15000);
}

/* 设置改一处生效一处，没有"保存"这一步；落盘跟在每次改动后面 */
async function applySettings() {
  const before = {
    ramp: config.ramp, k: config.class_count,
    nodata: config.nodata_view, def: config.raster_default,
  };
  config.basemap = $('cfgBasemap').value;
  config.annotation = $('cfgAnnotation').checked;
  /* 只写"确实有值"或"用户动过这一栏"的情况：别的控件触发 applySettings 时，
     万一这一栏没被 fillSettings 填上，空值也不会把已保存的密钥抹掉 */
  const keyVal = ($('cfgKey').value || '').trim();
  if (keyVal || keyTouched) config.tianditu_key = keyVal;
  // 换了底图要立刻换掉下面那几项：密钥留空不删，切回天地图还用得上
  paintBasemapFields();
  config.ramp = $('cfgRamp').value;
  config.class_count = Number($('cfgClassCount').value);
  config.nodata_view = $('cfgNodata').value;
  config.raster_default = $('cfgRasterDefault').value;
  config.vector_color = $('cfgVectorColor').value;
  config.max_features = Number($('cfgMaxFeatures').value);
  config.vec_precision = $('cfgVecPrecision').value || 'auto';
  if (window.GisMap) GisMap.setVecPrecision(config.vec_precision);
  applyTopMost($('cfgTopMost').checked, true);
  if ($('cfgPyrAsk')) {
    try { localStorage.setItem(PYR_NEVER, $('cfgPyrAsk').checked ? '0' : '1'); } catch { /* 同上 */ }
  }
  config.draw_limit = Number($('cfgDrawLimit').value);
  if (window.GisMap) GisMap.setDrawLimit(config.draw_limit);
  config.ui_font = $('cfgFontUi').value;
  config.num_font = $('cfgFontNum').value;
  config.ui_zoom = Number($('cfgZoom').value);
  config.panel_alpha = Number($('cfgAlpha').value);
  config.theme = $('cfgTheme').value;   // 主题也在设置里能选，和顶栏那颗按钮同一份配置
  config.unit_lang = $('cfgUnitLang').value === 'zh' ? 'zh' : 'en';
  config.close_act = segGet('cfgCloseAct') === 'exit' ? 'exit' : 'min';
  config.close_ask = $('cfgCloseAsk').checked;
  toShell('closeact:' + config.close_act);   // 关按钮的行为由壳执行，改完就告诉它
  toShell('closeask:' + (config.close_ask ? 'on' : 'off'));
  config.upd_freq = $('cfgUpdFreq').value;
  config.restore_last = $('cfgRestore').checked;
  config.open_dir = $('cfgOpenDir').value.trim();
  toShell('opendir:' + config.open_dir);     // 起始目录由壳执行，改完就告诉它
  config.recent_max = Number($('cfgRecentMax').value) || 5;
  renderRecent();   // 条数改了浮窗里的列表当场跟着变，不用重开文件
  config.toast_sec = Number($('cfgToastSec').value) || 5;
  config.cache_dir = $('cfgCache').value.trim();
  // 缓存位置：留空＝跟随数据目录；改了由引擎当场指过去（服务端处理）
  // 写"用户想用的位置"，不读输入框：框里显示的是生效目录，可能已经被服务端回退过
  config.cache_root = cachePickIntent || '';
  config.keep_hours = Number($('cfgKeepHours').value);
  applyDataColor();
  applyLook();
  // 单位写法这类设置改的是右栏里的文字，只重画那块，地图和图层都不动
  if (current && current.data && current.data.ok) renderRail(current.data);
  if (attrOpen() && window.GisMap) refreshAttr(true);
  if (window.GisMap) GisMap.refresh(config);
  updateBaseBtn();
  commitConfig();
  // 分级和上色是引擎算的，改完要把当前波段重算一遍，不能等用户重新拖文件
  if (raster) await refreshRasterView(before);
}

/* 每次改动都整份写回去：引擎那边是读一遍再覆盖，最后写回去的那份就是最终状态 */
async function commitConfig() {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.config) config = Object.assign(config, data.config);
      config.cache_note = data.cache_note || '';
      /* 缓存位置的真相由服务端给：生效目录 + 切换说明。界面照抄，不自己判断 */
      if ('cache_effective' in data) config.cache_effective = data.cache_effective;
      config.cache_fallback = !!data.cache_fallback;
      const note = data.cache_root_note || '';
      const fellBack = !!data.cache_fallback;
      if (note && note !== (config.cache_root_note || '')) {
        config.cache_root_note = note;
        // 切换失败由状态行说明；切换成功时把"旧缓存已清理"作为一次性提示
        if (!fellBack) showErrToast('缓存位置已更改', note, '', 'info');
      }
      // 框里始终显示用户选的位置（可能因为不可用而回退，状态行会说明）
      $('cachePath').value = config.cache_root || config.cache_effective || '';
      paintCachePathStatus();
      syncDirClearBtns();
      paintCacheHint();
    }
  } catch { /* 界面已经生效 */ }
}

/* 设置改完后的重算：换了默认显示方式就切波段，否则丢缓存重出当前波段 */
async function refreshRasterView(before) {
  const want = (config.raster_default !== 'single' && raster.count >= 3) ? 'rgb' : 1;
  if (before.def !== config.raster_default) {
    await selectBand(want, true);
    return;
  }
  if (before.ramp === config.ramp && before.k === config.class_count &&
      before.nodata === config.nodata_view) return;
  if (raster.band === 'rgb') return;   // 合成图不分级，色带和级数对它没有影响
  delete raster.cache[raster.band];
  await selectBand(raster.band, true);
}

/* 地图与信息栏之间的分隔条：拖动改宽度，宽度记在本地 */
function wireSplitter() {
  const handle = $('splitter');
  const stage = $('panels');
  const root = document.documentElement;
  const saved = parseInt(localStorage.getItem('gisviewer.rail_w') || '', 10);
  if (saved >= RAIL_MIN && saved <= RAIL_MAX) root.style.setProperty('--rail-w', saved + 'px');

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const move = (ev) => {
      const rect = stage.getBoundingClientRect();
      const w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(rect.right - ev.clientX)));
      root.style.setProperty('--rail-w', w + 'px');
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      const now = parseInt(getComputedStyle(root).getPropertyValue('--rail-w'), 10);
      if (now >= RAIL_MIN && now <= RAIL_MAX) localStorage.setItem('gisviewer.rail_w', String(now));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/* 拖进来的是文件夹吗：条目可能是 null（拖的不是文件系统里的东西），得先判空 */
function isFolderDrop(dt) {
  if (!dt || !dt.items) return false;
  return Array.from(dt.items).some((it) => {
    if (!it || it.kind !== 'file' || !it.webkitGetAsEntry) return false;
    const entry = it.webkitGetAsEntry();
    return !!(entry && entry.isDirectory);
  });
}

/* 拖放：浏览器版由页面自己接文件并上传一份副本；
   原生壳里外部拖入走 WinForms 那条通道（真实路径只有那边拿得到），
   页面只负责把"整个窗口都能放"这件事画出来，进出状态由壳报过来 */
function hasFileDrag(dt) {
  const types = (dt && dt.types) || [];
  return Array.prototype.indexOf.call(types, 'Files') >= 0;
}

function showDropVeil(on) {
  if (!NATIVE) return;
  $('dropVeil').hidden = !on;
  // 起始页的投放框整个让位（边框、底、文字），这一段只留遮罩自己那一圈虚线
  document.body.classList.toggle('native-drop', on);
}

/* 主体区（虚线框里那块）的矩形报给壳：遮罩窗口和"拖到哪算进来"都以它为准 */
function reportDropArea() {
  if (!NATIVE) return;
  const main = $('drop');
  if (!main) return;
  const r = main.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  const pad = 8;   // 和 .drop-veil 的 inset 一致
  toShell('dropArea:' + [
    Math.round((r.left + pad) * d), Math.round((r.top + pad) * d),
    Math.round((r.width - pad * 2) * d), Math.round((r.height - pad * 2) * d)
  ].join(','));
}

/* ---------- 窗口边缘拖动改大小 ----------

   为什么要在网页里做：窗口是 WebView2 铺满的，鼠标消息全被那个渲染子窗口接走，
   壳的窗口过程根本收不到 WM_NCHITTEST（实测一条都没有），系统那套边缘缩放自然也用不上。
   网页能看到指针位置，就把"进了哪条边"报给壳，由壳启动系统的缩放循环。

   边带取 6px：窄了不好按，宽了会挡住最外圈按钮。
   四条边全参与：顶栏最上沿 6px 交给缩放，其余顶栏区域仍是拖动窗口——
   两个意图都从"按下那一刻"分流，不会打架（见 edgePress 的 pointerdown 捕获）。 */
const EDGE_BAND = 6;
const CORNER_BAND = 12;   // 角部给宽一点：贴角斜拖是常用手势，6px 太挑剔，差一两像素就落空
let edgeZone = 0;   // 0=不在边缘带，10/11/12/15=四边，13/14/16/17=四角

/* 算指针落在哪条边：返回系统那套命中码，0 表示不在边缘带。
   角用 12px 圈（两轴同时进圈才算角），边用 6px 条。 */
function edgeAt(x, y) {
  const w = window.innerWidth, h = window.innerHeight;
  const cL = x <= CORNER_BAND, cR = x >= w - CORNER_BAND;
  const cT = y <= CORNER_BAND, cB = y >= h - CORNER_BAND;
  if (cL && cB) return 16;   // 左下
  if (cR && cB) return 17;   // 右下
  if (cL && cT) return 13;   // 左上
  if (cR && cT) return 14;   // 右上
  const nearL = x <= EDGE_BAND, nearR = x >= w - EDGE_BAND;
  const nearT = y <= EDGE_BAND, nearB = y >= h - EDGE_BAND;
  if (nearL) return 10;            // 左
  if (nearR) return 11;            // 右
  if (nearT) return 12;            // 上
  if (nearB) return 15;            // 下
  return 0;
}

/* 缩放方向对应的鼠标光标：这是用户唯一能看出"这里可以拖"的提示 */
const EDGE_CURSOR = {
  10: 'w-resize', 11: 'e-resize', 12: 'n-resize', 15: 'n-resize',
  13: 'nwse-resize', 14: 'nesw-resize',
  16: 'nesw-resize', 17: 'nwse-resize',
};

function wireEdgeResize() {
  if (!NATIVE) return;
  /* 光标形状跟着边缘换：顶栏上沿也要变，不然用户不知道顶边能缩放 */
  document.addEventListener('mousemove', (e) => {
    if (e.buttons) return;          // 正在拖别的东西，别改光标
    const z = edgeAt(e.clientX, e.clientY);
    if (z === edgeZone) return;
    edgeZone = z;
    const cur = EDGE_CURSOR[z];
    document.documentElement.style.cursor = cur || '';
    if (cur) document.body.style.cursor = cur;
    else document.body.style.cursor = '';
  }, true);

  /* 按下就把方向报给壳：真正的拖动由系统接管。
     必须挂在 pointerdown 捕获上：顶栏的窗口拖动绑在 #bar 的 pointerdown 冒泡上，
     而 pointerdown 先于 mousedown——只挂 mousedown 的话，顶栏那一按早就把窗口
     交给系统拖动循环了，缩放永远轮不到。捕获阶段拦下（preventDefault 顺带
     取消后续的 mousedown），其余顶栏区域照旧拖动，两边不打架。 */
  function edgePress(e) {
    if (e.button !== 0) return;
    const z = edgeAt(e.clientX, e.clientY);
    if (!z) return;
    /* 边缘带里如果正好压着按钮或输入框，优先让控件自己处理。
       四角例外：右上角那 6px 压在关闭按钮顶端，让位的话角部永远轮不到缩放
       （用户点按钮按中心，顶上 6px 几乎不会点到）；四边仍然让位。 */
    const corner = z === 13 || z === 14 || z === 16 || z === 17;
    if (!corner && e.target && e.target.closest
        && e.target.closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    e.stopPropagation();
    toShell('resize:' + z);
  }
  document.addEventListener('pointerdown', edgePress, true);
  document.addEventListener('mousedown', edgePress, true);   // 兜底：pointer 事件被吞的环境里仍能触发

  /* 指针离开窗口后光标要还原，不然会一直挂着缩放光标 */
  document.addEventListener('mouseleave', () => {
    edgeZone = 0;
    document.documentElement.style.cursor = '';
    document.body.style.cursor = '';
  });
}

function wireDrop() {
  const veil = $('dropVeil');
  let depth = 0;
  const paint = () => {
    const emptyOn = !$('empty').hidden;
    $('empty').classList.toggle('dragging', emptyOn);
    veil.hidden = emptyOn || depth <= 0;
  };
  const reset = () => { depth = 0; $('empty').classList.remove('dragging'); veil.hidden = true; };

  document.addEventListener('dragenter', (e) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    paint();
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && document.contains(e.relatedTarget)) return;
    depth = Math.max(0, depth - 1);
    paint();
  });
  document.addEventListener('drop', (e) => {
    if (!hasFileDrag(e.dataTransfer)) { reset(); return; }
    e.preventDefault();
    reset();
    if (NATIVE) return;
    if (isFolderDrop(e.dataTransfer)) {
      showErrToast('文件夹打不开', '把文件夹的完整路径填在上方输入框里就能打开；也可以先压成 zip 再拖进来。');
      return;
    }
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) uploadFiles(files);
  });
}

/* 设置页左侧导航：五个分组各占一屏，点哪一屏只显示哪一屏。
   上次停在哪个分组记在本地，下次打开还在那儿 */
const SET_PANES = ['base', 'render', 'look', 'file', 'sys', 'about'];

function showSettingPane(sec) {
  if (SET_PANES.indexOf(sec) < 0) sec = 'base';
  document.querySelectorAll('#setNav button').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-sec') === sec);
  });
  document.querySelectorAll('#setBody .set-pane').forEach((p) => {
    p.hidden = p.getAttribute('data-sec') !== sec;
  });
  // 换一屏就回到顶部：上一屏滚到一半的位置不该带到下一屏
  const body = $('setBody');
  if (body) body.scrollTop = 0;
}

function wireSettingNav() {
  const nav = $('setNav');
  if (!nav) return;
  showSettingPane(config.set_sec || 'base');
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('button[data-sec]') : null;
    if (!btn) return;
    const sec = btn.getAttribute('data-sec');
    showSettingPane(sec);
    // 记在配置里（不是 localStorage：调试端口每次启动都变，localStorage 按端口隔离，跨启动就丢了）
    config.set_sec = sec;
    commitConfig();
  });
}

function init() {
  wireSplitter();
  wireDrop();
  wireEdgeResize();

  $('pathForm').addEventListener('submit', (e) => {
    e.preventDefault();
    /* 手输的路径两种斜杠都认（服务端同样会归一化），这里先把写法收敛一下再交给下面 */
    const value = tidyPath($('pathInput').value);
    if (!value) return;
    $('pathInput').value = value;
    /* 顶栏这一个框两用：像经纬度就先当坐标定位，否则当文件路径去读 */
    const ll = parseLonLat(value);
    if (ll) { gotoLonLat(ll); return; }
    inspectPath(value);
  });

  $('filePick').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadFiles(files);
    e.target.value = '';
  });

  $('themeBtn').addEventListener('click', () => {
    const at = THEME_ORDER.indexOf(config.theme);
    const next = THEME_ORDER[(at + 1) % THEME_ORDER.length];
    config.theme = next;
    applyTheme(next);
    paintThemeBtn();
    commitConfig();
  });

  $('updOpen').addEventListener('click', () => {
    if (!updInfo) return;
    $('cfgClose').click();
    paintUpdBadge(true);
    showUpdPop();
  });

  $('updBadge').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUpdPop();
  });
  /* 点别处就收：它跟"最近打开"一样是临时浮层，不该占着手 */
  document.addEventListener('pointerdown', (e) => {
    if ($('updPop').hidden) return;
    if (e.target.closest && e.target.closest('#updPop, #updBadge')) return;
    closeUpdPop();
  });
  try { updLater = sessionStorage.getItem('gisviewer.upd_later') || ''; } catch { /* 存不了就只在本次生效 */ }

  $('settingsBtn').addEventListener('click', () => {
    settleHotkey();
    /* 弹窗一开，顶栏那两块浮层就收掉：否则两个按钮同时亮着，
       而且浮层压不到弹窗上面，看起来像没关干净 */
    hideCheckPop();
    hideConvPop();
    hidePickPop();
    fillSettings();
    $('settings').hidden = false;
    markBtn('settingsBtn', true);
    // 面板一开就告诉用户"这份密钥在"，不用他再去点一下才知道
    if (($('cfgKey').value || '').trim()) {
      if (TDT_KEY_RE.test($('cfgKey').value.trim())) paintKeyStatus('ok', '天地图密钥有效。');
      else flashKeySaved();
    } else paintKeyStatus('', '');
  });
  $('cfgClose').addEventListener('click', () => {
    settleHotkey();
    // 关面板前先落一次盘：密钥这类输入靠 change（失焦）保存，关得太快会丢
    clearTimeout(keySaveTimer);
    applySettings();
    paintKeyStatus('', '');
    $('settings').hidden = true;
    resetSetPos();   // 下次打开还是居中，不会停在上一回拖到的角落
    markBtn('settingsBtn', false);
  });
  wireSetDrag();
  // 浮层卡片没有关闭按钮：点卡片任意处即关（自动到点收走的逻辑在 showErrToast 里）
  $('errToast').addEventListener('click', hideErrToast);
  wireCloseAsk();
  
/* 设置页每项标签挂提示图标：只挂一次，图标里说的话见 SETTING_TIPS */

  mountSettingTips();
  $('cacheClearBtn').addEventListener('click', () => {
    const where = cacheDirShown || '缓存目录';
    if (!window.confirm('将清空 ' + where + ' 里本软件生成的缓存，不会动其他文件。\n\n继续？')) return;
    $('cacheSizeHint').textContent = '正在清空…';
    fetch('/api/cache', { method: 'POST' }).then((r) => r.json()).then((d) => {
      paintCacheSize((d && d.cache) || { bytes: 0, count: 0 }, d && (d.cache_dir || d.data_dir));
    }).catch(() => { $('cacheSizeHint').textContent = '清空失败，稍后再试'; });
  });
  // 缓存位置：只读显示，旁边一颗"打开"直接把这层目录交给资源管理器
  $('cacheOpenBtn').addEventListener('click', () => {
    if (cacheDirShown) toShell('openpath:' + cacheDirShown);
  });
  // 文件框的起始目录：点"选择…"由壳弹系统选文件夹框，选完回传 GisHost('dir', 路径)
  /* 选目录时从这一栏当前的路径起步：全从"起始目录"起步的话，
     选副本目录、缓存目录都得自己再翻一遍 */
  const pickFrom = (inputId) => toShell('pickdir:' + (($(inputId) || {}).value || '').trim());
  $('cfgOpenDirPick').addEventListener('click', () => { dirPickTarget = 'open'; pickFrom('cfgOpenDir'); });
  $('cfgCachePick').addEventListener('click', () => { dirPickTarget = 'cache'; pickFrom('cfgCache'); });
  $('cachePathPick').addEventListener('click', () => { dirPickTarget = 'cachedir'; pickFrom('cachePath'); });
  /* 只读框本身不收焦点，点它等于点旁边那颗"选择"按钮 */
  [['cfgOpenDir', 'cfgOpenDirPick'], ['cfgCache', 'cfgCachePick'], ['cachePath', 'cachePathPick'], ['convOut', 'convDirPick']]
    .forEach(([inputId, pickId]) => {
      const input = $(inputId);
      const pick = $(pickId);
      const row = input && input.closest('.icon-row, .cp-field');
      if (!row || !pick) return;
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;   // 按钮自己有活干
        pick.click();
      });
    });
  /* 三个目录框都是只读的，清空靠这枚按钮：清空＝恢复默认行为 */
  [['cfgOpenDirClear', 'cfgOpenDir', paintOpenDirStatus],
   ['cfgCacheClear', 'cfgCache', paintCacheDirStatus],
   ['cachePathClear', 'cachePath', paintCachePathStatus]].forEach(([btnId, inputId, after]) => {
    $(btnId).addEventListener('click', () => {
      $(inputId).value = '';
      if (inputId === 'cachePath') cachePickIntent = null;
      applySettings();
      after();
      syncDirClearBtns();
    });
  });
  $('cfgOpenDir').addEventListener('input', paintOpenDirStatus);
  $('cfgCache').addEventListener('input', paintCacheDirStatus);
  // 数据体检：顶栏那颗按钮开浮层，选文件/文件夹、看结论都在这一块里
  $('checkBtn').addEventListener('click', toggleCheckPop);
  // 选完就查：没有"开始体检"按钮之后，选择动作本身就是触发条件
  $('checkFilePick').addEventListener('click', () => toShell('pickcheck'));
  $('checkPathPick').addEventListener('click', () => { dirPickTarget = 'check'; pickFrom('checkPath'); });
  // 路径框里回车等同确认，省得手离开键盘
  $('checkPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runCheck(); }
  });
  // 格式互转：顶栏那颗按钮开浮层，四个输入加预检、转换都在这一块里
  $('convBtn').addEventListener('click', toggleConvPop);
  $('convFilePick').addEventListener('click', () => { filePickTarget = 'conv'; toShell('pickcheck'); });
  $('convDirPick').addEventListener('click', () => { dirPickTarget = 'conv'; pickFrom('convOut'); });
  // 只读框：没有手输这回事，选中就算用户定了这个目录
  $('convOut').addEventListener('change', () => { convOutPicked = !!$('convOut').value.trim(); });
  $('convPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearConvResult(); convLoadLayers(); }
  });
  // 手改输入文件就不再跟地图走；清空后重新跟随
  $('convPath').addEventListener('input', () => {
    convPathDirty = !!$('convPath').value.trim();
    updateConvRun();
  });
  $('convPath').addEventListener('change', () => { clearConvResult(); convLoadLayers(); });
  $('convLayer').addEventListener('change', () => {
    if (window.syncSelect) window.syncSelect($('convLayer'));
    clearConvResult();
    convScheduleDry();
  });
  $('convFmt').addEventListener('change', () => {
    if (window.syncSelect) window.syncSelect($('convFmt'));
    try { localStorage.setItem('gisviewer.conv_fmt', convFmtKey()); } catch { /* 存不了就本次生效 */ }
    clearConvResult();
    convScheduleDry();
  });
  $('convSuffix').addEventListener('input', () => { clearConvResult(); convScheduleDry(); });
  /* 勾选只影响"同名怎么办"，状态区不必先清空：清了会缩一下、结果回来再长回去，
     看着就是抖两下。直接重跑，内容原地替换 */
  $('convOver').addEventListener('change', () => { convScheduleDry(); });
  $('convOut').addEventListener('change', () => { clearConvResult(); convScheduleDry(); });
  $('convRun').addEventListener('click', runConv);
  /* 标题旁那颗说明：讲清互转搬什么、不搬什么、输出到哪 */
  const cvTip = $('cvTip');
  if (cvTip) {
    cvTip.setAttribute('data-tip', [
      '矢量格式互转把点线面这类数据换成另一种文件格式存放，不做裁剪、合并或简化。',
      '· **只处理矢量数据**，影像、DEM 这类栅格不在其中。',
      '· 输入文件可以直接填压缩包（.zip），包里有几份数据，「待转图层」就列出几份。',
      '· 坐标系、几何与属性按原样保留；只有 **KML、GPX、TopoJSON** 按规范只收 WGS 84 经纬度，输入文件是投影坐标时会换算成经纬度，并在结果里注明。',
      '· Shapefile、MapInfo TAB、DXF 一个图层只放一种几何，遇到点线面混在一起的数据，会 **按几何类型分开写成多个文件**，要素一条不丢。',
      '· 输出目录留空时，**与输入文件同目录**，靠文件名里的后缀区分；同名文件 **一律不覆盖**。',
      '· 转换前先给出该格式的已知代价与实测警告，转换后逐项对比要素数、字段数、几何类型与坐标系。',
    ].join('\n'));
    setSVG(cvTip, HINT_ICO);
  }
  /* 标题旁那颗说明：分点讲清体检查了什么、结论怎么分档。
     以"· "开头的行画圆点，其余行整段排——首句和末句是说明，中间三条才是清单 */
  const cpTip = $('cpTip');
  if (cpTip) {
    cpTip.setAttribute('data-tip', [
      '数据体检会把目标位置里的每份数据逐个打开检查，并核对以下项目：',
      '· 能否读取、坐标系是否齐全、范围与图层结构是否正常；',
      '· 矢量数据再核对要素数与字段表；',
      '· 栅格数据再核对波段数、像元大小、压缩方式与金字塔。',
      '每条结论按严重程度归入“有问题、要留意、没问题”3 档。',
      '一次最多体检 500 个数据，超出部分不查。',
    ].join('\n'));
    setSVG(cpTip, HINT_ICO);
  }
  /* 设置页里那几颗说明图标：正文都是常驻的，不随数据变。
     几何精度那颗的文案由 paintVecPrecHint 现写，这里只补图标 */
  const cfgTips = {
    tipTopMost: '开启后窗口始终显示在其他程序之上：切到大纲、表格或其他软件时不会被盖住。'
      + '顶栏最小化按钮左边那枚置顶按钮和这里同一个开关，两边同步。',
    tipPyrAsk: '打开大影像时，如果原文件还没有金字塔，会先问一次要不要建。'
      + '选过「以后不再询问」之后开关会自动关闭，在这里重新打开即可恢复询问。'
      + '金字塔只是缓存里的显示副本，原文件不会被改动。',
  };
  Object.keys(cfgTips).forEach((id) => {
    const ico = $(id);
    if (!ico) return;
    ico.setAttribute('data-tip', cfgTips[id]);
    setSVG(ico, HINT_ICO);
  });
  const tipPrec = $('tipVecPrecision');
  if (tipPrec) setSVG(tipPrec, HINT_ICO);
  paintVecPrecHint();
  const tipPyr = $('tipPyrAsk');
  if (tipPyr) setSVG(tipPyr, HINT_ICO);
  paintPyrAskTip();
  applyTopMost(config.always_on_top, true);
  $('diagBtn').addEventListener('click', runDiagnose);
  // 资源管理器右键"用图览打开"：扩展名清单问引擎，开关交给壳写注册表。
  // 开和关都带同一份清单，取消时壳照着删才删得干净
  const ctxExt = () => (host.menuExt || []).join(',');
  $('cfgCtxMenu').addEventListener('change', () => {
    const on = $('cfgCtxMenu').checked;
    toShell('ctxmenu:' + (on ? 'on' : 'off') + ',' + ctxExt());
  });
  if (window.GisMap && config.draw_limit) GisMap.setDrawLimit(config.draw_limit);
  if (window.GisMap) GisMap.setVecPrecision(config.vec_precision || 'auto');
  wireSettingNav();
  // 页内快捷键：点键帽进入捕获状态，恢复默认写回出厂组合
  ['Close', 'Fit', 'Find'].forEach((name) => {
    const btn = $('pageKey' + name);
    if (btn) btn.addEventListener('click', () => armPageKey(name));
    const rst = $('pageKey' + name + 'Reset');
    if (rst) rst.addEventListener('click', () => {
      const map = { Close: 'key_close', Fit: 'key_fit', Find: 'key_find' };
      config[map[name]] = PAGE_KEY_DEFAULTS[map[name]];
      commitConfig();
      paintPageKeys();
    });
  });
  paintPageKeys();
  /* 没有保存按钮：改一下生效一下。令牌那一栏不落盘，所以不参与 */
  document.querySelectorAll('#settings select, #settings input').forEach((node) => {
    if (node.id === 'cfgAutoStart' || node.id === 'cfgDeskLnk') return;
    node.addEventListener('change', applySettings);
  });
  /* 密钥这类长文本只靠 change（失焦）会丢：打完直接按 Esc 或点右上角关闭，
     焦点还没离开输入框，值就没落盘。改成边打边存，离开输入框再补一次 */
  let keySaveTimer = 0;
  $('cfgKey').addEventListener('input', () => {
    keyTouched = true;   // 只有用户真动过这一栏，才允许把空值写进配置
    const v = ($('cfgKey').value || '').trim();
    if (!v) { paintKeyStatus('', ''); }
    else if (!TDT_KEY_RE.test(v)) {
      paintKeyStatus('warn', '天地图密钥无效。请到天地图开放平台申请"浏览器端"密钥后重新填写。');
    } else {
      paintKeyStatus('', '');
    }
    clearTimeout(keySaveTimer);
    keySaveTimer = setTimeout(async () => {
      await applySettings();
      flashKeySaved();
    }, 500);
  });
  /* 关闭按钮行为是两态开关，不是下拉：点哪边就是哪边，点完立刻生效 */
  $('cfgCloseAct').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-val]');
    if (!b || b.classList.contains('on')) return;
    segSet('cfgCloseAct', b.dataset.val);
    applySettings();
  });
  $('cfgVectorColor').addEventListener('change', () => {
    $('cfgColorSwatch').style.background = $('cfgVectorColor').value;
  });
  // 主题直接切，不用关掉设置页再看效果；顶栏那颗按钮的图标与说明当场跟着换
  $('cfgTheme').addEventListener('change', () => {
    config.theme = $('cfgTheme').value;
    applyTheme(config.theme);
    paintThemeBtn();
  });
  /* 不透明度拖动时实时预览，松手（change）才落盘——每次 input 都 POST 配置太浪费 */
  $('cfgAlpha').addEventListener('input', () => {
    $('cfgAlphaOut').textContent = $('cfgAlpha').value + '%';
    config.panel_alpha = Number($('cfgAlpha').value);
    paintRange($('cfgAlpha'));
    applyLook();
  });
  [1, 2, 3].forEach((no) => {
    const row = HK_ROWS[no];
    const btn = $(row.btn);
    if (btn) btn.addEventListener('click', () => armHotkey(no));
    const back = $(row.reset);
    if (back) back.addEventListener('click', () => {
      settleHotkey();
      applyHotkeyChoice(no, row.def[0], row.def[1]);
    });
  });
  document.addEventListener('keydown', onArmKeydown, true);
  $('cfgAutoStart').addEventListener('change', (e) => {
    toShell('autostart:' + (e.target.checked ? '1' : '0'));
  });
  $('cfgDeskLnk').addEventListener('change', (e) => {
    toShell('desklnk:' + (e.target.checked ? 'on' : 'off'));
  });
  $('updBtn').addEventListener('click', () => {
    $('updHint').textContent = '正在检查更新…';
    $('updOpen').hidden = true;
    toShell('upd:check');
  });
  $('keyPeek').addEventListener('click', () => {
    const box = $('cfgKey');
    const show = box.type === 'password';
    box.type = show ? 'text' : 'password';
    // 眼睛图标：睁开=正显示，划掉=正藏着；标题跟着换，一眼看懂现在是哪种
    $('keyPeek').classList.toggle('peeking', show);
    const peekTip = show ? '隐藏密钥' : '显示密钥';
    $('keyPeek').setAttribute('data-tip', peekTip);
    $('keyPeek').setAttribute('aria-label', peekTip);
    if (show) box.focus();
  });
  $('baseBtn').addEventListener('click', toggleBasemap);
  $('histBtn').addEventListener('click', toggleHist);
  $('attrBtn').addEventListener('click', () => { attrAuto = false; toggleAttr(); });
  $('chipClose').addEventListener('click', () => { hideLayerPop(); closeLayer(); });
  /* 文件被外部改过的那条横幅：重读一次，或者这次先不管 */
  $('staleReload').addEventListener('click', () => {
    if (!stalePath) return;
    if (staleBarEl() && staleBarEl().dataset.kind === 'gone') { checkStale(); return; }
    const btn = $('staleReload');
    btn.disabled = true;
    inspectPath(stalePath).finally(() => { btn.disabled = false; });
  });
  $('staleIgnore').addEventListener('click', () => {
    staleIgnored = stalePath;
    hideStale();
  });
  /* 从后台切回来补查一次：这期间可能刚在别的软件里存过盘 */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStale(); });
  $('chipLayerBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (layerItems.length < 2) return;
    if ($('layerPop').hidden) showLayerPop();
    else hideLayerPop();
  });
  document.addEventListener('click', (e) => {
    if ($('layerPop').hidden) return;
    if (e.target.closest && (e.target.closest('#layerPop') || e.target.closest('#chipLayerBtn'))) return;
    hideLayerPop();
  });
  window.addEventListener('resize', hideLayerPop);
  wireFold($('legendFold'), $('legendTab'), 'legend', '收起图例', '展开图例');
  wireFold($('chipFold'), $('chipTab'), 'fileChip', '收起文件信息', '展开文件信息');
  $('chipFold').addEventListener('click', hideLayerPop);
  $('chipTab').addEventListener('click', hideLayerPop);
  wireChrome();
  wireAttrGrip();
  wireAttrBody();
  wireQuickKeys();
  renderRecent();
  /* 只有用户真的点进来、或用键盘切进来才弹"最近打开"：快捷键把窗口唤到前台时，
     WebView 也会把焦点还给输入框，那种被动聚焦不该弹出一块列表 */
  let lastUserAct = 0;
  ['pointerdown', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, () => { lastUserAct = Date.now(); }, true);
  });
  $('pathInput').addEventListener('focus', () => {
    if (Date.now() - lastUserAct < 1200) showRecent();
  });
  document.addEventListener('click', (e) => {
    const pop = $('recentPop');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || e.target === $('pathInput')) return;
    hideRecent();
  });
  // "打开"菜单点到别处就收掉；点按钮自身除外（它自己负责开/关）
  document.addEventListener('click', (e) => {
    const pop = $('pickPop');
    if (!pop || pop.hidden) return;
    const onBtn = e.target && e.target.closest ? e.target.closest('#filePickBtn') : null;
    // 提示气泡挂在 body 上、不在浮层里：点气泡（选字、复制）不算"点在外面"
    if (pop.contains(e.target) || onBtn || tipInBubble(e.target)) return;
    hidePickPop();
  });
  // 体检浮层同理：点外面收掉，点自己的按钮不算（否则按下去就没了）
  document.addEventListener('click', (e) => {
    const pop = $('checkPop');
    if (!pop || pop.hidden) return;
    const onBtn = e.target && e.target.closest ? e.target.closest('#checkBtn') : null;
    if (pop.contains(e.target) || onBtn || tipInBubble(e.target)) return;
    hideCheckPop();
  });
  // 互转浮层同理
  document.addEventListener('click', (e) => {
    const pop = $('convPop');
    if (!pop || pop.hidden) return;
    const onBtn = e.target && e.target.closest ? e.target.closest('#convBtn') : null;
    // 松手时浏览器补发的 click 会落到气泡上：这一下不能当成"点外面"把浮层关掉
    if (pop.contains(e.target) || onBtn || tipInBubble(e.target)) return;
    hideConvPop();
  });
  let findTimer = 0;
  $('attrFind').addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(applyAttrFind, 140);
  });
  $('map').addEventListener('gis:vector', (e) => {
    if (attrAuto && e.detail && e.detail.features && e.detail.features.length) {
      attrAuto = false;
      showAttr(true);
      refreshAttr();
    }
    /* 快速打开的矢量：个数先用取数结果补上；
       范围和混合类型的明细需要整份扫描，等画完再补一次全量检查 */
    localCoords = !!(e.detail && e.detail.assumedLocal);
  });
  $('map').addEventListener('gis:mouse', paintPos);
  /* 属性表双击的那一行画出来了：把"等绘制"换成结果，用户不用再双击一次。
     这一轮画完仍然没有它（超出单次绘制上限、几何为空）也要说一句，
     否则那条"正在等"会一直挂着 */
  $('map').addEventListener('gis:focus', (e) => {
    const d = e.detail || {};
    if (d.fid === null || d.fid === undefined) return;
    if (locateFid !== null && Number(d.fid) !== locateFid) return;
    if (d.ok === false) {
      toastNote('已框到该要素的范围', '视野内还没有画出这个要素，范围框先标出位置，放大后会补上高亮');
      return;
    }
    attrToast('已定位并高亮该要素');
  });
  /* 地图高亮变了：属性表里对应的那一行跟着亮起或撤掉。
     点地图上的要素做识别、按 Esc 收弹窗、双击定位，走的都是这一条 */
  $('map').addEventListener('gis:highlight', (e) => {
    const fids = (e.detail && e.detail.fids) || [];
    const c = attrShown;
    if (!c || !c.ids || !c.ids.length || !fids.length) { markLocateRow(null); return; }
    let row = null;
    for (let i = 0; i < fids.length && !row; i++) {
      const at = c.ids.indexOf(fids[i]);
      if (at >= 0 && c.tbody) row = c.tbody.children[at] || null;
    }
    markLocateRow(row);
  });
  /* 全精度重画：进度放在地图正中。底栏那行小字位置太偏，
     数据大时用户会以为没反应，跑到地图中央盯着看 */
  let fullBusyOn = false;
  $('map').addEventListener('gis:full', (e) => {
    const on = !!(e.detail && e.detail.on);
    if (on) {
      fullBusyOn = true;
      loadTip(true, (e.detail && e.detail.text) || '正在按原始顶点重画…');
    } else if (fullBusyOn) {
      fullBusyOn = false;
      loadTip(false);
    }
  });
  $('map').addEventListener('gis:view', (e) => {
    paintView(e);
  });
  $('attrBody').addEventListener('scroll', () => {
    const c = attrShown;
    if (!c || c.done || c.loading || c.error) return;
    const body = $('attrBody');
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 240) loadAttrPage(c);
  });
  $('map').addEventListener('gis:layers', (e) => {
    applyLayerState(e.detail);
  });
  document.addEventListener('keydown', (e) => {
    if (!attrOpen() || attrCol < 0 || attrResizing) return;
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C')) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, .combo')) return;
    const sel = window.getSelection ? String(window.getSelection()) : '';
    if (sel) return;   // 有文字选区时把复制让给系统
    if (!attrShown) return;
    e.preventDefault();
    copyAttrCol(attrShown, attrCol);
  });
  let baseHintShown = false;
  $('map').addEventListener('gis:drawn', (e) => {
    const kind = (e.detail && e.detail.kind) || 'none';
    /* 别人拿到软件第一件事常常是"地图怎么是白的"：画出图层但没底图时提醒一次 */
    /* 只提醒"选了要密钥的底图却没填密钥"这一种。用户自己把底图关掉，
       那是他的选择，不该每次重绘都弹一句"没有底图" */
    /* 配置还没读回来时 config.tianditu_key 一定是空的，这时候弹"没有底图"是误报——
       启动就恢复上次文件的那条路径正好会撞上。等配置就绪再判 */
    if (!baseHintShown && configReady && (kind === 'vector' || kind === 'raster')) {
      const bm = String(config.basemap || '');
      const noKey = bm.indexOf('tianditu') === 0 && !(config.tianditu_key || '').trim();
      if (noKey) {
        baseHintShown = true;
        showErrToast('当前无可用底图',
          '在 **设置 → 底图** 里选择底图源；天地图需要填一个"浏览器端"密钥（自备）。', '', 'info');
      }
    }
    /* 清空（none）不算画完：切文件时先清一次旧图层，那一下收遮罩就收早了。
       skip 是"这层画不出来"，这时候遮罩要立刻撤，别让人对着转圈等 */
    if (kind === 'skip') {
      releaseVeil();
    } else if (kind !== 'none') {
      drawTick++;
      if (veilHold && drawTick > veilAt) releaseVeil();
    }
    // 换成栅格或切片之后属性表已经没有意义，关掉，别把上一个矢量的行留在下面
    if (kind !== 'vector') closeAttr();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (config.theme === 'auto') applyTheme('auto');
  });
  /* 地图那边画崩了（坐标超范围之类）会走这里：立刻把"正在画图层…"收掉，
     错误提示由地图自己弹，别让遮罩一直转 */
  window.gisMapFail = () => { releaseVeil(); loadTip(false); };

  loadConfig().then(() => {
    configReady = true;
    if (window.GisMap) GisMap.init(config);
    pageReady = true;
    // 快捷键在界面就绪前按下的那一批：补跑一次，别让用户以为没反应
    if (pendingCheck.length) {
      const list = pendingCheck;
      pendingCheck = [];
      checkPaths(list);
    }
    reportDropArea();
    window.addEventListener('resize', reportDropArea);
    const mainEl = $('drop');
    if (mainEl && window.ResizeObserver) new ResizeObserver(reportDropArea).observe(mainEl);
    /* 地图宽度会被分栏拖动、信息栏收放改掉：提示卡跟着重新居中 */
    const mapEl = $('map');
    if (mapEl && window.ResizeObserver) new ResizeObserver(placeErrToast).observe(mapEl);
    /* 分栏拖动、信息栏收放、窗口缩放都会改地图高度；文件卡展开收起、换图层都会改它自己的高度。
       三类都影响图例能长多高，各挂一个观察器管住 */
    const stageEl = document.querySelector('.map-stage');
    const chipEl = $('fileChip');
    syncMapHeight();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(syncMapHeight);
      if (stageEl) ro.observe(stageEl);
      if (chipEl) ro.observe(chipEl);
    }
    // 底图按钮的亮灭按 config.basemap 定：设置里选过"无底图"，这里一启动就是灭的
    updateBaseBtn();
    toShell('closeact:' + (config.close_act === 'exit' ? 'exit' : 'min'));
    toShell('closeask:' + (config.close_ask === false ? 'off' : 'on'));
    toShell('ready');
    maybeCheckUpdate();
    const params = new URLSearchParams(location.search);
    const forced = params.get('theme');
    if (forced && THEME_LABELS[forced]) {
      config.theme = forced;
      applyTheme(forced);
      paintThemeBtn();
    }
    // 启动期间拖进来的文件优先：那是用户当下就要看的，比"恢复上次的文件"更要紧
    if (pendingPaths.length) {
      const dropped = pendingPaths[pendingPaths.length - 1];
      pendingPaths = [];
      openDropped(dropped);
      return;
    }
    const given = params.get('path');
    if (given) {
      const clean = tidyPath(given);
      $('pathInput').value = clean;
      inspectPath(clean);
      return;
    }
    fetch('/api/preload').then((r) => r.json()).then((d) => {
      if (d.ok && d.paths && d.paths.length) {
        const clean = tidyPath(d.paths[0]);
        $('pathInput').value = clean;
        inspectPath(clean);
      }
    }).catch(() => {});
  });
}

init();
