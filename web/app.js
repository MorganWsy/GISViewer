const $ = (id) => document.getElementById(id);

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
  } catch (_) { /* 连报错都失败就安静 */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    toShell('jserr:未处理的异步错误 ' + ((r && (r.message || r)) || ''));
  } catch (_) { /* 同上 */ }
});

let current = null;
let config = {
  theme: 'auto', basemap: 'tianditu_img', annotation: false, tianditu_key: '',
  ramp: 'viridis', class_count: 5, nodata_view: 'transparent', raster_default: 'composite',
  vector_color: '#d9781f', max_features: 500, restore_last: false, cache_dir: '', keep_hours: 12,
  ui_font: '', num_font: '', ui_zoom: 100, panel_alpha: 93, unit_lang: 'en',
  hk_mods: 3, hk_vk: 71, hk2_mods: 3, hk2_vk: 32,
  upd_freq: 'open', close_act: 'min', recent: [], recent_max: 5,
};
const RAIL_MIN = 300;
const RAIL_MAX = 760;

/* 图标全部走 currentColor，深浅主题下自动跟着文字变色 */
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v16.8"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2z"/></svg>',
};
const THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

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
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return String(v);
}

/* ---------- 字段说明：名字后面一枚 ⓘ，悬停弹出气泡；属性表表头也共用 ---------- */

/* 图标沿用历书设置页那枚圆形提示符 */
const HINT_ICO = '<svg viewBox="-12 -12 1048 1048" fill="currentColor"><path d="M512 0.021489c-282.758945 0-511.978511 229.219565-511.978511 511.978511s229.219565 511.978511 511.978511 511.978511c282.752806 0 511.978511-229.219565 511.978511-511.978511S794.752806 0.021489 512 0.021489zM650.535193 799.341311c-30.110785 10.406001-53.770648 18.430768-71.779813 24.12035-17.759479 5.683443-38.609343 8.524141-62.269205 8.524141-36.280298 0-64.599274-8.057513-84.656075-23.679305-20.332071-16.089443-30.366611-35.953863-30.366611-60.573587 0-9.465582 0.76748-18.936281 2.297322-28.869514 1.567705-9.93221 4.121877-21.304212 7.225565-33.617655l37.547151-118.810966c3.353374-11.340279 1.453095-21.74628 3.78828-32.177863 2.316765-9.93221 3.333932-19.397792 3.333932-27.429723 0-15.647375 1.433652-26.053376-5.528923-31.742958-7.219425-6.15007-20.312628-4.383844-40.139186-4.383844-9.804297 0-19.832697 1.408069-29.854958 3.776-10.290367 2.847861-19.032472 0.607844-26.251897 3.455705l10.060123-36.926004c24.427342-8.997931 48.087205-16.562211 70.499657-22.719444 22.39301-6.617721 43.722804-9.458419 63.549362-9.458419 36.274158 0 64.09376 7.583722 83.631746 23.205515 19.551288 15.621792 41.169655 35.960003 41.169655 60.579727 0 5.215792-0.800225 14.213723-2.080382 27.461445-1.274016 12.773931-3.858888 24.613584-7.468089 35.486212L563.843762 673.880901c-2.847861 9.465582-5.65786 20.363793-7.986905 32.677237-2.585895 11.839653-3.858888 21.304212-3.858888 27.455305 0 15.621792 4.114714 26.494421 11.845793 32.184003 7.980765 5.65786 21.618367 8.498558 40.900525 8.498558 9.011234 0 19.321044-1.408069 30.878265-4.224208 11.564383-2.841721 19.800975-5.215792 24.946159-7.589862L650.535193 799.341311zM643.860167 319.355445c-17.240663 14.681374-38.315654 21.771863-62.768579 21.771863-24.434505 0-45.540196-7.090489-63.305815-21.771863-17.496489-14.213723-26.238594-31.710212-26.238594-52.547797 0-20.369933 8.742105-37.893029 26.238594-52.547797 17.765619-14.655791 38.872333-22.245653 63.305815-22.245653 24.421202 0 45.527916 7.55814 62.768579 22.245653 17.496489 14.681374 26.258037 32.209586 26.258037 52.547797C670.118204 287.644209 661.356656 305.141722 643.860167 319.355445z"/></svg>';

/* 每个字段一句人话：先说这是什么，再说看它有什么用；结尾不带句号 */
const FIELD_TIPS = {
  '行列号': '影像网格的行数与列数，整幅数据就是由这些格子拼起来的',
  '像元总数': '行列相乘得到的格子总数，其中也包含没有数据的格子',
  '波段数量': '文件包含的波段个数；多波段常见于卫星影像与科学格网数据',
  '范围': '数据覆盖地面的四至边界；投影坐标后面括号里给出换算到经纬度后的同一圈边界',
  '像元大小': '一个格子在地面上代表的实际尺寸，直接决定影像的精细程度',
  '左上角坐标': '影像最上一行、最左一列的起始位置，与像元大小一起决定每个格子的坐标；两行分别是西边界与北边界',
  '坐标系': '数据采用的坐标参考系统。投影坐标系给出投影方式与参数，地理坐标系给出椭球与基准面，两者共同决定坐标怎样落到真实地球上',
  'EPSG': '坐标系在 EPSG 数据集里的统一编号（如 4326、4490）。与别的软件核对坐标系时，看编号最快也最不会认错；下面这条链接可以直接到官网按编号查它的定义与适用范围',
  '类型': '坐标系的投影方式，常见有高斯-克吕格、横轴墨卡托、兰勃特圆锥等；不同投影对长度、角度、面积的变形规律不一样',
  '中心纬度': '投影原点的纬度（Latitude of Origin）。圆锥类投影以它为基准建立坐标原点，同一投影带内所有要素都参照它换算',
  '中央经线': '投影中央子午线的经度（Central Meridian）。离它越远的点角度变形越大；我国常见 3° 或 6° 分带，每带一条中央经线',
  '第一/二标准纬线': '圆锥投影指定的两条无变形纬线（Standard Parallel 1/2），用来控制变形在南北方向的分布：两条之间变形最小，之外逐渐增大；只给一条时按单标准纬线处理',
  '第一标准纬线': '圆锥投影两条无变形纬线中靠北的一条，详见"第一/二标准纬线"',
  '第二标准纬线': '圆锥投影两条无变形纬线中靠南的一条，详见"第一/二标准纬线"',
  '假东/北偏距': '人为加在投影坐标上的向东、向北固定偏移（False Easting / False Northing），用来避免图面上出现负坐标；高斯投影的东偏常用 500000 米',
  '椭球': '用来逼近地球形状的旋转椭球体模型，如 WGS 84、CGCS2000、GRS 1980；一切坐标换算都以它为基准',
  '长/短半轴': '椭球的长半轴（赤道半径）与短半轴（极半径），单位米。两者之差反映地球扁的程度，WGS 84 相差约 21.4 千米',
  '扁率倒数': '椭球扁平程度的倒数表示（1/f），由长短半轴之差与长半轴之比取倒数得到；数值越大越接近正球',
  '地理基准': '该坐标系采用的大地基准名称与编码，描述椭球与真实地球的贴合关系。两组数据叠加或换算时基准必须一致，否则要先做基准转换',
  '单位': '平面坐标与距离使用的单位（米、度等）。读坐标、量算长度面积时都以它为准',
  '说明': '坐标系自带的一段备注文字',
  '最小/最大值': '全部有数据的像元里，数值最小和最大各是多少；统计范围之外的值不参与',
  '平均值': '所有有数据像元的算术平均，无效值不计入',
  '中位数': '把有数据的像元从小到大排好，正中间那个值；比平均值更不怕极端值',
  '标准差': '数值偏离平均值的程度，越大说明这张图上的数值分布越散',
  '不同取值': '像元一共出现过多少种不同的值；分类图通常很少，连续影像会很多',
  'NoData像元': '被标记为无效值的像元个数。这些位置没有真实观测数据，最小值、平均值等统计默认不把它们算进去',
  '有效像元占比': '有数据的像元占像元总数的比例，用来看这张图缺测多少',
  '统计来源': '这些统计数字是文件里自带的，还是软件现场算出来的',
  '名称': '波段自带的名字或描述',
  '数据类型': '数值的存储种类：栅格看每个像元存成什么类型，矢量看数据集本身是什么类型',
  '色表': '文件内置的颜色对照表有多少项，分类图常带这一项',
  'NoData': '用来表示"这里没有数据"的那个特殊数值',
  '压缩算法': '像元数据在文件里的压缩方式，决定体积与读取速度',
  '未压缩大小': '不压缩时这些数据要占多少空间',
  '压缩比': '压缩前后大小的比值，越大说明省得越多',
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

const tipState = { box: null, anchor: null, timer: 0 };

function tipBubble() {
  if (!tipState.box) {
    tipState.box = el('div', 'tip-bubble');
    tipState.box.hidden = true;
    /* 鼠标可以移进气泡：里面的说明文字要能选中复制，链接要能点。
       移进来时取消"即将收起"的定时器，移出去再收起 */
    tipState.box.addEventListener('mouseenter', () => clearTimeout(tipState.timer));
    tipState.box.addEventListener('mouseleave', hideTipBox);
    document.body.appendChild(tipState.box);
  }
  return tipState.box;
}

function showTipBox(anchor, text) {
  const box = tipBubble();
  clearTimeout(tipState.timer);
  box.textContent = text;
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
  const r = anchor.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  let x = r.left + r.width / 2 - br.width / 2;
  x = Math.max(8, Math.min(window.innerWidth - br.width - 8, x));
  let y = r.top - br.height - 8;
  let below = false;
  if (y < 8) { y = r.bottom + 8; below = true; }
  box.classList.toggle('below', below);
  // 三角对准锚点中心，但不许贴到气泡的圆角外面
  const arrow = Math.max(12, Math.min(br.width - 12, r.left + r.width / 2 - x));
  box.style.setProperty('--tip-arrow-x', Math.round(arrow) + 'px');
  box.style.left = Math.round(x) + 'px';
  box.style.top = Math.round(y) + 'px';
}

/* 收起前留一点时间：从标签移到气泡上这一小段路不该让气泡先消失 */
function scheduleHideTip() {
  clearTimeout(tipState.timer);
  tipState.timer = setTimeout(hideTipBox, 400);
}

function hideTipBox() {
  clearTimeout(tipState.timer);
  if (tipState.box && !tipState.box.hidden) tipState.box.hidden = true;
  tipState.anchor = null;
}

document.addEventListener('mouseover', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!t || t === tipState.anchor) return;
  showTipBox(t, t.getAttribute('data-tip'));
});
document.addEventListener('mouseout', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t && t === tipState.anchor) scheduleHideTip();
});
window.addEventListener('scroll', hideTipBox, true);

function hintIcon(label) {
  const tip = FIELD_TIPS[label];
  if (!tip) return null;
  const i = el('i', 'tip-ico');
  i.setAttribute('data-tip', tip);
  if (label === 'EPSG') {
    i.setAttribute('data-tip-href', 'https://epsg.org/');
    i.setAttribute('data-tip-link', '在 EPSG 官网（epsg.org）按编号查');
  }
  i.innerHTML = HINT_ICO;
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
    row(key, value) {
      if (value === null || value === undefined || value === '') return api;
      items.push({ k: key, v: String(value) });
      return api;
    },
    many(pairs) { pairs.forEach((p) => api.row(p[0], p[1])); return api; },
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
          const ico = hintIcon(it.k);
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
      tr.title = '收起或展开这一节';
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

function notice(kind, title, detail, hint) {
  const box = el('div', kind === 'error' ? 'err' : 'warn');
  box.appendChild(el('b', null, title));
  if (detail) box.appendChild(el('span', null, detail));
  if (hint) { box.appendChild(document.createElement('br')); box.appendChild(el('span', null, hint)); }
  return box;
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

function extentRows(extent, wgs, unitLabel) {
  const unit = unitText(unitLabel);
  const geo = !unit || unit === '°' || unit === '度';
  const lines = [];
  EXT_EDGES.forEach((e) => {
    const v = extent ? extent[e[1]] : null;
    const g = wgs ? wgs[e[2]] : null;
    if (v === null || v === undefined) {
      if (g !== null && g !== undefined) lines.push(e[0] + ' ' + degText(g, e[3]));
      return;
    }
    if (geo) { lines.push(e[0] + ' ' + degText(v, e[3])); return; }
    lines.push(e[0] + ' ' + num(v) + ' ' + unit +
      (g !== null && g !== undefined ? ' (' + degText(g, e[3]) + ')' : ''));
  });
  return lines.length ? [['范围', lines.join('\n')]] : [];
}

function statRows(st) {
  if (!st) return [];
  const rows = [];
  if (st.minimum !== null && st.minimum !== undefined) {
    // 这组值只统计有效像元（跳过 NoData），"最小/最大值"容易让人以为全图都算了
    rows.push(['有效值范围', num(st.minimum, 4) + ' ~ ' + num(st.maximum, 4)]);
  }
  rows.push(['平均值', num(st.mean, 4)]);
  // 中位数、不同取值、NoData 像元这几项要等值分布算出来才补得上
  if (st.median !== null && st.median !== undefined) rows.push(['中位数', num(st.median, 4)]);
  rows.push(['标准差', num(st.stddev, 4)]);
  if (st.unique_count !== null && st.unique_count !== undefined) {
    rows.push(['不同取值', count(st.unique_count) + ' 种']);
  }
  if (st.nodata_count !== null && st.nodata_count !== undefined) {
    rows.push(['NoData像元', count(st.nodata_count)]);
  }
  rows.push(['有效像元占比', (st.valid_percent === null || st.valid_percent === undefined)
    ? null : num(st.valid_percent, 2) + '%']);
  rows.push(['统计来源', st.source_label]);
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
      b.color_interp ? (b.color_interp_label || '') : '', nodataText(b)]));
}

function layerTable(layers) {
  return gridTable(['图层', '要素数', '几何类型', '坐标系'],
    layers.map((l, i) => [l.name || ('图层 ' + (i + 1)), [count(l.feature_count), 'num'],
      l.error ? '读取失败' : (l.geometry_type_label || '—'),
      prettyCrsName(l.crs && (l.crs.name || l.crs.label)) || '未记录']), 'layer-table');
}

function variableTable(d) {
  return gridTable(['变量', '尺寸', '数据类型', '最小值', '最大值', '平均值'],
    (d.variables || []).map((v) => {
      const s = v.summary || {};
      const st = s.statistics || {};
      return [v.label, [s.height ? '行 ' + num(s.height) + ' · 列 ' + num(s.width) : '—', 'num'],
        s.type_label || '—', [num(st.minimum, 4), 'num'], [num(st.maximum, 4), 'num'],
        [num(st.mean, 4), 'num']];
    }));
}

function tileLayerTable(layers) {
  return gridTable(['图层', '几何类型', '字段数', '字段', '单张要素数'],
    layers.map((l) => [l.name || '默认', l.geometry_type_label || '—', [l.field_count, 'num'],
      (l.fields || []).slice(0, 6).join('、') || '—', [count(l.features_in_tile), 'num']]));
}

/* ---------- 各格式的分节：只放数据本身的信息，文件级的都在地图胶囊里 ---------- */

function railRaster(rail, d) {
  const crs = d.crs || {};
  const band = (d.bands || [])[0] || {};

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
  if (d.no_georeference) space.push(['范围', '无地理坐标']);

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
  if (band.statistics) rail.many(statRows(band.statistics));
  else rail.loading('统计值');
  if (band.statistics_mismatch) {
    rail.node(notice('warn', '统计值与实测分布不一致', band.statistics_mismatch));
  }

  rail.sec('波段');
  rail.row('名称', (d.bands || []).map((b) => b.description).filter(Boolean).slice(0, 8).join('、'));
  // 类型和位深是一回事的两半，合成一行：32 位 Float
  rail.row('数据类型', (band.bits ? band.bits + ' 位 ' : '') + d.type_label
    + ((d.data_types || []).length > 1 ? '（多类型）' : ''));
  const palette = band.palette_count || d.palette_count || 0;
  rail.row('色表', palette ? palette + ' 项' : '无');
  rail.row('NoData', nodataText(band) || '未设置');
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
  rail.row('要素数', count(primary.feature_count));
  rail.row('Z 值坐标', primary.has_z ? '有' : '无');
  rail.row('M 值坐标', primary.has_m ? '有' : '无');
  rail.many(extentRows(primary.extent, primary.extent_wgs84, (primary.crs || {}).unit_label));

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
      const types = res.types || [];
      const text = types.length
        ? types.map((t) => t.label + ' ' + num(t.count)).join(' · ')
        : '类型混合';
      geomTypeText[key] = text;              // 本会话再打开同一个文件直接用
      primary.geometry_counts_text = text;   // 重画右栏时也直接复用
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
async function renderResult(data, path) {
  renderRail(data);

  if (!data.ok) {
    const err = data.error || {};
    renderError(err.title || '读取失败', err.detail, err.hint);
    return;
  }

  $('empty').hidden = true;
  $('panels').hidden = false;
  attrAuto = data.kind === 'vector' || data.kind === 'archive';
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

  if (window.GisMap) GisMap.clear();
  if (data.kind === 'raster' && !data.multi_variable) await setupRaster(data);
  else resetRasterView();
  if (window.GisMap) GisMap.show(data);
}

/* 右栏那张长表：单位写法之类的设置一改，只重画这一块，地图不动 */
function renderRail(data) {
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
  if (data.kind === 'vector' && (data.layers || []).some((l) => l.error)) {
    data.layers.filter((l) => l.error).forEach((l) => {
      rail.node(notice('warn', '图层 ' + (l.name || '未命名') + ' 读取失败', l.error));
    });
  }
  if (data.warning) rail.node(notice('warn', '提示', data.warning));
  if (data.kind === 'vector' && (data.layers || [])[0] && data.layers[0].warning) {
    rail.node(notice('warn', '提示', data.layers[0].warning));
  }
  if (data.kind === 'tileset') {
    rail.node(notice('warn', '这是切片缓存不是单一数据文件',
      '瓦片按视野需要逐张读取，已在地图上按级显示；要素的精确统计请回到原始矢量数据查看。'));
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
  btn.title = multi
    ? '切换图层（当前：' + (active.label || '') + '）'
    : '这份文件只有一个可以画到地图上的图层';
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
    b.title = it.full || it.label || '';
    b.innerHTML = '<svg class="lp-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2 6.2l2.6 2.6L10 3.4"/></svg>';
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
    rows.push(['图层数', d.layer_count], ['要素总数', count(d.feature_count_total)]);
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
    p.title = f.path;
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

function fillHistogram(res) {
  if (!res || !res.histogram) {
    // 三波段合成没有单一值分布：说清楚为什么是空的，别留个空白气泡
    $('histTitle').textContent = bandLabel(raster ? raster.band : 1);
    $('histBody').textContent = '';
    $('histNote').textContent = '三波段合成没有值分布，切到单个波段可看';
    return;
  }
  const hist = res.histogram || {};
  $('histTitle').textContent = bandLabel(res.band);
  $('histBody').textContent = '';
  $('histBody').appendChild(drawHistogram(hist));
  $('histNote').textContent = hist.source_label + ' · ' + hist.bins + ' 个分箱';
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
let histLast = null;   // 换主题时照着这份数据重画一次

function destroyHistChart() {
  if (histChart) { histChart.destroy(); histChart = null; }
}

function drawHistogram(hist) {
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
  const xd = step >= 1 ? 0 : 3;
  const labels = counts.map((c, i) => num(lo + i * step, xd));
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
      layout: { padding: { top: 2, right: 6, bottom: 0, left: 0 } },
      scales: {
        x: {
          grid: { display: false },
          border: { color: grid },
          // 标签再贴近轴线一点，给绘图区多留高度
          ticks: { maxTicksLimit: 6, color: dim, font: { size: 13 }, autoSkip: true, padding: 2 },
        },
        y: {
          beginAtZero: true,
          max: top,
          grid: { color: grid, drawTicks: false },
          border: { display: false },
          ticks: {
            stepSize: top / 4, color: dim, font: { size: 13 }, padding: 4,
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
              return num(a, 4) + ' ~ ' + num(a + step, 4);
            },
            label: (ctx) => count(counts[ctx.dataIndex]) + ' 像元',
          },
        },
      },
    },
  });
  histLast = hist;
  return wrap;
}

function legendBody(open) {
  const body = $('legendBody');
  body.textContent = '';
  $('legend').hidden = !open;
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
  if (res.discrete) {
    const table = res.discrete;
    const body = legendBody(true);
    (table.colors || []).forEach((color, i) => {
      const v = table.edges[i] === undefined ? i : table.edges[i];
      body.appendChild(legendRow(color, String(Math.round(v))));
    });
    return;
  }
  const items = res.classes || [];
  if (!items.length) {
    legendBlank('值域过窄 · 不分级显示');
    return;
  }
  const body = legendBody(true);
  items.forEach((c) => body.appendChild(legendRow(c.color, num(c.lo, 2) + ' ~ ' + num(c.hi, 2))));
}

function hideLegend() {
  legendBody(false);
}

/* ---------- 属性表：浮在地图里的一块，字段多时横向滚动，往下滚自动续读 ---------- */

let attrLayer = 0;     // 图层下拉里选中的项
let attrCol = -1;      // 选中的列（0 是行号列），Ctrl+C 复制它
let attrShown = null;  // 当前正显示的那份缓存
let attrCache = {};    // 键：路径+图层序号。收起再打开直接从这份里画，不再问服务端

function attrOpen() {
  return !$('attrPanel').hidden;
}

function showAttr(on) {
  const panel = $('attrPanel');
  const stage = document.querySelector('.map-stage');
  $('attrBtn').classList.toggle('on', on);
  $('attrBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
  if (on) {
    if (stage) stage.classList.add('attr-on');
    panel.hidden = false;
    panel.classList.add('shrunk');
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('shrunk')));
    return;
  }
  if (panel.hidden) return;
  panel.classList.add('shrunk');
  if (stage) stage.classList.remove('attr-on');
  setTimeout(() => { if (panel.classList.contains('shrunk')) panel.hidden = true; }, 200);
}

/* 收起只是藏起来：缓存不动，再打开是瞬时的 */
function closeAttr() {
  showAttr(false);
  attrCol = -1;
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

function attrToast(text) {
  const box = $('attrToast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(box.__timer);
  box.__timer = setTimeout(() => { box.hidden = true; }, 1400);
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
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
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
  try { document.execCommand('copy'); } catch (err) { /* 复制不了就给个安静的结果 */ }
  document.body.removeChild(ta);
  done();
}

const COPY_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2"/><path d="M5.2 15.6V6.6a1.6 1.6 0 0 1 1.6-1.6h9"/></svg>';

function copyAttrCol(c, colIdx) {
  const keys = c.keys || [];
  if (colIdx === 0) {
    const lines = ['行号'];
    c.rows.forEach((props, i) => lines.push(String(i + 1)));
    copyText(lines.join('\n'), '已复制行号列');
    return;
  }
  const key = keys[colIdx - 1];
  if (key === undefined) return;
  const lines = [key];
  c.rows.forEach((props) => lines.push(valText(props[key])));
  copyText(lines.join('\n'), '已复制「' + key + '」列 ' + c.rows.length + ' 行');
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
    try { handle.setPointerCapture(ev.pointerId); } catch (err) { /* 合成事件没有真实指针，忽略 */ }
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
    if (tip) th.setAttribute('data-tip', tip);
    th.appendChild(el('i', 'attr-rsz'));
    const cp = el('button', 'attr-copy');
    cp.type = 'button';
    cp.title = '复制整列';
    cp.innerHTML = COPY_ICO;
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
      if (td.textContent.length > 40) td.title = td.textContent;
      if (ci === attrCol - 1) td.classList.add('col-sel');
      tr.appendChild(td);
    });
    frag.appendChild(tr);
    c.rows.push(props);
    // 双击某一行要能定位回要素，得把要素号按行存着
    if (c.ids) c.ids[start + i] = f.fid === undefined ? null : f.fid;
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

/* 双击某一行：问引擎要这个要素的范围，把地图框过去 */
function locateAttrRow(c, i) {
  const fid = c && c.ids ? c.ids[i] : null;
  if (fid === null || fid === undefined) { attrToast('这一行定位不了'); return; }
  const url = '/api/measure?path=' + encodeURIComponent(c.target) +
    '&layer=' + (c.index || 0) + '&fid=' + fid;
  attrToast('正在定位…');
  fetch(url).then((r) => r.json()).then((res) => {
    if (!res || !res.ok || !res.bbox) { attrToast((res && res.error && res.error.title) || '定位失败'); return; }
    if (window.GisMap) GisMap.zoomToBBox(res.bbox);
    attrToast('已定位到该要素');
  }).catch(() => attrToast('定位失败'));
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
    if (e.key === 'Escape') {
      if (!$('recentPop').hidden) { hideRecent(); return; }
      if (!$('pickPop').hidden) { hidePickPop(); return; }
      if (!$('layerPop').hidden) { hideLayerPop(); return; }
      if (!$('settings').hidden) { $('cfgClose').click(); return; }
      if (!$('errToast').hidden) { hideErrToast(); return; }
      if (t === $('attrFind')) { $('attrFind').value = ''; applyAttrFind(); $('attrFind').blur(); return; }
      if (typing) return;
      if (window.GisMap && GisMap.closePopup()) return;
      if (attrOpen()) { closeAttr(); return; }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (!attrOpen()) { attrAuto = false; toggleAttr(); }
      const box = $('attrFind');
      if (box) { box.focus(); box.select(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') {
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
  if (!layers.length) {
    attrShown = null;
    body.textContent = '';
    body.appendChild(el('div', 'attr-empty', '这份文件里没有可以画到地图上的要素'));
    return;
  }
  const L = layers[attrLayer];
  const key = attrKeyOf(L);
  let c = attrCache[key];
  if (!c) {
    c = {
      key: key, target: L.target, index: L.index, layer: L, fields: L.fields || [],
      keys: (L.fields || []).map((f) => f.name), rows: [], ids: [], total: null,
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
    $('histTitle').textContent = '';
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
    $('posLng').textContent = num(d.lng, 5) || '—';
    $('posLat').textContent = num(d.lat, 5) || '—';
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
    btn.title = folded ? unfoldTitle : foldTitle;
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
    f.btn.title = f.foldTitle;
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
  const bar = $('bar');
  /* 顶栏空白处：按住能拖窗口，连点两下最大化/还原。
     双击不能等 dblclick——第一次按下就把窗口交给了系统拖动循环，
     第二个 click 根本回不到页面里，只能自己数这两下 */
  let barTap = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    /* 最近打开和"打开"菜单都挂在顶栏里：点它们时不能去拖窗口，
       否则这一下被系统拖动循环接走，列表项的 click 永远回不来（点不开就是这个原因） */
    if (e.target.closest('input, button, label, select, .combo, .no-drag, #recentPop, #pickPop')) return;
    /* 顶栏空白处一按下，窗口就交给系统拖动循环了，这一下之后的 click 再也回不到页面，
       所以浮窗只能在这里主动收掉，不能等外面的 document click */
    hideRecent();
    hidePickPop();
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

function showErrToast(title, detail, hint) {
  const box = $('errToast');
  if (!box) return;
  $('errTitle').textContent = title || '出了点问题';
  $('errDetail').textContent = detail || '';
  $('errDetail').hidden = !detail;
  $('errHint').textContent = hint || '';
  $('errHint').hidden = !hint;
  box.hidden = false;
  // 连着弹同一条时也要有"又来了"的动静：去掉类、强制重排、再加回去
  box.classList.remove('pop');
  void box.offsetWidth;
  box.classList.add('pop');
  // 每次弹出来都把自动收走的钟重新拨一遍，新消息不会刚出现就被上一条的钟收走
  clearTimeout(errToastTimer);
  errToastTimer = setTimeout(hideErrToast, toastMs());
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
  current = { path, data: null };
  mouseOn = false;
  openFrom = Date.now();
  $('empty').hidden = true;
  $('panels').hidden = false;
  hideErrToast();
  loadTip(true, '正在读取…');
  skeleton(String(path).split(/[\\/]/).pop());
  let data;
  try {
    const res = await fetch('/api/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    data = await res.json();
  } catch (err) {
    loadTip(false);
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
    renderResult(prev.data, prev.path).catch(() => { /* 回滚渲染不出来也就算了，浮层已经说明原因 */ });
    return;
  }
  current = { path, data };
  /* 先挂遮罩再渲染：栅格是同步画完的，等渲染返回时完成事件早发过了 */
  const staged = !!data.ok && VEIL_KINDS.indexOf(data.kind) >= 0;
  if (staged) holdVeil('正在画图层…');
  try {
    await renderResult(data, path);
    if (data.ok) rememberLast(path, data);
  } catch (err) {
    releaseVeil();
    renderError('界面渲染出错', (err && err.message) || String(err));
  } finally {
    if (!staged) { releaseVeil(); loadTip(false); }
  }
}

/* 记住这次打开的是哪个文件：一条给"启动时恢复上次的文件"，
   一份最近的清单给路径框下拉；临时副本两处都不记 */
function rememberLast(path, data) {
  const p = String(path || '');
  if (!p || (data && (data.temp_copy || data.file && data.file.temp_copy))) return;
  toShell('lastdir:' + p);   // 告诉壳"最近一次打开的是这里"，文件框下次从这儿起步
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
  cfgBasemap: '地图底层使用的地图服务。天地图影像与天地图矢量需要下方配置密钥；选择"无底图"时背景为纯色',
  cfgAnnotation: '在天地图底图上叠加地名、路名等注记，仅在选择天地图底图时生效',
  cfgKey: '到天地图开放平台申请一个"浏览器端"密钥，仅保存在本机。申请时请在授权域名里填写 127.0.0.1 和 localhost',
  cfgRamp: '单色分级显示影像时使用的颜色系列，由低值到高值依次取色；下拉选项即实际配色效果',
  cfgClassCount: '分级上色时将数值范围划分的档数；档数越多层次越细，过密时画面容易显得破碎',
  cfgNodata: '数值等于 NoData 的像元按何种方式绘制：透出底图、涂黑或涂白',
  cfgRasterDefault: '打开多波段文件时的默认显示方式：取前三个波段合成彩色，或取第一个波段做单色分级',
  cfgVectorColor: '矢量要素的填充、描边与数据范围框使用的颜色',
  cfgMaxFeatures: '属性表向下滚动时每次续读的行数；数值越大单次读取越多，大图层上滚动会更重',
  cfgFontUi: '界面文字使用的字体，列表中仅包含本机已安装的字体',
  cfgFontNum: '数字、坐标与表格内容使用的字体，可与界面字体分开设置',
  cfgUnitLang: '量算结果与坐标读数使用的单位写法：符号（m、km）或中文（米、千米）',
  cfgZoom: '仅缩放界面文字与面板，地图画布不参与缩放，因此不影响坐标取点的精度',
  cfgAlpha: '浮在地图上的面板的不透明度；顶栏与右侧信息栏始终保持不透明',
  cfgToastSec: '错误提示卡片与地图上那条"已定位到…"停留多久后自动收起；点一下卡片可以立即关掉',
  cfgOpenDir: '点"打开文件"或"打开文件夹"时，系统对话框从哪个目录起步。留空就用上次打开文件所在的文件夹；也可以点"选择…"固定一个目录',
  cachePath: '读取结果的缓存文件夹：打开过的文件的元数据、直方图与缩略图都在这里。清空只会让下次读取变慢，不会动源文件',
  cfgCloseAct: '点击窗口右上角关闭按钮时的行为：收进托盘（任务栏不再保留按钮），或直接退出软件。收进托盘后可通过托盘图标或快捷键重新唤出',
  cfgAutoStart: '开机后自动启动并驻留托盘：不弹出窗口，任务栏也不显示按钮，通过托盘图标或快捷键唤出',
  cfgDeskLnk: '在桌面放一个"图览"快捷方式',
  cfgUpdFreq: '检查新版本的频率。检查时仅访问发布页一次，其余时间不联网',
  cfgRestore: '启动时自动打开上次查看的文件',
  cfgRecentMax: '顶栏路径框点开时，下拉列表里"最近打开"最多显示的条数',
  cfgCache: '从别处拖进来的文件会先复制一份到这里供读取，软件退出后自动删除。读取结果的缓存不在这个目录，见下方"缓存位置"',
  cfgKeepHours: '软件异常退出时，临时副本保留的时长，超过后自动清理',
};

/* 标签上没有 for 的两处快捷键，按标签文字挂提示 */
const SETTING_LABEL_TIPS = {
  '唤出快捷键': '在任何程序中按下都可将窗口唤到前台；点按钮后按下新的组合键即可修改',
  '选中即开快捷键': '在资源管理器或桌面上选中文件后按下，直接在图览中打开；空格单独按下被系统占用，需要搭配修饰键',
};

function mountSettingTips() {
  const root = $('settings');
  if (!root) return;
  /* 提示挂在整条标签上，不是只挂在那枚 13 像素的小图标上——
     鼠标划到标签文字上就能出气泡，不用瞄准图标 */
  const put = (lab, tip) => {
    if (!lab || !tip || lab.querySelector('.tip-ico')) return;
    lab.setAttribute('data-tip', tip);
    lab.classList.add('has-tip');
    const i = el('i', 'tip-ico');
    i.innerHTML = HINT_ICO;
    lab.appendChild(i);
  };
  Object.keys(SETTING_TIPS).forEach((id) => {
    put(root.querySelector('label[for="' + id + '"]'), SETTING_TIPS[id]);
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
  /* 同一条路径换个写法（斜杠、大小写）不该重复出现：按归一化后的形式去重 */
  const key = (x) => String(x).replace(/[\\/]+/g, '/').toLowerCase();
  const list = (config.recent || []).filter((x) => x && key(x) !== key(p));
  list.unshift(p);
  config.recent = list.slice(0, RECENT_KEEP);
  renderRecent();
}

function baseName(p) { return String(p).split(/[\\/]/).pop(); }

function renderRecent() {
  const pop = $('recentPop');
  if (!pop) return;
  const list = (config.recent || []).filter(Boolean).slice(0, recentMax());
  pop.textContent = '';
  if (!list.length) { pop.hidden = true; return; }
  const head = el('div', 'rp-head');
  head.appendChild(el('span', null, '最近打开'));
  const clear = el('button', 'rp-clear');
  clear.type = 'button';
  clear.textContent = '清空';
  clear.addEventListener('click', (e) => {
    e.stopPropagation();
    config.recent = [];
    renderRecent();
    commitConfig();
  });
  head.appendChild(clear);
  pop.appendChild(head);
  list.forEach((p) => {
    const item = el('div', 'rp-item');
    item.appendChild(el('div', 'rp-name', baseName(p)));
    item.appendChild(el('div', 'rp-path', p));
    item.title = p;
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
}

function showRecent() {
  const pop = $('recentPop');
  const input = $('pathInput');
  if (!pop || !input || !(config.recent || []).length) return;
  // 有弹窗开着就不凑热闹：这时候点不到路径框，别在弹窗后面露出一块列表
  if (!$('settings').hidden) return;
  hidePickPop();
  const r = input.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  pop.style.width = Math.round(Math.max(r.width, 340)) + 'px';
  pop.hidden = false;
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
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  pop.hidden = false;
}

function hidePickPop() {
  const pop = $('pickPop');
  if (pop) pop.hidden = true;
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

function applyTheme(mode) {
  const dark = mode === 'dark' ||
    (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (window.GisMap) GisMap.themeChanged();
  // 原生壳要跟页面同一个底色，否则首帧是白的；浏览器里没有这个通道
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage('theme:' + (dark ? 'dark' : 'light'));
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
  btn.innerHTML = '<span class="btn-ico">' + THEME_ICONS[mode] + '</span>';
  btn.title = '当前主题：' + THEME_LABELS[mode] + '，点击切换';
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

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.ok) config = Object.assign(config, data.config);
    if (data.ramps) paintRampSwatches(data.ramps);
    if (data.version) {
      // 版本号不在界面上露脸了，只留给标题栏和更新检查
      document.title = '图览 ' + data.version;
      toShell('ver:' + data.version);
    }
  } catch (err) { /* 用默认值 */ }
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

/* 把 config 摊到设置页的各控件上；控件都是自绘的，摊完要再同步一次 */
function fillSettings() {
  $('cfgBasemap').value = config.basemap || 'tianditu_img';
  $('cfgAnnotation').checked = config.annotation === true;
  $('cfgKey').value = config.tianditu_key || '';
  $('cfgRamp').value = config.ramp || 'viridis';
  $('cfgClassCount').value = String(config.class_count || 5);
  $('cfgNodata').value = config.nodata_view || 'transparent';
  $('cfgRasterDefault').value = config.raster_default || 'composite';
  if (!/^#[0-9a-fA-F]{6}$/.test(config.vector_color)) config.vector_color = '#d9781f';
  $('cfgVectorColor').value = config.vector_color;
  $('cfgMaxFeatures').value = String(config.max_features || 500);
  $('cfgRestore').checked = !!config.restore_last;
  $('cfgOpenDir').value = config.open_dir || '';
  $('cfgRecentMax').value = String(recentMax());
  $('cfgCache').value = config.cache_dir || '';
  $('cfgKeepHours').value = String(config.keep_hours || 12);
  $('cfgZoom').value = String(config.ui_zoom || 100);
  $('cfgAlpha').value = String(config.panel_alpha || 93);
  $('cfgToastSec').value = String(Math.round(toastMs() / 1000));
  $('cfgUnitLang').value = config.unit_lang === 'zh' ? 'zh' : 'en';
  $('cfgCloseAct').value = config.close_act === 'exit' ? 'exit' : 'min';
  // 早先存过 "boot"（开机就查），这一版改成打开后延迟查，读到老值直接换算过去
  $('cfgUpdFreq').value = config.upd_freq === 'boot' ? 'open' : (config.upd_freq || 'open');
  fillFontSelects();
  paintHotkey();
  paintHotkey2();
  $('cfgAutoStart').checked = host.autoStart === true;
  $('cfgDeskLnk').checked = host.deskLnk === true;
  // 上次停在哪个分组
  showSettingPane(config.set_sec || 'base');
  // 文件框的起始位置由壳执行，这里把当前设置同步过去（含首次加载；留空＝上次的文件夹）
  toShell('opendir:' + String(config.open_dir || ''));
  // 快捷键两行提示平时留空，只在改键过程中显示操作反馈
  $('hkHint').textContent = '';
  $('hk2Hint').textContent = '';
  sysNote('');
  paintCacheHint();
  refreshCacheSize();
  document.querySelectorAll('#settings select').forEach((s) => window.syncSelect(s));
}

/* 副本目录用不了的时候引擎会退回系统临时目录，原因得自己说出来；
   平时这一行是空的（说明文字已移进"副本存放位置"的提示气泡） */
function paintCacheHint() {
  const note = config.cache_note || '';
  const hint = $('cfgCacheHint');
  hint.textContent = note;
  hint.hidden = !note;
  hint.classList.toggle('bad', !!note);
}

/* ---------- 数据缓存：显示占用 + 一键清空 ---------- */

/* dir 是引擎报上来的缓存目录（数据目录下的 cache），第一次拿到就写进提示气泡；
   用户问过"缓存到底存在哪"，这里把话说明白，不再只是一句"记在本地" */
let cacheDirShown = '';

function paintCacheSize(info, dir) {
  if (dir) cacheDirShown = dir;
  const where = $('cachePath');
  if (where) where.value = cacheDirShown || '';
  const hint = $('cacheSizeHint');
  if (!hint) return;
  if (!info) { hint.textContent = '统计不了缓存占用'; return; }
  hint.textContent = info.count
    ? '当前占用 ' + bytes(info.bytes) + '（' + count(info.count) + ' 项）'
    : '还没有缓存内容';
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
  paintView();   // 比例尺的条长跟字号有关，改完立刻重画一次
}

/* ---------- 和原生壳之间的那根线 ---------- */

function toShell(msg) {
  if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg);
}

/* 字体、自启状态、快捷键、有没有新版，这四件事只有壳知道 */
const host = { fonts: null, autoStart: null, deskLnk: null, hotkey: '', hotkey2: '' };
let hkSynced = false;
let configLoaded = false;

window.GisHost = function (name, value) {
  if (name === 'fonts') {
    host.fonts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    fillFontSelects();
    return;
  }
  if (name === 'dir') {
    // 壳那边选完文件夹回传的路径：填进"打开文件框从哪开始"并落盘
    const box = $('cfgOpenDir');
    if (box) { box.value = String(value || ''); applySettings(); }
    return;
  }
  if (name === 'autoStart') { host.autoStart = value === 'on'; $('cfgAutoStart').checked = host.autoStart; return; }
  if (name === 'deskLnk') { host.deskLnk = value === 'on'; $('cfgDeskLnk').checked = host.deskLnk; return; }
  if (name === 'hotkey') {
    host.hotkey = String(value || '');
    paintHotkey();
    trySyncHotkey();
    return;
  }
  if (name === 'hotkey2') {
    host.hotkey2 = String(value || '');
    paintHotkey2();
    trySyncHotkey();
    return;
  }
  if (name === 'hotkey2Ok') {
    host.hotkey2 = String(value || '');
    paintHotkey2();
    $('hk2Hint').textContent = '已生效：在资源管理器里选中文件后按 ' + host.hotkey2 + '。';
    return;
  }
  if (name === 'hotkey2Failed') {
    $('hk2Hint').textContent = value + ' 被别的软件占着，已经退回 ' + host.hotkey2 + '，换一组试试。';
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
  if (name === 'hotkeyOk') {
    host.hotkey = String(value || '');
    paintHotkey();
    $('hkHint').textContent = '快捷键已生效：' + host.hotkey + '。软件收进托盘后也能用它叫出来。';
    return;
  }
  if (name === 'hotkeyFailed') {
    $('hkHint').textContent = value + ' 被别的软件占着，已经退回 ' + host.hotkey + '，换一组试试。';
    return;
  }
  if (name === 'update') { paintUpdate(value); return; }
  if (name === 'notice') { showErrToast((value && value.title) || '提示', (value && value.detail) || ''); return; }
  if (name === 'drag') { showDropVeil(value === 'true'); return; }
  if (name === 'maximized') { document.body.classList.toggle('maxed', value === 'on'); return; }
  if (name === 'frame') {
    document.documentElement.style.setProperty('--max-inset', (Number(value) || 7) + 'px');
    return;
  }
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
   两条快捷键各管各的，哪一条不同就只重注册哪一条 */
function trySyncHotkey() {
  if (hkSynced || !configLoaded) return;
  hkSynced = true;
  const want = hkText(config.hk_mods, config.hk_vk);
  if (want && want !== host.hotkey) {
    host.hotkey = want;
    paintHotkey();
    toShell('hk:' + Number(config.hk_mods) + ',' + Number(config.hk_vk));
  }
  const want2 = hkText(config.hk2_mods, config.hk2_vk);
  if (want2 && want2 !== host.hotkey2) {
    host.hotkey2 = want2;
    paintHotkey2();
    toShell('hk2:' + Number(config.hk2_mods) + ',' + Number(config.hk2_vk));
  }
}

function paintHotkey() {
  const btn = $('hkBtn');
  if (!btn || arming) return;
  const txt = host.hotkey || hkText(config.hk_mods, config.hk_vk) || 'Ctrl+Alt+G';
  btn.textContent = txt;
  const cell = $('keyGlobal');
  if (cell) cell.textContent = txt;
}

function paintHotkey2() {
  const btn = $('hk2Btn');
  if (!btn || arming2) return;
  const txt = host.hotkey2 || hkText(config.hk2_mods, config.hk2_vk) || 'Ctrl+Alt+空格';
  btn.textContent = txt;
  const cell = $('keyOpenSel');
  if (cell) cell.textContent = txt;
}

let arming = false;
let arming2 = false;

function armHotkey() {
  settleHotkey();
  arming = true;
  const btn = $('hkBtn');
  btn.classList.add('arming');
  btn.textContent = '按下组合键…';
  $('hkHint').textContent = '按下想要的组合键，也可以按 Esc 取消。单独一个字母容易被别的软件抢走，建议带上 Ctrl 或 Alt。';
}

function armHotkey2() {
  settleHotkey();
  arming2 = true;
  const btn = $('hk2Btn');
  btn.classList.add('arming');
  btn.textContent = '按下组合键…';
  $('hk2Hint').textContent = '按下想要的组合键，也可以按 Esc 取消。建议带上 Ctrl 或 Alt，免得和系统或别的软件抢键。';
}

function settleHotkey() {
  arming = false;
  arming2 = false;
  const a = $('hkBtn');
  const b = $('hk2Btn');
  if (a) a.classList.remove('arming');
  if (b) b.classList.remove('arming');
  // 改键过程结束后先清掉操作提示，成功/被占用会各自再写一条
  $('hkHint').textContent = '';
  $('hk2Hint').textContent = '';
  paintHotkey();
  paintHotkey2();
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
  if (!arming && !arming2) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { settleHotkey(); return; }
  const mods = (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  const vk = e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' ||
    e.key === 'Meta' || e.key === 'CapsLock' ? 0 : vkOf(e);
  if (!vk || (mods === 0 && !(vk >= 0x70 && vk <= 0x7B))) {
    $(arming2 ? 'hk2Hint' : 'hkHint').textContent =
      '至少要按下一个修饰键（Ctrl、Alt、Shift、Win），单按 F1~F12 也可以。';
    return;
  }
  const second = arming2;
  settleHotkey();
  if (second) applyHotkey2Choice(mods, vk);
  else applyHotkeyChoice(mods, vk);
}

/* 快捷键归壳管，界面只负责把选择递过去并立刻把按钮上的字改掉 */
function applyHotkeyChoice(mods, vk) {
  config.hk_mods = mods;
  config.hk_vk = vk;
  host.hotkey = hkText(mods, vk);
  paintHotkey();
  toShell('hk:' + mods + ',' + vk);
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hk_mods: mods, hk_vk: vk }),
  }).catch(() => {});
}

function applyHotkey2Choice(mods, vk) {
  config.hk2_mods = mods;
  config.hk2_vk = vk;
  host.hotkey2 = hkText(mods, vk);
  paintHotkey2();
  toShell('hk2:' + mods + ',' + vk);
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hk2_mods: mods, hk2_vk: vk }),
  }).catch(() => {});
}

function sysNote(text) {
  const hint = $('sysHint');
  if (hint) hint.textContent = text;
}

function paintUpdate(r) {
  const hint = $('updHint');
  const open = $('updOpen');
  if (!r) return;
  if (r.error) {
    hint.textContent = r.error;
    if (open) open.hidden = true;
    return;
  }
  localStorage.setItem('gisviewer.upd_last', String(Date.now()));
  if (r.found) {
    hint.textContent = r.latest ? ('有新版本 v' + r.latest + '，当前 v' + r.current + '。') : '有新版本发布。';
    if (open) {
      open.hidden = false;
      open.onclick = () => { window.open(r.url || 'https://github.com/MorganWsy/GISViewer/releases'); };
    }
    return;
  }
  hint.textContent = r.current ? ('当前 v' + r.current + ' 已经是最新。') : '当前已经是最新版本。';
  if (open) open.hidden = true;
}

/* 打开后过十几秒再问更新：首屏和引擎正忙，这时候抢网络的检查结果多半也不准 */
function maybeCheckUpdate() {
  const freq = config.upd_freq || 'open';
  if (freq === 'off') return;
  const days = { '3d': 3, week: 7, month: 30 }[freq];
  const last = Number(localStorage.getItem('gisviewer.upd_last') || 0);
  if (days && Date.now() - last < days * 86400000) return;
  setTimeout(() => toShell('upd:'), 14000);
}

/* 设置改一处生效一处，没有"保存"这一步；落盘跟在每次改动后面 */
async function applySettings() {
  const before = {
    ramp: config.ramp, k: config.class_count,
    nodata: config.nodata_view, def: config.raster_default,
  };
  config.basemap = $('cfgBasemap').value;
  config.annotation = $('cfgAnnotation').checked;
  config.tianditu_key = $('cfgKey').value.trim();
  config.ramp = $('cfgRamp').value;
  config.class_count = Number($('cfgClassCount').value);
  config.nodata_view = $('cfgNodata').value;
  config.raster_default = $('cfgRasterDefault').value;
  config.vector_color = $('cfgVectorColor').value;
  config.max_features = Number($('cfgMaxFeatures').value);
  config.ui_font = $('cfgFontUi').value;
  config.num_font = $('cfgFontNum').value;
  config.ui_zoom = Number($('cfgZoom').value);
  config.panel_alpha = Number($('cfgAlpha').value);
  config.unit_lang = $('cfgUnitLang').value === 'zh' ? 'zh' : 'en';
  config.close_act = $('cfgCloseAct').value === 'exit' ? 'exit' : 'min';
  toShell('closeact:' + config.close_act);   // 关按钮的行为由壳执行，改完就告诉它
  config.upd_freq = $('cfgUpdFreq').value;
  config.restore_last = $('cfgRestore').checked;
  config.open_dir = $('cfgOpenDir').value.trim();
  toShell('opendir:' + config.open_dir);     // 起始目录由壳执行，改完就告诉它
  config.recent_max = Number($('cfgRecentMax').value) || 5;
  config.toast_sec = Number($('cfgToastSec').value) || 5;
  config.cache_dir = $('cfgCache').value.trim();
  config.keep_hours = Number($('cfgKeepHours').value);
  applyDataColor();
  applyLook();
  // 单位写法这类设置改的是右栏里的文字，只重画那块，地图和图层都不动
  if (current && current.data && current.data.ok) renderRail(current.data);
  if (attrOpen() && window.GisMap) refreshAttr(true);
  if (window.GisMap) GisMap.refresh(config);
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
      paintCacheHint();
    }
  } catch (err) { /* 界面已经生效 */ }
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
const SET_PANES = ['base', 'render', 'look', 'file', 'sys'];

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

  $('pathForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('pathInput').value.trim();
    if (!value) return;
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
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(config.theme) + 1) % order.length];
    config.theme = next;
    applyTheme(next);
    paintThemeBtn();
    commitConfig();
  });

  $('settingsBtn').addEventListener('click', () => {
    settleHotkey();
    fillSettings();
    $('settings').hidden = false;
  });
  $('cfgClose').addEventListener('click', () => { settleHotkey(); $('settings').hidden = true; });
  // 浮层卡片没有关闭按钮：点卡片任意处即关（自动到点收走的逻辑在 showErrToast 里）
  $('errToast').addEventListener('click', hideErrToast);
  /* 设置页每项标签挂提示图标：只挂一次，图标里说的话见 SETTING_TIPS */
  mountSettingTips();
  $('cacheClearBtn').addEventListener('click', () => {
    $('cacheSizeHint').textContent = '正在清空…';
    fetch('/api/cache', { method: 'POST' }).then((r) => r.json()).then((d) => {
      paintCacheSize((d && d.cache) || { bytes: 0, count: 0 }, d && (d.cache_dir || d.data_dir));
    }).catch(() => { $('cacheSizeHint').textContent = '清空失败，稍后再试'; });
  });
  // 缓存位置：只读显示，旁边一颗"打开"直接把这层目录交给资源管理器
  $('cachePathOpen').addEventListener('click', () => {
    if (cacheDirShown) toShell('openpath:' + cacheDirShown);
  });
  // 文件框的起始目录：点"选择…"由壳弹系统选文件夹框，选完回传 GisHost('dir', 路径)
  $('cfgOpenDirPick').addEventListener('click', () => toShell('pickdir'));
  wireSettingNav();
  /* 没有保存按钮：改一下生效一下。令牌那一栏不落盘，所以不参与 */
  document.querySelectorAll('#settings select, #settings input').forEach((node) => {
    if (node.id === 'cfgAutoStart' || node.id === 'cfgDeskLnk') return;
    node.addEventListener('change', applySettings);
  });
  $('cfgVectorColor').addEventListener('change', () => {
    $('cfgColorSwatch').style.background = $('cfgVectorColor').value;
  });
  $('hkBtn').addEventListener('click', armHotkey);
  $('hkReset').addEventListener('click', () => { settleHotkey(); applyHotkeyChoice(3, 71); });
  $('hk2Btn').addEventListener('click', armHotkey2);
  $('hk2Reset').addEventListener('click', () => { settleHotkey(); applyHotkey2Choice(3, 32); });
  document.addEventListener('keydown', onArmKeydown, true);
  $('cfgAutoStart').addEventListener('change', (e) => {
    toShell('autostart:' + (e.target.checked ? '1' : '0'));
  });
  $('cfgDeskLnk').addEventListener('change', (e) => {
    toShell('desklnk:' + (e.target.checked ? 'on' : 'off'));
  });
  $('updBtn').addEventListener('click', () => {
    $('updHint').textContent = '正在问发布页…';
    $('updOpen').hidden = true;
    toShell('upd:');   // 公开仓库不需要访问码
  });
  $('keyPeek').addEventListener('click', () => {
    const box = $('cfgKey');
    const show = box.type === 'password';
    box.type = show ? 'text' : 'password';
    // 眼睛图标：睁开=正显示，划掉=正藏着；标题跟着换，一眼看懂现在是哪种
    $('keyPeek').classList.toggle('peeking', show);
    $('keyPeek').title = show ? '隐藏密钥' : '显示密钥';
    if (show) box.focus();
  });
  $('histBtn').addEventListener('click', toggleHist);
  $('attrBtn').addEventListener('click', () => { attrAuto = false; toggleAttr(); });
  $('chipClose').addEventListener('click', () => { hideLayerPop(); closeLayer(); });
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
    if (pop.contains(e.target) || onBtn) return;
    hidePickPop();
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
  });
  $('map').addEventListener('gis:mouse', paintPos);
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
  $('map').addEventListener('gis:drawn', (e) => {
    const kind = (e.detail && e.detail.kind) || 'none';
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

  loadConfig().then(() => {
    if (window.GisMap) GisMap.init(config);
    pageReady = true;
    reportDropArea();
    window.addEventListener('resize', reportDropArea);
    const mainEl = $('drop');
    if (mainEl && window.ResizeObserver) new ResizeObserver(reportDropArea).observe(mainEl);
    toShell('closeact:' + (config.close_act === 'exit' ? 'exit' : 'min'));
    toShell('ready');
    maybeCheckUpdate();
    const params = new URLSearchParams(location.search);
    const forced = params.get('theme');
    if (forced === 'light' || forced === 'dark') {
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
      $('pathInput').value = given;
      inspectPath(given);
      return;
    }
    fetch('/api/preload').then((r) => r.json()).then((d) => {
      if (d.ok && d.paths && d.paths.length) {
        $('pathInput').value = d.paths[0];
        inspectPath(d.paths[0]);
      }
    }).catch(() => {});
  });
}

init();
