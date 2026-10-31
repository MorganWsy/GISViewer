/* 地图：底图切换 + 用户数据绘制。位置换算只作用在底图和显示上，绝不改动用户数据的坐标系。 */
(function () {
  'use strict';

  const TD_HOSTS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'];
  let drawLimit = 5000;   // 视野内单次绘制的要素数（设置里可改）
  let vecInFlight = false;   // 上一次取数还没回来
  let vecPending = false;    // 取数期间视野又变了：回来后补一次
  let lastLimitToast = 0;    // 上次弹"超上限"提示的时刻：6 秒内不重复
  let localNoteShown = false;   // "坐标按米临时摆放"每个文件只说明一次
  const TILE_PALETTE = ['#d9781f', '#2f6fed', '#2e9e5b', '#a24bd8', '#c94f4f', '#0f9b8e'];

  let map = null;
  let popup = null;
  let idToken = 0;
  let elapsed = '';
  let config = { basemap: 'tianditu_img', annotation: false, tianditu_key: '' };
  let data = null;
  let pending = null;
  let token = 0;
  let debounce = null;
  let lastVec = null;
  /* 相机指纹：中心点、缩放、朝向、俯仰。窗口还原时画布尺寸会变，但相机没动，
     拿它就能分辨"只是画布变大了"和"用户真的动过地图"——前者不该重取要素 */
  let resizeCam = '';

  function emit(name, detail) {
    const box = document.getElementById('map');
    if (box) box.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  // 内联 style 在构造时就能用，不必等渲染帧；页面不可见时 requestAnimationFrame 会被挂起
  function live() {
    return !!map && !!map.getStyle();
  }

  /* 相机指纹：中心、缩放、朝向、俯仰。用来分辨"只是画布变大了"和"用户真的动过地图" */
  function cameraKey() {
    if (!map) return '';
    const c = map.getCenter();
    return [c.lng.toFixed(6), c.lat.toFixed(6), map.getZoom().toFixed(4),
            map.getBearing().toFixed(2), map.getPitch().toFixed(2)].join(',');
  }

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  let lastNote = '';
  function note(text) {
    lastNote = text || '';
    const box = document.getElementById('mapNote');
    if (!box) return;
    box.textContent = lastNote ? (elapsed ? elapsed + ' · ' + lastNote : lastNote) : '';
  }

  /* 全局提示统一走页面上那套浮层卡片（showErrToast）：位置、样式、停留时间
     全软件只有一处定义。地图这边只在拿不到它时退回控制台。
     kind='info' 去掉警告图标——"超过上限，先画这些"不是出错，是说明 */
  function toast(title, detail, kind) {
    if (typeof window.showErrToast === 'function') window.showErrToast(title, detail || '', '', kind || '');
    else console.warn(title, detail || '');
  }

  function setElapsed(text) {
    elapsed = text || '';
    note(lastNote);
  }

  function fail(where, err) {
    const msg = err && err.message ? err.message : String(err);
    toast('地图显示失败', where + '：' + msg.slice(0, 180));
  }

  function guard(where, fn) {
    try { fn(); } catch (err) { fail(where, err); }
  }

  function enc(v) {
    return encodeURIComponent(v);
  }

  function td(layer, key) {
    return TD_HOSTS.map((h) =>
      `https://${h}.tianditu.gov.cn/DataServer?T=${layer}&x={x}&y={y}&l={z}&tk=${enc(key)}`);
  }

  function rasterSource(id, tiles, attribution, maxzoom) {
    return { id, type: 'raster', tiles, tileSize: 256, maxzoom, attribution };
  }

  function basemapSources() {
    const key = (config.tianditu_key || '').trim();
    if ((config.basemap === 'tianditu_img' || config.basemap === 'tianditu_vec') && !key) return [];
    switch (config.basemap) {
      case 'tianditu_img':
        return [rasterSource('bm', td('img_w', key), '天地图', 18)];
      case 'tianditu_vec':
        return [rasterSource('bm', td('vec_w', key), '天地图', 18)];
      case 'esri':
        return [rasterSource('bm',
          ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          'Esri, Maxar', 19)];
      case 'osm':
        return [rasterSource('bm', ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], 'OpenStreetMap', 19)];
      case 'amap':
        return [rasterSource('bm', ['/api/tile/amap/{z}/{x}/{y}'], '高德', 18)];
      default:
        return [];
    }
  }

  /* 注记层：天地图两种底图各有自己的注记瓦片；Esri 影像本身没有地名，
     叠一层天地图矢量注记（两边同为 Web 墨卡托，位置对得上），代价是要有天地图密钥。
     OpenStreetMap 的瓦片自带注记，再叠一层就成了两套字；高德是 GCJ-02 基准，
     叠天地图注记会整体偏出几百米——这两种不给叠 */
  function annotationSources() {
    const key = (config.tianditu_key || '').trim();
    if (!key || !config.annotation) return [];
    if (config.basemap === 'tianditu_img') return [rasterSource('bm-note', td('cia_w', key), '天地图', 18)];
    if (config.basemap === 'tianditu_vec') return [rasterSource('bm-note', td('cva_w', key), '天地图', 18)];
    if (config.basemap === 'esri') return [rasterSource('bm-note', td('cva_w', key), '天地图', 18)];
    return [];
  }

  function style() {
    // sources 必须是 {id: 定义} 对象；写成数组会让整份样式校验失败，地图从此不再加载
    const sources = {};
    basemapSources().concat(annotationSources()).forEach((s) => { sources[s.id] = s; });
    const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': css('--map-bg', '#e9edf2') } }];
    Object.keys(sources).forEach((id) => {
      layers.push({
        id: id,
        type: 'raster',
        source: id,
        paint: { 'raster-opacity': id === 'bm-note' ? 0.85 : 1 },
      });
    });
    return { version: 8, sources: sources, layers: layers };
  }

  /* 无坐标系的图层（CAD 图纸等，按原始坐标当作米临时摆放）显示时，
     底图和注记跟数据根本对不到一起，容易让人以为数据摆错了位置——
     把这两层暂时隐起来；切回正常坐标系的图层再按用户设置恢复。
     bm = 底图，bm-note = 天地图注记（见 basemapSources/annotationSources） */
  let baseHidden = false;

  function setBaseHidden(hidden) {
    baseHidden = !!hidden;
    if (!live()) return;
    ['bm', 'bm-note'].forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', baseHidden ? 'none' : 'visible');
      }
    });
  }

  function palette() {
    return {
      fill: css('--map-fill', 'rgba(217, 120, 31, 0.18)'),
      line: css('--map-data', '#d9781f'),
      point: css('--map-data', '#d9781f'),
      extent: css('--map-extent', '#1a6fb0'),
      hl: css('--map-hl', '#d92b2b'),
      card: css('--panel', '#ffffff'),
    };
  }

  function applyPaint() {
    if (!live()) return;
    const c = palette();
    const set = (id, props) => {
      if (!map.getLayer(id)) return;
      Object.keys(props).forEach((k) => map.setPaintProperty(id, k, props[k]));
    };
    set('bg', { 'background-color': css('--map-bg', '#e9edf2') });
    set('gis-raster', { 'raster-opacity': 0.94 });
    set('gis-fill', { 'fill-color': c.fill });
    set('gis-outline', { 'line-color': c.line });
    set('gis-line', { 'line-color': c.line });
    set('gis-circle', { 'circle-color': c.point, 'circle-stroke-color': c.card });
    set('gis-extent', { 'line-color': c.extent });
    set('gis-hl-fill', { 'fill-color': c.hl });
    set('gis-hl-line', { 'line-color': c.hl });
    set('gis-hl-circle', { 'circle-color': c.hl, 'circle-stroke-color': c.card });
  }

  function ensureSources() {
    if (!map.getSource('gis-data')) {
      map.addSource('gis-data', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('gis-extent')) {
      map.addSource('gis-extent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('gis-hl')) {
      map.addSource('gis-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
  }

  /* 点中的要素描一圈高亮；弹窗关掉或点了别处就撤掉。
     描的是哪个要素要告诉界面：属性表靠着这条把对应行一起标上或撤掉 */
  function setHighlight(feats) {
    if (!live()) return;
    const src = map.getSource('gis-hl');
    if (!src) return;
    const kept = (feats || []).filter((f) => f && f.geometry);
    const list = kept.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: {} }));
    src.setData({ type: 'FeatureCollection', features: list });
    emit('gis:highlight', { fids: kept.map(fidOf).filter((v) => v !== null) });
  }

  function addLayers() {
    const c = palette();
    const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    const polygonal = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
    const linear = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
    const pointly = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

    if (map.getSource('gis-image')) {
      add({ id: 'gis-raster', type: 'raster', source: 'gis-image', paint: { 'raster-opacity': 0.94 } });
    }
    add({ id: 'gis-fill', type: 'fill', source: 'gis-data', filter: polygonal,
      paint: { 'fill-color': c.fill, 'fill-opacity': 1 } });
    add({ id: 'gis-outline', type: 'line', source: 'gis-data', filter: polygonal,
      paint: { 'line-color': c.line, 'line-width': 1.1, 'line-opacity': 0.95 } });
    add({ id: 'gis-line', type: 'line', source: 'gis-data', filter: linear,
      paint: { 'line-color': c.line, 'line-width': 1.8, 'line-opacity': 0.95 } });
    add({ id: 'gis-circle', type: 'circle', source: 'gis-data', filter: pointly,
      paint: { 'circle-color': c.point, 'circle-radius': 4, 'circle-stroke-width': 1,
        'circle-stroke-color': c.card } });
    add({ id: 'gis-extent', type: 'line', source: 'gis-extent',
      paint: { 'line-color': c.extent, 'line-width': 1.4, 'line-dasharray': [3, 2] } });
    /* 高亮压在数据之上：面只描粗边、点位放大一圈，颜色跟数据色拉开才看得出是哪一个 */
    add({ id: 'gis-hl-fill', type: 'fill', source: 'gis-hl', filter: polygonal,
      paint: { 'fill-color': c.hl, 'fill-opacity': 0.16 } });
    add({ id: 'gis-hl-line', type: 'line', source: 'gis-hl',
      paint: { 'line-color': c.hl, 'line-width': 2.8, 'line-opacity': 0.98 } });
    add({ id: 'gis-hl-circle', type: 'circle', source: 'gis-hl', filter: pointly,
      paint: { 'circle-color': c.hl, 'circle-radius': 7, 'circle-stroke-width': 2,
        'circle-stroke-color': c.card } });
  }

  function removeImage() {
    if (map.getLayer('gis-raster')) map.removeLayer('gis-raster');
    if (map.getSource('gis-image')) map.removeSource('gis-image');
  }

  function setImage(url, corners) {
    removeImage();
    map.addSource('gis-image', { type: 'image', url, coordinates: corners });
    if (!map.getLayer('gis-raster')) {
      map.addLayer({ id: 'gis-raster', type: 'raster', source: 'gis-image',
        paint: { 'raster-opacity': 0.94 } });
    }
  }

  function boxFromRing(ring) {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return [Math.min.apply(null, xs), Math.min.apply(null, ys),
      Math.max.apply(null, xs), Math.max.apply(null, ys)];
  }

  function setExtentRing(ring) {
    const src = map.getSource('gis-extent');
    if (!src) return;
    if (!ring || ring.length < 4) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    src.setData({ type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [ring.map((p) => [p[0], p[1]])] } });
  }

  /* 属性表压着地图下半截（高 260 或用户拖过的 --attr-h）：
     聚焦时把这块让出来，不然图层范围的下半总被表盖住 */
  function attrReserve() {
    const stage = document.querySelector('.map-stage');
    if (!stage) return 0;
    const on = stage.classList.contains('attr-on');
    if (!on) return 0;
    return parseFloat(getComputedStyle(stage).getPropertyValue('--attr-h')) || 260;
  }

  function fitTo(box, willReserve) {
    /* 属性表要让出来的高度，最多只给到容器的四成：竖排的小窗口里地图才三百来像素高，
       真留出 260 就只剩几十像素可用，fitBounds 在这么窄的高度里会算出退化的视野
       （宽高反转、甚至无穷），取要素时带上这种框，服务端换算必然失败 */
    const h = map.getContainer().clientHeight || 0;
    const want = Math.max(attrReserve(), willReserve ? 260 : 0);
    const cap = h > 0 ? Math.max(24, Math.round(h * 0.4)) : want;
    const bottom = 26 + Math.min(want, cap);
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]],
      { padding: { top: 26, left: 26, right: 26, bottom }, duration: 0, maxZoom: 12 });
  }

  function cornersOf(t) {
    if (t.corners && t.corners.length === 4) return t.corners;
    const b = t.wgs;
    return [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]];
  }

  /* 抽稀容差按屏幕像素走：1.5 个像素，放大到多少级都一样细，
     不再留 0.00002°（约 2 米）的底——那个底在十六级以后会粗到看得见 */
  function zoomTolerance(z) {
    return 1.5 * 360 / Math.pow(2, z) / 256;
  }

  function baseNote() {
    return data && data.warning ? data.warning + ' · ' : '';
  }

  /* 无坐标系图层"对准镜头"只做一次的记账：按 文件+图层 记 */
  const vecLocalFit = {};

  /* 一屏要素的经纬度外包框：无坐标系图层打开时用它把视图对上去 */
  function featsBBox(feats) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else {
        c.forEach(walk);
      }
    };
    feats.forEach((f) => {
      const geom = f.geometry;
      if (geom && geom.coordinates) walk(geom.coordinates);
    });
    return isFinite(minX) ? [minX, minY, maxX, maxY] : null;
  }

  function loadVector(fromMove) {
    if (!data || data.kind !== 'vector' || !live()) return;
    // 初次取数还在路上时，贴合视野触发的 moveend 会跟着要一次——那不是用户在动，
    // 只是初画的一部分：不并发、不亮胶囊，等这次回来按需补
    if (vecInFlight) {
      if (fromMove) vecPending = true;
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    /* 视野还没定下来时（容器刚变小、地图还没重新量过）getBounds 会给出反转的
       或非有限的框。这种框发给服务端只会换回一句"转不到经纬度"，连要素都不给；
       宁可这一趟不带框、按全量取，回来再按需补 */
    const boxOk = bbox.every((v) => isFinite(v)) && bbox[0] < bbox[2] && bbox[1] < bbox[3];
    // 容差按图层规模分档：大图层照旧；两万要素以内给 1/3 容差（0.5 像素级，
    // 肉眼看不出损失）。完全不抽稀不行——实测 China2019（35 个要素但顶点极密）
    // 全精度一次视野要 22 秒，1/3 容差 3 秒
    const cur = targets && targets[activeTarget];
    const big = !(cur && cur.count != null) || cur.count > 20000;
    const tol = zoomTolerance(map.getZoom()) * (big ? 1 : 1 / 3);
    const url = '/api/vector?path=' + enc(data.target) +
      '&layer=' + (data.layerIndex || 0) +
      '&limit=' + drawLimit +
      // 别用 toExponential：0 会写成 "0.00e+0"，查询串里的 + 会被当成空格，服务端解析就炸了
      '&tolerance=' + String(tol) +
      (boxOk ? '&bbox=' + bbox.map((v) => v.toFixed(5)).join(',') : '');
    const mine = ++token;
    const wanted = data;
    const busy = document.getElementById('vecBusy');
    if (busy) busy.hidden = !fromMove;   // 初次绘制有遮罩，别再叠一个胶囊
    vecInFlight = true;
    const settle = () => {
      vecInFlight = false;
      if (busy) busy.hidden = true;
      // 取数期间视野又变了：补一次（走防抖，还是只发一个请求）
      if (vecPending && data && data.kind === 'vector') { vecPending = false; scheduleVector(); }
    };
    fetch(url).then((r) => r.json()).then((res) => {
      settle();
      if (mine !== token || data !== wanted) return;
      if (!res.ok) {
        toast('要素读取失败', (res.error || {}).title || '');
        // 取数失败也算这一轮画完：等定位的提示得有个着落，不能一直挂着
        if (pendingFocus) flushFocus();
        emit('gis:drawn', { kind: 'vector' });
        return;
      }
      const m = res.gisviewer || {};
      // 无坐标系图层：底图和注记跟它摆不到一起（见 setBaseHidden 的说明）
      setBaseHidden(!!m.assumed_local);
      // 补一个稳定的 id：点选时要在填充层和描边层之间去重，认的就是它
      const feats = (res.features || []).map((f, i) =>
        (f.id === undefined ? Object.assign({ id: 'f' + i }, f) : f));
      lastVec = {
        features: feats,
        layerName: m.layer_name || data.layerName || data.label || '',
        total: m.layer_total, inBbox: m.in_bbox, truncated: !!m.truncated,
        assumedLocal: !!m.assumed_local,
      };
      const parts = [];
      if (m.simplified) parts.push('几何已抽稀，误差不超过 2 个屏幕像素，量算仍按原始几何');
      if (m.layer_name) parts.push('图层 ' + m.layer_name);
      if (m.field_count != null) parts.push(m.field_count + ' 个字段');
      if (m.layer_total != null) parts.push('共 ' + m.layer_total + ' 个要素');
      if (m.in_bbox != null) parts.push('视野内 ' + m.in_bbox + ' 个');
      parts.push('已绘制 ' + feats.length + ' 个');
      if (res.cached) parts.push('缓存命中');
      /* 没有空间索引的大文件，引擎会在后台给这个文件建一份本地索引。
         建好之前拖动还是慢的，这里得说一句，不然用户只看到"越拖越慢" */
      if (m.indexing) parts.push('正在建索引，建好后拖动更快');
      /* 状态栏只留事实：没有坐标系这件事在这里写一句短的，
         为什么要这样摆、底图去哪了，交给全局浮层说一次 */
      if (m.assumed_local) {
        parts.push('坐标按米临时摆放');
        if (!localNoteShown) {
          localNoteShown = true;
          toast('这个图层没有坐标系',
            '按原始坐标当作米临时摆放，只用于看清图形；底图与注记已暂时收起。');
        }
      } else if (m.reprojected) parts.push('显示坐标已转到经纬度');
      note(baseNote() + parts.join(' · '));
      // 超上限只在全局浮层里说一次：什么原因、画了多少、下一步怎么办。
      // 移动、缩放会连着触发，6 秒内不重复弹，免得一路拖动一路弹窗
      if (m.truncated) {
        const now = Date.now();
        if (now - lastLimitToast > 6000) {
          lastLimitToast = now;
          toast('视野内超过单次上限', '已绘制 ' + feats.length + ' 个，移动、缩放后继续加载。', 'info');
        }
      }
      const src = map.getSource('gis-data');
      if (src) src.setData({ type: 'FeatureCollection', features: feats });
      // 没有经纬度范围可框（无坐标系的本地坐标文件）：用第一屏要素自己的
      // 范围把视图对上去，每个图层只对一次，之后随便平移缩放都不再抢镜头
      const fkey = (data.target || '') + '|' + (data.layerIndex || 0);
      if (!data.wgs && !vecLocalFit[fkey] && feats.length) {
        vecLocalFit[fkey] = 1;
        const b = featsBBox(feats);
        if (b) fitTo(b, data.reserveAttr);
      }
      emit('gis:vector', lastVec);
      // 属性表双击定位的要素如果刚才还没画出来，这一批里有了就补上高亮
      if (pendingFocus) flushFocus();
      emit('gis:drawn', { kind: 'vector' });
    }).catch((err) => {
      settle();
      if (mine === token) toast('要素读取失败', err.message);
      if (pendingFocus) flushFocus();
      emit('gis:drawn', { kind: 'vector' });
    });
  }

  function scheduleVector() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => loadVector(true), 260);
  }

  function rasterUrl(t) {
    const base = '/api/thumbnail?path=' + enc(t.target);
    if (t.edges && t.colors && t.edges.length > 2) {
      // 颜色里的 # 不转义会被当成 URL 片段，服务端收到的就是空列表
      return base + '&band=' + (t.band || 1) +
        '&edges=' + enc(t.edges.map((v) => Number(v).toFixed(6)).join(',')) +
        '&colors=' + enc(t.colors.join(',')) +
        '&fill=' + enc(t.fill || 'transparent');
    }
    return base + '&bands=' + (t.bands || 1);
  }

  function drawRaster(t, keepView) {
    removeImage();
    setExtentRing(null);
    // 栅格能定位就说明坐标是真实的，底图恢复显示
    setBaseHidden(false);
    if (!t.wgs && !t.corners) {
      toast('这个栅格没有坐标系', '无法定位到地图上，右侧信息栏仍可查看它的数值与分布。');
      emit('gis:drawn', { kind: 'skip' });
      return;
    }
    setImage(rasterUrl(t), t.corners && t.corners.length === 4 ? t.corners : cornersOf(t));
    setExtentRing(t.ring || null);
    emit('gis:drawn', { kind: 'raster' });
    if (!keepView) fitTo(t.wgs || boxFromRing(t.ring));
    const box = t.band ? '第 ' + t.band + ' 波段' : '前 ' + (t.bands || 1) + ' 个波段合成';
    /* 状态栏只写事实：波段、分级数、拉伸区间。为什么这样画属于"提示"，
       不该长期挂在底栏上占一行 */
    note(box + (t.edges && t.edges.length > 2
      ? ' · 分 ' + (t.edges.length - 1) + ' 级设色' + (t.scheme ? '（' + t.scheme + '）' : '')
      : ' · 2%~98% 拉伸'));
  }

  function drawVector(t, keepView) {
    /* 没有坐标系的图层（多为 CAD 图纸）也能看效果：引擎把原始坐标当作米
       临时摆到地图上，这里正常取数绘制；有经纬度范围就先框到范围
       （keepView：换底图后的补画不动视野，用户看哪儿就还在哪儿） */
    if (t.wgs && !keepView) fitTo(t.wgs, data.reserveAttr);
    // 有经纬度范围说明坐标系是真的，底图立刻恢复，不用等取数回来
    if (t.wgs) setBaseHidden(false);
    loadVector();
  }

  function clearTileLayers() {
    const st = map.getStyle() || {};
    (st.layers || []).forEach((l) => {
      if (l.id.indexOf('tile-') === 0) map.removeLayer(l.id);
    });
    if (map.getSource('tiles')) map.removeSource('tiles');
  }

  function drawTileset(t, keepView) {
    clearTileLayers();
    // 切片自带覆盖范围，同样是真实坐标，底图恢复显示
    setBaseHidden(false);
    if (!t.wgs) {
      toast('瓦片编号算不出覆盖范围', '只能查看信息，无法在地图上定位。');
      emit('gis:drawn', { kind: 'skip' });
      return;
    }
    const vector = t.tileType === 'vector';
    map.addSource('tiles', {
      type: vector ? 'vector' : 'raster',
      tiles: [t.target],
      minzoom: t.zoomMin,
      maxzoom: t.zoomMax,
      bounds: t.wgs,
      // 矢量切片的 tileSize 只能是 512，写 256 会被 MapLibre 直接拒掉
      tileSize: vector ? 512 : 256,
    });
    if (vector) {
      (t.layers || []).forEach((L, i) => {
        const color = TILE_PALETTE[i % TILE_PALETTE.length];
        const base = { id: 'tile-' + i, source: 'tiles', 'source-layer': L.name };
        map.addLayer(Object.assign({}, base, {
          id: 'tile-fill-' + i, type: 'fill',
          paint: { 'fill-color': color, 'fill-opacity': 0.22 },
        }));
        map.addLayer(Object.assign({}, base, {
          id: 'tile-line-' + i, type: 'line',
          paint: { 'line-color': color, 'line-width': 1.1, 'line-opacity': 0.85 },
        }));
        map.addLayer(Object.assign({}, base, {
          id: 'tile-circle-' + i, type: 'circle',
          paint: { 'circle-color': color, 'circle-radius': 3, 'circle-opacity': 0.9 },
        }));
      });
    } else {
      map.addLayer({ id: 'tile-raster', type: 'raster', source: 'tiles' });
    }
    if (!keepView) fitTo(t.wgs);
    const names = (t.layers || []).map((L) => L.name).join('、');
    note(`本地切片：${t.zoomMin}~${t.zoomMax} 级 · ${t.count} 张` +
      (vector && names ? ` · 图层 ${names}` : '') + ' · 按视野只取需要的瓦片');
  }

  function draw(t, keepView) {
    if (!live()) {
      pending = t;
      setTimeout(() => {
        if (pending === t && !live()) {
          toast('地图还没准备好', '样式还在加载，稍等会自动出现；信息栏不受影响。');
        }
      }, 2500);
      return;
    }
    // 正常打开/切换数据不算"换样式后的补画"，把补画记账清掉
    if (!keepView) needRedraw = false;
    guard('绘制', () => drawTarget(t, keepView));
  }

  function drawTarget(t, keepView) {
    ensureSources();
    addLayers();
    data = t;
    lastVec = null;
    // 换了图层：上一条"等绘制完再高亮"的待办已经不属于眼前这个文件了
    pendingFocus = null;
    if (popup) popup.remove();
    const btn = document.getElementById('attrBtn');
    if (btn) btn.hidden = t.kind !== 'vector';
    if (t.kind === 'tileset') {
      drawTileset(t, keepView);
      return;
    }
    clearTileLayers();
    const src = map.getSource('gis-data');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
    if (t.kind === 'raster') {
      if (t.lazy) {
        fetch('/api/inspect?path=' + enc(t.target)).then((r) => r.json()).then((res) => {
          if (!res.ok || data !== t) return;
          t.wgs = res.extent_wgs84;
          t.corners = res.corners_wgs84;
          t.ring = res.extent_ring_wgs84;
          t.band_count = res.band_count;
          t.bands = Math.min(3, res.band_count || 1);
          drawRaster(t, keepView);
        }).catch(() => toast('变量信息读取失败', '这个多变量文件的缩略图与范围没能补上。'));
        return;
      }
      drawRaster(t, keepView);
      return;
    }
    drawVector(t, keepView);
  }

  function collect(d) {
    const file = d.file || {};
    const path = d.read_path || file.path;
    if (d.kind === 'raster') {
      if (d.multi_variable) {
        return (d.variables || []).slice(0, 8).map((v) => ({
          kind: 'raster', label: v.label || '变量', target: v.path, lazy: true,
        }));
      }
      const s = d.style || {};
      return [{
        kind: 'raster', label: file.name || '栅格', target: path,
        bands: s.band ? 1 : Math.min(3, d.band_count || 1), band: s.band || null,
        edges: s.edges || null, colors: s.colors || null, scheme: s.scheme || null,
        fill: s.fill || 'transparent',
        wgs: d.extent_wgs84, corners: d.corners_wgs84, ring: d.extent_ring_wgs84,
        warning: d.warning,
      }];
    }
    if (d.kind === 'tileset') {
      return [{
        kind: 'tileset', label: (d.file || {}).name || '切片', target: d.tile_url,
        tileType: d.tile_type, wgs: d.extent_wgs84, zoomMin: d.zoom_min,
        zoomMax: d.zoom_max, count: d.tile_count, layers: d.layers || [],
      }];
    }
    if (d.kind === 'vector') {
      return (d.layers || [])
        .map((L, i) => ({ L: L, index: i }))
        .filter((p) => p.L.has_geometry !== false)
        .map((p) => ({
          kind: 'vector', label: p.L.name || ('图层 ' + (p.index + 1)),
          layerName: p.L.name || ('图层 ' + (p.index + 1)),
          layerIndex: p.index,
          target: path, count: p.L.feature_count, wgs: p.L.extent_wgs84, warning: p.L.warning,
          reserveAttr: !!d.reserveAttr,
        }));
    }
    if (d.kind === 'archive') {
      const out = [];
      (d.layers || []).forEach((payload) => {
        const name = String(payload.member || '').split('/').pop();
        if (payload.kind === 'vector') {
          (payload.layers || []).forEach((L, i) => out.push({
            kind: 'vector', label: name + ' · ' + (L.name || '图层 ' + (i + 1)),
            layerName: L.name || ('图层 ' + (i + 1)),
            layerIndex: i, target: payload.read_path, count: L.feature_count,
            wgs: L.extent_wgs84, warning: L.warning, reserveAttr: !!d.reserveAttr,
          }));
        } else if (payload.kind === 'raster') {
          out.push({ kind: 'raster', label: name, target: payload.read_path,
            bands: Math.min(3, payload.band_count || 1), wgs: payload.extent_wgs84,
            corners: payload.corners_wgs84, ring: payload.extent_ring_wgs84 });
        }
      });
      return out;
    }
    return [];
  }

  function labelOf(t) {
    const name = t.label || '数据';
    return t.count == null ? name : name + '（' + t.count + '）';
  }

  /* 这份文件里能画到地图上的每一项。界面标题上的图层列表和画哪一层都以它为准 */
  let targets = [];
  let activeTarget = 0;

  function targetKey(t) {
    return (t.target || '') + '\u0000' + (t.kind === 'vector' ? (t.layerIndex || 0) : 'r');
  }

  function emitLayers() {
    emit('gis:layers', {
      active: activeTarget,
      items: targets.map((t, i) => ({
        label: t.label || ('图层 ' + (i + 1)),
        full: labelOf(t),
        kind: t.kind,
        key: targetKey(t),
        index: i,
      })),
    });
  }

  /* 换图层：重画地图、清掉上一个图层的弹窗；界面里的信息栏和属性表跟着切换 */
  function selectLayer(i) {
    const n = Number(i);
    if (!targets.length || !isFinite(n)) return false;
    const at = Math.max(0, Math.min(targets.length - 1, Math.round(n)));
    activeTarget = at;
    emitLayers();
    draw(targets[at]);
    return true;
  }

  function show(d) {
    guard('载入', () => {
      if (!ensureMap()) return;
      map.resize();
      const list = collect(d);
      targets = list;
      activeTarget = 0;
      if (!list.length) {
        clear();
        if (d.kind === 'json') toast('这份 JSON 里没有可定位的地理要素', '信息栏里仍可查看它的结构与字段。');
        else if (d.kind === 'archive') toast('压缩包里没有找到可绘制的数据', '信息栏里列出了包内文件的构成。');
        else toast('这类数据没有可在地图上显示的空间信息', '信息栏里仍可查看它的元数据。');
        emit('gis:drawn', { kind: 'skip' });
        emitLayers();
        return;
      }
      emitLayers();
      draw(list[0]);
    });
  }

  function clear() {
    if (!live()) return;
    // 作废在途请求：不然它回来会把说明文字又写回去，图层都关了底下还留着上一句
    token++;
    idToken++;
    vecInFlight = false;
    vecPending = false;
    data = null;
    pending = null;
    lastVec = null;
    targets = [];
    activeTarget = 0;
    localNoteShown = false;
    emitLayers();
    const src = map.getSource('gis-data');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
    setExtentRing(null);
    removeImage();
    clearTileLayers();
    if (popup) { popup.remove(); popup = null; }
    if (pin) { pin.remove(); pin = null; }
    setHighlight(null);
    emit('gis:drawn', { kind: 'none' });
    // elapsed 不动：renderResult 先写"读取 X 毫秒"再调 clear，抹掉会让这半截前缀消失
    note('');
  }

  /* 换底图、开关注记都要整份重建地图样式：数据源和图上内容会跟着一起没。
     这里记账，等新样式就绪后在 wire 里按原视野把数据补回来——
     不补的话用户看到的就是"一开关注记，图层没了" */
  let needRedraw = false;

  function refresh(next) {
    if (next) config = Object.assign(config, next);
    if (!map) return;
    const apply = () => {
      map.setStyle(style());
      needRedraw = true;
      // 样式如果已经就绪，wire 立即能补；没就绪就等 styledata 事件把它带回来
      if (map.isStyleLoaded()) wire();
    };
    // 上一个样式还没加载完就 setStyle，MapLibre 会放弃样式比对重建整张图
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }

  function themeChanged() {
    applyPaint();
  }

  function wire() {
    guard('初始化', () => {
      if (!live()) return;
      ensureSources();
      addLayers();
      applyPaint();
      // 样式刚重建完，底图暂时是显示状态：如果当前是无坐标系图层，立刻重新收起
      setBaseHidden(baseHidden);
      if (pending) {
        const t = pending;
        pending = null;
        needRedraw = false;
        draw(t);
      } else if (needRedraw && data) {
        /* 换底图/开关注记之后：把当前这份数据按原视野放回来（keepView），
           向量、切片重新取数，栅格重新贴图，视野一动不动 */
        needRedraw = false;
        draw(data, true);
      }
    });
  }

  function ensureMap() {
    if (map) return true;
    if (typeof maplibregl === 'undefined') {
      toast('地图组件加载失败', '请确认 web/vendor 里有 maplibre-gl.js');
      return false;
    }
    map = new maplibregl.Map({
      container: 'map',
      style: style(),
      center: [104, 35],
      zoom: 3.2,
      maxZoom: 20,
      // MapLibre 自己也会监听窗口 resize，而且不合并：拖一下窗口就是几十次整幅重绘
      // 加一轮瓦片请求，这才是闪烁的主因。只留下面这一个受控入口
      trackResize: false,
      // 两帧之间不把画布清掉，尺寸变化那一下才不会露出底色
      preserveDrawingBuffer: true,
      // 底图版权行不要了：位置组件挪到最右边，署名不再占一块地方
      attributionControl: false,
      // 滚轮自己接管：库的默认做法是每一格滚轮都重新起一段缓动，
      // 快节奏连滚时动画互相打断，看着就是一顿一顿的
      scrollZoom: false,
    });
    // showCompass 打开的就是"指北"：针随地图转，点一下回正北
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    // 比例尺不用 MapLibre 那条，它和图例都要占左下角，改由界面自己画
    // 值分布、属性表、复位三个按钮并进缩放那一组，右上角只留一块控件
    const group = map.getContainer().querySelector('.maplibregl-ctrl-top-right .maplibregl-ctrl-group');
    if (group) {
      /* 顺序有讲究：缩放、指北、复位这三个是固定控件，永远在；直方图和属性表跟着图层走，
         放在最下面。这样切换图层时上面的控件不会跟着上下跳 */
      ['homeBtn', 'histBtn', 'attrBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.className = 'maplibregl-ctrl-icon';
        group.appendChild(btn);
      });
    }
    /* 控件提示一律走项目自己的气泡（data-tip → showTipBox）：
       库自带的 title 是英文，而且原生提示会跟我们的气泡同时冒出来，两个叠着更乱。
       去掉 title，中文挂到 data-tip，读屏用的 aria-label 照旧补上 */
    const tipOf = (el, text) => {
      if (!el) return;
      el.removeAttribute('title');
      el.setAttribute('data-tip', text);
      el.setAttribute('aria-label', text);
    };
    tipOf(group && group.querySelector('.maplibregl-ctrl-zoom-in'), '放大：拉近一档');
    tipOf(group && group.querySelector('.maplibregl-ctrl-zoom-out'), '缩小：拉远一档');
    tipOf(document.getElementById('homeBtn'), '复位：回到初始视野');
    tipOf(document.getElementById('histBtn'), '波段值分布');
    tipOf(document.getElementById('attrBtn'), '属性表');
    // 复位：回到"当前打开图层"的范围，不是全国视野。
    // 有真实范围用范围；本地坐标的 CAD 用已绘制要素的范围。
    // 用 flyTo 而不是 jumpTo——一秒钟的移动能让人看清"从哪飞到哪"
    const home = document.getElementById('homeBtn');
    if (home) home.addEventListener('click', () => {
      if (!live()) return;
      const t = targets && targets[activeTarget];
      const box = t && (t.wgs || (t.ring && t.ring.length >= 4 ? boxFromRing(t.ring) : null));
      const reserve = data && data.reserveAttr;
      if (box) { fitTo(box, reserve); return; }
      const b = lastVec && lastVec.features.length ? featsBBox(lastVec.features) : null;
      if (b) fitTo(b, reserve);
    });
    // 指北针：库自己只把方位角转回正北，俯仰角留着不动。这里连俯仰一起压平，
    // 不然刚拖成斜视的地图"回正"之后还是歪的
    const compass = map.getContainer().querySelector('.maplibregl-ctrl-compass');
    if (compass) {
      /* 经典红白针：北半红、南半白描灰边，中心一枚红点。
         viewBox 只框住针形：同样的格子里墨迹铺得更满，看着才够大。
         角度胶囊不能放组内——组有 overflow:hidden（裁按钮圆角用），
         组外的胶囊会被整个裁掉，所以挂到组的外层容器。 */
      compass.innerHTML =
        '<svg class="compass-needle" viewBox="6.2 0.4 7.6 19.2" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
        '<path d="M10 1.4 L12.9 10 L7.1 10 Z" fill="#e05252"/>' +
        '<path d="M7.1 10 L12.9 10 L10 18.6 Z" fill="#ffffff" stroke="#8f979f" stroke-width="1.1"/>' +
        '<circle cx="10" cy="10" r="1.8" fill="#e05252" stroke="#ffffff" stroke-width="0.9"/>' +
        '</svg>';
      const needle = compass.querySelector('.compass-needle');
      const badge = document.createElement('div');
      badge.className = 'map-bearing';
      badge.id = 'mapBearing';
      /* 两个数值各带一枚小图标：斜面＝俯仰角，环形箭头＝旋转角，
         光有两个数字谁也分不清哪个是哪个。顺序按"先俯仰后旋转"走 */
      badge.innerHTML =
        '<span class="mb-item"><svg class="mb-ico" viewBox="0 0 14 14" aria-hidden="true">' +
        '<path d="M1.9 11.4h10.2"/><path d="M1.9 11.4 10.4 3.2"/></svg>' +
        '<b class="mb-p">0°</b></span>' +
        '<span class="mb-item"><svg class="mb-ico" viewBox="0 0 14 14" aria-hidden="true">' +
        '<path d="M11.8 7.6a5 5 0 1 1-1.6-4.2"/><path d="M9.1 1.3l1.4 2.3-2.4 1"/></svg>' +
        '<b class="mb-b">0°</b></span>';
      const outPitch = badge.querySelector('.mb-p');
      const outBearing = badge.querySelector('.mb-b');
      const group = compass.closest('.maplibregl-ctrl-group');
      if (group && group.parentElement) group.parentElement.appendChild(badge);
      tipOf(compass, '指北：回到正北并压平俯仰角');
      compass.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (live()) map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
      }, true);   // 捕获阶段拦下，别让库自己再转一次
      /* 徽标竖直方向对齐针那一格的中心。徽标平时是 visibility:hidden，
         几何仍然在，offsetHeight 量得到——早先换成 display:none 时量到 0，
         算出来的位置整整偏了半个徽标高，就是看着不居中的来由 */
      const alignBadge = () => {
        const cr = compass.getBoundingClientRect();
        const pr = group.parentElement.getBoundingClientRect();
        badge.style.top = Math.round(cr.top - pr.top + (cr.height - badge.offsetHeight) / 2) + 'px';
      };
      const alignSoon = () => {
        if (window.requestAnimationFrame) requestAnimationFrame(alignBadge);
        else alignBadge();
      };
      alignSoon();
      window.addEventListener('resize', alignSoon);
      /* 针随地图转（地图顺时针转 b 度，针就逆时针转回 b 度）。
         徽标平时不显眼：贴正北就藏起来，转出角度才浮现——常亮反而像坏了个格子。
         俯仰角不显示：这个软件看图是俯视为主，3D 斜视是顺带能力，一格里塞两个
         数值既挤又要解释哪对哪；指北按钮按下会把俯仰一起压平。 */
      const paintBearing = () => {
        if (!live()) return;
        let b = map.getBearing() % 360;
        if (b < 0) b += 360;
        const near = Math.min(b, 360 - b) < 0.5;
        const pitch = Math.abs(map.getPitch()) < 0.5 ? 0 : Math.round(map.getPitch());
        if (needle) {
          needle.style.transformOrigin = '50% 50%';
          needle.style.transform = near ? '' : 'rotate(' + (-b) + 'deg)';
        }
        /* 正北且没有俯仰，就是"正着看"：徽标不必占地方，转出角度才浮现 */
        if (near && !pitch) { badge.classList.remove('on'); return; }
        outBearing.textContent = Math.round(b) + '°';
        outPitch.textContent = pitch + '°';
        const was = badge.classList.contains('on');
        badge.classList.add('on');
        if (!was) alignSoon();   // 刚浮现时位置还没定过，补一次对齐
      };
      map.on('rotate', paintBearing);
      map.on('move', paintBearing);
      paintBearing();
    }
    /* 容器尺寸在栅格里会被右栏挤动，MapLibre 只监听窗口，不监听容器，得自己补。
       拖动窗口一次会连着触发几十次布局，每次都重建画布就是用户看到的闪烁——
       攒成每帧最多一次，尺寸没真变就不动手。

       窗口最小化时客户区只剩一条边框（容器缩到 133×2），这时千万别碰地图：
       map.resize() 会把视口压成一条细缝，相机跟着动一下，MapLibre 重新排瓦片；
       还原时又来一轮重排，重取一遍要素。屏幕上就是闪一下，数据也白取一遍。
       所以尺寸小到不像给人看的样子就整个跳过，等窗口回来再补一次。 */
    if (window.ResizeObserver) {
      const box = document.getElementById('map');
      const TINY = 8;          // 最小化时容器只剩两像素
      let lastW = 0, lastH = 0, settle = 0;
      const apply = () => {
        settle = 0;
        box.classList.remove('resizing');
        if (!live()) return;
        const r = box.getBoundingClientRect();
        if (r.width < TINY || r.height < TINY) return;   // 还是最小着，别动
        lastW = r.width; lastH = r.height;
        resizeCam = cameraKey();
        map.resize();
      };
      // 拖动过程中一次都不 resize，只让画布跟着容器拉伸（.resizing 那条样式），
      // 等尺寸稳住 140 毫秒再补一次真重绘
      new ResizeObserver(() => {
        const r = box.getBoundingClientRect();
        if (r.width < TINY || r.height < TINY) {
          /* 最小化：连 .resizing 都不能加——那条样式会把画布拉成 100%，
             窗口只剩一条缝时画布也跟着塌成一团，还原后第一眼就是花的 */
          if (settle) { clearTimeout(settle); settle = 0; }
          box.classList.remove('resizing');
          lastW = r.width; lastH = r.height;
          return;
        }
        if (!settle && Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1) return;
        box.classList.add('resizing');
        if (settle) clearTimeout(settle);
        settle = setTimeout(apply, 140);
      }).observe(box);
    }
    map.on('styledata', wire);
    map.on('load', wire);
    map.on('error', (e) => {
      const err = e && e.error;
      if (!err) return;
      if (e.sourceId !== undefined && e.tile !== undefined) return;
      fail('初始化', err);
    });
    map.on('moveend', () => {
      /* 画布只是变大了（窗口还原），相机没动：视野里的要素还是那批，
         再取一遍只是多一次往返，画面还要再重绘一次，看着就是闪。
         相机动过（用户拖了、滚了）就照旧按新视野取。 */
      if (data && data.kind === 'vector') {
        if (resizeCam && cameraKey() === resizeCam) resizeCam = '';
        else { resizeCam = ''; scheduleVector(); }
      }
      emitView();
    });
    map.on('move', scheduleView);
    // 用 DOM 的 mousemove 换算，地图自己的 mousemove 在拖拽过程中会被吞掉
    const canvasBox = map.getCanvasContainer();
    canvasBox.addEventListener('mousemove', (ev) => {
      const r = canvasBox.getBoundingClientRect();
      const ll = map.unproject(new maplibregl.Point(ev.clientX - r.left, ev.clientY - r.top));
      scheduleMouse(ll.lat, ll.lng);
    });
    canvasBox.addEventListener('mouseleave', () => emit('gis:mouse', null));
    wireGestures();
    wireWheelZoom();
    wire();
    emitView();
    return true;
  }

  /* 底栏那几个读数会随鼠标和缩放狂变，节流到 200ms 一跳，
     鼠标那一路留了尾巴一帧，所以停在哪儿显示的就是哪儿 */
  const TICK = 200;
  let viewTimer = null;
  function scheduleView() {
    if (viewTimer) return;
    viewTimer = setTimeout(() => { viewTimer = null; emitView(); }, TICK);
  }

  function emitView() {
    if (!map) return;
    const z = map.getZoom();
    const c = map.getCenter();
    const lat = c.lat * Math.PI / 180;
    emit('gis:view', {
      zoom: z,
      lat: c.lat,
      lng: c.lng,
      epsg: 3857,
      metersPerPixel: 156543.03392 * Math.cos(lat) / Math.pow(2, z),
    });
  }

  let mouseAt = 0;
  let mouseHold = null;
  let mouseTimer = null;
  function scheduleMouse(lat, lng) {
    const now = Date.now();
    if (now - mouseAt >= TICK) {
      mouseAt = now;
      emit('gis:mouse', { lat: lat, lng: lng });
      return;
    }
    mouseHold = { lat: lat, lng: lng };
    if (mouseTimer) return;
    mouseTimer = setTimeout(() => {
      mouseTimer = null;
      mouseAt = Date.now();
      emit('gis:mouse', mouseHold);
    }, TICK);
  }

  function el2(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number') {
      if (v !== v || v === Infinity || v === -Infinity) return '—';
      // 整型属性常是代码值，加千分位反而读错，原样给数字
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
    }
    return String(v);
  }

  /* ---------- 要素量算：由引擎回读原始几何算，前端只负责显示 ----------
   地图上画的几何是为显示抽稀过的，直接量会偏小（实测少了六个百分点），
   所以面积、周长和"聚焦"用的范围都问服务端要。 */

  /* 要素在服务端数组里的编号（OGR FID）；没有或用不上的返回 null */
  function fidOf(f) {
    if (!f || f.id === undefined || f.id === null) return null;
    if (typeof f.id === 'string' && f.id.charAt(0) === 'f') return null;
    const n = Number(f.id);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  /* 点要素没有长度和面积，按钮直接不亮 */
  function canMeasure(g) {
    const t = g && g.type ? String(g.type) : '';
    return t.indexOf('Point') < 0;
  }

  function measureRemote(target, layer, fid) {
    const url = '/api/measure?path=' + enc(target) + '&layer=' + (layer || 0) + '&fid=' + fid;
    return fetch(url).then((r) => r.json());
  }

  /* 聚焦用眼前这份几何的范围就够了：抽稀误差不到两个像素，框过去看不出差别。
     以前聚焦也去问服务端要原始范围，大 GeoJSON 每问一次都要重新解析整份文件，
     按钮按下去要等七八秒——现在这一下是瞬时的。量算仍然用原始几何，见下面 ask() */

  function geomBBox(geom) {
    if (!geom || !geom.coordinates) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (c) => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
        return;
      }
      for (let i = 0; i < c.length; i++) walk(c[i]);
    };
    walk(geom.coordinates);
    return isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)
      ? [minX, minY, maxX, maxY] : null;
  }

  /* 属性表开着时画面下半截被它盖住：定位要素要把它让出来，
     否则要素正好落在面板背后，看着像"没定位过去" */
  function attrPad() {
    const p = document.getElementById('attrPanel');
    if (!p || p.hidden) return 0;
    const h = p.getBoundingClientRect().height;
    return h > 0 ? h + 12 : 0;
  }

  function fitBBox(b) {
    if (!b || b.length < 4) return;
    const pad = { top: 80, bottom: 80 + attrPad(), left: 80, right: 80 };
    if (b[2] - b[0] < 1e-7 && b[3] - b[1] < 1e-7) {
      map.easeTo({ center: [b[0], b[1]], zoom: Math.max(map.getZoom(), 16), padding: pad, duration: 450 });
      return;
    }
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad, maxZoom: 17, duration: 450 });
  }

  /* ---------- 属性表双击定位 ----------
     两件事：把视图框到这个要素的范围上，再把它描一圈。
     范围由属性表随行带过来（服务端读那几行时几何已经解析过，取包络是顺手的事），
     所以定位不在服务端再扫一遍文件，按下就是瞬时的。
     要素还没画出来时（绘制没完、或超出单次绘制上限）先画一个范围框顶着，
     把要素编号记在这里；下一次绘制完成自动补成要素高亮，用户不必再双击一次 */
  let pendingFocus = null;

  function boxRing(b) {
    const w = b[0], s = b[1], e = b[2], n = b[3];
    // 用线不用面：面会连高亮底色一起铺满整个范围，看着像选中了一大片
    return { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] };
  }

  /* 试着把待高亮的要素描上；描上了就清掉待办，并告诉界面"好了"。
     这一轮画完还是没有它（超出单次绘制上限、或几何为空），也说一声"没画出来"，
     让界面把"正在等"换成结果——但待办留着，往后平移放大再画时还能补上 */
  function flushFocus() {
    if (!pendingFocus) return false;
    const fid = pendingFocus.fid;
    const f = fid === null ? null : ((lastVec && lastVec.features) || []).find((x) => fidOf(x) === fid);
    if (f) {
      setHighlight([f]);
      pendingFocus = null;
      emit('gis:focus', { fid: fid, ok: true });
      return true;
    }
    // 带上 fid：范围框也是这个要素的高亮，属性表那一行不能跟着灭
    setHighlight([{ id: fid, geometry: boxRing(pendingFocus.box) }]);
    if (fid === null) { pendingFocus = null; return false; }
    /* 视图可能还没走到目标位置（定位是带动画的）：这一轮画的是旧视野，
       不能拿它下结论，等视图到位那一轮再说 */
    try {
      const b = map.getBounds();
      if (!b.contains([(pendingFocus.box[0] + pendingFocus.box[2]) / 2,
                       (pendingFocus.box[1] + pendingFocus.box[3]) / 2])) return false;
    } catch (err) { /* 拿不到视野就照常往下走 */ }
    // 只在这一轮画完时说一次；之后每次平移缩放都再报一遍就成了骚扰
    if (!pendingFocus.told) {
      pendingFocus.told = true;
      emit('gis:focus', { fid: fid, ok: false });
    }
    return false;
  }

  /* 坐标定位用的十字标记：一个不带气泡的标记点，再定位或关掉图层就撤 */
  let pin = null;

  function dropPin(lngLat) {
    if (!map) return;
    if (pin) { pin.remove(); pin = null; }
    if (!lngLat) return;
    const node = document.createElement('div');
    node.className = 'map-pin';
    node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M12 3.4v6.2M12 14.4v6.2M3.4 12h6.2M14.4 12h6.2"/><circle cx="12" cy="12" r="2.6"/></svg>';
    pin = new maplibregl.Marker({ element: node, anchor: 'center' })
      .setLngLat(lngLat).addTo(map);
  }

  function fmtNum4(n) {
    if (!isFinite(n)) return '—';
    return String(Number(n.toPrecision(4)));
  }
  function fmtLength(m) {
    if (m === null || m === undefined) return '—';
    return m >= 1000 ? fmtNum4(m / 1000) + ' km' : fmtNum4(m) + ' m';
  }
  function fmtArea(a) {
    if (a === null || a === undefined) return '—';
    if (a >= 1e6) return fmtNum4(a / 1e6) + ' km²';
    if (a >= 1e4) return fmtNum4(a / 1e4) + ' 公顷';
    return fmtNum4(a) + ' m²';
  }

  /* 弹窗脚上的图标：上下切换用历书里那枚单色 chev，聚焦/量算是常规描边小图标 */
  const ICON_CHEV = '<svg viewBox="310 213 330 593" aria-hidden="true"><path fill="currentColor" d="M318.8 493.6l280.5-280.5c10.8-10.8 28.4-10.8 39.2 0 10.8 10.8 10.8 28.4 0 39.2L377.3 513.4l261.1 261.1c10.8 10.8 10.8 28.4 0 39.2-10.8 10.8-28.4 10.8-39.2 0L318.8 533.2c-5.4-5.4-8.1-12.6-8.1-19.8-0.1-7.1 2.6-14.3 8.1-19.8z"/></svg>';
  const ICON_FOCUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.6"/><path d="M12 2.8v3.4M12 17.8v3.4M2.8 12h3.4M17.8 12h3.4"/></svg>';
  /* 量算按钮用用户挑的"测量"图标：带刻度的尺身+顶部横杆，原图是深灰+青色双色，
     这里改成 currentColor 两档透明度——深浅主题、悬停、禁用态都能自动跟着变色 */
  const ICON_MEASURE = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path fill="currentColor" d="M938.666667 480a32 32 0 0 1 32 32v341.333333a32 32 0 0 1-32 32H85.333333A32 32 0 0 1 53.333333 853.333333V512A32 32 0 0 1 85.333333 480z m-724.8 64H117.333333v277.333333h789.333334v-277.333333h-116.8v78.933333a32 32 0 0 1-63.850667 3.072l-0.149333-3.072v-78.933333h-106.666667v146.133333a32 32 0 0 1-63.850667 3.072l-0.149333-3.072V544h-106.666667v78.933333a32 32 0 0 1-63.850666 3.072l-0.149334-3.072v-78.933333h-106.666666v124.8a32 32 0 0 1-63.850667 3.072l-0.149333-3.072V544z"/><path fill="currentColor" opacity=".38" d="M938.666667 138.666667a32 32 0 0 1 31.850666 28.928L970.666667 170.666667v149.333333a32 32 0 0 1-63.850667 3.072L906.666667 320v-42.666667h-789.333334v42.666667a32 32 0 0 1-63.850666 3.072L53.333333 320V170.666667a32 32 0 0 1 63.850667-3.072L117.333333 170.666667v42.666666h789.333334V170.666667A32 32 0 0 1 938.666667 138.666667z"/></svg>';

  function popupNode(res) {
    const box = el2('div', 'idp');
    const g = res.identify || {};
    if (res.kind === 'raster') {
      const body = el2('div', 'idp-body');
      box.appendChild(head('图层：' + (data.label || '栅格')));
      body.appendChild(row('行列号',
        g.inside ? '行 ' + g.row + ' · 列 ' + g.col : '落在数据范围外'));
      (g.bands || []).forEach((b) => {
        body.appendChild(row(b.description || ('波段' + b.index),
          b.nodata ? 'NoData' : fmtValue(b.value)));
      });
      box.appendChild(body);
      return widen(box, body, body.childElementCount);
    }
    const feats = res.feats || [];
    const body = el2('div', 'idp-body');
    let idx = 0;
    let measureBox = null;
    let measureOn = false;   // 点过尺子就亮着：翻页时新要素也跟着自动算
    let paintToken = 0;
    const paint = (f) => {
      paintToken++;
      // 换要素时只清主体重填，不动外框，免得弹窗位置和箭头跟着跳
      body.textContent = '';
      const props = f.properties || {};
      Object.keys(props).forEach((k) => {
        /* 下划线开头的是引擎随绘制一起带回来的量算值，不算属性。
           OBJECTID 这类主键要留着：属性表里有这一列，点选后靠它对上那一行 */
        if (k.charAt(0) === '_') return;
        body.appendChild(row(k, fmtValue(props[k])));
      });
      body.scrollTop = 0;
    };
    paint(feats[0] || { properties: {} });
    box.appendChild(head('图层：' + (res.layerName || '要素')));
    box.appendChild(body);
    /* 绘制时引擎已经把原始几何的面积、周长算好放进属性里（_msr_ 开头），
       点开就直接用，不再等一次大文件的重新解析；万一没有这份数再回退问服务端 */
    const localMeasure = (f) => {
      const p = (f && f.properties) || {};
      const hasA = typeof p._msr_area === 'number';
      const hasL = typeof p._msr_len === 'number';
      if (!hasA && !hasL) return null;
      return { ok: true, area_m2: hasA ? p._msr_area : null, length_m: hasL ? p._msr_len : null };
    };
    const askCache = {};
    const ask = (f) => {
      const fid = fidOf(f);
      if (fid === null || !res.target) return null;
      const key = (res.layer || 0) + ':' + fid;
      if (!askCache[key]) askCache[key] = measureRemote(res.target, res.layer, fid);
      return askCache[key];
    };
    const dropMeasure = () => {
      if (measureBox && measureBox.parentNode) measureBox.remove();
      measureBox = null;
    };
    const showMeasure = (m, token) => {
      if (!m || !m.ok || token !== paintToken) return;
      /* 重复点"计算"只留最新一次的结果：旧的先摘掉再插新的。
         不摘的话每点一次就往上叠一层，翻页时还会留下不属于当前要素的旧结果 */
      dropMeasure();
      measureBox = el2('div', 'idp-measure');
      if (m.area_m2 !== null && m.area_m2 !== undefined) {
        measureBox.appendChild(row('面积', fmtArea(m.area_m2)));
        measureBox.appendChild(row('周长', fmtLength(m.length_m)));
      } else {
        measureBox.appendChild(row('长度', fmtLength(m.length_m)));
      }
      /* 钉在底部工具行上方：不在滚动区里，滚字段、翻页都不动它 */
      box.insertBefore(measureBox, footNode);
      measureOn = true;
    };
    /* 量算一个要素：绘制时引擎已把数带回来的直接显示，没有才问服务端 */
    const doMeasure = (f) => {
      const local = localMeasure(f);
      if (local) {
        showMeasure(local, paintToken);
        return Promise.resolve();   // 交给按钮：结果已显示，再点一下就是收起
      }
      const p = ask(f);
      if (!p) return null;
      const mine = paintToken;
      return p.then((m) => showMeasure(m, mine))
        .catch(() => { /* 量不到就不显示，不打扰 */ });
    };
    const footNode = foot(
      () => feats[idx],
      feats.length,
      (dir) => {
        idx += dir;
        paint(feats[idx]);
        /* 量算结果正显示着的时候翻页：旧的先摘掉（防止一瞬显示上一页的数），
           新要素跟着自动算一遍——本地有数就同步换，问服务端的等回来再插 */
        if (measureOn) {
          dropMeasure();
          doMeasure(feats[idx]);
        }
        return idx;
      },
      doMeasure,
      (f) => {   // 聚焦：直接框到画面上这份几何的范围，不再等引擎
        const b = geomBBox(f.geometry);
        if (b) fitBBox(b);
      },
      () => {   // 再点一次量算图标：把结果收起来
        dropMeasure();
        measureOn = false;
      });
    box.appendChild(footNode);
    // 宽窄按字段最多的那个要素一次定死，翻页时弹窗不会左右跳
    let most = 0;
    feats.forEach((f) => { most = Math.max(most, Object.keys(f.properties || {}).length); });
    return widen(box, body, most);
  }

  function head(text) {
    const node = el2('div', 'idp-title');
    node.appendChild(el2('span', 'idp-name', text));
    return node;
  }

  /* 底部工具行：左边聚焦、量算，右边翻页；上面一条分隔线和主体分开 */
  function foot(getFeat, total, step, onMeasure, onFocus, onMeasureToggle) {
    const node = el2('div', 'idp-foot');
    const mkBtn = (icon, title, cls) => {
      const b = el2('button', 'idp-tbtn' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      /* 翻页两颗只说"上一个/下一个"，箭头本身就写着这层意思，
         挂在弹窗里还会盖住字段，索性不给气泡；无障碍名仍然留着 */
      if (title) {
        b.setAttribute('data-tip', title);
        b.setAttribute('aria-label', title);
      }
      b.innerHTML = icon;
      return b;
    };
    const focus = mkBtn(ICON_FOCUS, '聚焦到该要素');
    focus.onclick = () => onFocus(getFeat() || {});
    const measure = mkBtn(ICON_MEASURE, '计算面积和周长');
    let busy = false;
    let hasResult = false;   // 量算结果正钉在弹窗里
    measure.onclick = () => {
      if (busy) return;
      /* 结果已经钉在弹窗里时再点一下就是收掉，不是重新算一遍 */
      if (hasResult) { onMeasureToggle(); hasResult = false; syncMeasure(); return; }
      const p = onMeasure(getFeat() || {});
      if (!p || typeof p.then !== 'function') return;
      hasResult = true;
      busy = true;
      syncMeasure();
      const done = () => { busy = false; syncMeasure(); };
      p.then(done, done);
    };
    node.appendChild(focus);
    node.appendChild(measure);
    /* 点要素没有面积周长，量算按钮跟着当前要素亮灭；等待引擎时按钮里转圈 */
    const syncMeasure = () => {
      const f = getFeat() || {};
      const ok = fidOf(f) !== null && canMeasure(f.geometry);
      measure.disabled = busy || !ok;
      measure.classList.toggle('busy', busy);
      const measureTip = busy ? '正在计算…'
        : (hasResult ? '收起量算结果'
          : (!ok
            ? (fidOf(f) === null ? '这个要素量不了' : '点要素没有长度和面积')
            : (String(f.geometry && f.geometry.type).indexOf('Polygon') >= 0
              ? '计算面积和周长' : '计算长度')));
      measure.setAttribute('data-tip', measureTip);
      measure.setAttribute('aria-label', measureTip);
    };
    if (total > 1) {
      let idx = 0;
      const pagerNode = el2('div', 'idp-pager');
      const label = el2('span', 'idp-page', '1/' + total);
      const prev = mkBtn(ICON_CHEV, '', 'idp-chev');
      const next = mkBtn(ICON_CHEV, '', 'idp-chev flip');
      prev.setAttribute('aria-label', '上一个');
      next.setAttribute('aria-label', '下一个');
      const sync = () => {
        label.textContent = (idx + 1) + '/' + total;
        prev.disabled = idx === 0;
        next.disabled = idx === total - 1;
        syncMeasure();
      };
      prev.onclick = () => { idx = step(-1); sync(); };
      next.onclick = () => { idx = step(1); sync(); };
      sync();
      pagerNode.appendChild(prev);
      pagerNode.appendChild(label);
      pagerNode.appendChild(next);
      node.appendChild(pagerNode);
    } else {
      syncMeasure();
    }
    return node;
  }

  /* 行数一多就换成两列并排，省得一条弹窗拖到半个屏幕高；
     宽度得写在外框上，主体被 .idp 自己的 max-width 卡着 */
  function widen(box, body, rows) {
    const wide = rows > 6;
    body.classList.toggle('two', wide);
    box.style.maxWidth = wide ? '440px' : '';
    return box;
  }

  function row(k, v) {
    const node = el2('div', 'idp-row');
    node.appendChild(el2('span', 'idp-k', k));
    node.appendChild(el2('b', 'idp-v', v));
    return node;
  }

  function showPopup(lngLat, node) {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '470px', offset: 12 })
      .setLngLat(lngLat)
      .setDOMContent(node)
      .addTo(map);
    /* 撤高亮挂在关按钮的点击上：库的 close 事件各版本发射时机不同，不靠它 */
    const node2 = popup.getElement();
    if (node2) node2.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.maplibregl-popup-close-button')) setHighlight(null);
    });
  }

  /* 只认地图上真正画出来的要素：点中的就是眼前这些，超大文件里没画出来的那些不参与。
     矢量这一路完全在本地判定，不再问服务端要一遍 */
  const PICK_LAYERS = ['gis-fill', 'gis-outline', 'gis-line', 'gis-circle'];

  function identifyAt(lngLat, point) {
    if (!data || !live()) return;
    if (data.kind === 'vector') {
      const hits = point ? map.queryRenderedFeatures(point, { layers: PICK_LAYERS }) : [];
      // 同一个面在填充和描边两层里各报一次，按要素 id 去重
      const seen = {};
      const feats = [];
      hits.forEach((h) => {
        const key = h.id === undefined ? h.layer.id + ':' + feats.length : String(h.id);
        if (seen[key]) return;
        seen[key] = true;
        // id 要留着：量算和聚焦要拿它回引擎读原始要素
        feats.push({ id: h.id, properties: h.properties || {}, geometry: h.geometry });
      });
      if (!feats.length) {   // 没点中就当没点，不留弹窗也不留高亮
        setHighlight(null);
        if (popup) { popup.remove(); popup = null; }
        return;
      }
      setHighlight(feats);
      showPopup(lngLat, popupNode({ kind: 'vector', feats: feats,
        layerName: data.layerName || data.label,
        target: data.target, layer: data.layerIndex || 0 }));
      return;
    }
    if (data.kind !== 'raster') return;
    const url = '/api/identify?path=' + enc(data.target) +
      '&lng=' + lngLat.lng.toFixed(6) + '&lat=' + lngLat.lat.toFixed(6) + '&kind=raster';
    const mine = ++idToken;
    fetch(url).then((r) => r.json()).then((res) => {
      if (mine !== idToken) return;
      if (!res.ok) return;   // 读不到就什么都不弹，别拿错误文本打扰人
      const g = res.identify || {};
      if (!g.inside) { if (popup) { popup.remove(); popup = null; } return; }
      showPopup(lngLat, popupNode(res));
    }).catch(() => { /* 网络这类问题上面有统一的提示，这里不重复 */ });
  }

  /* 滚轮缩放：把每一格的增量累加起来，动画一帧一帧地追目标值。
     连滚十格也只是目标值变大，动画不会重头开始，所以看着是连续走的；
     锚点固定住鼠标下那一点，和常见地图软件的手感一致 */
  function wireWheelZoom() {
    const canvas = map.getCanvas();
    let target = null;
    let anchor = null;
    let raf = 0;
    const tick = () => {
      raf = 0;
      if (target === null) return;
      const cur = map.getZoom();
      const diff = target - cur;
      if (Math.abs(diff) < 0.0015) { target = null; return; }
      const next = cur + diff * 0.32;
      const before = anchor ? map.unproject(anchor) : null;
      map.jumpTo({ zoom: next });
      if (anchor && before) {
        const after = map.unproject(anchor);
        const c = map.getCenter();
        map.jumpTo({
          center: [c.lng + (before.lng - after.lng), c.lat + (before.lat - after.lat)],
        });
      }
      raf = requestAnimationFrame(tick);
    };
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 100;
      // 一格普通滚轮约 100，折成 0.2 级；单次再大也不超过 0.6 级
      const dz = Math.max(-0.6, Math.min(0.6, -dy / 500));
      const base = target === null ? map.getZoom() : target;
      target = Math.max(0, Math.min(map.getMaxZoom(), base + dz));
      anchor = new maplibregl.Point(e.clientX - r.left, e.clientY - r.top);
      if (!raf) raf = requestAnimationFrame(tick);
    }, { passive: false });
  }

  function wireGestures() {
    const canvas = map.getCanvas();
    let mid = null;
    map.on('click', (e) => identifyAt(e.lngLat, e.point));
    // 中键按住平移，左键留给点选识别
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      mid = { x: e.clientX, y: e.clientY };
      canvas.classList.add('mid-pan');
    });
    window.addEventListener('mousemove', (e) => {
      if (!mid) return;
      map.panBy([-(e.clientX - mid.x), -(e.clientY - mid.y)], { duration: 0 });
      mid = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 1 || !mid) return;
      mid = null;
      canvas.classList.remove('mid-pan');
    });
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  }

  function restyle(next) {
    if (!data || data.kind !== 'raster') return;
    Object.assign(data, next);
    guard('换色', () => drawRaster(data, true));
  }

  function vector() {
    return lastVec;
  }

  function current() {
    return data;
  }

  /* 当前视野的范围和简化容差：属性表要看别的图层时照着这个再问一次服务端 */
  function viewQuery() {
    if (!live()) return null;
    const b = map.getBounds();
    return {
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      tolerance: zoomTolerance(map.getZoom()),
    };
  }

  function init(cfg) {
    // 只记配置；容器真正可见时再建图，避免在隐藏容器里初始化
    if (cfg) config = Object.assign(config, cfg);
  }

  function resize() {
    if (map) map.resize();
  }

  window.GisMap = {
    init, show, clear, refresh, themeChanged, setElapsed, restyle, resize,
    vector, current, viewQuery, selectLayer,
    layerInfo() {
      return { active: activeTarget, items: targets.map((t, i) => ({
        label: t.label, kind: t.kind, key: targetKey(t), index: i })) };
    },
    /* 输入经纬度定位：落一个十字标记 */
    goTo(lngLat, zoom) {
      if (!live()) return false;
      map.easeTo({ center: lngLat, zoom: zoom || Math.max(map.getZoom(), 12), duration: 500 });
      dropPin(lngLat);
      return true;
    },
    /* Esc 收识别弹窗：关掉弹窗顺带撤掉那一圈高亮，返回有没有东西可关 */
    closePopup() {
      const had = !!popup;
      if (had) { popup.remove(); popup = null; }
      if (pin) { pin.remove(); pin = null; }
      setHighlight(null);
      return had;
    },
    hasLayer() { return live() && !!data; },
    /* 调试与自动化测试用的地图句柄：CDP 里能直接查渲染状态 */
    __map() { return map; },
    /* 设置页改"视野内单次绘制要素数"时调用 */
    setDrawLimit(n) {
      const v = Number(n);
      if (Number.isFinite(v) && v >= 500) drawLimit = Math.min(v, 200000);
    },
    /* 属性表双击过来的定位：frame 是该要素的范围（读表时服务端随行带回）。
       返回 'feature'（已高亮）、'box'（要素还没画出来，先用范围框顶着，等下一次绘制补）
       或 'none'（地图没起来）。 */
    focusFid(fid, box) {
      if (!live()) return 'none';
      const b = box && box.length >= 4 ? box.map(Number) : null;
      const n = (fid === null || fid === undefined || !Number.isFinite(Number(fid))) ? null : Number(fid);
      if (!b || !isFinite(b[0]) || !isFinite(b[1]) || !isFinite(b[2]) || !isFinite(b[3])) return 'none';
      pendingFocus = { fid: n, box: b };
      // 框过去会和要素高亮一起发生：视图动画 450 毫秒，画完这一批再补高亮
      fitBBox(b);
      const f = n === null ? null : ((lastVec && lastVec.features) || []).find((x) => fidOf(x) === n);
      if (f) {
        setHighlight([f]);
        pendingFocus = null;
        return 'feature';
      }
      setHighlight([{ id: n, geometry: boxRing(b) }]);
      return 'box';
    },
    fullExtent() {
      if (!live() || !data) return;
      const box = data.wgs || (data.ring && data.ring.length >= 4 ? boxFromRing(data.ring) : null);
      if (box) fitTo(box, data.reserveAttr);
    },
  };
})();
