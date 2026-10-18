"""本地服务：只绑 127.0.0.1，同时提供接口和前端静态文件。

用标准库起服务，不引入 Web 框架，打包时少一层依赖。
"""

import atexit
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from . import cache
from . import formats

# GDAL 那一坨导入是启动耗时的大头。先绑上端口、先把界面发出去，
# 这些名字由 load_engine() 填上；真正要读数据时才会用到。
_LOADED = False

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

_T0 = None


def _phase(t, label):
    """GISVIEWER_TIMING=1 时把各阶段耗时打到标准输出，用来看慢在哪一步。"""
    if not os.environ.get("GISVIEWER_TIMING"):
        return
    global _T0
    if _T0 is None:
        from . import T_START
        _T0 = T_START
    print("TIMING %-22s 自引擎起 %6.0f ms" % (label, (time.perf_counter() - _T0) * 1000),
          file=sys.stderr, flush=True)


_phase(time.perf_counter(), "模块导入完成")
MAX_UPLOAD = 4 * 1024 * 1024 * 1024
SAFE_NAME = re.compile(r"[^\w.\-一-鿿]+")
TILE_TYPES = {".pbf": "application/vnd.mapbox-vector-tile", ".png": "image/png",
              ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
TILE_ROUTE = re.compile(r"^/api/tile/(amap)/(\d+)/(\d+)/(\d+)$")


_ENGINE_NAMES = ("engine", "raster", "vector", "tileset", "labels", "amap", "dwg")
_engine_lock = threading.Lock()


def load_engine():
    """把 GDAL 相关的模块请进来；只在第一次真正需要读数据时执行一次。"""
    global _LOADED
    global engine, raster, vector, tileset, labels, amap, dwg
    if _LOADED:
        return
    with _engine_lock:
        if _LOADED:
            return
        t = time.perf_counter()
        from . import amap as _amap, dwg as _dwg, labels as _labels
        from . import raster as _raster, tileset as _tileset, vector as _vector
        from . import inspect as _inspect
        engine, raster, vector, tileset = _inspect, _raster, _vector, _tileset
        labels, amap, dwg = _labels, _amap, _dwg
        _LOADED = True
        _phase(t, "引擎按需导入")


def __getattr__(name):
    """外部直接取 server.raster 这类名字时，顺手把引擎请进来。"""
    if name in _ENGINE_NAMES:
        load_engine()
        return globals()[name]
    raise AttributeError("module %r has no attribute %r" % (__name__, name))


# 这几个接口不碰数据，答完就能让界面先跑起来
LIGHT_ROUTES = ("/api/formats", "/api/config", "/api/preload", "/api/cache")


def _need_engine(route):
    if route.startswith("/api/") and route not in LIGHT_ROUTES:
        load_engine()

_upload_root = None
_upload_lock = threading.Lock()
_cache_note = ""
_cache_dir_used = ""

# 副本统一装在这个子目录里，免得在用户挑的目录下乱删别的东西
CACHE_TAG = "gisviewer-副本"


def config_dir():
    """配置放哪。GISVIEWER_DATA_DIR 指到别处时，测试实例就不会碰到用户真正的设置——
       壳那边的日志、webview2 缓存本来就跟着这个变量走，配置必须一起走，
       否则一个测试实例改一下色带就把人家调好的偏好覆盖了。"""
    override = os.environ.get("GISVIEWER_DATA_DIR")
    if override:
        path = Path(override)
    else:
        base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
        path = Path(base) / "GISViewer"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_base():
    """临时副本放哪：设置里指定就用那个目录，用不了就退回系统临时目录并把原因带回去。"""
    want = str(read_config().get("cache_dir") or "").strip()
    if not want:
        return Path(tempfile.gettempdir()), ""
    try:
        root = Path(want) / CACHE_TAG
        root.mkdir(parents=True, exist_ok=True)
        probe = root / ".write"
        probe.write_text("1", encoding="utf-8")
        probe.unlink()
        return root, ""
    except OSError as exc:
        reason = exc.strerror or exc.__class__.__name__
        return (Path(tempfile.gettempdir()),
                "设置里的副本目录用不了（" + reason + "），这一轮先放在系统临时目录")


def upload_root():
    global _upload_root, _cache_note, _cache_dir_used
    with _upload_lock:
        if not _upload_root:
            want = str(read_config().get("cache_dir") or "").strip()
            base, note = cache_base()
            _cache_note = note
            _cache_dir_used = want
            _upload_root = tempfile.mkdtemp(prefix="run-", dir=str(base))
        return _upload_root


def cleanup_uploads():
    root = _upload_root
    if not root:
        return
    shutil.rmtree(root, ignore_errors=True)


def keep_hours():
    """异常退出留下的副本能存多久；正常退出是当场就删的。"""
    try:
        hours = float(read_config().get("keep_hours"))
    except (TypeError, ValueError):
        return 12.0
    return max(0.5, min(hours, 720.0))


def sweep_stale_uploads():
    """把上次异常退出留下的副本清掉，临时文件不该一直攒着。"""
    limit = keep_hours() * 3600
    now = time.time()
    roots = {Path(tempfile.gettempdir()), cache_base()[0]}
    for base in roots:
        for entry in base.glob("*"):
            try:
                name = entry.name
                if name == CACHE_TAG or not entry.is_dir():
                    continue
                if not name.startswith("gisviewer-") and not name.startswith("run-"):
                    continue
                if str(entry) == str(_upload_root or ""):
                    continue
                if now - entry.stat().st_mtime > limit:
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                continue


def mark_temp_copy(result):
    """拖进来的文件其实落在临时目录，界面不该把这条路径当作用户的路径展示。"""
    if not isinstance(result, dict):
        return result
    root = _upload_root
    info = result.get("file")
    if root and isinstance(info, dict) and str(info.get("path", "")).startswith(str(root)):
        info["temp_copy"] = True
        result["temp_copy"] = True
    return result


def _safe_name(raw):
    name = os.path.basename(str(raw).replace("\\", "/"))
    name = SAFE_NAME.sub("_", name)
    return name[:120] or "upload.bin"


def _readable(path):
    """本地路径要求真实存在；/vsi、NETCDF:"..." 这类虚拟路径交给 GDAL 判断。"""
    if not path:
        return False
    if path.startswith("/vsi") or ":" in path.split("/", 1)[0]:
        return True
    return os.path.exists(path)


def read_config():
    path = config_dir() / "config.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_config(data):
    global _cache_note
    path = config_dir() / "config.json"
    allowed = {"theme", "basemap", "tianditu_key", "annotation", "max_features", "last_paths",
               "recent", "recent_max",
               "ramp", "class_count", "nodata_view", "raster_default", "vector_color",
               "restore_last", "cache_dir", "keep_hours",
               "ui_font", "num_font", "ui_zoom", "panel_alpha", "unit_lang",
               "hk_mods", "hk_vk", "hk2_mods", "hk2_vk", "upd_freq", "close_act"}
    payload = read_config()
    for key, value in data.items():
        if key in allowed:
            payload[key] = value
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    # 本轮的副本目录已经建好，中途换会把已复制的文件丢在原处，所以只能下次启动生效
    if _upload_root and str(payload.get("cache_dir") or "").strip() != _cache_dir_used:
        _cache_note = "本轮仍用 " + str(_upload_root) + "，副本目录下次启动才换"
    return payload


# 无数据处可选的三种底色，"transparent" 保持原来的透明
NODATA_FILL = {
    "transparent": None,
    "black": (0, 0, 0),
    "white": (255, 255, 255),
}


# 设置页里能改的显示参数，都在这里收敛成引擎用的值：越界或写坏了就用默认
def view_prefs():
    cfg = read_config()
    try:
        k = int(cfg.get("class_count") or formats.CLASS_DEFAULT)
    except (TypeError, ValueError):
        k = formats.CLASS_DEFAULT
    ramp = cfg.get("ramp")
    if ramp not in formats.RAMPS:
        ramp = formats.RAMP_DEFAULT
    nodata = cfg.get("nodata_view")
    if nodata not in NODATA_FILL:
        nodata = "transparent"
    if cfg.get("raster_default") not in ("composite", "single"):
        cfg["raster_default"] = "composite"
    return {"k": max(2, min(k, 12)), "ramp": ramp,
            "nodata": NODATA_FILL[nodata], "cfg": cfg}


def band_stats_and_hist(target, info, band_index):
    """单独请求一个波段的值分布，避免拖慢主信息。"""
    load_engine()
    if not info.get("height") or not info.get("width"):
        return {"ok": False, "error": {"title": "这个文件没有单一栅格波段可统计"}}
    band = next((b for b in info.get("bands") or [] if b["index"] == band_index), None)
    if not band:
        return {"ok": False, "error": {"title": "没有这个波段"}}
    hist = raster.band_histogram(target, band_index, info["height"], info["width"], band["type"])
    if hist is None:
        return {"ok": False, "error": {"title": "值分布计算失败"}}
    out = {"ok": True, "band": band_index, "histogram": hist,
           "statistics": band.get("statistics")}
    discrete = raster.band_color_table(target, band_index)
    if discrete:
        out["discrete"] = discrete
    else:
        prefs = view_prefs()
        got = raster.classify(hist, prefs["k"], prefs["ramp"])
        if got:
            out["classes"] = got["classes"]
            out["method"] = got["method"]
    return out


# ---------- 缓存包装：文件没变过就搬上次的结果，重开快得多 ----------

def _cacheable(path):
    """临时副本每轮路径都不一样，缓存它没有意义；其余路径都缓存。"""
    root = _upload_root
    return not (root and str(path).startswith(str(root)))


def _stamp_elapsed(result, started):
    """缓存命中时把耗时改写成这次读缓存花的时间，并标上来源。
    不冒充原来的读取时间——不然面板上会显示一个不是这次发生的数字。"""
    if isinstance(result, dict):
        result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        result["cached"] = True
    return result


def cached_safe_inspect(path, **kwargs):
    """safe_inspect 外面套缓存。失败的结果不缓存——文件可能马上就被修好。"""
    load_engine()
    if not _cacheable(path):
        return engine.safe_inspect(path, **kwargs)
    label = "&".join("%s=%r" % kv for kv in sorted(kwargs.items()))
    k = cache.key("inspect", path, label)
    started = time.perf_counter()
    hit = cache.load_json("inspect", k)
    if hit is not None:
        return _stamp_elapsed(hit, started)
    result = engine.safe_inspect(path, **kwargs)
    if isinstance(result, dict) and result.get("ok"):
        cache.save_json("inspect", k, result)
    return result


def cached_band_stats(target, info, band_index):
    """直方图 + 分级。分级跟设置里的色带、级数有关，键里带上它们。"""
    if not _cacheable(target):
        return band_stats_and_hist(target, info, band_index)
    prefs = view_prefs()
    k = cache.key("hist", target,
                  "band=%d;k=%d;ramp=%s" % (band_index, prefs["k"], prefs["ramp"]))
    started = time.perf_counter()
    hit = cache.load_json("hist", k)
    if hit is not None:
        # 和 inspect 一致：命中时标上 cached 并把耗时改写成读缓存的时间
        return _stamp_elapsed(hit, started)
    out = band_stats_and_hist(target, info, band_index)
    if isinstance(out, dict) and out.get("ok"):
        cache.save_json("hist", k, out)
    return out


def _png_size(body):
    """PNG 的宽高就写在文件头第 16-24 字节，不用再存一份侧车文件。"""
    try:
        import struct
        w, h = struct.unpack(">II", body[16:24])
        return w, h
    except Exception:
        return 0, 0


def raster_grid(target, indexes, max_side=512, resampling="bilinear"):
    """出图用的像元网格：投影坐标系的数据先降采样、再转到 Web 墨卡托，返回 (波段数组列表, 经纬度框)。

    地图那一侧只能把一张图贴到四个角点上，而圆锥投影里数据的边是弧线：
    照原样出图，整幅影像会和底图错开（pre_2000_01.tif 就是这样）。
    先在原坐标系里降到 512 再转墨卡托，两步加起来不到半秒；
    直接对原文件开 WarpedVRT 要把上亿像元整个重算一遍，得两秒多。
    贴图的四角取同一个经纬度外框，和这里的网格范围一一对应。
    """
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, transform_bounds

    from .crs import bounds_to_wgs84

    want = [int(i) for i in indexes]
    with rasterio.open(target) as src:
        want = [min(max(1, i), src.count) for i in want]
        ratio = max(1, int(max(src.height, src.width) / max_side) + 1)
        small_h, small_w = max(1, src.height // ratio), max(1, src.width // ratio)
        b = src.bounds
        box = [b.left, b.bottom, b.right, b.top]
        geographic = src.crs is None or src.crs.is_geographic
        if not geographic:
            conv = bounds_to_wgs84(src.crs.wkt, b.left, b.bottom, b.right, b.top, densify=16)
            geographic = not conv
            box = conv or box
        if geographic:
            return [src.read(i, out_shape=(small_h, small_w), masked=True) for i in want], box

        out_w = max_side
        # 目标网格按 Web 墨卡托算，不按经纬度：地图那边是把一张图线性铺在四角点
        # 围成的墨卡托矩形里，转到经纬度会在中高纬被拉偏，影像和底图还是对不上
        mb = transform_bounds("EPSG:4326", "EPSG:3857", box[0], max(box[1], -84.9),
                              box[2], min(box[3], 84.9), densify_pts=2)
        out_h = max(1, int(round(out_w * (mb[3] - mb[1]) / max(1e-9, mb[2] - mb[0]))))
        dst_tf = from_bounds(mb[0], mb[1], mb[2], mb[3], out_w, out_h)
        # 降采样之后像元已经变大，源变换必须按小网格重算，
        # 接着用原分辨率的 transform 会让重投影只读到数组的一个角
        src_tf = from_bounds(b.left, b.bottom, b.right, b.top, small_w, small_h)
        res = Resampling[resampling]
        arrays = []
        for i in want:
            raw = src.read(i, out_shape=(small_h, small_w), masked=True)
            buf = np.full((out_h, out_w), np.nan, dtype="float64")
            reproject(source=raw.filled(np.nan).astype("float64"), destination=buf,
                      src_transform=src_tf, src_crs=src.crs,
                      src_nodata=np.nan,
                      dst_transform=dst_tf, dst_crs="EPSG:3857", dst_nodata=np.nan,
                      resampling=res)
            arrays.append(np.ma.masked_invalid(buf))
        return arrays, box


def thumbnail(target, band_count, max_side=512):
    """降采样出一张给界面铺底的小图，返回 PNG 字节。"""
    import numpy as np
    from rasterio.io import MemoryFile

    want = min(band_count or 1, 3)
    arrays_in = raster_grid(target, range(1, want + 1), max_side)[0]
    out_h, out_w = arrays_in[0].shape
    arrays = []
    # NoData 处给透明，底图才透得出来，不会糊成一片黑
    alpha = np.full((out_h, out_w), 255, dtype="uint8")
    for arr in arrays_in:
        mask = np.ma.getmaskarray(arr)
        comp = arr.compressed()
        if comp.size == 0:
            arrays.append(np.zeros((out_h, out_w), dtype="uint8"))
            alpha[:] = 0
            continue
        lo = float(comp.min())
        hi = float(comp.max())
        try:
            lo = float(np.percentile(comp, 2))
            hi = float(np.percentile(comp, 98))
        except Exception:
            pass
        if hi <= lo:
            lo, hi = float(comp.min()), float(comp.max())
        if hi <= lo:
            hi = lo + 1.0
        # 重投影补出来的 NaN 先填成下界，免得转 uint8 时报警（这些位置本来就是透明的）
        vals = np.ma.filled(arr.astype("float64"), lo)
        scaled = np.clip((vals - lo) / (hi - lo) * 255.0, 0, 255)
        scaled = scaled.astype("uint8")
        scaled[mask] = 0
        arrays.append(scaled)
        alpha = np.minimum(alpha, np.where(mask, 0, 255).astype("uint8"))

    if len(arrays) == 1:
        arrays = arrays * 3
    arrays.append(alpha)
    with MemoryFile() as mem:
        with mem.open(driver="PNG", width=out_w, height=out_h, count=4,
                      dtype="uint8", cs="RGB") as dest:
            for i, arr in enumerate(arrays, start=1):
                dest.write(arr, i)
        return mem.read(), out_w, out_h


def class_image(target, band_index, edges, colors, max_side=512, fill=None):
    """按分级界给单个波道上色，输出 RGBA 的 PNG：图例和影像用的是同一套分级。

    fill 给定时，无数据处涂这个颜色而不是留透明。
    """
    import numpy as np
    from rasterio.io import MemoryFile

    # 分类栅格必须最近邻重采样，插值会造出文件里根本不存在的类别
    arr = raster_grid(target, [band_index], max_side, "nearest")[0][0]
    out_h, out_w = arr.shape
    cuts = np.asarray(edges[1:-1], dtype="float64")
    index = np.digitize(arr.data, cuts)
    lut = np.array([[int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)] for c in colors],
                   dtype="uint8")
    rgb = lut[np.clip(index, 0, len(lut) - 1)]
    # 没有 NoData 时 arr.mask 是标量 False，直接索引会塌成 0 维
    mask = np.ma.getmaskarray(arr)
    if fill is None:
        alpha = np.where(mask, 0, 255).astype("uint8")
    else:
        for c in range(3):
            rgb[:, :, c] = np.where(mask, fill[c], rgb[:, :, c])
        alpha = np.full(rgb.shape[:2], 255, dtype="uint8")
    rgba = np.dstack([rgb, alpha[:, :, None]])
    with MemoryFile() as mem:
        with mem.open(driver="PNG", width=out_w, height=out_h, count=4, dtype="uint8",
                      cs="RGB") as dest:
            for i in range(4):
                dest.write(rgba[:, :, i], i + 1)
        return mem.read(), out_w, out_h


class Handler(BaseHTTPRequestHandler):
    server_version = "GISViewer"

    def log_message(self, fmt, *args):
        if os.environ.get("GISVIEWER_DEBUG"):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(engine_body(body) if isinstance(body, dict) else body,
                              ensure_ascii=False, default=str).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _static(self, rel):
        rel = (rel or "index.html").lstrip("/")
        if rel in ("", "index.html"):
            rel = "index.html"
        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            return self._send(404, {"ok": False, "error": {"title": "文件不存在"}})
        if not target.is_file():
            return self._send(404, {"ok": False, "error": {"title": "文件不存在"}})
        types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
                ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png"}
        return self._send(200, target.read_bytes(), types.get(target.suffix, "application/octet-stream"))

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)
        _need_engine(route)
        if route in ("/", "/index.html"):
            return self._static("index.html")
        if route.startswith("/web/"):
            return self._static(route[5:])
        if route == "/api/formats":
            return self._send(200, {"ok": True, "raster": sorted(formats.RASTER_EXT),
                                    "vector": sorted(formats.VECTOR_EXT),
                                    "archive": sorted(formats.ZIP_LIKE)})
        if route == "/api/preload":
            raw = os.environ.get("GISVIEWER_PRELOAD")
            paths = json.loads(raw) if raw else []
            cfg = read_config()
            # 命令行没带文件、且开了"恢复上次的文件"，才把上次那个再端出来
            if not paths and cfg.get("restore_last"):
                paths = [p for p in (cfg.get("last_paths") or []) if os.path.exists(p)]
            return self._send(200, {"ok": True, "paths": paths})
        if route == "/api/config":
            payload = read_config()
            payload.setdefault("theme", "auto")
            payload.setdefault("basemap", "tianditu_img")
            payload.setdefault("annotation", True)
            payload.setdefault("ramp", formats.RAMP_DEFAULT)
            payload.setdefault("class_count", formats.CLASS_DEFAULT)
            payload.setdefault("nodata_view", "transparent")
            payload.setdefault("raster_default", "composite")
            payload.setdefault("vector_color", "#d9781f")
            payload.setdefault("max_features", 500)
            payload.setdefault("restore_last", False)
            payload.setdefault("cache_dir", "")
            payload.setdefault("keep_hours", 12)
            payload["cache_note"] = _cache_note
            return self._send(200, {
                "ok": True, "config": payload, "version": __version__,
                # 色带的端点颜色只在这里给一份，设置页照着画预览条，不再抄第二遍。
                # 放在 config 外面：它是"有哪些可选"的说明，不是用户的一项设置
                "ramps": [
                    {"value": key, "colors": ["rgb(%d,%d,%d)" % c for c in stops]}
                    for key, stops in formats.RAMPS.items()
                ],
            })
        if route == "/api/inspect":
            path = (query.get("path") or [""])[0]
            return self._inspect(path.strip())
        if route == "/api/histogram":
            return self._histogram(query)
        if route == "/api/thumbnail":
            return self._thumbnail(query)
        if route == "/api/vector":
            return self._vector(query)
        if route == "/api/measure":
            return self._measure(query)
        if route == "/api/tileset":
            return self._tileset(query)
        if route == "/api/identify":
            return self._identify(query)
        if route == "/api/geomtypes":
            return self._geomtypes(query)
        if route == "/api/cache":
            return self._send(200, {"ok": True, "cache": cache.stats(),
                                    "data_dir": str(config_dir())})
        if route.startswith("/api/tile/"):
            return self._amap_tile(route)
        return self._send(404, {"ok": False, "error": {"title": "没有这个接口"}})

    def do_POST(self):
        route = urlparse(self.path).path
        _need_engine(route)
        if route == "/api/path":
            body = self._json_body()
            return self._inspect(str(body.get("path", "")).strip())
        if route == "/api/upload":
            return self._upload()
        if route == "/api/config":
            body = self._json_body()
            payload = write_config(body)
            return self._send(200, {"ok": True, "config": payload, "cache_note": _cache_note})
        if route == "/api/cache":
            # 设置页的"清空缓存"：清完把新一轮的占用直接带回去
            cache.clear()
            return self._send(200, {"ok": True, "cache": cache.stats(),
                                    "data_dir": str(config_dir())})
        return self._send(404, {"ok": False, "error": {"title": "没有这个接口"}})

    def _inspect(self, path):
        if not path:
            return self._send(200, {"ok": False,
                                    "error": {"title": "没有指定文件", "hint": "把文件拖进来，或填写完整路径。"}})
        result = cached_safe_inspect(path, histograms=False)
        return self._send(200, mark_temp_copy(result))

    def _histogram(self, query):
        path = (query.get("path") or [""])[0].strip()
        try:
            band_index = int((query.get("band") or ["1"])[0])
        except ValueError:
            band_index = 1
        if not path:
            return self._send(400, {"ok": False, "error": {"title": "没有指定文件"}})
        info = cached_safe_inspect(path, compute_stats=True, histograms=False)
        if not info.get("ok"):
            return self._send(200, info)
        target = (info.get("file") or {}).get("path") or path
        return self._send(200, cached_band_stats(target, info, band_index))

    def _geomtypes(self, query):
        """信息栏"几何类型"那一行的补充数据：混合类型的图层各有多少个，慢就慢点，界面异步来问。"""
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            layer = int((query.get("layer") or ["0"])[0])
        except ValueError:
            return self._send(400, {"ok": False, "error": {"title": "参数不对"}})
        k = cache.key("gtypes", path, "layer=%d" % layer) if _cacheable(path) else None
        if k:
            started = time.perf_counter()
            hit = cache.load_json("gtypes", k)
            if hit is not None:
                return self._send(200, _stamp_elapsed(hit, started))
        try:
            data = vector.geom_type_counts(path, layer)
        except Exception as exc:
            return self._send(200, engine.error_block(exc, path))
        data["ok"] = True
        if k and data.get("types"):
            cache.save_json("gtypes", k, data)
        return self._send(200, data)

    def _measure(self, query):
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            layer = int((query.get("layer") or ["0"])[0])
            fid = int((query.get("fid") or ["0"])[0])
        except ValueError:
            return self._send(400, {"ok": False, "error": {"title": "参数不对"}})
        try:
            data = vector.measure_feature(path, layer, fid)
        except Exception as exc:
            return self._send(200, engine.error_block(exc, path))
        data["ok"] = True
        return self._send(200, data)

    def _vector(self, query):
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            layer = int((query.get("layer") or ["0"])[0])
            limit = max(1, min(int((query.get("limit") or ["20000"])[0]), 200000))
            offset = max(0, int((query.get("offset") or ["0"])[0]))
            tolerance = max(0.0, float((query.get("tolerance") or ["0"])[0]))
            with_geometry = (query.get("geom") or ["1"])[0] != "0"
            bbox = None
            raw_bbox = (query.get("bbox") or [""])[0]
            if raw_bbox:
                parts = [float(v) for v in raw_bbox.split(",")]
                if len(parts) != 4:
                    raise ValueError("bbox 需要 4 个数：左,下,右,上")
                bbox = parts
        except ValueError as exc:
            return self._send(400, {"ok": False, "error": {"title": "参数不对",
                                                           "detail": str(exc)[:200]}})

        # 同一次视野（重开文件、来回平移）重复来取数时直接搬上次的结果。
        # 键里带上抽稀容差和 bbox，视野一变就自然换键。翻页请求不占缓存。
        vkey = None
        if _cacheable(path) and offset == 0:
            box = ",".join("%.4f" % v for v in bbox) if bbox else "-"
            vkey = cache.key("vec", path,
                             "layer=%d;limit=%d;tol=%.6g;box=%s;g=%d"
                             % (layer, limit, tolerance, box, 1 if with_geometry else 0))
            started = time.perf_counter()
            hit = cache.load_json("vec", vkey, mem=False)
            if hit is not None:
                if isinstance(hit.get("gisviewer"), dict):
                    hit["gisviewer"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
                    hit["gisviewer"]["cached"] = True
                return self._send(200, _stamp_elapsed(hit, started))

        # 总要素数走缓存的元数据，省掉开头几秒钟的重数（GeoJSON 没索引，数一遍=全扫一遍）
        total_hint = None
        info = cached_safe_inspect(path, histograms=False)
        if isinstance(info, dict) and info.get("ok"):
            ls = info.get("layers") or []
            if 0 <= layer < len(ls):
                fc = ls[layer].get("feature_count")
                if isinstance(fc, int):
                    total_hint = fc
        started = time.perf_counter()
        try:
            data = vector.read_features(path, layer, bbox, limit, tolerance,
                                        offset=offset, with_geometry=with_geometry,
                                        layer_total_hint=total_hint)
        except Exception as exc:
            return self._send(200, engine.error_block(exc, path))
        data["gisviewer"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        data["ok"] = True
        if vkey:
            # 别让单条几 MB 的响应把缓存撑爆：超过 48 MB 的就不存了
            try:
                if len(json.dumps(data, ensure_ascii=False, default=str)) < 48 * 1024 * 1024:
                    cache.save_json("vec", vkey, data, mem=False)
            except Exception:
                pass   # 缓存写不进去不影响这次返回
        return self._send(200, data)

    def _tileset(self, query):
        root = (query.get("path") or [""])[0].strip()
        ext = (query.get("ext") or [".pbf"])[0].lower()
        if not os.path.isdir(root) or ext not in TILE_TYPES:
            return self._send(404, {"ok": False, "error": {"title": "没有这组瓦片"}})
        try:
            z = int((query.get("z") or [""])[0])
            x = int((query.get("x") or [""])[0])
            y = int((query.get("y") or [""])[0])
        except ValueError:
            return self._send(400, {"ok": False, "error": {"title": "瓦片编号不对"}})
        target = tileset.tile_path(root, z, x, y, ext)
        if not os.path.isfile(target):
            return self._send(404, {"ok": False, "error": {"title": "这一级没有这张瓦片"}})
        with open(target, "rb") as fh:
            body = fh.read()
        return self._send(200, body, TILE_TYPES[ext],
                         {"Cache-Control": "public, max-age=3600"})

    def _amap_tile(self, route):
        m = TILE_ROUTE.match(route)
        if not m:
            return self._send(404, {"ok": False, "error": {"title": "没有这条瓦片路径"}})
        z, x, y = int(m.group(2)), int(m.group(3)), int(m.group(4))
        try:
            png = amap.render(z, x, y)
        except Exception as exc:
            return self._send(200, {"ok": False, "error": {
                "title": "底图纠偏失败", "detail": labels.friendly_error(exc)[:200]}})
        if not png:
            return self._send(404, {"ok": False, "error": {"title": "这一级没有这张瓦片"}})
        return self._send(200, png, "image/png", {"Cache-Control": "public, max-age=86400"})

    def _thumbnail(self, query):
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        edges = [float(v) for v in (query.get("edges") or [""])[0].split(",") if v.strip()]
        colors = [v.strip() for v in (query.get("colors") or [""])[0].split(",") if v.strip()]
        cacheable = _cacheable(path)
        try:
            if edges and len(edges) >= 3 and len(colors) == len(edges) - 1:
                band_index = int((query.get("band") or ["1"])[0])
                fill = view_prefs()["nodata"]
                label = "class;band=%d;edges=%s;colors=%s;fill=%s" % (
                    band_index, ",".join(str(e) for e in edges), ",".join(colors), fill)
                k = cache.key("thumb", path, label) if cacheable else None
                png = cache.load_blob("thumb", k)
                if png is None:
                    png, _w, _h = class_image(path, band_index, edges, colors, fill=fill)
                    cache.save_blob("thumb", k, png)
            else:
                band_count = int((query.get("bands") or ["1"])[0])
                k = cache.key("thumb", path, "bands=%d" % band_count) if cacheable else None
                png = cache.load_blob("thumb", k)
                if png is None:
                    png, _w, _h = thumbnail(path, band_count)
                    cache.save_blob("thumb", k, png)
        except Exception as exc:
            return self._send(200, {"ok": False, "error": {
                "title": "影像预览生成失败", "detail": labels.friendly_error(exc)[:200]}})
        w, h = _png_size(png)
        return self._send(200, png, "image/png", {"X-Image-Width": str(w), "X-Image-Height": str(h)})

    def _identify(self, query):
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            lon = float((query.get("lng") or [""])[0])
            lat = float((query.get("lat") or [""])[0])
            tol = max(0.0, float((query.get("tol") or ["0"])[0]))
        except ValueError:
            return self._send(400, {"ok": False, "error": {"title": "点击位置不对"}})
        kind = (query.get("kind") or ["vector"])[0]
        try:
            if kind == "raster":
                got = raster.identify_value(path, lon, lat)
                if not got:
                    return self._send(200, {"ok": False, "error": {
                        "title": "这个位置没有读到像元",
                        "hint": "点击处可能落在数据范围外，或者这张图没有地理参考。"}})
                return self._send(200, {"ok": True, "kind": "raster", "identify": got})
            layer = int((query.get("layer") or ["0"])[0])
            got = vector.identify_point(path, layer, lon, lat, tol)
            return self._send(200, {"ok": True, "kind": "vector", "identify": got})
        except Exception as exc:
            return self._send(200, engine.error_block(exc, path))

    def _upload(self):
        # 前端用 encodeURIComponent 传中文名，HTTP 头只允许 latin-1
        name = _safe_name(unquote(self.headers.get("X-File-Name") or "upload.bin"))
        group = _safe_name(unquote(self.headers.get("X-Group") or ""))
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            return self._send(413, {"ok": False, "error": {
                "title": "文件太大，不适合走上传",
                "detail": labels.human_size(length),
                "hint": "请在路径框里填写文件所在位置的完整路径。"}})
        folder = Path(upload_root())
        if group:
            folder = folder / group
            folder.mkdir(parents=True, exist_ok=True)
        target = folder / name
        written = 0
        try:
            with open(target, "wb") as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
                    written += len(chunk)
        except OSError as exc:
            return self._send(500, {"ok": False, "error": {"title": "保存上传文件失败",
                                                            "detail": str(exc)[:200]}})
        return self._send(200, {"ok": True, "path": str(target).replace("\\", "/"),
                                "saved_bytes": written, "group": group or None,
                                "primary": engine.is_primary(name)})


def engine_body(payload):
    """把 NaN 和无穷清掉再序列化，前端 JSON.parse 才不会失败。"""
    def walk(value):
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [walk(v) for v in value]
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return None
        return value

    return walk(payload)


def pick_port(preferred=0):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", preferred))
        return probe.getsockname()[1]


def watch_parent():
    """原生壳被强制结束时，子进程不能留在后台占着端口和临时目录。"""
    raw = os.environ.get("GISVIEWER_PPID")
    if not raw or os.name != "nt":
        return
    try:
        import ctypes
        import ctypes.wintypes as wt
        ppid = int(raw)
    except (TypeError, ValueError):
        return
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wt.HANDLE
    kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    kernel32.WaitForSingleObject.restype = wt.DWORD
    kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
    handle = kernel32.OpenProcess(0x00100000, False, ppid)  # SYNCHRONIZE
    if not handle:
        return

    def loop():
        while True:
            if kernel32.WaitForSingleObject(handle, 2000) == 0:  # WAIT_OBJECT_0
                cleanup_uploads()
                os._exit(0)
            time.sleep(0.5)

    threading.Thread(target=loop, daemon=True).start()


def serve(port=0, open_browser=True, quiet=False):
    t = time.perf_counter()
    watch_parent()
    sweep_stale_uploads()
    atexit.register(cleanup_uploads)
    cache.init(config_dir())
    chosen = pick_port(port)
    httpd = ThreadingHTTPServer(("127.0.0.1", chosen), Handler)
    _phase(t, "可以应答")
    # 端口已经在了，界面能发出去了；GDAL 在后台预热，等用户真的丢文件时多半已经好了
    threading.Thread(target=_warm_engine, name="gisviewer-warm", daemon=True).start()
    # 缓存超容量时在后台清一次，不挡启动
    threading.Thread(target=cache.prune, name="gisviewer-cache-prune", daemon=True).start()
    url = f"http://127.0.0.1:{chosen}/"
    if not quiet:
        print(f"GISViewer 已启动：{url}")
        print("按 Ctrl+C 停止")
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        cleanup_uploads()
    return 0


def _warm_engine():
    try:
        load_engine()
        amap.set_cache_dir(config_dir())
    except Exception as exc:
        if os.environ.get("GISVIEWER_DEBUG"):
            traceback.print_exc()


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(prog="gisviewer-server", description="启动本地查看服务")
    parser.add_argument("--port", type=int, default=0, help="监听端口，默认随机空闲端口")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    parser.add_argument("paths", nargs="*", help="启动后直接在界面里预先打开的文件路径")
    args = parser.parse_args(argv)
    if args.paths:
        os.environ["GISVIEWER_PRELOAD"] = json.dumps(args.paths, ensure_ascii=False)
    return serve(args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    raise SystemExit(main())
