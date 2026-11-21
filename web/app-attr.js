/* ---------- 属性表、值分布气泡、底部读数、属性表上沿的拖动条 ---------- */
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
/* 字段类型的解释：给人读的一句话。带长度/精度的用函数生成，固定说法直接写 */
const TYPE_EXPLAIN = {
  IntegerList: () => '整数列表（IntegerList）：一个字段里存一组整数',
  RealList: () => '浮点列表（RealList）：一个字段里存一组带小数点的数值',
  Integer: (w) => '整数（Integer，32 位）：不含小数位，常用于编号、计数、年份。' +
    (w ? '最多 ' + w + ' 位数字' : '取值范围约 ±21.5 亿'),
  Integer64: (w) => '长整数（Integer64，64 位）：取值范围远大于 32 位整数' +
    (w ? '，最多 ' + w + ' 位数字' : '') + '，常用于大编号与时间戳',
  Real: (w, p) => '双精度浮点（Real，即 Double）：存带小数点的连续数值，如面积、人口、降水量。' +
    (p ? '小数位 ' + p + ' 位' : '按双精度存储，约 15 位有效数字'),
  Date: () => '日期（Date）：只记年月日，不含时刻',
  DateTime: () => '日期时间（DateTime）：年月日与时刻一起记',
  Time: () => '时间（Time）：只记时刻，不含日期',
};

function typeExplain(f) {
  const t = String(f.type || '');
  const w = f.width ? Number(f.width) : 0;
  const p = f.precision ? Number(f.precision) : 0;
  if (!t) return '';
  // 带 List 的、带 String/Binary 的是一整类，先按前缀判，剩下的是定名类型
  if (t.startsWith('StringList')) return '文本列表（StringList）：一个字段里存多段文字';
  if (t === 'WideString' || t.startsWith('String')) {
    return '文本（String）：存名称、编号、备注这类文字内容。' +
      (w ? '每个值最多 ' + w + ' 个字符，超出即截断' : '长度上限由数据源定义');
  }
  if (t.startsWith('Binary')) return '二进制（Binary）：存字节流，如图片、附件，表格里读不出内容';
  const make = TYPE_EXPLAIN[t];
  return make ? make(w, p) : '存储类型：' + t;
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
    Object.keys(f.properties || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); });
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
    const on = String(tr.textContent).toLowerCase().includes(q);
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

/* Esc 一层层往回收：先关最上面的浮层，再关识别弹窗；属性表不归它管 */
function escapeTopLayer(e, typing) {
  const t = e.target;
  if (!$('closeAsk').hidden) { hideCloseAsk(); toShell('closechoice:cancel'); return; }
  if (!$('updPop').hidden) { closeUpdPop(); return; }
  if (!$('recentPop').hidden) { hideRecent(); return; }
  if (!$('pickPop').hidden) { hidePickPop(); return; }
  if (!$('checkPop').hidden) { hideCheckPop(); return; }
  if (!$('convPop').hidden) { hideConvPop(); return; }
  if (!$('cmpPop').hidden) { hideCmpPop(); return; }
  if (!$('layerPop').hidden) { hideLayerPop(); return; }
  if (!$('settings').hidden) { $('cfgClose').click(); return; }
  if (!$('errToast').hidden) { hideErrToast(); return; }
  if (t === $('attrFind')) { $('attrFind').value = ''; applyAttrFind(); $('attrFind').blur(); return; }
  if (typing) return;
  if (window.GisMap && GisMap.closePopup()) return;
  // 属性表不归 Esc 管：点右上角的 × 关，别让按键误伤
}

/* Ctrl+F：属性表没开就先打开，再把光标放进查找框 */
function focusAttrFind(e) {
  e.preventDefault();
  if (!attrOpen()) { attrAuto = false; toggleAttr(); }
  const box = $('attrFind');
  if (box) { box.focus(); box.select(); }
}

function fitToLayer() {
  if (window.GisMap && GisMap.hasLayer && GisMap.hasLayer()) GisMap.fullExtent();
}

/* 键盘上的 shortcuts：Esc 一层层往回收，F 回全图，Ctrl+F 跳到属性表查找框。
   正在打字的时候除了 Esc 都不抢键 */
function wireQuickKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = !!(t && t.closest && t.closest('input, textarea, select, .combo'));
    const combo = comboOf(e);
    if (combo === keyOf('key_close')) { escapeTopLayer(e, typing); return; }
    if (combo === keyOf('key_find')) { focusAttrFind(e); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (combo === keyOf('key_fit')) fitToLayer();
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
/* 第一次拿到数据时立表头；这个图层一个属性字段都没有就说明白，返回 false */
function attrBuildShell(c, got) {
  if (!(c.keys && c.keys.length)) c.keys = keysFromRows(got, c.layer);
  if (!c.keys.length) {
    if (attrShown === c) {
      setAttrMore(c, false);
      const body = $('attrBody');
      body.textContent = '';
      body.appendChild(el('div', 'attr-empty', '这个图层没有可展示的属性字段'));
    }
    c.done = true;
    return false;
  }
  attrShell(c);
  return true;
}

/* 一页要素到了：补字段、加行、判断还有没有下一页；没铺满一屏就接着要 */
function attrPageArrived(c, res, n) {
  const m = res.gisviewer || {};
  const got = res.features || [];
  if (m.deep_page && !got.length) {
    toastNote('翻页较慢', '这个格式没有空间索引，已在后台建索引；等几秒再翻会快很多。', '', false);
  }
  if (m.layer_total !== null && m.layer_total !== undefined) c.total = m.layer_total;
  if (!c.built && !attrBuildShell(c, got)) return;
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
}

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
    attrPageArrived(c, res, n);
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
