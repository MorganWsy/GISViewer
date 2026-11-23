/* 界面文字的中英两套说法。
 *
 * 约定：代码里不写死中文，一律 t('键名')；HTML 里用 data-i18n / data-i18n-tip /
 * data-i18n-ph 标出要翻的节点，applyI18n() 负责填。
 *
 * 英文没写到的键会退回中文，所以可以分批补，界面不会出现空字符串或键名。
 */
(function () {
  'use strict';

  const STORE = 'tulan.lang';
  const LANGS = ['zh', 'en'];

  const zh = {
    'lang.zh': '中文',
    'lang.en': 'English',

    'chrome.settings': '设置：**底图**、**密钥**、**显示**与**快捷键**',
    'chrome.closeSettings': '关闭设置',
    'chrome.expandLegend': '展开图例',
    'chrome.collapseLegend': '收起图例',
    'chrome.collapseChip': '收起文件信息',
    'chrome.expandChip': '展开文件信息',
    'chrome.ramp': '色带：点击更换',
    'chrome.showKey': '显示密钥',
    'chrome.pickDir': '选择一个固定目录',
    'chrome.pickCache': '选择缓存目录',
    'chrome.clearDefault': '清除，恢复默认',
    'chrome.checkNow': '现在检查',
    'chrome.repo': '在浏览器中打开 github.com/MorganWsy/GISViewer',
    'chrome.newHotkey': '点击后按下新的组合键',

    'legend.title': '图例',
    'legend.ramp.auto': '色带：自动（{0}）',
    'legend.ramp.pick': '色带：{0}。点击更换',
    'pyr.title': '创建金字塔',
    'pyr.sub': '为影像生成一组逐级降采样的显示副本',
    'pyr.fact.size': '原始尺寸',
    'pyr.fact.bytes': '文件大小',
    'pyr.fact.levels': '副本层级',
    'pyr.fact.where': '保存位置',
    'pyr.where.value': '本机缓存目录',
    'pyr.method': '采样方法',
    'pyr.m.average': '平均值',
    'pyr.d.average': '区域等权汇总，取值不越界',
    'pyr.m.bilinear': '双线性',
    'pyr.d.bilinear': '邻域加权插值，过渡更连续',
    'pyr.m.cubic': '三次卷积',
    'pyr.d.cubic': '锐度最好，边缘可能过冲',
    'pyr.m.nearest': '最近邻',
    'pyr.d.nearest': '只取原值，不生成新的类别',
    'pyr.tag.cont': '连续数据',
    'pyr.tag.cat': '分类数据',
    'pyr.rec': '推荐',
    'pyr.note': '副本保存在本机缓存目录，不会改动原文件及其所在文件夹。创建过程在后台进行，可以随时取消。',
    'pyr.never': '以后不再询问',
    'pyr.skip': '暂不创建',
    'pyr.build': '创建',
    'rail.bandName': '名称',
    'rail.dataType': '数据类型',
    'rail.unit': '数值单位',
    'rail.colormap': '色表',
    'rail.geomType': '几何类型',
    'rail.featureCount': '要素数',
    'rail.hasZ': 'Z 值坐标',
    'rail.hasM': 'M 值坐标',
    'rail.encoding': '属性表编码',
    'rail.variables': '变量数',
    'rail.format': '格式',
    'rail.sampleTile': '取样',
    'rail.readFailed': '读取失败',
    'ramp.title': '色带',
    'ramp.auto': '自动，按数据类型',
    'ramp.autoWith': '自动，按数据类型（{0}）',
    'ramp.autoNamed': '自动，{0}',
    'ramp.cont': '连续数据',
    'ramp.cat': '分类数据',

    'set.title': '设置',
    'set.nav.base': '底图',
    'set.nav.render': '栅格与矢量',
    'set.nav.look': '外观',
    'set.nav.file': '文件',
    'set.nav.sys': '系统',
    'set.nav.about': '关于',

    'set.base.label': '底图',
    'set.base.none': '无底图',
    'set.base.tdtImg': '天地图影像',
    'set.base.tdtVec': '天地图矢量',
    'set.base.esri': 'Esri 卫星影像',
    'set.base.osm': 'OpenStreetMap',
    'set.base.amap': '高德影像',
    'set.base.annot': '天地图注记',
    'set.base.key': '天地图密钥',
    'set.base.keyPh': '填一次就行，之后不用管',

    'set.render.ramp': '色带',
    'set.render.classes': '分级级数',
    'set.render.classN': '{0} 级',
    'set.render.classDefault': '{0} 级（默认）',
    'set.render.nodata': '无数据像元',
    'set.render.nodataTransparent': '透出底图（默认）',
    'set.render.nodataBlack': '涂黑',
    'set.render.nodataWhite': '涂白',
    'set.render.multi': '多波段默认显示',
    'set.render.multiComposite': '前三个波段合成（默认）',
    'set.render.multiSingle': '第一个波段，单色分级',
    'set.render.vecColor': '要素颜色',
    'set.render.colorOrange': '橙（默认）',
    'set.render.colorYellow': '明黄',
    'set.render.colorCyan': '青',
    'set.render.colorGreen': '草绿',
    'set.render.colorMagenta': '品红',
    'set.render.drawLimit': '视野内单次绘制',
    'set.render.limitN': '{0} 个',
    'set.render.limitFast': '{0} 个（快）',
    'set.render.limitDefault': '{0} 个（默认）',
    'set.render.limitSlow': '{0} 个（大图层会慢）',
    'set.render.precision': '几何精度',
    'set.render.precisionAuto': '自动（推荐）',
    'set.render.precisionAccurate': '精确优先',
    'set.render.precisionFast': '速度优先',
    'set.render.attrBatch': '属性表每批条数',
    'set.render.rowsN': '{0} 条',
    'set.render.rowsDefault': '{0} 条（默认）',
    'set.render.rowsSlow': '{0} 条（大图层会慢）',

    'set.look.theme': '主题',
    'set.look.themeAuto': '跟随系统',
    'set.look.themeLight': '浅色',
    'set.look.themeDark': '深色',
    'set.look.themePaper': '暖纸',
    'set.look.themeInk': '墨黑',
    'set.look.themeSlate': '青岩',
    'set.look.fontUi': '界面字体',
    'set.look.fontNum': '数字与英文字体',
    'set.look.unit': '单位显示',
    'set.look.unitEn': '英文（m、km、°）',
    'set.look.unitZh': '中文（米、千米、度）',
    'set.look.zoom': '界面字号',
    'set.look.zoomN': '{0}%',
    'set.look.zoomCompact': '{0}%（紧凑）',
    'set.look.zoomDefault': '{0}%（默认）',
    'set.look.zoomTiring': '{0}%（费眼）',
    'set.look.alpha': '面板不透明度',
    'set.look.toast': '浮窗停留时间',
    'set.look.toastN': '{0} 秒',
    'set.look.toastDefault': '{0} 秒（默认）',
    'set.look.lang': '界面语言',

    'set.file.ctxMenu': '资源管理器右键',
    'set.file.ctxOpen': '用图览打开',
    'set.file.openDir': '文件框起始目录',
    'set.file.openDirPh': '点右侧按钮选择，留空则跟随上次打开文件',
    'set.file.restore': '启动时恢复上次文件',
    'set.file.recent': '最近打开条数',
    'set.file.recentN': '{0} 条',
    'set.file.recentDefault': '{0} 条（默认）',
    'set.file.cacheDir': '副本存放位置',
    'set.file.cacheDirPh': '点右侧按钮选择，留空则用系统临时目录',
    'set.file.keep': '副本保留时长',
    'set.file.keepN': '{0} 小时',
    'set.file.keepDefault': '{0} 小时（默认）',
    'set.file.keepDays': '{0} 天',
    'set.file.cachePath': '缓存位置',
    'set.file.openFolder': '打开文件夹',
    'set.file.clearCache': '清空缓存',
    'set.file.counting': '正在统计…',

    'set.sys.autostart': '开机自启动',
    'set.sys.topmost': '窗口置顶',
    'set.sys.pyrAsk': '打开大影像时询问创建金字塔',
    'set.sys.deskLnk': '桌面快捷方式',
    'set.sys.closeAct': '关闭按钮行为',
    'set.sys.closeMin': '驻留托盘',
    'set.sys.closeExit': '直接退出',
    'set.sys.closeAsk': '关闭时询问',
    'set.sys.keys': '键盘操作',
    'set.sys.keyToggle': '唤出或收起窗口',
    'set.sys.keyOpen': '打开资源管理器中选中的文件',
    'set.sys.keyCheck': '对资源管理器中选中的文件做体检',
    'set.sys.keyClose': '收起提示、识别弹窗与属性表',
    'set.sys.keyFit': '回到全图',
    'set.sys.keyFind': '定位到属性表查找框',
    'set.sys.keyEnter': '路径框回车：打开文件或按坐标定位',
    'set.sys.reset': '恢复默认',

    'set.about.version': '版本',
    'set.about.repo': '项目仓库',
  };

  const en = {
    'lang.zh': '中文',
    'lang.en': 'English',

    'chrome.settings': 'Settings: **basemap**, **key**, **display** and **shortcuts**',
    'chrome.closeSettings': 'Close settings',
    'chrome.expandLegend': 'Expand legend',
    'chrome.collapseLegend': 'Collapse legend',
    'chrome.collapseChip': 'Collapse file info',
    'chrome.expandChip': 'Expand file info',
    'chrome.ramp': 'Colour ramp: click to change',
    'chrome.showKey': 'Show key',
    'chrome.pickDir': 'Choose a fixed folder',
    'chrome.pickCache': 'Choose cache folder',
    'chrome.clearDefault': 'Clear and use the default',
    'chrome.checkNow': 'Check now',
    'chrome.repo': 'Open github.com/MorganWsy/GISViewer in your browser',
    'chrome.newHotkey': 'Click, then press a new key combination',

    'legend.title': 'Legend',
    'legend.ramp.auto': 'Colour ramp: auto ({0})',
    'legend.ramp.pick': 'Colour ramp: {0}. Click to change',
    'pyr.title': 'Create pyramids',
    'pyr.sub': 'Build a set of downsampled copies so the image opens fast',
    'pyr.fact.size': 'Pixels',
    'pyr.fact.bytes': 'File size',
    'pyr.fact.levels': 'Levels',
    'pyr.fact.where': 'Stored in',
    'pyr.where.value': 'the local cache folder',
    'pyr.method': 'Resampling',
    'pyr.m.average': 'Average',
    'pyr.d.average': 'Equal-weight mean, never leaves the value range',
    'pyr.m.bilinear': 'Bilinear',
    'pyr.d.bilinear': 'Distance-weighted neighbours, smoother transitions',
    'pyr.m.cubic': 'Cubic',
    'pyr.d.cubic': 'Sharpest, may overshoot at edges',
    'pyr.m.nearest': 'Nearest',
    'pyr.d.nearest': 'Reuses original values, invents no classes',
    'pyr.tag.cont': 'Continuous',
    'pyr.tag.cat': 'Categorical',
    'pyr.rec': 'Suggested',
    'pyr.note': 'The copy lives in the local cache. Your file and its folder are not touched. Building runs in the background and can be cancelled.',
    'pyr.never': "Don't ask again",
    'pyr.skip': 'Not now',
    'pyr.build': 'Create',
    'rail.bandName': 'Name',
    'rail.dataType': 'Data type',
    'rail.unit': 'Unit',
    'rail.colormap': 'Colour table',
    'rail.geomType': 'Geometry',
    'rail.featureCount': 'Features',
    'rail.hasZ': 'Has Z',
    'rail.hasM': 'Has M',
    'rail.encoding': 'Attribute encoding',
    'rail.variables': 'Variables',
    'rail.format': 'Format',
    'rail.sampleTile': 'Tile',
    'rail.readFailed': 'Read failed',
    'ramp.title': 'Colour ramp',
    'ramp.auto': 'Auto, by data type',
    'ramp.autoWith': 'Auto, by data type ({0})',
    'ramp.autoNamed': 'Auto, {0}',
    'ramp.cont': 'Continuous',
    'ramp.cat': 'Categorical',

    'set.title': 'Settings',
    'set.nav.base': 'Basemap',
    'set.nav.render': 'Raster & vector',
    'set.nav.look': 'Appearance',
    'set.nav.file': 'Files',
    'set.nav.sys': 'System',
    'set.nav.about': 'About',

    'set.base.label': 'Basemap',
    'set.base.none': 'None',
    'set.base.tdtImg': 'Tianditu imagery',
    'set.base.tdtVec': 'Tianditu vector',
    'set.base.esri': 'Esri satellite',
    'set.base.osm': 'OpenStreetMap',
    'set.base.amap': 'Amap imagery',
    'set.base.annot': 'Tianditu labels',
    'set.base.key': 'Tianditu key',
    'set.base.keyPh': 'Fill it in once; you will not need it again',

    'set.render.ramp': 'Colour ramp',
    'set.render.classes': 'Classes',
    'set.render.classN': '{0} classes',
    'set.render.classDefault': '{0} classes (default)',
    'set.render.nodata': 'NoData pixels',
    'set.render.nodataTransparent': 'Show basemap through (default)',
    'set.render.nodataBlack': 'Paint black',
    'set.render.nodataWhite': 'Paint white',
    'set.render.multi': 'Multi-band default',
    'set.render.multiComposite': 'First three bands as RGB (default)',
    'set.render.multiSingle': 'First band only, graduated',
    'set.render.vecColor': 'Feature colour',
    'set.render.colorOrange': 'Orange (default)',
    'set.render.colorYellow': 'Yellow',
    'set.render.colorCyan': 'Cyan',
    'set.render.colorGreen': 'Green',
    'set.render.colorMagenta': 'Magenta',
    'set.render.drawLimit': 'Features drawn per view',
    'set.render.limitN': '{0} features',
    'set.render.limitFast': '{0} features (fast)',
    'set.render.limitDefault': '{0} features (default)',
    'set.render.limitSlow': '{0} features (slow on large layers)',
    'set.render.precision': 'Geometry precision',
    'set.render.precisionAuto': 'Auto (recommended)',
    'set.render.precisionAccurate': 'Precision first',
    'set.render.precisionFast': 'Speed first',
    'set.render.attrBatch': 'Attribute rows per batch',
    'set.render.rowsN': '{0} rows',
    'set.render.rowsDefault': '{0} rows (default)',
    'set.render.rowsSlow': '{0} rows (slow on large layers)',

    'set.look.theme': 'Theme',
    'set.look.themeAuto': 'Follow system',
    'set.look.themeLight': 'Light',
    'set.look.themeDark': 'Dark',
    'set.look.themePaper': 'Warm paper',
    'set.look.themeInk': 'Ink',
    'set.look.themeSlate': 'Slate',
    'set.look.fontUi': 'Interface font',
    'set.look.fontNum': 'Numbers and Latin font',
    'set.look.unit': 'Units',
    'set.look.unitEn': 'English (m, km, °)',
    'set.look.unitZh': 'Chinese (米, 千米, 度)',
    'set.look.zoom': 'Interface scale',
    'set.look.zoomN': '{0}%',
    'set.look.zoomCompact': '{0}% (compact)',
    'set.look.zoomDefault': '{0}% (default)',
    'set.look.zoomTiring': '{0}% (large)',
    'set.look.alpha': 'Panel opacity',
    'set.look.toast': 'Toast duration',
    'set.look.toastN': '{0} s',
    'set.look.toastDefault': '{0} s (default)',
    'set.look.lang': 'Language',

    'set.file.ctxMenu': 'Explorer context menu',
    'set.file.ctxOpen': 'Open with Tulan',
    'set.file.openDir': 'Start folder for the file dialog',
    'set.file.openDirPh': 'Pick a folder on the right; empty follows the last opened file',
    'set.file.restore': 'Reopen the last file at startup',
    'set.file.recent': 'Recent entries',
    'set.file.recentN': '{0} items',
    'set.file.recentDefault': '{0} items (default)',
    'set.file.cacheDir': 'Working copy folder',
    'set.file.cacheDirPh': 'Pick a folder on the right; empty uses the system temp folder',
    'set.file.keep': 'Keep working copies for',
    'set.file.keepN': '{0} hours',
    'set.file.keepDefault': '{0} hours (default)',
    'set.file.keepDays': '{0} days',
    'set.file.cachePath': 'Cache folder',
    'set.file.openFolder': 'Open folder',
    'set.file.clearCache': 'Clear cache',
    'set.file.counting': 'Counting…',

    'set.sys.autostart': 'Start with Windows',
    'set.sys.topmost': 'Always on top',
    'set.sys.pyrAsk': 'Ask before building pyramids',
    'set.sys.deskLnk': 'Desktop shortcut',
    'set.sys.closeAct': 'Close button',
    'set.sys.closeMin': 'Keep in tray',
    'set.sys.closeExit': 'Exit',
    'set.sys.closeAsk': 'Ask when closing',
    'set.sys.keys': 'Keyboard',
    'set.sys.keyToggle': 'Show or hide the window',
    'set.sys.keyOpen': 'Open the file selected in Explorer',
    'set.sys.keyCheck': 'Check the file selected in Explorer',
    'set.sys.keyClose': 'Dismiss tips, identify popups and the attribute table',
    'set.sys.keyFit': 'Back to the full extent',
    'set.sys.keyFind': 'Focus the attribute search box',
    'set.sys.keyEnter': 'Enter in the path box: open a file or locate coordinates',
    'set.sys.reset': 'Reset',

    'set.about.version': 'Version',
    'set.about.repo': 'Repository',
  };

  const DICT = { zh, en };
  let current = 'zh';

  function read() {
    try {
      const got = localStorage.getItem(STORE);
      return LANGS.includes(got) ? got : 'zh';
    } catch {
      return 'zh';
    }
  }

  function fill(text, args) {
    if (!args || !args.length) return text;
    return text.replace(/\{(\d+)\}/g, function (all, idx) {
      const got = args[Number(idx)];
      return got === undefined ? all : String(got);
    });
  }

  function t(key, ...args) {
    const table = DICT[current] || zh;
    let text = table[key];
    if (text === undefined) text = zh[key];
    if (text === undefined) return key;
    return fill(text, args);
  }

  function applyI18n(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (node) {
      const args = (node.getAttribute('data-i18n-args') || '')
        .split(',')
        .map(function (v) { return v.trim(); })
        .filter(function (v) { return v !== ''; });
      node.textContent = t(node.getAttribute('data-i18n'), ...args);
    });
    scope.querySelectorAll('[data-i18n-tip]').forEach(function (node) {
      const text = t(node.getAttribute('data-i18n-tip'));
      node.setAttribute('data-tip', text);
      if (node.hasAttribute('aria-label')) node.setAttribute('aria-label', text);
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach(function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-ph')));
    });
  }

  function setLang(lang) {
    current = LANGS.includes(lang) ? lang : 'zh';
    try {
      localStorage.setItem(STORE, current);
    } catch {
      /* 隐私模式下写不进去，这一次照样用 */
    }
    document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
    applyI18n();
    window.dispatchEvent(new CustomEvent('tulan:lang', { detail: current }));
  }

  function langNow() {
    return current;
  }

  current = read();
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';

  window.t = t;
  window.setLang = setLang;
  window.langNow = langNow;
  window.applyI18n = applyI18n;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyI18n(); });
  } else {
    applyI18n();
  }
})();
