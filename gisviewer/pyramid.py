"""按需金字塔：把大影像降采样一份放进缓存，放大缩小的时候少读原图。

为什么要有这个模块：地图上每次换视野都要“读原图的一块 → 重投影”。
视野越往外拉，要读的原图像元越多，读盘和重采样的时间就压在拖动的手感上。
ArcGIS Pro 和 QGIS 的做法是首次打开时问一句“要不要建金字塔”，建完之后
按层级读，粗视图只碰少数几个块。这里照做，只是把金字塔放到本机缓存里
（`pyramid/<指纹>.tif`），不往用户的数据目录里写任何东西——这个软件是只读阅览器，
不该在别人的文件夹里留下接近原图大小的文件。

和 QGIS 的另一个差别：它们的 `.ovr` 是紧挨着原文件的旁挂文件，GDAL 自动认；
我们的副本由 raster.py 自己挑（见 pyramid.pick），原文件一个字节都不动。

副本本身是“降采样后的底图 + 内建层级”：底图最多 4096 像素长边（按波段数和
数据类型自动往下调，单个副本不超过 BUDGET），层级 2/4/8/…/32。这样往里放大的
时候仍然读原图（那里才有一比一的细节），往外拉的时候读副本。
"""

from __future__ import annotations

import contextlib
import shutil
import threading
import time
from pathlib import Path

from . import cache

# 副本底图的长边上限：再大就只是把原图抄一遍，收益抵不上磁盘
BASE_MAX = 4096
# 单个副本的上限。float32 三波段在 4096 上是 200 MB，按这个预算往下压到 2048 甚至 1024
BUDGET = 220 * 1024 * 1024
LEVELS = (2, 4, 8, 16, 32)
# 原图小于这个规模就别建了：读一次本来就只有几十毫秒
MIN_PIXELS = 12_000_000
MIN_BYTES = 24 * 1024 * 1024

_RESAMPLE = {"nearest", "average", "bilinear", "cubic", "lanczos", "gauss"}

_lock = threading.Lock()
_jobs: dict[str, dict] = {}       # 指纹 -> {thread, started, total, done, cancel, error}
_CACHE: dict[str, tuple[float, Path | None]] = {}   # 原文件 -> (mtime, 副本路径)


def _fingerprint(target):
    """缓存键：路径 + 大小 + 修改时间。原文件一改，旧副本自动作废。

    文件读不到时 key() 返回 None，这里给个不会撞上的占位值——建副本本来也会失败，
    但别让调用方每次都去判空。"""
    return cache.key("pyramid", str(target), "v1") or ("0" * 40)


def _dest(target):
    return cache.blob_path("pyramid", _fingerprint(target), ".tif")


def current(target):
    """已经建好的副本路径；没有就 None。"""
    key = str(target)
    try:
        mtime = Path(target).stat().st_mtime
    except OSError:
        return None
    with _lock:
        hit = _CACHE.get(key)
        # 记着的路径也要当场确认还在：用户点“清空缓存”或超预算被 prune 删掉之后，
        # 这里再返回一个不存在的文件，raster_grid 就会拿它去开而报错
        # 命中也可能记的是 None（缓存目录没初始化时查过一次），Path(None) 会抛 TypeError
        if hit and hit[1] and abs(hit[0] - mtime) < 1e-6 and Path(hit[1]).exists():
            return hit[1]
    dest = _dest(target)
    found = dest if dest is not None and dest.exists() else None
    with _lock:
        _CACHE[key] = (mtime, found)
    if found is not None:
        # 读到就顺手碰一下时间戳：清理按“最久没用”挑，刚用过的副本不该先走
        with contextlib.suppress(OSError):
            found.touch()
    return found


def size_of(path):
    """副本的像素宽高；读不到返回 None。"""
    import rasterio  # pyright: ignore[reportMissingImports]

    try:
        with rasterio.open(path) as ds:  # pi-lens-ignore: python-path-traversal -- 用户自己打开的文件
            return ds.width, ds.height
    except Exception:  # noqa: BLE001
        return None


def pick(target, src_width, need_ratio):
    """视野要多少原图像元换一个输出像元时，用副本划不划算。

    副本是原图的 1/factor。视野要求的分辨率（need_ratio = 原图像元/输出像元）
    只要不细于 factor，读副本就一点都不糊；细于它就得回原图，那里才有一比一的细节。
    """
    kept = current(target)
    if kept is None:
        return None
    dims = size_of(kept)
    if not dims or not src_width:
        return None
    factor = src_width / max(1, dims[0])
    return kept if need_ratio >= factor * 0.98 else None


def _levels_of(path):
    import rasterio  # pyright: ignore[reportMissingImports]

    with rasterio.open(path) as ds:  # pi-lens-ignore: python-path-traversal -- 用户自己打开的文件
        return [int(f) for f in (ds.overviews(1) or [])]  # pi-lens-ignore: unchecked-numeric-parse-python


def _looks_categorical(ds):
    """按一小块原始像元猜是不是分类图：整型、取值少、数值小，三者都满足才算。

    只看 dtype 不够：高程也是 int16，但它不是分类数据，缩小时用最近邻会出
    台阶。分类图的取值是离散编号（0、1、2 或者 11、12、13），取中间一小块
    通常只有几个到几十个不同值；连续数据在同一块里动辄几百个不同值。
    读一块原始尺寸的 160×160 像元，几十毫秒，代价可以接受。
    """
    import numpy as np  # pyright: ignore[reportMissingImports]

    with contextlib.suppress(Exception):
        dtype = (ds.dtypes[0] if ds.dtypes else "").lower()
        if not dtype.startswith(("int", "uint")):
            return False
        w = min(160, ds.width)
        h = min(160, ds.height)
        if w < 2 or h < 2:
            return False
        x0 = max(0, (ds.width - w) // 2)
        y0 = max(0, (ds.height - h) // 2)
        arr = ds.read(1, window=((y0, y0 + h), (x0, x0 + w)), masked=True)
        vals = arr.compressed()
        if vals.size == 0:
            return False
        uniq = np.unique(vals)
        if uniq.size > 64:
            return False
        return bool(np.abs(uniq).max() <= 4096)
    return False


def status(target):
    """界面弹窗要的信息：值不值得建、建了没有、有多大、正在建吗。"""
    info = {
        "ok": True,
        "path": str(target),
        "recommend": False,
        "reason": "",
        "width": 0,
        "height": 0,
        "size": 0,
        "has_overviews": False,
        "pyramid": {"exists": False, "size": 0, "levels": []},
        "running": False,
        "elapsed": 0.0,
        "progress": 0.0,
    }
    try:
        import rasterio  # pyright: ignore[reportMissingImports]

        with rasterio.open(target) as ds:  # pi-lens-ignore: python-path-traversal -- 用户自己打开的文件
            info["width"], info["height"] = ds.width, ds.height
            info["has_overviews"] = bool(ds.overviews(1))
            info["bands"] = ds.count
            info["dtype"] = ds.dtypes[0] if ds.dtypes else ""
            # 带调色板的多半是分类图（土地利用、掩膜）：副本只能用最近邻，
            # 否则平均值会造出原数据里不存在的类别
            with contextlib.suppress(Exception):
                ds.colormap(1)
                info["colortable"] = True
            # 没有调色板也要认得出分类图：土地利用、掩膜这类数据常常是裸的整型
            info["categorical"] = bool(info.get("colortable")) or _looks_categorical(ds)
    except Exception as exc:  # noqa: BLE001
        info["recommend"] = False
        info["reason"] = f"读不了这个文件：{exc}"[:120]
        return info
    with contextlib.suppress(OSError):
        info["size"] = Path(target).stat().st_size

    job = _jobs.get(_fingerprint(target))
    if job:
        info["running"] = bool(job["thread"].is_alive())
        info["elapsed"] = round(time.perf_counter() - job["started"], 1)
        total = max(1, job["total"])
        info["progress"] = round(min(1.0, job["done"] / total), 3)
        if job.get("error"):
            info["error"] = job["error"]

    kept = current(target)
    if kept is not None:
        info["pyramid"] = {"exists": True, "size": kept.stat().st_size,
                           "levels": _levels_of(kept)}

    pixels = info["width"] * info["height"]
    info["levels"] = list(LEVELS)
    if info["has_overviews"]:
        info["reason"] = "原文件已包含金字塔，无需重复创建。"
    elif pixels < MIN_PIXELS and info["size"] < MIN_BYTES:
        info["reason"] = ("该影像尺寸较小，读取一次耗时不长，创建金字塔带来的提升有限。"
                          if not info["width"] else
                          f"该影像为 {info['width']:,}×{info['height']:,} 像素、"
                          f"{info['size'] / 1024 / 1024:.1f} MB，尺寸较小，"
                          "创建金字塔带来的提升有限。")
    else:
        info["recommend"] = True
        info["reason"] = (f"该影像为 {info['width']:,}×{info['height']:,} 像素、"
                          f"{info['size'] / 1024 / 1024:.0f} MB，尚未建立金字塔。"
                          "创建后在缩放浏览时只需读取相应级别的副本，不再重复读取原始像元。")
    return info


def building(target):
    job = _jobs.get(_fingerprint(target))
    return bool(job and job["thread"].is_alive())


def _base_side(src):
    """副本底图的长边：按单波段字节数压预算，别为了 4096 把内存吃光。"""
    cell = _ITEM_BYTES.get(str(src.dtypes[0]), 4) if src.dtypes else 4
    per_row = max(1, src.count) * cell
    limit = int((BUDGET / max(1, per_row)) ** 0.5)  # pi-lens-ignore: unchecked-numeric-parse-python
    return max(512, min(BASE_MAX, limit))


_ITEM_BYTES = {"uint8": 1, "int8": 1, "int16": 2, "uint16": 2, "int32": 4,
               "uint32": 4, "float32": 4, "float64": 8, "int64": 8, "uint64": 8}


def build(target, resample="average", blocking=False):
    """建副本。默认起线程，返回状态；blocking=True 时直接跑完（测试用）。"""
    resample = resample if resample in _RESAMPLE else "average"
    key = _fingerprint(target)
    with _lock:
        job = _jobs.get(key)
        if job and job["thread"].is_alive():
            return {"ok": True, "started": False, "running": True}
    dest = _dest(target)
    if dest is None:
        return {"ok": False, "started": False, "error": "缓存目录不可用"}
    part = dest.with_suffix(".part")

    def work():
        job = _jobs[key]
        try:
            _write(str(target), str(part), resample, job)
            part.replace(dest)
            with _lock:
                _CACHE[str(target)] = (Path(target).stat().st_mtime, dest)
        except Exception as exc:  # noqa: BLE001
            job["error"] = f"{type(exc).__name__}: {exc}"[:200]
            shutil.rmtree(part, ignore_errors=True)
        finally:
            job["done"] = job["total"]

    job = {"started": time.perf_counter(), "total": 1, "done": 0, "cancel": False,
           "error": ""}
    # 建副本在后台线程里跑：这个线程只写自己那条 job 与 .part 临时文件，
    # 对外可见的状态都在 _lock 里改，不碰别的共享数据
    job["thread"] = threading.Thread(target=work, name="tulan-pyramid", daemon=True)  # pi-lens-ignore: python-thread-global-write
    with _lock:
        _jobs[key] = job
    if blocking:
        job["thread"].start()
        job["thread"].join()
        return {"ok": not job["error"], "started": True, "running": False,
                "error": job["error"], "path": str(dest)}
    job["thread"].start()
    return {"ok": True, "started": True, "running": True}


def cancel(target):
    """停下正在建的副本。已经写完的块不管，半成品删掉。"""
    job = _jobs.get(_fingerprint(target))
    if not job:
        return {"ok": True, "cancelled": False}
    job["cancel"] = True
    return {"ok": True, "cancelled": True}


def _write(target, dest, resample, job):
    """分块读原图、降采样、写副本，再补建层级。

    整幅读进来对 4 万×4 万、三波段 float32 的影像就是几十 GB，只能一块一块来。
    """
    import numpy as np  # pyright: ignore[reportMissingImports]
    import rasterio  # pyright: ignore[reportMissingImports]
    from rasterio.enums import Resampling  # pyright: ignore[reportMissingImports]
    from rasterio.transform import Affine  # pyright: ignore[reportMissingImports]

    method = Resampling[resample]
    with rasterio.open(target) as src:  # pi-lens-ignore: python-path-traversal -- 用户自己打开的文件
        side = _base_side(src)
        factor = max(1, round(max(src.width, src.height) / side))
        out_w = max(1, round(src.width / factor))
        out_h = max(1, round(src.height / factor))
        tf = src.transform * Affine.scale(src.width / out_w, src.height / out_h)
        prof = {
            "driver": "GTiff", "width": out_w, "height": out_h, "count": src.count,
            "dtype": src.dtypes[0], "crs": src.crs, "transform": tf,
            "nodata": src.nodata, "tiled": True, "blockxsize": 256, "blockysize": 256,
            "compress": "deflate", "predictor": 2 if str(src.dtypes[0]).startswith("int") else 3,
            "BIGTIFF": "IF_SAFER",
        }
        tile = 1024
        cols = (out_w + tile - 1) // tile
        rows = (out_h + tile - 1) // tile
        job["total"] = max(1, cols * rows)
        job["done"] = 0
        with rasterio.open(dest, "w", **prof) as dst:  # pi-lens-ignore: python-path-traversal -- 目标在缓存目录里，路径自己拼的
            for ty in range(rows):
                for tx in range(cols):
                    if job["cancel"]:
                        raise RuntimeError("已取消")
                    x0, y0 = tx * tile, ty * tile
                    w = min(tile, out_w - x0)
                    h = min(tile, out_h - y0)
                    # 目标块在原图里的位置：把副本的窗口换算回原分辨率
                    sx0 = round(x0 * src.width / out_w)
                    sy0 = round(y0 * src.height / out_h)
                    sx1 = round((x0 + w) * src.width / out_w)
                    sy1 = round((y0 + h) * src.height / out_h)
                    # 窗口用 ((行起, 行止), (列起, 列止)) 的写法：rasterio 两种都收，
                    # 这种不依赖 Window 的类型存根，也省一次 import
                    win = ((sy0, max(sy0 + 1, sy1)), (sx0, max(sx0 + 1, sx1)))
                    block = src.read(window=win, out_shape=(src.count, h, w),
                                     resampling=method)
                    dst.write(block, window=((y0, y0 + h), (x0, x0 + w)))
                    job["done"] += 1
            dst.build_overviews(list(LEVELS), method)
            dst.update_tags(ns="rio_overview", resampling=resample)
        _ = np  # numpy 只在 src.read 的 out_shape 路径上间接用到，留着便于将来插值
