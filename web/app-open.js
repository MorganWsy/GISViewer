/* ---------- 无边框标题栏、读取入口、关闭确认、外部改动监测、金字塔、最近打开、打开菜单、坐标定位 ---------- */
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

/* 打开一个文件前把浮窗、焦点、状态收干净：快捷方式、拖放、最近打开都走这一条 */
function prepareOpen(path) {
  /* 开始打开新文件就把浮窗收掉：路径框那边不该还挂着一块"最近打开"盖在地图上 */
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
}

/* 问一次服务端：这个路径是什么。fast 为真时只要头部那点信息，慢的统计后台补 */
async function fetchInspect(path, fast) {
  const res = await fetch('/api/path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, fast }),
    signal: openAbort ? openAbort.signal : undefined,
  });
  return res.json();
}

/* 最近打开里的路径可能已经不在（文件被移走、改名）：顺手从清单里删掉，
   否则这一条以后每次点都会失败一次 */
function dropStaleRecent(path, data) {
  if (data.ok) return false;
  if (!(config.recent || []).includes(path)) return false;
  if (!/找不到|不存在/.test((data.error && data.error.title) || '')) return false;
  config.recent = config.recent.filter((x) => x !== path);
  renderRecent();
  commitConfig();
  return true;
}

/* 已经开着图层时又拖进来一个读不出来的东西（比如文件夹）：
   浮层卡片说明原因，眼前这块原样留着，不能顺手把人正在看的东西清了 */
function rollbackOpen(prev, data) {
  const err = data.error || {};
  loadTip(false);
  showErrToast(err.title || '这个文件打不开', err.detail, err.hint);
  current = prev;
  /* 回滚重画走的是正常渲染路径，没有 finally 管它：栅格首屏算配色时
     会把加载指示重新挂起来，收尾必须自己收，否则屏幕上一直转圈、看着像还在读 */
  renderResult(prev.data, { quiet: true })
    .catch(() => { /* 回滚渲染不出来也就算了，浮层已经说明原因 */ })
    .finally(() => { loadTip(false); });
}

/* 大矢量的后半程：先出图，再把全量统计补进右栏。
   统计会拿 GDAL 读锁，和首屏取数抢锁会把首屏拖慢，所以等这一批要素画完
   （gis:drawn）再发请求；取数失败也会发这个事件，15 秒兜底，避免统计永远不补 */
async function finishDeferred(data, path) {
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
  await renderResult(data);   // 先出图（范围由取数响应补）
  await drawn;
  const full = await fetchInspect(path, false).catch(() => null);
  if (!(current && current.data === data && full && full.ok)) {
    if (data.ok) noteOpened(path, data);
    return;
  }
  current.data = full;
  const ly = (full.layers || [])[full.layerIndex || 0];
  if (ly && ly.extent_wgs84 && window.GisMap) {
    /* 首屏是拿这一批要素的包围盒临时对上的；全量范围到了，
       用户还没动过地图就补一次真正的全图 */
    GisMap.setExtent(ly.extent_wgs84);
  }
  renderRail(full, false);          // 只换右栏，地图保持已画好的状态
  setChip(full);                    // 左上角文件卡片也要从"0"补成真实数量
  if (window.GisMap) GisMap.setElapsed(dur(full.elapsed_ms));
  noteOpened(path, full);
}

/* 打开失败：DWG 被用户取消时静默收手，其余情况把原因写在浮层上 */
function openFailed(err) {
  stopDwgWatch();
  loadTip(false);
  if (err && err.name === 'AbortError') return;   // 用户取消 DWG 转换
  renderError('本地服务没有响应', err.message, '请确认服务已启动。');
}

/* 画之前先挂遮罩：栅格是同步画完的，等渲染返回时完成事件早发过了 */
function stageVeil(data) {
  const staged = !!data.ok && VEIL_KINDS.includes(data.kind);
  if (staged) holdVeil('正在画图层…');
  return staged;
}

function endOpen(staged) {
  stopDwgWatch();
  openAbort = null;
  if (!staged) { releaseVeil(); loadTip(false); }
}

/* 大矢量走快速元数据：信息栏立刻立起来，地图等全量检查（带范围）到了再画 */
function needsDeferredMap(data) {
  return !!data.ok && !!data.quick && data.kind === 'vector';
}

async function inspectPath(path) {
  const prev = current;
  const hadLayer = !!(prev && prev.data && prev.data.ok);
  prepareOpen(path);
  let data;
  try {
    data = await fetchInspect(path, true);   // 先立界面，个数范围后台补
  } catch (err) {
    openFailed(err);
    return;
  }
  dropStaleRecent(path, data);
  if (!data.ok && hadLayer) {
    rollbackOpen(prev, data);
    return;
  }
  current = { path, data };
  /* 地图换了数据，格式互转的输入文件跟着换（用户没手填过才跟） */
  syncConvSource();
  const staged = stageVeil(data);
  const deferMap = needsDeferredMap(data);
  try {
    await renderResult(data, { deferMap });
    if (deferMap) {
      await finishDeferred(data, path);
      return;
    }
    if (data.ok) noteOpened(path, data);
  } catch (err) {
    releaseVeil();
    renderError('界面渲染出错', (err && err.message) || String(err));
  } finally {
    endOpen(staged);
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

function fetchPyrStatus(path, probe) {
  return fetch('/api/pyramid/status?probe=' + (probe ? '1' : '0') +
    '&path=' + encodeURIComponent(path)).then((r) => r.json());
}

/* 把信息填进弹窗。方法默认值按数据类型给，但用户一碰就以用户为准 */
function openPyramidDialog(path, st) {
  pyrPath = path;
  pyrTouched = false;
  $('paSize').textContent = st.width ? st.width.toLocaleString() + '×' + st.height.toLocaleString() : '—';
  $('paBytes').textContent = st.size ? fmtBytes(st.size) : '—';
  const levels = st.levels || [];
  $('paLevels').textContent = levels.length ? levels.length + ' 级（1/' + levels[levels.length - 1] + '）' : '—';
  pyrRecommend = (st.colortable || st.categorical) ? 'nearest' : 'average';
  setPyramidMethod(pyrRecommend);
  $('paNever').checked = false;
  $('pyrAsk').hidden = false;
}

function askPyramid(path, data) {
  /* 压缩包里的临时副本不建：它下次打开就是另一个路径了，副本白建 */
  if (!data || !data.ok || data.kind !== 'raster' || data.temp_copy) return Promise.resolve();
  if (pyrNeverAsked()) return Promise.resolve();
  /* 判断全用打开文件时已经拿到的数字（宽高、字节数、金字塔级数），一次请求都不发。
     以前这里要单独问一次 status，第一次请求得排在大图渲染后面，实测能等到一秒多，
     弹窗就慢了 */
  const py = data.pyramid;
  if (!py || py.exists || !py.recommend) return Promise.resolve();
  if (!current || current.path !== path) return Promise.resolve();
  openPyramidDialog(path, py);
  /* 后台再确认两件事：有没有已经建好的副本（缓存可能刚被清），以及是不是分类图。
     分类判断要读一小块原始像元，大文件冷盘上要一秒，所以放在弹窗之后 */
  fetchPyrStatus(path, true)
    .then((st) => {
      if (!st || !st.ok) return;
      if (st.pyramid && st.pyramid.exists) { hidePyramidAsk(); return; }
      if (pyrPath !== path) return;
      if (st.running) { hidePyramidAsk(); return; }
      if (!st.categorical || pyrTouched) return;       // 用户已经自己选过就别抢
      pyrRecommend = 'nearest';
      if (pyramidMethod() === 'nearest') paintPyramidHint();
      else setPyramidMethod('nearest');
    })
    .catch(() => { /* 问不出来就按连续数据处理，不影响看文件 */ });
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
let pyrTouched = false;      // 用户自己动过采样方法：之后不再自动改

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
  /* 点卡片时高亮要跟着走：以前只重画说明文字，高亮一直留在默认那张 */
  el.addEventListener('change', () => {
    if (!el.checked) return;
    pyrTouched = true;
    setPyramidMethod(el.value);
  });
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
const RECENT_FMT_RULES = [
  // 驱动名有中文（文件地理数据库）也有英文，两套都得认
  [/Geodatabase|GeoPackage|SQLite|SpatiaLite|地理数据库|空间数据库/i, 'db'],
  [/表格|CSV|XLSX/i, 'table'],
  [/^KML|^GPX/i, 'globe'],
  [/GeoJSON|GML|TopoJSON|JSON/i, 'code'],
  [/^DXF|^DWG/i, 'cad']
];
const RECENT_GEOM_KEYS = ['point', 'line', 'polygon'];

function recentIconKey(m) {
  if (!m) return 'file';
  if (m.kind === 'archive') return 'archive';
  const fmt = m.fmt || '';
  for (let i = 0; i < RECENT_FMT_RULES.length; i += 1) {
    if (RECENT_FMT_RULES[i][0].test(fmt)) return RECENT_FMT_RULES[i][1];
  }
  if (m.kind === 'raster') return 'raster';
  const g = (m.geom || '').toLowerCase();
  for (let i = 0; i < RECENT_GEOM_KEYS.length; i += 1) {
    if (g.startsWith(RECENT_GEOM_KEYS[i])) return RECENT_GEOM_KEYS[i];
  }
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
/* 一个数字加可选的度数符号与方位字母："116.4"、"116.4E"、"39.9N" 都认 */
function parseCoord(part) {
  const m = /^([-+]?[\d.]+)\s*(?:°|deg)?([NSEWnsew])?$/.exec(part);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  const h = (m[2] || '').toUpperCase();
  if (h === 'S' || h === 'W') v = -v;
  const axis = h === 'N' || h === 'S' ? 'lat' : (h === 'E' || h === 'W' ? 'lon' : '');
  return { v: v, axis: axis };
}

function parseLonLat(text) {
  const s = String(text || '').trim().replace(/，/g, ',').replace(/；/g, ';').replace(/\s+/g, ' ');
  if (!s || /[\\/:*?"<>|]/.test(s)) return null;
  if (/\.[A-Za-z]{2,5}$/.test(s)) return null;
  const parts = s.split(/[,; ]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = parseCoord(parts[0]);
  const b = parseCoord(parts[1]);
  if (!a || !b) return null;
  let lon = a.v;
  let lat = b.v;
  // 写了 N/S 在前（39.9N 116.4E 这类），按字母把两数换回来
  if (a.axis === 'lat' || b.axis === 'lon') { lon = b.v; lat = a.v; }
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
