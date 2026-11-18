"""本地服务：只绑 127.0.0.1，同时提供接口和前端静态文件。

用标准库起服务，不引入 Web 框架，打包时少一层依赖。
"""

import atexit
import contextlib
import hmac
import json
import math
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

from . import __version__, cache, formats, winpath
from .textutil import clean_text

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
    print(f"TIMING {label:<22} 自引擎起 {(time.perf_counter() - _T0) * 1000:6.0f} ms",
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
        from . import amap as _amap
        from . import dwg as _dwg
        from . import inspect as _inspect
        from . import labels as _labels
        from . import raster as _raster
        from . import tileset as _tileset
        from . import vector as _vector
        engine, raster, vector, tileset = _inspect, _raster, _vector, _tileset
        labels, amap, dwg = _labels, _amap, _dwg
        _LOADED = True
        _phase(t, "引擎按需导入")


def __getattr__(name):
    """外部直接取 server.raster 这类名字时，顺手把引擎请进来。
    名字逐个写出来，不做 globals()[name] 这种动态取值。"""
    if name not in _ENGINE_NAMES:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    load_engine()
    return {"engine": engine, "raster": raster, "vector": vector,
            "tileset": tileset, "labels": labels, "amap": amap,
            "dwg": dwg}[name]


# 这几个接口不碰数据，答完就能让界面先跑起来
LIGHT_ROUTES = ("/api/formats", "/api/config", "/api/preload", "/api/cache", "/api/stamp")


def _file_stamp(path):
    """只取大小与修改时间，给界面判断"文件有没有被外部改过"。

    不碰 GDAL：界面每隔几秒问一次，为此把引擎拉起来不值当。
    """
    if not path:
        return {"exists": False, "size": None, "mtime_ns": None}
    try:
        st = winpath.stat(path)
    except OSError:
        return {"exists": False, "size": None, "mtime_ns": None}
    return {"exists": True, "size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _need_engine(route):
    """读数据的接口先确认引擎在。GDAL 缺失时不能直接抛：处理线程里一抛，
    连接就被关掉，界面拿到的是空白而不是原因——早先连 /api/config 都因为
    响应里那句 import 一起断连，排查时看不出是引擎没起来。"""
    if route.startswith("/api/") and route not in LIGHT_ROUTES:
        try:
            load_engine()
        except Exception as exc:  # noqa: BLE001
            return {"title": "读取引擎没能启动",
                    "detail": f"{exc.__class__.__name__}: {exc}",
                    "hint": "GIS 读取模块（GDAL）缺失或损坏，重新安装本软件即可恢复。"}
    return None

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


CACHE_MARK = ".tulan-cache"     # 目录里的标记：有它才认定这是本软件的缓存目录
CACHE_SUBDIR = "TulanCache"     # 用户选的位置下固定建这个子目录，绝不直接占用所选目录
_cache_root_used = None
_cache_root_note = ""
_cache_fell_back = False       # 用户选的位置用不了、退回了默认目录


def _cache_target(want):
    """把"用户选的位置"翻译成真正的缓存目录。

    永远落在所选目录下的 TulanCache 子目录里：用户完全可能把缓存位置指到
    D:\\资料 这种已经有东西的文件夹，缓存不能和原文件混在一起，
    更不能在清理时把整个目录端掉。用户直接选了名为 TulanCache 的目录时
    不再套一层。"""
    if not want:
        return config_dir() / "cache"
    p = Path(want)
    if p.name.lower() == CACHE_SUBDIR.lower():
        return p
    return p / CACHE_SUBDIR


def cache_root_dir():
    """缓存实际在用哪个目录。apply_cache_root 跑过就以它为准（可能已经回退过），
    没跑过才按配置推算——界面拿到的永远是"真正在用"的那个，不是"设置里写的"那个。"""
    if _cache_root_used is not None:
        return Path(_cache_root_used)
    want = str(read_config().get("cache_root") or "").strip()
    return _cache_target(want)


def _human_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return (f"{n:d} {unit}") if unit == "B" else (f"{n:.1f} {unit}")
        n /= 1024.0
    return f"{n:.1f} GB"


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(str(path)):
        for name in files:
            with contextlib.suppress(OSError):
                total += os.path.getsize(os.path.join(root, name))
    return total


def _clear_cache_dir(path):
    """清掉一个缓存目录里的内容。只认带标记的目录，而且只删 cache.KINDS
    里的子目录——根目录下如果还放着用户自己的文件，一个都不碰。
    返回释放的字节数；不是我们的目录返回 -1。"""
    p = Path(path)
    if not (p / CACHE_MARK).exists():
        return -1
    freed = 0
    for kind in cache.KINDS:
        child = p / kind
        try:
            if not child.is_dir():
                continue
            freed += _dir_size(child)
            shutil.rmtree(str(child), ignore_errors=True)
        except OSError:
            continue
    return freed


def _cleanup_legacy_root(parent):
    """旧版本把缓存直接摊在用户选的目录里；升级后顺手清掉纯缓存的老目录。

    只有目录里除了标记和已知缓存子目录之外什么都没有时才动手；用户往里放过
    任何一个自己的文件，就原样留着，让用户自己处理。"""
    try:
        names = {child.name for child in Path(parent).iterdir()}
    except OSError:
        return
    allowed = set(cache.KINDS) | {CACHE_MARK, CACHE_SUBDIR}
    if names and names <= allowed:
        _clear_cache_dir(parent)


def apply_cache_root():
    """按当前配置把缓存目录指过去。返回 (实际用的目录, 说明)。
    换了目录就把旧缓存清掉——但只清 cache.KINDS 里的子目录，旧目录本身和
    里面的用户文件永远不动。缓存目录是"用户所选位置 / TulanCache"，
    和用户的资料物理隔开。"""
    global _cache_root_used, _cache_root_note, _cache_fell_back
    want = str(read_config().get("cache_root") or "").strip()
    target = _cache_target(want)
    note = ""
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".write"
        probe.write_text("1", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        reason = exc.strerror or exc.__class__.__name__
        target = config_dir() / "cache"
        cache.init(config_dir())
        note = "缓存目录不可用（" + reason + "），仍使用默认位置。"
        _cache_fell_back = True
    else:
        cache.repoint(target)
        # 底图瓦片也归缓存管：切目录/清空时一起走，不能留在旧 config_dir/tiles
        if "amap" in globals() and amap is not None:
            amap.set_cache_dir(target)
        _cache_fell_back = False
    with contextlib.suppress(OSError):
        (target / CACHE_MARK).write_text("tulan", encoding="utf-8")
    # 旧版本可能把缓存直接摊在所选目录里，升级后只清"纯缓存"的老目录
    if want and Path(want) != target:
        _cleanup_legacy_root(want)
    old = _cache_root_used
    _cache_root_used = target
    if old and Path(old) != target:
        freed = _clear_cache_dir(old)
        if freed >= 0:
            note = (note + " " if note else "") + (
                "旧缓存已清除（释放 " + _human_bytes(freed) + "）。" if freed else "旧缓存已清除。")
    _cache_root_note = note
    return target, note


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
                "副本目录不可用（" + reason + "），本次改用系统临时目录。")


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
    # 临时副本目录被占用时删不掉，留到下次启动的 sweep 再处理
    with contextlib.suppress(OSError):
        shutil.rmtree(root, ignore_errors=True)  # pi-lens-ignore: unchecked-throwing-call-python


def keep_hours():
    """异常退出留下的副本能存多久；正常退出是当场就删的。"""
    try:
        hours = float(read_config().get("keep_hours") or 12)
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


def _as_int(value, default=0):
    """HTTP 头、请求体、查询串里来的数字可能是脏的；坏值退回默认，不抛。"""
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _as_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _safe_name(raw):
    name = os.path.basename(str(raw).replace("\\", "/"))
    name = SAFE_NAME.sub("_", name)
    return name[:120] or "upload.bin"


def _readable(path):
    """只接受真实存在的本地路径，以及软件自己生成的压缩包虚拟路径。

    以前任何带冒号的写法（NETCDF:"..."、/vsicurl/...）都直接放行，等于把
    GDAL 的连接串能力暴露给了本地接口。这里收紧到 /vsizip/ 与 /vsitar/
    两种内部会用到的前缀；盘符路径先走 os.path.exists，不受影响。
    """
    if not path:
        return False
    if os.path.exists(path):
        return True
    low = path.lower()
    return low.startswith(("/vsizip/", "/vsitar/"))


# 配置文件是"读—改—写"三步：界面改一项设置就整份发过来，服务端读出旧内容、
# 改掉这一项、再整份写回。多个请求同时进来会互相踩——A 读到时还没 B 的改动，
# B 读到时也还没 A 的，各自写回就只剩后写的那个；更糟的是 write_text 先截断再写，
# 同一瞬间读到的可能是半个文件，json 解析失败后 read_config 返回空字典，
# 落盘就只剩本次那一项，其余设置全部丢失。一把锁串起整个流程，写盘换成
# 临时文件 + 原子替换，读的一侧永远看到完整的旧版或新版，不会是半截。
#
# 锁必须是可重入的：写配置的第一步就是 read_config()，普通 Lock 会当场自锁。
# 读也要在同一把锁里——Windows 上目标文件正被读着时 os.replace 会报"拒绝访问"，
# 光把写串起来没用，读的一端照样能把替换撞掉。
_cfg_lock = threading.RLock()


def _write_text_atomic(path, text):
    """整份替换而不是原地覆盖：写到一半断电/被杀，留下的还是上一次的完整内容。"""
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".cfg-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        # 别的进程（命令行同一份配置、杀毒软件扫文件）读着的窗口只有几十微秒，
        # 短等重试几次就过去了；一直不放就退回原地覆盖——本进程的读写已被锁串起来，
        # 这一步只防外部，退化也不至于写出半截，总比让界面报"保存失败"强
        for i in range(8):
            try:
                os.replace(tmp, path)
                tmp = None
                return
            except PermissionError:
                if i == 7:
                    break
                time.sleep(0.02)  # pi-lens-ignore: python-sleep-in-test -- 重试写配置的退避
        path.write_text(text, encoding="utf-8")  # pi-lens-ignore: python-path-traversal -- 配置目录内的固定文件名
    finally:
        if tmp and os.path.exists(tmp):
            Path(tmp).unlink(missing_ok=True)


def read_config():
    path = config_dir() / "config.json"
    with _cfg_lock:
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001  （转成界面能看懂的失败，不往上抛）
            return {}


def write_config(data):
    """把界面发来的改动合进配置文件。整段加锁，理由见 _cfg_lock。"""
    with _cfg_lock:
        return _write_config(data)


def _write_config(data):
    global _cache_note
    path = config_dir() / "config.json"
    allowed = {"theme", "basemap", "tianditu_key", "annotation", "max_features", "last_paths",
               "recent", "recent_max", "recent_meta",
               "ramp", "class_count", "nodata_view", "raster_default", "vector_color",
               "restore_last", "cache_dir", "cache_root", "keep_hours",
               "ui_font", "num_font", "ui_zoom", "panel_alpha", "unit_lang",
               "hk_mods", "hk_vk", "hk2_mods", "hk2_vk", "hk3_mods", "hk3_vk",
               "upd_freq", "close_act", "close_ask",
               "open_dir", "toast_sec", "set_sec",
               "key_close", "key_fit", "key_find", "draw_limit"}
    payload = read_config()
    for key, value in data.items():
        if key in allowed:
            payload[key] = value
    # 路径统一成 Windows 的规范写法：界面偶尔会送来正斜杠或重复分隔符
    # （D:////GISViewer-data////x 这种），存进去以后"最近打开"里显示得一塌糊涂
    for key in ("recent", "last_paths"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        fixed, seen = [], set()
        for item in items:
            if not isinstance(item, str) or not item.strip():
                continue
            clean = os.path.normpath(item)
            if clean in seen:
                continue
            seen.add(clean)
            fixed.append(clean)
        payload[key] = fixed
    _write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2))
    # 本轮的副本目录已经建好，中途换会把已复制的文件丢在原处，所以只能下次启动生效
    if _upload_root and str(payload.get("cache_dir") or "").strip() != _cache_dir_used:
        _cache_note = "本次仍使用 " + str(_upload_root) + "，副本目录的改动下次启动生效。"
    # 缓存位置改了立刻生效：缓存的读写都走 cache 模块，指过去就行，不用重启
    if "cache_root" in data:
        apply_cache_root()
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
    hist = raster.band_histogram(target, band_index, info["height"], info["width"], band["type"],
                                 nodata=band.get("nodata") if band.get("nodata_from") == "metadata" else None)
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


def _check_facts(result):
    """单文件体检表头那一行：什么格式、几个图层、多少要素、多大。
    实现放在 verdict 里，诊断包的 xlsx 用的是同一份。"""
    from . import verdict
    return verdict.facts(result)


def cached_safe_inspect(path, **kwargs):
    """safe_inspect 外面套缓存。失败的结果不缓存——文件可能马上就被修好。"""
    load_engine()
    if not _cacheable(path):
        return engine.safe_inspect(path, **kwargs)
    label = "&".join(f"{k}={v!r}" for k, v in sorted(kwargs.items()))
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
                  f"band={band_index};k={prefs['k']};ramp={prefs['ramp']}")
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
    except Exception:  # noqa: BLE001  （转成界面能看懂的失败，不往上抛）
        return 0, 0


def raster_grid(target, indexes, max_side=512, resampling="bilinear"):
    """出图用的像元网格：投影坐标系的数据先降采样、再转到 Web 墨卡托，返回 (波段数组列表, 经纬度框)。

    地图那一侧只能把一张图贴到四个角点上，而圆锥投影里数据的边是弧线：
    照原样出图，整幅影像会和底图错开（pre_2000_01.tif 就是这样）。
    先在原坐标系里降到 512 再转墨卡托，两步加起来不到半秒；
    直接对原文件开 WarpedVRT 要把上亿像元整个重算一遍，得两秒多。
    贴图的四角取同一个经纬度外框，和这里的网格范围一一对应。
    """
    import numpy as np  # pyright: ignore[reportMissingImports]
    import rasterio  # pyright: ignore[reportMissingImports]
    from rasterio.enums import Resampling  # pyright: ignore[reportMissingImports]
    from rasterio.transform import from_bounds  # pyright: ignore[reportMissingImports]
    from rasterio.warp import (  # pyright: ignore[reportMissingImports]
        reproject,
        transform_bounds,
    )

    from .crs import bounds_to_wgs84

    want = [_as_int(i, 1) for i in indexes]
    with rasterio.open(target) as src:
        want = [min(max(1, i), src.count) for i in want]
        ratio = max(1, math.floor(max(src.height, src.width) / max(1, max_side)) + 1)
        small_h, small_w = max(1, src.height // ratio), max(1, src.width // ratio)
        b = src.bounds
        box = [b.left, b.bottom, b.right, b.top]
        crs = src.crs
        geographic = crs is None or crs.is_geographic
        if not geographic and crs is not None:
            conv = bounds_to_wgs84(crs.wkt, b.left, b.bottom, b.right, b.top, densify=16)
            geographic = not conv
            box = conv or box
        if geographic:
            return [src.read(i, out_shape=(small_h, small_w), masked=True) for i in want], box

        out_w = max_side
        # 目标网格按 Web 墨卡托算，不按经纬度：地图那边是把一张图线性铺在四角点
        # 围成的墨卡托矩形里，转到经纬度会在中高纬被拉偏，影像和底图还是对不上
        mb = transform_bounds("EPSG:4326", "EPSG:3857", box[0], max(box[1], -84.9),
                              box[2], min(box[3], 84.9), densify_pts=2)
        out_h = max(1, round(out_w * (mb[3] - mb[1]) / max(1e-9, mb[2] - mb[0])))
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
    import numpy as np  # pyright: ignore[reportMissingImports]
    from rasterio.io import MemoryFile  # pyright: ignore[reportMissingImports]

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
        lo = comp.min().item()
        hi = comp.max().item()
        with contextlib.suppress(Exception):
            lo = np.percentile(comp, 2).item()
            hi = np.percentile(comp, 98).item()
        if hi <= lo:
            lo, hi = comp.min().item(), comp.max().item()
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
    import numpy as np  # pyright: ignore[reportMissingImports]
    from rasterio.io import MemoryFile  # pyright: ignore[reportMissingImports]

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

    def _authorized(self):
        """本地接口的会话令牌 + Host/Origin 校验。

        壳启动引擎时会生成随机 token，通过 GISVIEWER_TOKEN 传进来；
        开发时手动起服务、没有这个环境变量，就保持原来的无鉴权行为。
        """
        token = os.environ.get("GISVIEWER_TOKEN") or ""
        if not token:
            return True
        port = _as_int(getattr(self.server, "server_port", 0))
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if (self.headers.get("Host") or "") not in hosts:
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{h}" for h in hosts}:
            return False
        given = self.headers.get("X-GISViewer-Token") or ""
        if not given:
            given = (parse_qs(urlparse(self.path).query).get("t") or [""])[0]
        return hmac.compare_digest(given, token)


    def log_message(self, format, *args):
        if os.environ.get("GISVIEWER_DEBUG"):
            sys.stderr.write(f"{self.address_string()} {format % args}\n")

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            # 元数据里可能带着非 UTF-8 的原始字节（见 textutil.clean_text），
            # 直接 encode 会让整条响应 500，这里统一洗一遍再发
            text = json.dumps(engine_body(body) if isinstance(body, dict) else body,
                              ensure_ascii=False, default=str)
            body = clean_text(text).encode("utf-8")
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
        length = _as_int(self.headers.get("Content-Length"), 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001  （转成界面能看懂的失败，不往上抛）
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
        # 界面文件一律不缓存。WebView2 会按启发式规则把 app.js 存下来，
        # 换了新版本还拿旧脚本跑——改了半天看不到效果，就是这个原因
        headers = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}
        return self._send(200, target.read_bytes(),
                          types.get(target.suffix, "application/octet-stream"), headers)

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)
        if route.startswith("/api/") and not self._authorized():
            return self._send(403, {"ok": False, "error": {
                "title": "本机接口需要会话令牌",
                "hint": "请从图览启动；手动启动时用终端里打印的带 ?t= 的地址打开。"}})
        failed = _need_engine(route)
        if failed:
            return self._send(500, {"ok": False, "error": failed})
        if route in ("/", "/index.html"):
            return self._static("index.html")
        if route.startswith("/web/"):
            return self._static(route[5:])
        if route == "/api/formats":
            return self._send(200, {"ok": True, "raster": sorted(formats.RASTER_EXT),
                                    "vector": sorted(formats.VECTOR_EXT),
                                    "archive": sorted(formats.ZIP_LIKE),
                                    "menu": sorted(formats.MENU_EXT)})
        if route == "/api/preload":
            raw = os.environ.get("GISVIEWER_PRELOAD")
            try:
                paths = json.loads(raw) if raw else []
            except (TypeError, ValueError):
                paths = []
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
            payload.setdefault("open_dir", "")
            payload.setdefault("toast_sec", 5)
            payload.setdefault("draw_limit", 5000)
            payload.setdefault("key_close", "Esc")
            payload.setdefault("key_fit", "F")
            payload.setdefault("key_find", "Ctrl+F")
            payload["cache_note"] = _cache_note
            # 系统临时目录：界面上"副本存放位置"留空时实际用的就是这里，
            # 让它直接显示出来，不必让用户去猜
            payload["temp_dir"] = tempfile.gettempdir()
            # 缓存位置：设置里那一项、实际生效的目录、以及用不了时的原因
            payload.setdefault("cache_root", "")
            payload["cache_effective"] = str(cache_root_dir())
            payload["cache_fallback"] = _cache_fell_back
            return self._send(200, {
                "ok": True, "config": payload, "version": __version__,
                # 色带的端点颜色只在这里给一份，设置页照着画预览条，不再抄第二遍。
                # 放在 config 外面：它是"有哪些可选"的说明，不是用户的一项设置
                "ramps": [
                    {"value": key,
                     "label": formats.RAMP_META.get(key, (key, False))[0],
                     "discrete": bool(formats.RAMP_META.get(key, (key, False))[1]),
                     "colors": [f"rgb({c[0]},{c[1]},{c[2]})" for c in stops]}
                    for key, stops in formats.RAMPS.items()
                ],
            })
        if route == "/api/stamp":
            return self._send(200, {"ok": True,
                                    "stamp": _file_stamp((query.get("path") or [""])[0].strip())})
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
        if route == "/api/convert_formats":
            from . import convert
            return self._send(200, {"ok": True, "formats": convert.formats()})
        if route == "/api/column":
            return self._column(query)
        if route == "/api/cache":
            return self._send(200, {"ok": True, "cache": cache.stats(),
                                    "data_dir": str(config_dir()),
                                    "cache_dir": str(cache_root_dir())})
        if route == "/api/dwg/status":
            return self._dwg_status(query)
        if route.startswith("/api/tile/"):
            return self._amap_tile(route)
        return self._send(404, {"ok": False, "error": {"title": "没有这个接口"}})

    def do_POST(self):
        route = urlparse(self.path).path
        if route.startswith("/api/") and not self._authorized():
            return self._send(403, {"ok": False, "error": {
                "title": "本机接口需要会话令牌",
                "hint": "请从图览启动；手动启动时用终端里打印的带 ?t= 的地址打开。"}})
        failed = _need_engine(route)
        if failed:
            return self._send(500, {"ok": False, "error": failed})
        if route == "/api/path":
            body = self._json_body()
            return self._inspect(str(body.get("path", "")).strip(),
                                 fast=bool(body.get("fast")))
        if route == "/api/upload":
            return self._upload()
        if route == "/api/config":
            body = self._json_body()
            payload = write_config(body)
            # 写完把"实际生效的缓存目录"和失败标记一起回给界面：
            # 生效目录是"所选位置 / TulanCache"，和用户选的父目录本来就不是同一条路径，
            # 界面不能再靠比对两条路径判断有没有回退。
            return self._send(200, {"ok": True, "config": payload,
                                    "cache_note": _cache_note,
                                    "cache_effective": str(cache_root_dir()),
                                    "cache_fallback": _cache_fell_back,
                                    "cache_root_note": _cache_root_note})
        if route == "/api/dwg/cancel":
            body = self._json_body()
            path = str(body.get("path", "")).strip()
            return self._send(200, {"ok": True, "cancelled": bool(dwg.cancel(path))})
        if route == "/api/vindex/prebuild":
            body = self._json_body()
            return self._vindex_prebuild(str(body.get("path", "")).strip(),
                                         body.get("layer", 0))
        if route == "/api/cache":
            # 设置页的"清空缓存"：清完把新一轮的占用直接带回去
            cache.clear()
            return self._send(200, {"ok": True, "cache": cache.stats(),
                                    "data_dir": str(config_dir()),
                                    "cache_dir": str(cache_root_dir()),
                                    "cache_fallback": _cache_fell_back})
        if route == "/api/check":
            return self._check(self._json_body())
        if route == "/api/convert":
            from . import convert
            body = self._json_body()
            return self._send(200, convert.convert(
                body.get("path"), _as_int(body.get("layer")),
                str(body.get("fmt") or "geojson"), body.get("out_dir"),
                dry=bool(body.get("dry")), suffix=body.get("suffix"),
                overwrite=bool(body.get("overwrite"))))
        if route == "/api/diagnose":
            return self._diagnose(self._json_body())
        return self._send(404, {"ok": False, "error": {"title": "没有这个接口"}})

    def _check(self, body):
        """批量体检：文件夹展开成逐个文件，出结论，并与上一次的报告对比。

        每跑一次就把这份结果存成"上次报告"，下一次自动和它比——命令行的
        --check / --out / --diff 三件事在这里合成一次请求，界面与命令行同一份实现。
        """
        from . import report, verdict
        paths = body.get("paths") or []
        if isinstance(paths, str):
            paths = [paths]
        paths = [str(p).strip() for p in paths if str(p).strip()]
        if not paths:
            return self._send(400, {"ok": False, "error": {
                "title": "未指定文件或文件夹",
                "hint": "填写一个文件夹，软件会对其中的每份数据逐个体检。"}})
        started = time.time()
        targets, truncated = report.expand_paths(paths)
        results = [engine.safe_inspect(p, compute_stats=False, histograms=False)
                   for p in targets]
        folder = config_dir() / "checks"
        prev_path = folder / "last.json"
        prev = report.load(str(prev_path))
        old = report.load_by_path(str(prev_path))
        files = []
        summary = {"bad": 0, "warn": 0, "ok": 0}
        single = len(results) == 1
        for r in results:
            v = verdict.judge(r)
            summary[v["level"]] = summary.get(v["level"], 0) + 1
            f = r.get("file") or {}
            path = f.get("path") or r.get("input")
            before = old.get(report.norm(path))
            item = {
                "path": path,
                "name": f.get("name") or (os.path.basename(str(path)) if path else "（未命名）"),
                "kind": r.get("kind"),
                "level": v["level"],
                "items": v["items"],
                "changes": verdict.compare(before, r) if before else None,
            }
            # 只查了一个文件时，界面要铺一张完整体检表：逐项结论 + 这份数据的基本事实。
            # 查文件夹时这些字段没人用，多传就是几百份空数组
            if single:
                item["rows"] = v.get("rows") or []
                item["facts"] = _check_facts(r)
            files.append(item)
        # 落盘只是给"下次对比"和"导出诊断包"用的，写不进去不能连累这一次的结论
        with contextlib.suppress(Exception):
            folder.mkdir(parents=True, exist_ok=True)
            report.save(report.build(results), str(prev_path))
        return self._send(200, {
            "ok": True, "elapsed_ms": round((time.time() - started) * 1000, 1),
            "files": files, "summary": summary,
            "truncated": truncated, "limit": report.DIR_LIMIT,
            "prev_at": (prev or {}).get("generated"),
            "report_path": str(prev_path),
        })

    def _diagnose(self, body):
        """诊断包：环境信息 + 最近一次体检的结论，打包成一个 zip。

        界面上的入口在体检浮层里，导出的就是用户刚看到的那份结论，不重跑一遍——
        重跑既慢，又可能与屏幕上显示的结论对不上。只有从来没体检过（命令行第一次
        就 --diagnose）时，才按给定路径现查一份。
        """
        from . import report
        paths = body.get("paths") or []
        if isinstance(paths, str):
            paths = [paths]
        paths = [str(p).strip() for p in paths if str(p).strip()]
        last = report.load(str(config_dir() / "checks" / "last.json"))
        results = (last or {}).get("files") or []
        if not results and paths:
            results = [engine.safe_inspect(p, compute_stats=False, histograms=False)
                       for p in report.expand_paths(paths)[0]]
        if not results:
            return self._send(400, {"ok": False, "error": {
                "title": "暂无可导出的体检结果",
                "hint": "请先在体检浮层中执行一次体检，再导出诊断包。"}})
        folder = config_dir() / "diag"
        zip_path = report.write_zip_at(results, str(folder))
        if not zip_path:
            return self._send(500, {"ok": False, "error": {
                "title": "诊断包未能生成", "hint": "确认磁盘空间充足，或更换保存位置后重试。"}})
        return self._send(200, {"ok": True, "path": zip_path,
                                "size_label": labels.human_size(os.path.getsize(zip_path))})

    def _inspect(self, path, fast=False):
        if not path:
            return self._send(200, {"ok": False,
                                    "error": {"title": "未指定文件", "hint": "将文件拖入窗口，或填写完整路径。"}})
        # fast=True：矢量跳过"数个数、量范围"这两步全文件扫描，先把界面立起来，
        # 缺的数字由页面在取数完成后回填（见 app.js 里 gis:vector 的处理）
        result = cached_safe_inspect(path, histograms=False, quick=fast)
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

    def _column(self, query):
        """整列复制用：只返回某一列的全部取值，不碰几何、不碰别的字段。"""
        path = (query.get("path") or [""])[0].strip()
        field = (query.get("field") or [""])[0].strip()
        try:
            layer = int((query.get("layer") or ["0"])[0])
        except ValueError:
            layer = 0
        if not path or not field:
            return self._send(400, {"ok": False, "error": {"title": "参数不对"}})
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            data = vector.column_values(path, layer, field)
        except Exception as exc:  # noqa: BLE001
            return self._send(200, engine.error_block(exc, path))
        data["ok"] = True
        return self._send(200, data)

    def _geomtypes(self, query):
        """信息栏"几何类型"那一行的补充数据：混合类型的图层各有多少个，慢就慢点，界面异步来问。"""
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            layer = int((query.get("layer") or ["0"])[0])
        except ValueError:
            return self._send(400, {"ok": False, "error": {"title": "参数不对"}})
        k = cache.key("gtypes3", path, f"layer={layer}") if _cacheable(path) else None
        if k:
            started = time.perf_counter()
            hit = cache.load_json("gtypes", k)
            if hit is not None:
                return self._send(200, _stamp_elapsed(hit, started))
        try:
            data = vector.geom_type_counts(path, layer)
        except Exception as exc:  # noqa: BLE001
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
        except Exception as exc:  # noqa: BLE001
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
        # 只进进程内 LRU，不落盘：单条几 MB，落盘会把 prune 的预算吃光。
        # 键里带上抽稀容差和 bbox，视野一变就自然换键。翻页请求不占缓存。
        vkey = None
        if _cacheable(path) and offset == 0:
            box = ",".join(f"{v:.4f}" for v in bbox) if bbox else "-"
            vkey = cache.key("vec", path,
                             f"layer={layer};limit={limit};tol={tolerance:.6g};"
                             f"box={box};g={1 if with_geometry else 0}")
            started = time.perf_counter()
            hit = cache.load_vec(vkey)
            if hit is not None:
                # 索引刚建好、或后台建索引已经结束，旧响应里的 indexed/indexing
                # 就过期了：别把“正在建索引”的旧图一直喂给前端。命中时只做两次
                # 轻量文件检查，不再扫数据。
                meta = hit.get("gisviewer") or {}
                from . import vindex  # 延迟导入，别让 server 一启动就拉 GDAL
                stale = (not meta.get("indexed") and vindex.existing(path, layer) is not None)                     or (bool(meta.get("indexing")) and not vindex.building(path, layer))
                if not stale:
                    if isinstance(hit.get("gisviewer"), dict):
                        hit["gisviewer"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
                        hit["gisviewer"]["cached"] = True
                    return self._send(200, _stamp_elapsed(hit, started))

        # 总要素数不再单独跑一遍全量 inspect：read_features 本来就要打开并扫一遍，
        # 没索引的 GeoJSON 再数一次等于把三秒多的解析重复一遍。索引路径和
        # 支持 GetFeatureCount 的驱动会自己带总数；没有的，右栏稍后由全量检查补。
        started = time.perf_counter()
        try:
            data = vector.read_features(path, layer, bbox, limit, tolerance,
                                        offset=offset, with_geometry=with_geometry)
        except Exception as exc:  # noqa: BLE001
            return self._send(200, engine.error_block(exc, path))
        data["gisviewer"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        data["ok"] = True
        if vkey:
            # 别让单条太大的响应占住内存：超过 48 MB 的就不存了
            with contextlib.suppress(Exception):
                body = json.dumps(data, ensure_ascii=False, default=str)
                if len(body) < 48 * 1024 * 1024:
                    cache.save_vec(vkey, data, len(body))
        return self._send(200, data)

    def _vindex_prebuild(self, path, layer):
        """打开大文件后由前端叫一声，在子进程里预建索引；请求本身立即返回。"""
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            layer = max(0, int(layer))
        except (TypeError, ValueError):
            layer = 0
        from . import vindex  # 延迟导入，别让 server 一启动就拉 GDAL
        if os.path.getsize(path) < vindex.MIN_BYTES:
            return self._send(200, {"ok": True, "skipped": "small"})
        if vindex.existing(path, layer):
            return self._send(200, {"ok": True, "indexed": True})
        vindex.ensure(path, layer)
        return self._send(200, {"ok": True, "started": True,
                                "building": vindex.building(path, layer)})

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
        try:
            with open(target, "rb") as fh:  # pi-lens-ignore: python-path-traversal -- tileset.tile_path 拼出的路径
                body = fh.read()
        except OSError:
            return self._send(404, {"ok": False, "error": {"title": "这张瓦片读不出来"}})
        return self._send(200, body, TILE_TYPES[ext],
                         {"Cache-Control": "public, max-age=3600"})

    def _dwg_status(self, query):
        path = str((query.get("path") or [""])[0]).strip()
        return self._send(200, {"ok": True, **dwg.status(path)})

    def _amap_tile(self, route):
        m = TILE_ROUTE.match(route)
        if not m:
            return self._send(404, {"ok": False, "error": {"title": "没有这条瓦片路径"}})
        # 正则里就是 \d+，不会不是数字
        z, x, y = (int(m.group(2)), int(m.group(3)),  # pi-lens-ignore: unchecked-numeric-parse-python
                   int(m.group(4)))
        try:
            png = amap.render(z, x, y)
        except Exception as exc:  # noqa: BLE001
            return self._send(200, {"ok": False, "error": {
                "title": "底图纠偏失败", "detail": labels.friendly_error(exc)[:200]}})
        if not png:
            return self._send(404, {"ok": False, "error": {"title": "这一级没有这张瓦片"}})
        return self._send(200, png, "image/png", {"Cache-Control": "public, max-age=86400"})

    def _thumbnail(self, query):
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        edges = []
        for raw in (query.get("edges") or [""])[0].split(","):
            if not raw.strip():
                continue
            value = _as_float(raw)
            if value is None:
                return self._send(400, {"ok": False, "error": {
                    "title": "分级断点不是数字", "detail": raw.strip()[:30]}})
            edges.append(value)
        colors = [v.strip() for v in (query.get("colors") or [""])[0].split(",") if v.strip()]
        cacheable = _cacheable(path)
        try:
            if edges and len(edges) >= 3 and len(colors) == len(edges) - 1:
                band_index = int((query.get("band") or ["1"])[0])
                fill = view_prefs()["nodata"]
                label = (f"class;band={band_index};edges={','.join(str(e) for e in edges)};"
                         f"colors={','.join(colors)};fill={fill}")
                k = cache.key("thumb", path, label) if cacheable else None
                png = cache.load_blob("thumb", k)
                if png is None:
                    png, _w, _h = class_image(path, band_index, edges, colors, fill=fill)
                    cache.save_blob("thumb", k, png)
            else:
                band_count = int((query.get("bands") or ["1"])[0])
                k = cache.key("thumb", path, f"bands={band_count}") if cacheable else None
                png = cache.load_blob("thumb", k)
                if png is None:
                    png, _w, _h = thumbnail(path, band_count)
                    cache.save_blob("thumb", k, png)
        except Exception as exc:  # noqa: BLE001
            return self._send(200, {"ok": False, "error": {
                "title": "影像预览生成失败", "detail": labels.friendly_error(exc)[:200]}})
        w, h = _png_size(png)
        return self._send(200, png, "image/png", {"X-Image-Width": str(w), "X-Image-Height": str(h)})

    def _identify(self, query):
        """只给栅格用：点一个位置，报出该像元的行列号和数值。

        矢量点选在界面上走的是地图自己渲染出来的要素（MapLibre 的
        queryRenderedFeatures），点中的就是眼前画出来的那些，不需要引擎再扫一遍文件。
        """
        path = (query.get("path") or [""])[0].strip()
        if not _readable(path):
            return self._send(404, {"ok": False, "error": {"title": "找不到这个文件"}})
        try:
            lon = float((query.get("lng") or [""])[0])
            lat = float((query.get("lat") or [""])[0])
        except ValueError:
            return self._send(400, {"ok": False, "error": {"title": "点击位置不对"}})
        if (query.get("kind") or ["raster"])[0] != "raster":
            return self._send(400, {"ok": False, "error": {
                "title": "这个接口只处理栅格",
                "hint": "矢量要素请直接点地图，界面拿渲染出来的要素判断点中了谁。"}})
        try:
            got = raster.identify_value(path, lon, lat)
            if not got:
                return self._send(200, {"ok": False, "error": {
                    "title": "这个位置没有读到像元",
                    "hint": "点击处可能落在数据范围外，或者这张图没有地理参考。"}})
            return self._send(200, {"ok": True, "kind": "raster", "identify": got})
        except Exception as exc:  # noqa: BLE001
            return self._send(200, engine.error_block(exc, path))

    def _upload(self):
        # 前端用 encodeURIComponent 传中文名，HTTP 头只允许 latin-1
        name = _safe_name(unquote(self.headers.get("X-File-Name") or "upload.bin"))
        group = _safe_name(unquote(self.headers.get("X-Group") or ""))
        length = _as_int(self.headers.get("Content-Length"), 0)
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
            with open(target, "wb") as fh:  # pi-lens-ignore: python-path-traversal -- 上传目录内、_safe_name 过滤过的名字
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
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
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
            time.sleep(0.5)  # pi-lens-ignore: python-sleep-in-test -- 守护父进程的轮询

    threading.Thread(target=loop, daemon=True).start()  # pi-lens-ignore: python-thread-global-write


def serve(port=0, open_browser=True, quiet=False):
    t = time.perf_counter()
    watch_parent()
    sweep_stale_uploads()
    atexit.register(cleanup_uploads)
    # 启动就按配置定缓存目录：自定义过的话直接指过去，不再先落到默认位置
    apply_cache_root()
    chosen = pick_port(port)
    httpd = ThreadingHTTPServer(("127.0.0.1", chosen), Handler)
    _phase(t, "可以应答")
    # 端口已经在了，界面能发出去了；GDAL 在后台预热，等用户真的丢文件时多半已经好了
    threading.Thread(target=_warm_engine, name="gisviewer-warm",  # pi-lens-ignore: python-thread-global-write
                     daemon=True).start()
    # 缓存超容量时在后台清一次，不挡启动
    threading.Thread(target=cache.prune, name="gisviewer-cache-prune",  # pi-lens-ignore: python-thread-global-write
                     daemon=True).start()
    token = os.environ.get("GISVIEWER_TOKEN") or ""
    url = f"http://127.0.0.1:{chosen}/" + (f"?t={token}" if token else "")
    if not quiet:
        print(f"GISViewer 已启动：{url}")
        if not token:
            print("开发模式：未设置 GISVIEWER_TOKEN，本机接口不校验令牌。")
        print("按 Ctrl+C 停止")
    if open_browser:
        # 浏览器启动器，不是文件路径
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()  # pi-lens-ignore: python-thread-global-write, python-path-traversal
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass  # pi-lens-ignore: python-empty-except -- Ctrl+C 是正常退出
    finally:
        httpd.server_close()
        cleanup_uploads()
    return 0


def _warm_engine():
    try:
        load_engine()
        amap.set_cache_dir(cache_root_dir())
    except Exception:  # noqa: BLE001  （转成界面能看懂的失败，不往上抛）
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
