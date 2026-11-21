/* ---------- 界面：气泡、右栏、各格式分节、主渲染、图层切换、波段与图例 ---------- */
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

const TIP_GAP = 8;
const TIP_EDGE = 8;

/* 锚点属于哪一类：顶栏、窄卡（文件卡/图例/图层下拉）、标了向上展的 */
function tipFlags(anchor) {
  return {
    inBar: !!(anchor.closest && anchor.closest('#bar')),
    inCard: !!(anchor.closest && anchor.closest('#fileChip, #legend, .layer-pop')),
    dirUp: !!(anchor.getAttribute && anchor.getAttribute('data-tip-dir') === 'up')
  };
}

/* 一行：以"· "开头画圆点，其余整段排（有的气泡是"一句总述 + 几条清单 + 一句收尾"） */
function tipLine(line, marked) {
  const bullet = marked ? line.startsWith('· ') : true;
  const row = el('div', 'tip-li' + (bullet ? '' : ' tip-plain'));
  if (bullet) row.appendChild(el('i', 'tip-dot'));
  const span = el('span', 'tip-txt');
  fillTipText(span, bullet && marked ? line.slice(2) : line);
  row.appendChild(span);
  return row;
}

/* 正文：有换行就按行拆，末尾按 data-tip-href 补一条外链 */
function fillTipBody(box, anchor, text) {
  const raw = String(text).split('\n').filter((s) => s.length);
  if (raw.length > 1) {
    const marked = raw.some((s) => s.startsWith('· '));
    box.classList.add('tip-multi');
    raw.forEach((line) => { box.appendChild(tipLine(line, marked)); });
  } else {
    box.classList.remove('tip-multi');
    fillTipText(box, raw[0] || '');
  }
  const href = anchor.getAttribute('data-tip-href');
  if (!href) return;
  /* target=_blank 会走壳里的 NewWindowRequested，用系统浏览器打开，不把页面导航走 */
  const a = document.createElement('a');
  a.className = 'tip-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = anchor.getAttribute('data-tip-link') || href;
  box.appendChild(a);
}

/* 横向：默认摆右侧，右边放不下翻左边；顶栏、窄卡、上展锚点一律走竖向，返回 null */
function tipSideX(flags, r, br) {
  if (flags.inBar || flags.inCard || flags.dirUp) return null;
  if (br.width <= window.innerWidth - r.right - TIP_GAP - TIP_EDGE) {
    return { side: 'right', x: r.right + TIP_GAP };
  }
  if (br.width <= r.left - TIP_GAP - TIP_EDGE) {
    return { side: 'left', x: r.left - TIP_GAP - br.width };
  }
  return null;
}

/* 竖向时的水平位置：宽度压到窗口能容下的尺寸，再对准锚点中心 */
function tipVerticalX(box, r, br) {
  const fit = Math.max(160, window.innerWidth - TIP_EDGE * 2);
  if (br.width > fit) box.style.maxWidth = fit + 'px';
  const b2 = box.getBoundingClientRect();
  return Math.max(TIP_EDGE,
    Math.min(window.innerWidth - b2.width - TIP_EDGE, r.left + r.width / 2 - b2.width / 2));
}

/* 竖向时的竖直位置：上展锚点先试上方，其余先试下方，放不下再翻另一侧。
   上方还要让开顶栏：紧贴窗口顶的锚点往上展只会压在标题栏上 */
function tipVerticalY(flags, r, br) {
  const barEl = document.getElementById('bar');
  const topSafe = Math.max(TIP_EDGE, (barEl ? barEl.getBoundingClientRect().bottom : 0) + 4);
  const bottomRoom = window.innerHeight - TIP_EDGE - br.height;
  let y = r.top + r.height / 2 - br.height / 2;
  if ((flags.dirUp || flags.inCard) && r.top - TIP_GAP - br.height >= topSafe) {
    y = r.top - TIP_GAP - br.height;
  } else if (r.bottom + TIP_GAP + br.height <= window.innerHeight - TIP_EDGE) {
    y = r.bottom + TIP_GAP;
  } else if (r.top - TIP_GAP - br.height >= topSafe) {
    y = r.top - TIP_GAP - br.height;
  }
  y = Math.max(topSafe, Math.min(bottomRoom, y));
  /* 气泡整段落在锚点上沿之上才算 above：被夹回来卡在中间时仍按 below 画箭头 */
  return { y: y, above: y + br.height < r.top - 2 };
}

/* 箭头对准锚点中心：横向时按竖直位置定，竖向时按水平位置定，不贴到圆角外面 */
function tipArrow(box, side, r, br, x, y) {
  if (side === 'v') {
    const ax = Math.max(12, Math.min(br.width - 12, r.left + r.width / 2 - x));
    box.style.setProperty('--tip-arrow-x', Math.round(ax) + 'px');
    box.style.removeProperty('--tip-arrow-y');
    return;
  }
  const ay = Math.max(12, Math.min(br.height - 12, r.top + r.height / 2 - y));
  box.style.setProperty('--tip-arrow-y', Math.round(ay) + 'px');
  box.style.removeProperty('--tip-arrow-x');
}

/* 方向策略：顶栏里的控件横着排一排，气泡摆左右会盖住旁边的按钮；
   文件卡、图例、图层下拉这类窄卡同理；标了 data-tip-dir="up" 的锚点
   （信息窗标题栏、属性表表头这类贴近底部的浮层件）也走上下、且优先向上。
   其余区域默认摆右侧，右边放不下翻左边，两边都放不下才退回上下方 */
function showTipBox(anchor, text) {
  const box = tipBubble();
  clearTimeout(tipState.timer);
  tipState.timer = 0;
  box.textContent = '';
  fillTipBody(box, anchor, text);
  box.hidden = false;
  tipState.anchor = anchor;
  /* 上一次如果压过宽度或高度，这里先还原，否则会带着旧尺寸显示。
     量之前先把 left 归零：气泡是 position:fixed 且只设了 left，宽度按收缩适配算，
     可用宽度 = 视口宽 - left。上一次若把气泡摆到了右边（left 很大），
     这里可用宽度会变成负数，浏览器只能收缩到最小内容宽（实测 46px），
     照着这个宽度定位，气泡就会被甩到窗口外面去 */
  box.style.maxWidth = '';
  box.style.maxHeight = '';
  box.style.overflowY = '';
  box.style.left = '0px';
  box.style.top = '0px';
  const r = anchor.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const flags = tipFlags(anchor);
  const horiz = tipSideX(flags, r, br);
  const side = horiz ? horiz.side : 'v';
  const x = horiz ? horiz.x : tipVerticalX(box, r, br);
  let y = Math.max(TIP_EDGE,
    Math.min(window.innerHeight - br.height - TIP_EDGE, r.top + r.height / 2 - br.height / 2));
  let vert = 'below';
  if (!horiz) {
    const v = tipVerticalY(flags, r, br);
    y = v.y;
    vert = v.above ? 'above' : 'below';
  }
  /* 气泡比窗口还高时（窄窗口 + 长文案），再怎么夹位置也会溢出：
     这时把高度压到窗口内，内容超出部分由气泡自己滚动 */
  if (br.height > window.innerHeight - TIP_EDGE * 2) {
    box.style.maxHeight = (window.innerHeight - TIP_EDGE * 2) + 'px';
    box.style.overflowY = 'auto';
    const b3 = box.getBoundingClientRect();
    y = Math.max(TIP_EDGE, Math.min(window.innerHeight - b3.height - TIP_EDGE, y));
  }
  box.classList.remove('below', 'above', 'left', 'right');
  box.classList.add(horiz ? side : vert);
  tipArrow(box, side, r, br, x, y);
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
  /* 亮着的按钮照样提示：底图、值分布这类开关，开着的时候更需要知道点一下会关掉什么。
     只滤「真的会弹出东西、而且已经弹开了」那一种——这时指针就在面板边上，再飘一句是噪音。
     折叠按钮（收起文件信息、收起图例）长期是 aria-expanded="true"，它不弹任何浮层，
     只认 .on 与 aria-expanded 会把它们永远滤掉——这曾经是"最小化按钮没气泡"的根子 */
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

/* 图例自己那一圈（标题行、内边距、下边距）先让出来，剩下的才是能给卡片与表体的 */
function legendChrome(sr) {
  const legend = $('legend');
  const body = $('legendBody');
  if (!legend || !body || legend.hidden) return { chrome: 0, lmargin: 0 };
  const lr = legend.getBoundingClientRect();
  return {
    chrome: lr.height - body.getBoundingClientRect().height,
    lmargin: Math.max(0, sr.bottom - lr.bottom)
  };
}

/* 卡片自然高度只能"解开封顶量一次"：封顶值若由封顶后的高度反推，两者会互相追着跑 */
function chipNatural(sr) {
  const chip = $('fileChip');
  const chipBody = $('chipBody');
  if (!chip || !chipBody || chip.hidden) {
    return { present: false, natural: 0, chipTop: 0, chipChrome: 0 };
  }
  const prev = chipBody.style.maxHeight;
  chipBody.style.maxHeight = 'none';
  const cr = chip.getBoundingClientRect();
  const chipTop = Math.max(0, cr.top - sr.top);
  const out = {
    present: true,
    natural: chipTop + cr.height + LEGEND_GAP,
    chipTop: chipTop,
    chipChrome: cr.height - chipBody.getBoundingClientRect().height
  };
  chipBody.style.maxHeight = prev;
  return out;
}

function syncMapHeight() {
  const stage = document.querySelector('.map-stage');
  if (!stage) return;
  const sr = stage.getBoundingClientRect();
  if (!sr.height) return;
  const z = uiZoom() || 1;
  const chrome = legendChrome(sr);
  const base = sr.height - chrome.chrome - chrome.lmargin;
  const chip = chipNatural(sr);
  const chipBody = $('chipBody');
  /* 卡片最高能有多高：给图例留够三行 */
  const capLimit = base - LEGEND_GAP - chip.chipTop - LEGEND_MIN;
  const cap = (chip.present && base - chip.natural < LEGEND_MIN)
    ? Math.max(CHIP_MIN, capLimit) : 0;
  if (chipBody) {
    chipBody.style.maxHeight = cap ? Math.max(0, Math.round((cap - chip.chipChrome) / z)) + 'px' : '';
  }
  const used = cap ? chip.chipTop + cap + LEGEND_GAP : chip.natural;
  document.documentElement.style.setProperty(
    '--legend-max', Math.max(0, Math.round((base - used) / z)) + 'px');
  syncLegendTips();
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
  let head = null;   /* 表头由 head() 设置，render() 用；放在闭包里而不是挂在 api 上 */
  const api = {
    head(title, sub) { head = { title, sub }; return api; },
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
      if (head) {
        const box = el('div', 'rail-head');
        box.appendChild(el('div', 'rail-name', head.title));
        if (head.sub) box.appendChild(el('div', 'rail-sub', head.sub));
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
          } else if (it.v.includes('\n')) {
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

/* 投影参数：成对的先合成一行（第一/二标准纬线、假东/假北偏距），
   其余按引擎给的顺序一条一行 */
function crsParamRows(crs) {
  const params = crs.parameters || [];
  const rows = [];
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
  return rows;
}

/* 椭球：名字、长/短半轴、扁率倒数 */
function crsEllipsoidRows(crs) {
  const e = crs.ellipsoid;
  if (!e) return [];
  const rows = [];
  if (e.name || e.semi_major_m) rows.push(['椭球', prettyCrsName(e.name) || '未记录']);
  if (!e.semi_major_m) return rows;
  const m = unitText('m');
  if (e.semi_minor_m) {
    rows.push(['长/短半轴', num(e.semi_major_m, 3) + ' ' + m + '，' + num(e.semi_minor_m, 3) + ' ' + m]);
  } else {
    rows.push(['长半轴', num(e.semi_major_m, 3) + ' ' + m]);
  }
  if (e.inverse_flattening) rows.push(['扁率倒数', '1 / ' + num(e.inverse_flattening, 4)]);
  return rows;
}

/* 地理基准：WGS 84 这一类，括号里给 EPSG 号；没有就是没有 */
function crsGeogRow(crs) {
  const g = crs.geographic_crs;
  if (!g || !g.name) return null;
  return ['地理基准', prettyCrsName(g.name) +
    (g.epsg ? '（EPSG:' + g.epsg + '）' : '（无标准编码）')];
}

function crsRows(crs) {
  if (!crs || (!crs.name && !crs.label)) return [['坐标系', '未记录']];
  // 坐标系写完整名称（如 "China Geodetic Coordinate System 2000"），
  // EPSG 表示法单独一行放，一眼能对上号
  const rows = [['坐标系', prettyCrsName(crs.name || crs.label)]];
  rows.push(['EPSG', crs.code || (crs.is_custom ? '无标准编码（自定义坐标系）' : '未记录')]);
  const kind = [crs.kind_label, crs.method_label].filter(Boolean).join(' · ');
  if (kind) rows.push(['类型', kind]);
  rows.push.apply(rows, crsParamRows(crs));
  rows.push.apply(rows, crsEllipsoidRows(crs));
  const geog = crsGeogRow(crs);
  if (geog) rows.push(geog);
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
  if (s.includes('千米') || s.includes('公里')) return 'km';
  if (s.includes('米')) return 'm';
  if (s.includes('度')) return '°';
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
  return s.replace(/(\d)\s?(km|m|°|ft|yd|nmi)\b/g, (_all, d, u) => d + ' ' + (UNIT_ZH[u] || u));
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

/* 统计项可能是真的没有（快速统计没算），一律用这个判断，别把 0 当缺失 */
function hasNum(v) {
  return v !== null && v !== undefined;
}

function statRows(st, phys) {
  if (!st) return [];
  const digits = physDigits(phys);
  const rows = [];
  if (hasNum(st.minimum)) {
    // 这组值只统计有效像元（跳过 NoData），"最小/最大值"容易让人以为全图都算了
    rows.push(['有效值范围', withUnit(physText(phys, st.minimum, digits) + ' ~ ' +
      physText(phys, st.maximum, digits), phys && phys.unit)]);
  }
  rows.push(['平均值', physText(phys, st.mean, digits)]);
  // 中位数、不同取值、NoData 像元这几项要等值分布算出来才补得上
  if (hasNum(st.median)) rows.push(['中位数', physText(phys, st.median, digits)]);
  rows.push(['标准差', physText(phys, st.stddev, digits)]);
  if (hasNum(st.unique_count)) rows.push(['不同取值', count(st.unique_count) + ' 种']);
  if (hasNum(st.nodata_count)) rows.push(['NoData像元', count(st.nodata_count)]);
  rows.push(['有效像元占比', hasNum(st.valid_percent) ? num(st.valid_percent, 2) + '%' : null]);
  rows.push(['统计来源', st.source_label]);
  /* 换算过的统计另起一行给出原始数：别的软件多半显示文件里那一份，
     对不上数的时候要有个地方能核对 */
  if (phys && phys.on && hasNum(st.minimum)) {
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

/* 左上角坐标：两个值分两行写，一行西边界、一行北边界，和"范围"那四条边同一套说法；
   挤在一行时读的人分不清哪个是经度哪个是纬度 */
function originRow(d, crs) {
  const unit = unitText(crs.unit_label);
  const geoUnit = !unit || unit === '°' || unit === '度';
  const lines = geoUnit
    ? ['西 ' + degText(d.origin[0], true), '北 ' + degText(d.origin[1], false)]
    : d.extent_wgs84
      ? ['西 ' + num(d.origin[0]) + ' ' + unit + ' (' + degText(d.extent_wgs84[0], true) + ')',
        '北 ' + num(d.origin[1]) + ' ' + unit + ' (' + degText(d.extent_wgs84[3], false) + ')']
      : ['西 ' + num(d.origin[0]), '北 ' + num(d.origin[1])];
  return ['左上角坐标', lines.join('\n')];
}

/* 栅格"空间"一节的后半段：范围之后是像元大小、左上角，以及没有地理坐标时的说明 */
function rasterSpaceRows(d, crs) {
  const rows = extentRows(d.extent, d.extent_wgs84, crs.unit_label);
  if (d.pixel_size_label) {
    rows.push(['像元大小', unitSwap(d.pixel_size_label) +
      (d.pixel_size_deg ? '（约 ' + num(d.pixel_size_deg, 6) + '°）' : '')]);
  }
  if (d.origin) rows.push(originRow(d, crs));
  /* 缺哪一样只说在地图区底栏那一句里：信息栏再列一遍，同一件事要在两个地方读，
     而且底下那段话比"无坐标原因"四个字更说得清 */
  if (d.no_georeference) rows.push(['范围', '无地理坐标']);
  return rows;
}

/* 缩放系数与偏移是文件自己写的换算，只在真有且是有限数时才占一行 */
function scaleRow(band, phys) {
  if (phys.rawScale === null || !Number.isFinite(phys.rawScale)) return null;
  return ['缩放系数', '× ' + num(phys.rawScale, 10), band.scale_key
    ? ['换算关系为 真实值 = 原始值 × 缩放系数 + 偏移，系数取自文件属性 ' + band.scale_key + '。']
    : null];
}

function offsetRow(band, phys) {
  if (phys.rawOffset === null || !Number.isFinite(phys.rawOffset)) return null;
  return ['数值偏移', '+ ' + num(phys.rawOffset, 10), band.offset_key
    ? ['偏移取自文件属性 ' + band.offset_key + '，换算时加在缩放之后。']
    : null];
}

/* 栅格"波段"一节：名称、类型、单位与换算系数都来自文件属性，
   多波段时再挂一张逐波段表 */
function railRasterBands(rail, d, band, phys) {
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
  const scale = scaleRow(band, phys);
  if (scale) rail.row(scale[0], scale[1], scale[2]);
  const offset = offsetRow(band, phys);
  if (offset) rail.row(offset[0], offset[1], offset[2]);
  const palette = band.palette_count || d.palette_count || 0;
  rail.row('色表', palette ? palette + ' 项' : '无');
  rail.row('NoData', nodataText(band) || '未设置', band.nodata_key
    ? ['无效值标记取自文件属性 ' + band.nodata_key + '。', '读数据时应先按它做掩膜，否则统计会被填充值带偏。']
    : null);
  if (d.bands && d.bands.length > 1) rail.node(bandTable(d.bands));
}

/* 栅格"存储"一节：压缩、排布、金字塔。金字塔级别取自第一波段，
   各级的重采样方法也一并写出来，用户能看出它是平均值还是最近邻 */
function rasterStorageRows(d, band) {
  return [
    ['压缩算法', d.compression_label],
    ['未压缩大小', bytes(d.uncompressed_bytes)],
    ['压缩比', d.compression_ratio_label],
    ['存储组织', d.storage_layout],
    ['金字塔', band.overviews ? band.overviews + ' 级' +
      (band.overview_resampling ? ' · 重采样 ' + band.overview_resampling : '') : '无'],
    ['波段排布', { BAND: '波段顺序存放', PIXEL: '像元顺序存放' }[d.interleave]],
  ];
}

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

  rail.sec('空间');
  rail.many([
    ['行列号', '行 ' + num(d.rows) + ' · 列 ' + num(d.cols)],
    ['像元总数', count(d.pixels)],
    ['波段数量', d.band_count],
  ]);
  rail.many(rasterSpaceRows(d, crs));

  rail.sec('坐标');
  rail.many(crsRows(crs));

  /* 统计是整层的数，波段是它的细分：先看数再看逐波段的属性 */
  rail.sec('统计');
  if (band.statistics) rail.many(statRows(band.statistics, phys));
  else rail.loading('统计值');
  if (band.statistics_mismatch) {
    showErrToast('统计值与实测分布不一致', band.statistics_mismatch);
  }

  railRasterBands(rail, d, band, phys);

  rail.sec('存储');
  rail.many(rasterStorageRows(d, band));
}

/* 几何类型这一格：混合类型先写名字，各类型个数交给后台数；
   单一类型直接写中文名，括号里带 OGR 的叫法 */
function railGeomType(rail, primary) {
  if (!primary.geometry_type_label) return;
  /* 中文给人读，英文是 OGR 那一套的名字，两边对得上才知道说的是同一种几何；
     Z/M 单独列出（下面两行），几何类型这里不再缀一遍 */
  const geomLabel = primary.geometry_type_label.replace('·含 Z 值', '').replace('·含 M 值', '');
  if (geomLabel.includes('混合')) {
    /* 先把类型本身写出来，"各类型各有多少个"交给后台数——大文件要几秒，
       不能让人盯着一句"正在统计…"干等。数完把这一格换成明细 */
    rail.row('几何类型', primary.geometry_counts_text || geomLabel);
    if (!primary.geometry_counts_text) fillGeomTypes(primary, geomLabel);
    return;
  }
  rail.row('几何类型', geomLabel +
    (primary.geometry_type ? '（' + primary.geometry_type + '）' : ''));
}

/* 范围四条边；快速模式下还没有范围时留一行"统计中"，不让右栏看着缺一块 */
function vectorExtentRows(primary) {
  const rows = extentRows(primary.extent, primary.extent_wgs84,
    (primary.crs || {}).unit_label, !primary.extent_wgs84 && !!primary.extent);
  if (primary.quick && !primary.extent) rows.push(['范围', '统计中…']);
  return rows;
}

function railVector(rail, d) {
  const layers = d.layers || [];
  const primary = layers.find((l) => !l.error) || layers[0] || {};

  rail.sec('空间');
  rail.row('数据类型', (d.driver_label || '矢量数据') + ' 要素类');
  railGeomType(rail, primary);
  rail.row('要素数', count(primary.feature_count) ||
    (primary.quick ? '统计中…' : null));
  rail.row('Z 值坐标', primary.has_z ? '有' : '无');
  rail.row('M 值坐标', primary.has_m ? '有' : '无');
  if (primary.attr_encoding && primary.field_count) rail.row('属性表编码', primary.attr_encoding);
  rail.many(vectorExtentRows(primary));

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
      /* 包内某一份读不出来：气泡里说清是哪一份，右栏也留一行，别让这一段凭空消失 */
      const name = layer.member || '包内文件';
      const err = layer.error || {};
      showErrToast(name + '：' + (err.title || '读取失败'), err.detail, err.hint);
      rail.row('读取失败', name + (err.title ? '：' + err.title : ''));
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
/* 文件自带的提醒（DWG 转换这类）走浮层卡片：看一眼知道就行，
   不放在信息栏里长期占一行，重新渲染时也不再弹 */
function renderConversionNote(data) {
  if (!data.conversion) return;
  showErrToast('转换后读取' +
    (data.conversion.version ? '（' + data.conversion.version + ' 格式）' : ''),
    data.conversion.note);
}

/* 换文件后要重置的那些状态：空图提示、属性表缓存与自动打开、左上角卡片、耗时 */
function resetRenderState(data) {
  $('empty').hidden = true;
  $('panels').hidden = false;
  attrAuto = (data.kind === 'vector' || data.kind === 'archive') && !stackedStage();
  attrLayer = 0;
  attrCache = {};   // 换了文件，属性表的缓存全部作废
  attrShown = null;
  setChip(data);
  // 缓存命中时耗时是 0，dur() 会返回空；直接说"缓存命中"比留白清楚
  if (window.GisMap) GisMap.setElapsed(data.cached ? '缓存命中' : dur(data.elapsed_ms));
}

/* 交给地图：栅格要先算配色，矢量直接画 */
async function drawIntoMap(data) {
  if (window.GisMap) GisMap.clear();
  if (data.kind === 'raster' && !data.multi_variable) await setupRaster(data);
  else resetRasterView();
  // 地图聚焦时要把即将弹出的属性表高度让出来（drawVector 里读这个标志）
  data.reserveAttr = attrAuto;
  if (window.GisMap) GisMap.setDrawLimit(config.draw_limit || 5000);
  if (window.GisMap) GisMap.show(data);
}

async function renderResult(data, opts) {
  /* notes：这次渲染要不要把文件自带的提示/警告弹出来。打开新文件要，重新渲染
     （切波段、改单位、打不开时回滚到上一个文件）不要——同一条提示用户已经看过一遍 */
  renderRail(data, !(opts && opts.quiet));
  if (window.GisMap) GisMap.closePopup();   // 换文件时上一个识别弹窗别留着

  if (!data.ok) {
    const err = data.error || {};
    renderError(err.title || '读取失败', err.detail, err.hint);
    return;
  }

  resetRenderState(data);
  renderConversionNote(data);
  /* deferMap：快速打开的大矢量先不画地图——这时还没有范围，取数会按当前视野过滤，
     十有八九取回来 0 个，而且永远等不到自动聚焦。等全量检查（带范围）到了再画 */
  if (opts && opts.deferMap) return;
  await drawIntoMap(data);
}

/* 右栏那张长表：单位写法之类的设置一改，只重画这一块，地图不动 */
/* 每种数据由谁画右栏：加一种格式只在这里添一行 */
const RAIL_PAINTERS = {
  raster: railRaster,
  vector: railVector,
  tileset: railTileset,
  archive: railArchive,
  json: railJson,
};

/* 图层级的问题逐个报出来，哪个图层读失败了要能指名字 */
function railLayerErrors(data) {
  (data.layers || []).filter((l) => l.error).forEach((l) => {
    showErrToast('图层 ' + (l.name || '未命名') + ' 读取失败', l.error);
  });
}

function railLayerWarning(data) {
  const first = (data.layers || [])[0];
  if (first && first.warning) showErrToast(first.warning, '', '', 'info');
}

/* 提示、警告一律走全局浮层：信息栏只放数据本身，不留说明性文字 */
function railNotes(data) {
  if (data.kind === 'vector') railLayerErrors(data);
  if (data.warning) showErrToast(data.warning, '', '', 'info');
  if (data.kind === 'vector') railLayerWarning(data);
  if (data.kind === 'tileset') {
    showErrToast('这是切片缓存不是单一数据文件',
      '瓦片按视野需要逐张读取，已在地图上按级显示；要素的精确统计请回到原始矢量数据查看。');
  }
}

function renderRail(data, notes) {
  const rail = newRail();
  const f = (data && data.file) || {};
  const path = (current && current.path) || '';
  rail.head(f.name || path || '数据');
  unfoldPanels();

  if (data && data.ok) {
    const painter = RAIL_PAINTERS[data.kind];
    if (painter) painter(rail, data);
    else rail.row('格式', data.driver_label || '未知');
    if (notes) railNotes(data);
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

/* 左上角卡片的那几行：按数据种类拼，空值留给渲染时统一跳过 */
function chipRows(d) {
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
  return rows;
}

function setChip(d) {
  const chip = $('fileChip');
  if (!d) { chip.hidden = true; hideLayerPop(); return; }
  layerItems = [];
  layerActive = 0;
  const f = d.file || {};
  const rows = chipRows(d);

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

/* 直方图里已经算出来了、统计缓存里却空着的那几项，就地补进 statistics：
   大文件走的是快速统计，别为了三个数字再跑一遍引擎 */
function fillMedian(st, h) {
  if (st.median !== null && st.median !== undefined) return false;
  const m = medianOfHist(h);
  if (m === null || !Number.isFinite(m)) return false;
  st.median = m;
  return true;
}

function fillUniqueCount(st, h) {
  if (st.unique_count !== null && st.unique_count !== undefined) return false;
  if (!h.per_value_bins) return false;   // 分箱过的直方图数不出"不同取值个数"
  st.unique_count = (h.counts || []).filter((c) => c > 0).length;
  return true;
}

function fillNodataCount(st, d, h) {
  if (st.nodata_count !== null && st.nodata_count !== undefined) return false;
  if (!d.pixels || h.valid_percent === null || h.valid_percent === undefined) return false;
  const n = Math.round(d.pixels * (1 - h.valid_percent / 100));
  if (n <= 0) return false;
  st.nodata_count = n;
  return true;
}

function mergeHistStats(res) {
  const d = current && current.data;
  const h = res && res.histogram;
  if (!h || !d || d.kind !== 'raster' || d.multi_variable || res.band !== 1) return false;
  const band0 = (d.bands || [])[0];
  const st = band0 && band0.index === 1 ? band0.statistics : null;
  if (!st) return false;
  const changed = [fillMedian(st, h), fillUniqueCount(st, h), fillNodataCount(st, d, h)];
  return changed.some(Boolean);
}

/* 分级界值和颜色：图例、影像出图共用这一份。
   fill 只是给影像 URL 用的记号，让"无数据处"一改就绕开浏览器缓存 */
function styleOf(res) {
  const fill = config.nodata_view || 'transparent';
  if (res.discrete) {
    return {
      band: res.band, edges: res.discrete.edges, colors: res.discrete.colors,
      scheme: '分类数据', fill: fill,
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
  $('histBody').appendChild(drawHistogram(hist, phys, !!res.discrete));
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

/* 线性刻度：档距取 1/2/5×10^n，而且必须盖住峰值，顶上再多走一格。
   档距若向下取整（以前 5 会退成 2），最高那根柱子就会顶到框线外面去；
   对数轴的标签会全挤在顶上（1/2/5 之间差一个数量级），直方图看的是相对高低，线性才对 */
function linTicks(peak, parts) {
  const n = parts || 4;
  if (!(peak > 0)) return { list: [0, 1], step: 1 };
  const raw = peak / n;
  const mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  const k = raw / mag;
  const step = (k > 5 ? 10 : k > 2 ? 5 : k > 1 ? 2 : 1) * mag;
  const list = [0];
  let v = 0;
  /* 一直走到高过峰值一点点：最后一格就是留给最高那根柱子的余量 */
  while (v < peak * 1.06) {
    v += step;
    list.push(v);
  }
  return { list: list, step: step };
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

/* 图表的配色全部取自 CSS 变量：浅色/深色主题切换后不用重画就有正确颜色 */
function histPalette(root) {
  const get = (name, fallback) => (root.getPropertyValue(name) || '').trim() || fallback;
  return {
    bar: get('--bar', '#4b8ec4'),
    dim: get('--text-dim', '#777'),
    grid: get('--line', 'rgba(0,0,0,.1)'),
    tipBg: get('--panel', '#fff'),
    tipTx: get('--text', '#222'),
  };
}

/* 横轴数字跟着信息栏那份换算走：一边显示 0.001~0.598、一边显示 1~598
   会让人以为看了两份数据 */
function histFrame(hist, phys) {
  const lo = Number(hist.min);
  const step = Number(hist.bin_width) || 0;
  const on = !!(phys && phys.on);
  const pd = physDigits(phys);
  return {
    lo: lo,
    step: step,
    on: on,
    pd: pd,
    at: (v) => (on ? physVal(phys, v) : v),
    xDigits: on ? pd : (step >= 1 ? 0 : 3),
  };
}

/* 分类数据的横轴就是「第几类」，每一类都得标出来：挤的时候斜着排，
   不再按 maxTicksLimit 抽掉一半，否则对不上图例里那些类别 */
function histXTicks(discrete, count, color) {
  if (discrete) {
    return {
      color: color, font: { size: 12 }, autoSkip: false,
      maxRotation: count > 12 ? 60 : 0, minRotation: 0, padding: 0,
    };
  }
  return { maxTicksLimit: 6, color: color, font: { size: 13 }, autoSkip: true, padding: 0 };
}

function histYTitle(unit, color) {
  return {
    display: true,
    text: '像元数' + (unit[1] ? '（' + unit[1] + '）' : ''),
    color: color,
    font: { size: 13 },
    padding: { top: 0, bottom: 0 },
  };
}

/* 悬停气泡：标题给这一档的区间，正文给像元数 */
function histTooltip(fr, counts, colors) {
  const gap = fr.on ? fr.pd : 4;
  return {
    displayColors: false,
    // 气泡跟着主题走：浅色底上不再是默认那块深灰
    backgroundColor: colors.tipBg,
    titleColor: colors.tipTx,
    bodyColor: colors.tipTx,
    borderColor: colors.grid,
    borderWidth: 1,
    cornerRadius: 6,
    padding: 8,
    callbacks: {
      title: (items) => {
        const a = fr.lo + items[0].dataIndex * fr.step;
        return num(fr.at(a), gap) + ' ~ ' + num(fr.at(a + fr.step), gap);
      },
      label: (ctx) => count(counts[ctx.dataIndex]) + ' 像元',
    },
  };
}

function drawHistogram(hist, phys, discrete) {
  const wrap = el('div', 'hist-canvas');
  const counts = (hist && hist.counts) || [];
  if (!counts.length) return wrap;
  const peak = Math.max.apply(null, counts.concat([1]));
  const unit = tickUnit(peak);
  // 先按万/亿缩一遍再取整，刻度才是 0 2.5 5 7.5 10 这样均匀的一串
  const scale = linTicks(peak / unit[0]);
  const top = scale.list[scale.list.length - 1] || 1;
  const shown = (v) => String(Math.round(v * 10) / 10);
  const fr = histFrame(hist, phys);
  const labels = counts.map((_c, i) => num(fr.at(fr.lo + i * fr.step), fr.xDigits));
  const colors = histPalette(getComputedStyle(document.documentElement));

  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  destroyHistChart();
  histChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: counts.map((c) => c / unit[0]),
        backgroundColor: colors.bar,
        hoverBackgroundColor: colors.bar,
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
          border: { color: colors.grid },
          // 标签再贴近轴线一点，给绘图区多留高度
          ticks: histXTicks(discrete, counts.length, colors.dim),
        },
        y: {
          beginAtZero: true,
          max: top,
          grid: { color: colors.grid, drawTicks: false },
          border: { display: false },
          ticks: {
            stepSize: scale.step, color: colors.dim, font: { size: 13 }, padding: 2,
            callback: (v) => shown(v),
          },
          // 轴标题竖着写在轴左侧，不占顶上那条位置
          title: histYTitle(unit, colors.dim),
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: histTooltip(fr, counts, colors),
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

/* 图例宽度有上限，值太长会被省略号切掉。切没切要量过才知道（同一个字符串在窄图例里
   切、在宽图例里不切），所以按 scrollWidth 判定，切掉了才挂全文气泡，没切就不挂 */
function syncLegendTips() {
  document.querySelectorAll('#legendBody .legend-val').forEach((v) => {
    if (v.scrollWidth > v.clientWidth + 1) v.setAttribute('data-tip', v.textContent);
    else v.removeAttribute('data-tip');
  });
}

function legendRow(color, text) {
  const row = el('div', 'legend-row');
  const sw = el('i', 'legend-swatch');
  sw.style.background = color;
  row.appendChild(sw);
  const val = el('span', 'legend-val', text);
  row.appendChild(val);
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
    syncMapHeight();
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
  syncMapHeight();   // 行数变了，能长多高跟着变；这一步顺带量一次哪几行被省略
}

function hideLegend() {
  legendBody(false);
}
