/* 地图：底图切换 + 用户数据绘制。位置换算只作用在底图和显示上，绝不改动用户数据的坐标系。 */
(function () {
  'use strict';

  const TD_HOSTS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const FEATURE_LIMIT = 5000;
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

  function emit(name, detail) {
    const box = document.getElementById('map');
    if (box) box.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  // 内联 style 在构造时就能用，不必等渲染帧；页面不可见时 requestAnimationFrame 会被挂起
  function live() {
    return !!map && !!map.getStyle();
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

  function setElapsed(text) {
    elapsed = text || '';
    note(lastNote);
  }

  function fail(where, err) {
    const msg = err && err.message ? err.message : String(err);
    note('地图显示失败（' + where + '）：' + msg.slice(0, 180));
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

  function annotationSources() {
    const key = (config.tianditu_key || '').trim();
    if (!key || !config.annotation) return [];
    if (config.basemap === 'tianditu_img') return [rasterSource('bm-note', td('cia_w', key), '天地图', 18)];
    if (config.basemap === 'tianditu_vec') return [rasterSource('bm-note', td('cva_w', key), '天地图', 18)];
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

  /* 点中的要素描一圈高亮；弹窗关掉或点了别处就撤掉 */
  function setHighlight(feats) {
    if (!live()) return;
    const src = map.getSource('gis-hl');
    if (!src) return;
    const list = (feats || []).filter((f) => f && f.geometry)
      .map((f) => ({ type: 'Feature', geometry: f.geometry, properties: {} }));
    src.setData({ type: 'FeatureCollection', features: list });
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

  function fitTo(box) {
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 26, duration: 0, maxZoom: 12 });
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

  function loadVector() {
    if (!data || data.kind !== 'vector' || !live()) return;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const tol = zoomTolerance(map.getZoom());
    const url = '/api/vector?path=' + enc(data.target) +
      '&layer=' + (data.layerIndex || 0) +
      '&limit=' + FEATURE_LIMIT +
      '&tolerance=' + tol.toExponential(2) +
      '&bbox=' + bbox.map((v) => v.toFixed(5)).join(',');
    const mine = ++token;
    const wanted = data;
    fetch(url).then((r) => r.json()).then((res) => {
      if (mine !== token || data !== wanted) return;
      if (!res.ok) {
        note(baseNote() + ((res.error || {}).title || '要素读取失败'));
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
      };
      const parts = [];
      if (m.layer_name) parts.push('图层 ' + m.layer_name);
      if (m.field_count != null) parts.push(m.field_count + ' 个字段');
      if (m.layer_total != null) parts.push('共 ' + m.layer_total + ' 个要素');
      if (m.in_bbox != null) parts.push('视野内 ' + m.in_bbox + ' 个');
      else if (m.truncated) parts.push('视野内超过单次上限');
      parts.push('已绘制 ' + feats.length + ' 个');
      if (res.cached) parts.push('缓存命中');
      if (m.assumed_local) parts.push('这个图层没有坐标系，按原始坐标当作米临时摆放，仅供预览，底图与注记已暂时收起');
      else if (m.reprojected) parts.push('显示坐标已转到经纬度');
      if (m.simplified) parts.push('显示几何已抽稀');
      note(baseNote() + parts.join(' · ') +
        (m.simplified ? ' · 抽稀误差不超过 2 个屏幕像素，量算仍按原始几何' : '') +
        (m.truncated ? ' · 到达单次上限，放大后继续加载' : ''));
      const src = map.getSource('gis-data');
      if (src) src.setData({ type: 'FeatureCollection', features: feats });
      // 没有经纬度范围可框（无坐标系的本地坐标文件）：用第一屏要素自己的
      // 范围把视图对上去，每个图层只对一次，之后随便平移缩放都不再抢镜头
      const fkey = (data.target || '') + '|' + (data.layerIndex || 0);
      if (!data.wgs && !vecLocalFit[fkey] && feats.length) {
        vecLocalFit[fkey] = 1;
        const b = featsBBox(feats);
        if (b) fitTo(b);
      }
      emit('gis:vector', lastVec);
      emit('gis:drawn', { kind: 'vector' });
    }).catch((err) => {
      if (mine === token) note(baseNote() + '要素读取失败：' + err.message);
      emit('gis:drawn', { kind: 'vector' });
    });
  }

  function scheduleVector() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(loadVector, 260);
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
      note('这个栅格没有坐标系，无法定位到地图上');
      emit('gis:drawn', { kind: 'skip' });
      return;
    }
    setImage(rasterUrl(t), t.corners && t.corners.length === 4 ? t.corners : cornersOf(t));
    setExtentRing(t.ring || null);
    emit('gis:drawn', { kind: 'raster' });
    if (!keepView) fitTo(t.wgs || boxFromRing(t.ring));
    const box = t.band ? '第 ' + t.band + ' 波段' : '前 ' + (t.bands || 1) + ' 个波段合成';
    note(box + (t.edges && t.edges.length > 2
      ? ' · 分 ' + (t.edges.length - 1) + ' 级设色' + (t.scheme ? '（' + t.scheme + '）' : '') + '，无数据处透明，色块颜色只代表数值区间'
      : ' · 按 512 像元降采样、2%~98% 分位拉伸，色阶不代表原始数值'));
  }

  function drawVector(t, keepView) {
    /* 没有坐标系的图层（多为 CAD 图纸）也能看效果：引擎把原始坐标当作米
       临时摆到地图上，这里正常取数绘制；有经纬度范围就先框到范围
       （keepView：换底图后的补画不动视野，用户看哪儿就还在哪儿） */
    if (t.wgs && !keepView) fitTo(t.wgs);
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
      note('瓦片编号算不出覆盖范围，只能看信息');
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
          note('地图样式还没加载完，稍等会自动出现；下面这些信息不受影响');
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
        }).catch(() => note('变量信息读取失败'));
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
            wgs: L.extent_wgs84, warning: L.warning,
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
        if (d.kind === 'json') note('这份 JSON 里没有可定位的地理要素');
        else if (d.kind === 'archive') note('压缩包里没有找到可绘制的数据');
        else note('这类数据没有可在地图上显示的空间信息');
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
    data = null;
    pending = null;
    lastVec = null;
    targets = [];
    activeTarget = 0;
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
      note('地图组件加载失败，请确认 web/vendor 里有 maplibre-gl.js');
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
      ['histBtn', 'attrBtn', 'homeBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.className = 'maplibregl-ctrl-icon';
        group.appendChild(btn);
      });
    }
    // 复位：不管当前在第几级、转到哪，回到开场那个中国全图的视野
    const home = document.getElementById('homeBtn');
    if (home) home.addEventListener('click', () => {
      if (live()) map.jumpTo({ center: [104, 35], zoom: 3.2, bearing: 0, pitch: 0 });
    });
    // 指北针的提示语换成中文（库默认是英文）
    const compass = map.getContainer().querySelector('.maplibregl-ctrl-compass');
    if (compass) compass.title = '指北：把地图转向正北';
    /* 容器尺寸在栅格里会被右栏挤动，MapLibre 只监听窗口，不监听容器，得自己补。
       拖动窗口一次会连着触发几十次布局，每次都重建画布就是用户看到的闪烁——
       攒成每帧最多一次，尺寸没真变就不动手。 */
    if (window.ResizeObserver) {
      const box = document.getElementById('map');
      let lastW = 0, lastH = 0, settle = 0;
      const apply = () => {
        settle = 0;
        box.classList.remove('resizing');
        if (!live()) return;
        const r = box.getBoundingClientRect();
        lastW = r.width; lastH = r.height;
        map.resize();
      };
      // 拖动过程中一次都不 resize，只让画布跟着容器拉伸（.resizing 那条样式），
      // 等尺寸稳住 140 毫秒再补一次真重绘
      new ResizeObserver(() => {
        const r = box.getBoundingClientRect();
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
      if (data && data.kind === 'vector') scheduleVector();
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

  function fitBBox(b) {
    if (!b || b.length < 4) return;
    if (b[2] - b[0] < 1e-7 && b[3] - b[1] < 1e-7) {
      map.easeTo({ center: [b[0], b[1]], zoom: Math.max(map.getZoom(), 16), duration: 450 });
      return;
    }
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 17, duration: 450 });
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
        /* OBJECTID 是数据源自己的主键，和软件里的行号、要素编号是同一件事，
           放在识别结果里既占地方又容易让人以为它是业务字段；
           下划线开头的是引擎随绘制一起带回来的量算值，不算属性 */
        if (k.charAt(0) === '_' || /^objectid(_\d+)?$/i.test(k)) return;
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
        return null;
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
  function foot(getFeat, total, step, onMeasure, onFocus) {
    const node = el2('div', 'idp-foot');
    const mkBtn = (icon, title, cls) => {
      const b = el2('button', 'idp-tbtn' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      b.title = title;
      b.innerHTML = icon;
      return b;
    };
    const focus = mkBtn(ICON_FOCUS, '聚焦到该要素');
    focus.onclick = () => onFocus(getFeat() || {});
    const measure = mkBtn(ICON_MEASURE, '计算面积和周长');
    let busy = false;
    measure.onclick = () => {
      if (busy) return;
      const p = onMeasure(getFeat() || {});
      if (!p || typeof p.then !== 'function') return;
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
      measure.title = busy ? '正在计算…' : (!ok
        ? (fidOf(f) === null ? '这个要素量不了' : '点要素没有长度和面积')
        : (String(f.geometry && f.geometry.type).indexOf('Polygon') >= 0
          ? '计算面积和周长' : '计算长度'));
    };
    if (total > 1) {
      let idx = 0;
      const pagerNode = el2('div', 'idp-pager');
      const label = el2('span', 'idp-page', '1/' + total);
      const prev = mkBtn(ICON_CHEV, '上一个', 'idp-chev');
      const next = mkBtn(ICON_CHEV, '下一个', 'idp-chev flip');
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
    /* 给"输入经纬度定位"和"属性表双击定位到要素"用 */
    goTo(lngLat, zoom) {
      if (!live()) return false;
      map.easeTo({ center: lngLat, zoom: zoom || Math.max(map.getZoom(), 12), duration: 500 });
      dropPin(lngLat);
      return true;
    },
    zoomToBBox(b) { if (live()) fitBBox(b); },
    /* Esc 收识别弹窗：关掉弹窗顺带撤掉那一圈高亮，返回有没有东西可关 */
    closePopup() {
      const had = !!popup;
      if (had) { popup.remove(); popup = null; }
      if (pin) { pin.remove(); pin = null; }
      setHighlight(null);
      return had;
    },
    hasLayer() { return live() && !!data; },
    fullExtent() {
      if (!live() || !data) return;
      const box = data.wgs || (data.ring && data.ring.length >= 4 ? boxFromRing(data.ring) : null);
      if (box) fitTo(box);
    },
  };
})();
