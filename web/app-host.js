/* ---------- 与原生壳的连线、页内快捷键、更新检查、边缘拖动改大小、启动装配 ---------- */
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

/* 壳发来的消息按名字分派：一张表一件事，比一长串 if (name === 'x') 好读，
   加一条新消息只要往表里添一行，不用再找"该插在哪个 if 后面" */
const hostDirInput = {
  check: 'checkPath',
  conv: 'convOut',
  cache: 'cfgCache',
  cachedir: 'cachePath',
};

const hostHandlers = {
  fonts(value) {
    host.fonts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    fillFontSelects();
  },

  // 壳那边选完文件夹回传的路径：看是谁发起的，填进对应的输入框
  dir(value) {
    const id = hostDirInput[dirPickTarget] || 'cfgOpenDir';
    const where = $(id);
    const fromCheck = dirPickTarget === 'check';
    dirPickTarget = '';
    if (!where) return;
    where.value = String(value || '');
    if (id === 'cfgOpenDir' || id === 'cfgCache' || id === 'cachePath') {
      if (id === 'cachePath') cachePickIntent = where.value.trim();
      applySettings();
      if (id === 'cfgOpenDir') paintOpenDirStatus();
      else if (id === 'cfgCache') paintCacheDirStatus();
      else paintCachePathStatus();
      syncDirClearBtns();
    }
    if (fromCheck && where.value.trim()) runCheck();
  },

  // 体检里"选择文件"回传：填进路径框，接着就查。互转的选文件共用这一条回传，
  // 按谁发起的分路（pickcheck 只是"挑一个数据文件"，跟用途无关）
  checkpath(value) {
    const toConv = filePickTarget === 'conv';
    filePickTarget = '';
    const where = toConv ? $('convPath') : $('checkPath');
    if (!where) return;
    where.value = String(value || '');
    if (toConv) convLoadLayers();
    else if (where.value.trim()) runCheck();
  },

  autoStart(value) {
    host.autoStart = value === 'on';
    $('cfgAutoStart').checked = host.autoStart;
  },

  deskLnk(value) {
    host.deskLnk = value === 'on';
    $('cfgDeskLnk').checked = host.deskLnk;
  },

  // 壳回报右键菜单现在是不是挂着：开关要跟着注册表走，不能只信本地配置
  ctxmenu(value) {
    const box = $('cfgCtxMenu');
    if (box) box.checked = value === 'on';
  },

  autoStartState(value) {
    switchState('cfgAutoStart', 'autoStart', value, '开机自启没改成：');
  },

  deskLnkState(value) {
    switchState('cfgDeskLnk', 'deskLnk', value, '桌面上的快捷方式没改成：');
  },

  update(value) { onUpdateMessage(value); },
  notice(value) { showErrToast((value && value.title) || '提示', (value && value.detail) || '', '', 'info'); },
  askClose() { showCloseAsk(); },
  drag(value) { showDropVeil(value === 'true'); },
  maximized(value) { document.body.classList.toggle('maxed', value === 'on'); },
};

/* 开关类回报统一处理：value 是 on/off，出错时是 error:原因 */
function switchState(boxId, hostKey, value, failPrefix) {
  const bad = String(value).startsWith('error');
  const on = !bad && value === 'on';
  const box = $(boxId);
  if (box) box.checked = on;
  host[hostKey] = on;
  sysNote(bad ? failPrefix + (String(value).slice(6) || '系统不让写这个位置') : '');
}

/* 三套全局快捷键的回报：hotkey / hotkey2 / hotkey3 是当前值，
   带 Ok 是刚改成功，带 Failed 是新组合键被占了、壳已经退回旧的 */
function hostHotkey(name, value) {
  const m = /^(hotkey|hotkey2|hotkey3)(Ok|Failed)?$/.exec(name);
  if (!m) return false;
  const no = m[1] === 'hotkey' ? 1 : m[1] === 'hotkey2' ? 2 : 3;
  const row = HK_ROWS[no];
  if (m[2] === 'Ok') {
    host[row.host] = String(value || '');
    paintHotkey(no);
    $(row.hint).textContent = row.ok.replace('%s', host[row.host]);
    return true;
  }
  if (m[2] === 'Failed') {
    $(row.hint).textContent = value + ' 被别的软件占着，已经退回 ' +
      host[row.host] + '，换一组试试。';
    return true;
  }
  host[row.host] = String(value || '');
  paintHotkey(no);
  trySyncHotkey();
  return true;
}

window.GisHost = function (name, value) {
  if (hostHotkey(name, value)) return;
  const fn = hostHandlers[name];
  if (fn) fn(value);
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
    if (chosen && !names.includes(chosen)) {
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

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'];

/* 修饰键按位记：Ctrl=2、Alt=1、Shift=4、Win=8，和壳里的约定一致 */
function modifierBits(e) {
  return (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

/* 只按下修饰键本身时还没有具体键：Control/Alt/Shift/Meta/CapsLock 都算 0 */
function vkOfEvent(e) {
  if (MODIFIER_KEYS.includes(e.key)) return 0;
  return vkOf(e);
}

/* 允许的组合：带一个修饰键，或者单按 F1~F12 */
function hotkeyAcceptable(mods, vk) {
  if (!vk) return false;
  if (mods) return true;
  return vk >= 0x70 && vk <= 0x7B;
}

function onArmKeydown(e) {
  if (!armingHot) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { settleHotkey(); return; }
  const mods = modifierBits(e);
  const vk = vkOfEvent(e);
  if (!hotkeyAcceptable(mods, vk)) {
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
/* 设置页上半部分：底图与数据显示相关，改完立刻影响下一次绘制 */
function saveRenderPreferences() {
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
    try { localStorage.setItem(PYR_NEVER, $('cfgPyrAsk').checked ? '0' : '1'); } catch { /* 隐私模式下写不了，不影响本次使用 */ }
  }
  config.draw_limit = Number($('cfgDrawLimit').value) || 5000;
  if (window.GisMap) GisMap.setDrawLimit(config.draw_limit);
}

/* 设置页下半部分：窗口行为、目录、缓存。改完要把"由壳执行"的那几项告诉壳 */
function saveSystemPreferences() {
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
}

/* 把改动应用出去：配色、字号、右栏文字、属性表、底图按钮都要跟上，
   最后整份存回引擎；分级与上色是引擎算的，改了要重算当前波段 */
async function applySavedSettings(before) {
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

async function applySettings() {
  const before = {
    ramp: config.ramp, k: config.class_count,
    nodata: config.nodata_view, def: config.raster_default,
  };
  saveRenderPreferences();
  saveSystemPreferences();
  await applySavedSettings(before);
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
      config.cache_fallback = Boolean(data.cache_fallback);
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
  if (!SET_PANES.includes(sec)) sec = 'base';
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

/* 设置页“边打边存”的定时器：关面板时要能清掉，所以放在模块里 */
let keySaveTimer = 0;

/* 顶栏路径框、打开按钮、主题与更新入口 */
function wireShellAndPath() {
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

}

/* 设置面板的打开、关闭与拖动 */
function wireSettingsPanel() {
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
}

/* 设置页里的缓存位置、目录选择与清空 */
function wireCacheSettings() {
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
}

/* 顶栏数据体检浮层 */
function wireCheckPopover() {
  // 数据体检：顶栏那颗按钮开浮层，选文件/文件夹、看结论都在这一块里
  $('checkBtn').addEventListener('click', toggleCheckPop);
  // 选完就查：没有"开始体检"按钮之后，选择动作本身就是触发条件
  $('checkFilePick').addEventListener('click', () => toShell('pickcheck'));
  $('checkPathPick').addEventListener('click', () => { dirPickTarget = 'check'; pickFrom('checkPath'); });
  // 路径框里回车等同确认，省得手离开键盘
  $('checkPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runCheck(); }
  });
}

/* 顶栏格式互转浮层 */
function wireConvertPopover() {
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
}

/* 体检与互转标题旁的说明气泡 */
function wireToolTips() {
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
}

/* 设置页的说明图标、置顶同步、体检入口 */
function wireSettingTips() {
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
}

/* 设置页的分栏、右键菜单与页内快捷键 */
function wireSettingSections() {
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
}

/* 设置页各项输入改一下生效一下 */
function wireSettingInputs() {
  /* 没有保存按钮：改一下生效一下。令牌那一栏不落盘，所以不参与 */
  document.querySelectorAll('#settings select, #settings input').forEach((node) => {
    if (node.id === 'cfgAutoStart' || node.id === 'cfgDeskLnk') return;
    node.addEventListener('change', applySettings);
  });
  /* 密钥这类长文本只靠 change（失焦）会丢：打完直接按 Esc 或点右上角关闭，
     焦点还没离开输入框，值就没落盘。改成边打边存，离开输入框再补一次 */
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
}

/* 全局快捷键、开机自启、桌面快捷方式、更新 */
function wireGlobalKeys() {
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
}

/* 地图右上角的底图、值分布、属性表按钮 */
function wireMapTools() {
  $('baseBtn').addEventListener('click', toggleBasemap);
  $('histBtn').addEventListener('click', toggleHist);
  $('attrBtn').addEventListener('click', () => { attrAuto = false; toggleAttr(); });
  $('chipClose').addEventListener('click', () => { hideLayerPop(); closeLayer(); });
}

/* 文件被外部改过时的那条横幅 */
function wireStaleBanner() {
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
}

/* 文件卡上的图层切换与图例收起 */
function wireLayerChip() {
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
}

/* 分栏、属性表接缝与页内快键 */
function wireChromeGlue() {
  wireChrome();
  wireAttrGrip();
  wireAttrBody();
  wireQuickKeys();
}

/* 最近打开列表的弹出与收起 */
function wireRecentMenu() {
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
}

/* 打开、体检、互转三块浮层点外面收起 */
function wirePopoverDismiss() {
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
}

/* 属性表里的搜索框 */
function wireAttrSearch() {
  let findTimer = 0;
  $('attrFind').addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(applyAttrFind, 140);
  });
}

/* 地图取数与鼠标位置 */
function wireMapDataEvents() {
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
}

/* 定位、高亮、全精度重画的反馈 */
function wireMapFocusEvents() {
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
}

/* 影像取不回来时的提示与视野刷新 */
function wireMapRasterEvents() {
  /* 贴图没取回来：地图还在，底图也还在，只这一张影像缺了。
     给一句话就够，别把界面压成错误页 */
  $('map').addEventListener('gis:rasterfail', (e) => {
    const why = (e.detail && e.detail.message) || '未能取到影像数据';
    toastNote('影像显示失败',
      why + '。请确认文件仍然存在并可读；缩放或平移后会自动重新尝试。');
  });
  $('map').addEventListener('gis:view', (e) => {
    paintView(e);
  });
}

/* 属性表滚动翻页与复制整列 */
function wireAttrTable() {
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
}

/* 画出图层但没底图时提醒一次。只提醒"选了要密钥的底图却没填密钥"这一种，
   用户自己把底图关掉是他的选择；配置还没读回来时不能判，否则启动就恢复上次文件那条路径会误报 */
function hintNoBasemap(kind, state) {
  if (state.shown || !configReady) return;
  if (kind !== 'vector' && kind !== 'raster') return;
  const bm = String(config.basemap || '');
  if (!bm.startsWith('tianditu')) return;
  if ((config.tianditu_key || '').trim()) return;
  state.shown = true;
  showErrToast('当前无可用底图',
    '在 **设置 → 底图** 里选择底图源；天地图需要填一个"浏览器端"密钥（自备）。', '', 'info');
}

/* 清空（none）不算画完：切文件时先清一次旧图层，那一下收遮罩就收早了。
   skip 是"这层画不出来"，这时候遮罩要立刻撤，别让人对着转圈等 */
function veilOnDrawn(kind) {
  if (kind === 'skip') { releaseVeil(); return; }
  if (kind === 'none') return;
  drawTick += 1;
  if (veilHold && drawTick > veilAt) releaseVeil();
}

/* 图层画完后的收尾与主题跟随系统 */
function wireMapDrawDone() {
  const state = { shown: false };
  $('map').addEventListener('gis:drawn', (e) => {
    const kind = (e.detail && e.detail.kind) || 'none';
    hintNoBasemap(kind, state);
    veilOnDrawn(kind);
    // 换成栅格或切片之后属性表已经没有意义，关掉，别把上一个矢量的行留在下面
    if (kind !== 'vector') closeAttr();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (config.theme === 'auto') applyTheme('auto');
  });
  /* 地图那边画崩了（坐标超范围之类）会走这里：立刻把"正在画图层…"收掉，
     错误提示由地图自己弹，别让遮罩一直转 */
  window.gisMapFail = () => { releaseVeil(); loadTip(false); };

}

/* 布局类的观察器：地图尺寸、文件卡高度都会影响图例能长多高 */
function watchLayout() {
  reportDropArea();
  window.addEventListener('resize', reportDropArea);
  const mainEl = $('drop');
  if (mainEl && window.ResizeObserver) new ResizeObserver(reportDropArea).observe(mainEl);
  /* 地图宽度会被分栏拖动、信息栏收放改掉：提示卡跟着重新居中 */
  const mapEl = $('map');
  if (mapEl && window.ResizeObserver) new ResizeObserver(placeErrToast).observe(mapEl);
  /* 分栏拖动、信息栏收放、窗口缩放都会改地图高度；文件卡展开收起、换图层都会改它自己的高度 */
  const stageEl = document.querySelector('.map-stage');
  const chipEl = $('fileChip');
  syncMapHeight();
  if (!window.ResizeObserver) return;
  const ro = new ResizeObserver(syncMapHeight);
  if (stageEl) ro.observe(stageEl);
  if (chipEl) ro.observe(chipEl);
}

/* 让壳知道关闭按钮的行为与"就绪"，顺便查一次更新 */
function tellShellReady() {
  // 底图按钮的亮灭按 config.basemap 定：设置里选过"无底图"，这里一启动就是灭的
  updateBaseBtn();
  toShell('closeact:' + (config.close_act === 'exit' ? 'exit' : 'min'));
  toShell('closeask:' + (config.close_ask === false ? 'off' : 'on'));
  toShell('ready');
  maybeCheckUpdate();
}

/* 地址栏上的 ?theme= 优先于设置里的主题 */
function applyForcedTheme(params) {
  const forced = params.get('theme');
  if (!forced || !THEME_LABELS[forced]) return;
  config.theme = forced;
  applyTheme(forced);
  paintThemeBtn();
}

/* 启动时该打开哪个文件：启动期间拖进来的最要紧，其次是地址栏的 ?path=，最后问壳要预载路径 */
function openBootDoc(params) {
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
    if (!d.ok || !d.paths || !d.paths.length) return;
    const clean = tidyPath(d.paths[0]);
    $('pathInput').value = clean;
    inspectPath(clean);
  }).catch(() => {});
}

/* 读回配置后恢复上次的文件与界面状态 */
function boot() {
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
    watchLayout();
    tellShellReady();
    const params = new URLSearchParams(location.search);
    applyForcedTheme(params);
    openBootDoc(params);
  });
}

function init() {
  wireShellAndPath();
  wireSettingsPanel();
  wireCacheSettings();
  wireCheckPopover();
  wireConvertPopover();
  wireToolTips();
  wireSettingTips();
  wireSettingSections();
  wireSettingInputs();
  wireGlobalKeys();
  wireMapTools();
  wireStaleBanner();
  wireLayerChip();
  wireChromeGlue();
  wireRecentMenu();
  wirePopoverDismiss();
  wireAttrSearch();
  wireMapDataEvents();
  wireMapFocusEvents();
  wireMapRasterEvents();
  wireAttrTable();
  wireMapDrawDone();
  boot();
}

init();
