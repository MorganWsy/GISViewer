/* ---------- 主题与设置、缓存、数据体检、格式互转、外观与字体 ---------- */
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

/* 设置页按分组填：每个函数只负责一个分区的控件，
   顺序与原来自上而下一致（基础、显示、窗口、缓存、外观、系统） */
function fillBasemapSettings() {
  $('cfgBasemap').value = config.basemap || 'tianditu_img';
  $('cfgAnnotation').checked = config.annotation === true;
  $('cfgKey').value = config.tianditu_key || '';
  keyTouched = false;
  paintBasemapFields();
}

function fillRenderSettings() {
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
}

function fillWindowSettings() {
  $('cfgTopMost').checked = !!config.always_on_top;
  if ($('cfgPyrAsk')) $('cfgPyrAsk').checked = !pyrNeverAsked();
  $('cfgRestore').checked = !!config.restore_last;
  $('cfgOpenDir').value = config.open_dir || '';
  $('cfgRecentMax').value = String(recentMax());
}

function fillCacheSettings() {
  /* 副本存放位置留空时直接填上系统临时目录：让用户看见实际用的是哪，
     而不是对着一个"留空则用临时目录"的占位符去猜 */
  $('cfgCache').value = config.cache_dir || config.temp_dir || '';
  cachePickIntent = config.cache_root || null;
  // 框里给"用户选的位置"；实际生效的目录（所选位置 / TulanCache）在下方状态行
  $('cachePath').value = config.cache_root || config.cache_effective || cacheDirShown || '';
  $('cfgKeepHours').value = String(config.keep_hours || 12);
}

function fillLookSettings() {
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
}

function fillSystemSettings() {
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

function fillSettings() {
  fillBasemapSettings();
  fillRenderSettings();
  fillWindowSettings();
  fillCacheSettings();
  fillLookSettings();
  fillSystemSettings();
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

/* 选目录时从这一栏当前的路径起步：全从"起始目录"起步的话，
   选副本目录、缓存目录都得自己再翻一遍 */
function pickFrom(inputId) {
  const box = $(inputId);
  toShell('pickdir:' + ((box && box.value) || '').trim());
}

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
    if (convDryStale(seq, sig)) return;
    convDrySig = sig;
    convDryDone = true;
    const box2 = convStatusBox();
    const sum2 = $('convSrcSum');
    if (!box2 || !sum2) return;
    box2.textContent = '';
    if (!d || !d.ok) { convDryFail(d, sum2); return; }
    convDryOk(d, box2, sum2);
  }).catch(() => {
    const sum2 = $('convSrcSum');
    if (sum2) sum2.textContent = '';
    convReady = false;
    updateConvRun();
    convError('预检没能完成。', '请确认引擎在运行，然后重试。');
  });
}

/* 这次预检还算数吗：序号不是最新、参数变了、浮层已经关掉，都作废 */
function convDryStale(seq, sig) {
  if (seq !== convDrySeq) return true;      // 已经有更新的一次预检在跑
  if (sig !== convSignature()) return true; // 参数在等待期间变了，结果对不上
  const pop = $('convPop');
  return !!(pop && pop.hidden);
}

/* 预检成功：把"转换后长什么样"填进页脚摘要，警告逐条列出 */
function convDryOk(d, box2, sum2) {
  const b = d.before || {};
  convReady = true;
  updateConvRun();
  sum2.textContent = [
    b.feature_count + ' 个要素',
    b.field_count + ' 个字段',
    b.geometry || '几何未知',
    b.crs || '坐标系未记录'
  ].join(' · ');
  // 落点直接给完整路径，就在页脚那一行的最左侧
  paintConvOutHint(d.out_path || '');
  (d.warnings || []).forEach((w) => box2.appendChild(convMsg('warn', w)));
}

/* 预检没过：清掉摘要，把引擎给的标题与建议一起亮出来 */
function convDryFail(d, sum2) {
  const err = (d && d.error) || {};
  sum2.textContent = '';
  convReady = false;
  updateConvRun();
  paintConvOutHint('');
  convError(err.title || '预检未通过。', err.hint);
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


/* ---- 两份文件对比 ----
   左边默认填当前打开的那份，右边自己挑。结果分三段，顺序按"先看结论、再看结构、
   最后看内容"排：表头（范围/坐标系/个数）、字段结构、前 20 行属性。
   属性按行号对齐，不按主键配对——真要逐要素比对，得先由用户指定一个唯一字段，
   那是质检流程，这里不做，也不假装做了。 */
let cmpBusy = false;

function toggleCmpPop() {
  const pop = $('cmpPop');
  if (pop && !pop.hidden) hideCmpPop();
  else showCmpPop();
}

function showCmpPop() {
  const pop = $('cmpPop');
  if (!pop) return;
  const a = $('cmpPathA');
  // 左边跟着当前文件走：换文件后重开浮层就是新那份
  if (a && (current && current.path) && (!a.value.trim() || a.dataset.auto === '1')) {
    a.value = current.path;
    a.dataset.auto = '1';
  }
  pop.hidden = false;
  markBtn('cmpBtn', true);
  placeCmpPop();
  syncCmpRun();
}

function hideCmpPop() {
  if (cmpBusy) return;
  const pop = $('cmpPop');
  if (pop) pop.hidden = true;
  markBtn('cmpBtn', false);
}

function placeCmpPop() {
  const pop = $('cmpPop');
  const btn = $('cmpBtn');
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 720;
  pop.style.left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
}

function setCmpBusy(on) {
  cmpBusy = !!on;
  const mask = $('cmpBusy');
  if (mask) mask.hidden = !on;
  const run = $('cmpRun');
  if (run) run.disabled = !!on;
}

function syncCmpRun() {
  const run = $('cmpRun');
  if (!run) return;
  const a = ($('cmpPathA') || {}).value || '';
  const b = ($('cmpPathB') || {}).value || '';
  run.disabled = cmpBusy || !a.trim() || !b.trim();
}

function setCmpHint(text) {
  const hint = $('cmpHint');
  if (!hint) return;
  hint.textContent = text || '';
}

function clearCmpResult() {
  const res = $('cmpResult');
  if (res) res.hidden = true;
  ['cmpSummary', 'cmpMetaSec', 'cmpFieldSec', 'cmpSampleSec'].forEach((id) => {
    const node = $(id);
    if (node) node.textContent = '';
  });
}

/* 现在选的配对字段：空串就是按行号对齐 */
function cmpKey() {
  const sel = $('cmpKeySel');
  return sel && !sel.disabled ? String(sel.value || '') : '';
}

function runCompare() {
  const a = (($('cmpPathA') || {}).value || '').trim();
  const b = (($('cmpPathB') || {}).value || '').trim();
  if (!a || !b || cmpBusy) return;
  setCmpHint('');
  setCmpBusy(true);
  let url = '/api/compare?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b);
  const key = cmpKey();
  if (key) url += '&key=' + encodeURIComponent(key);
  fetch(url).then((r) => r.json()).then((d) => {
    if (!d || !d.ok) {
      clearCmpResult();
      const err = (d && d.error) || {};
      setCmpHint(err.title || '对比失败');
      if (err.detail || err.hint) showErrToast(err.title || '对比失败', err.detail, err.hint);
      return;
    }
    renderCompare(d);
  }).catch(() => {
    clearCmpResult();
    setCmpHint('对比失败');
    showErrToast('没能完成对比', null, '检查网络与本机服务是否还在，稍后重试。');
  }).then(() => setCmpBusy(false));
}

/* 表头对照：一行一项，两边值并排；不同的整行标注底色 */
function renderCmpMeta(rows, host) {
  const table = el('table', 'cmp-table');
  const head = el('thead');
  const hr = el('tr');
  ['项目', '左', '右'].forEach((t) => hr.appendChild(el('th', null, t)));
  head.appendChild(hr);
  table.appendChild(head);
  const body = el('tbody');
  rows.forEach((row) => {
    const tr = el('tr');
    if (!row.same) tr.className = 'diff';
    tr.appendChild(el('td', null, row.label));
    const ca = el('td', row.a === '' || row.a === null ? 'cmp-empty' : null, row.a === '' || row.a === null ? '（无）' : row.a);
    const cb = el('td', row.b === '' || row.b === null ? 'cmp-empty' : null, row.b === '' || row.b === null ? '（无）' : row.b);
    tr.appendChild(ca);
    tr.appendChild(cb);
    body.appendChild(tr);
  });
  table.appendChild(body);
  host.appendChild(table);
}

/* 字段差异：只在一边有的字段、类型/宽度变了的字段，各占一段 */
function renderCmpFields(fields, host) {
  const lines = [];
  (fields.only_a || []).forEach((n) => lines.push(['只在左边', n]));
  (fields.only_b || []).forEach((n) => lines.push(['只在右边', n]));
  (fields.changed || []).forEach((item) => {
    (item.diffs || []).forEach((d) => {
      lines.push([item.name + ' · ' + d.what, (d.a === null ? '（无）' : d.a) + ' → ' + (d.b === null ? '（无）' : d.b)]);
    });
  });
  if (!lines.length) {
    host.appendChild(el('div', 'cmp-none', fields.order_same === false ? '字段集合一致，但两边的排列顺序不同。' : '字段名、类型、宽度都一致。'));
    return;
  }
  const list = el('div', 'cmp-list');
  lines.slice(0, 40).forEach(([where, what]) => {
    const line = el('div', 'cmp-line');
    line.appendChild(el('span', 'cmp-where', where));
    line.appendChild(el('span', 'cmp-val', what));
    list.appendChild(line);
  });
  host.appendChild(list);
  if (lines.length > 40) host.appendChild(el('div', 'cmp-more', '还有 ' + (lines.length - 40) + ' 处未列出。'));
}

/* 属性差异：一条一条写清楚"第几行、哪个字段、两边各是什么" */
function renderCmpSample(sample, host) {
  const cells = sample.cells || [];
  const note = sample.note || '';
  if (!cells.length) {
    // 没有同名字段时 note 已经把原因说清楚了，不再补一句"没有可对比的属性行"重复
    if ((sample.common_fields || 0) > 0 || !note) {
      const unit = sample.mode === 'key' ? ' 个要素' : ' 行';
      host.appendChild(el('div', 'cmp-none', sample.rows_compared ? '对比的 ' + sample.rows_compared + unit + '属性完全一致。' : '没有可对比的属性行。'));
    }
    if (note) host.appendChild(el('div', 'cmp-more', note));
    return;
  }
  const list = el('div', 'cmp-list');
  cells.forEach((cell) => {
    const line = el('div', 'cmp-line');
    const where = (sample.mode === 'key' ? '要素 ' + cell.row : '第 ' + cell.row + ' 行') +
      ' · ' + cell.field;
    line.appendChild(el('span', 'cmp-where', where));
    const val = el('span', 'cmp-val');
    val.appendChild(el('b', null, '左 '));
    val.appendChild(document.createTextNode(cell.a === '' ? '（空）' : cell.a));
    val.appendChild(el('b', null, '  · 右 '));
    val.appendChild(document.createTextNode(cell.b === '' ? '（空）' : cell.b));
    line.appendChild(val);
    list.appendChild(line);
  });
  host.appendChild(list);
  if (sample.cells_truncated) host.appendChild(el('div', 'cmp-more', '差异太多，只列前 ' + cells.length + ' 处。'));
  if (note) host.appendChild(el('div', 'cmp-more', note));
}

function syncCmpKeys(d) {
  const sel = $('cmpKeySel');
  if (!sel) return;
  const sample = d.sample || {};
  const list = sample.common_fields_list || [];
  const want = sel.value;
  sel.textContent = '';
  if (d.kind !== 'vector') {
    const only = el('option', null, '影像没有要素可配对');
    only.value = '';
    sel.appendChild(only);
    sel.disabled = true;
    return;
  }
  const plain = el('option', null, '按行号对齐（不配对要素）');
  plain.value = '';
  sel.appendChild(plain);
  list.forEach((name) => {
    const o = el('option', null, '按「' + name + '」配对要素');
    o.value = name;
    sel.appendChild(o);
  });
  // 上一次选的字段如果这份数据里没有，就退回按行号
  sel.value = list.indexOf(want) >= 0 ? want : '';
  sel.disabled = !list.length;
  // 选项是刚换的，自定义下拉要跟着重建（原生 select 已经退成 1px 的替身）
  if (window.syncSelect) window.syncSelect(sel);
}

function renderCompare(d) {
  clearCmpResult();
  syncCmpKeys(d);
  const sum = $('cmpSummary');
  if (sum) sum.textContent = d.summary || '';
  const metaSec = $('cmpMetaSec');
  if (metaSec && (d.rows || []).length) {
    metaSec.appendChild(cmpSectionHead('表头与元信息', d.diff ? d.diff.meta : 0));
    renderCmpMeta(d.rows, metaSec);
  }
  if (d.kind === 'vector') {
    const fieldSec = $('cmpFieldSec');
    if (fieldSec) {
      fieldSec.appendChild(cmpSectionHead('字段结构', d.diff ? d.diff.fields : 0));
      renderCmpFields(d.fields || {}, fieldSec);
    }
    const sampleSec = $('cmpSampleSec');
    if (sampleSec) {
      // 两边一个同名字段都没有时，"0 处不同"会被读成"逐格比过、结果一致"，
      // 其实压根没得比，标题这里就写明白
      const common = (d.sample || {}).common_fields || 0;
      sampleSec.appendChild(common
        ? cmpSectionHead('属性内容', d.diff ? d.diff.sample_rows : 0)
        : cmpSectionHead('属性内容', null, '无法对比'));
      renderCmpSample(d.sample || {}, sampleSec);
    }
  } else if ($('cmpSampleSec')) {
    $('cmpSampleSec').hidden = true;
  }
  const res = $('cmpResult');
  if (res) res.hidden = false;
}

function cmpSectionHead(title, count, note) {
  const hd = el('div', 'cmp-sec-hd', title);
  if (note) hd.appendChild(el('span', 'cmp-cnt', note));
  else if (count) hd.appendChild(el('span', 'cmp-cnt', count + ' 处不同'));
  else hd.appendChild(el('span', 'cmp-cnt', '一致'));
  return hd;
}
