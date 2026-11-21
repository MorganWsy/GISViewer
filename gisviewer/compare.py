"""两份同类文件的对照：元信息、字段结构、内容抽样、顶点数量。

定位是"快速阅览"，所以这里只做只读对照：

- 元信息：大小、修改时间、格式、图层、几何类型、要素个数、顶点总数、范围、坐标系
- 字段：名称、类型、宽度、精度，标出只在一边出现的、类型或宽度不同的
- 内容：前若干行逐格对照。**按行号对齐**，不做按主键的配对。真要逐要素比对，
  得先由用户指定一个能唯一标识要素的字段（ArcGIS Pro 的 Feature Compare 就叫它
  Sort Field），那是数据质检流程，不属于"看一眼"的范围，这里不做，也不假装做了。
- 栅格：尺寸、波段、数据类型、像元大小、范围、坐标系、NoData、压缩、金字塔、统计

顶点数量要把几何从头到尾走一遍。大文件按时间与要素数两道闸，超了就标成部分统计，
两份都按同样的闸停下来，比较的仍是同一段范围。
"""

from __future__ import annotations

import contextlib
import os
import time

from . import formats, raster, vector
from .errors import InspectError

SAMPLE_ROWS = 20
SCAN_SECONDS = 8.0
SCAN_FEATURES = 200_000
MAX_CELLS = 300


class CompareError(InspectError):
    """给界面看的错误：一句话标题，一行详情，一条提示。"""


def _kind(path):
    ext = os.path.splitext(str(path))[1].lower()
    if ext in formats.RASTER_EXT:
        return "raster"
    if ext in formats.VECTOR_EXT:
        return "vector"
    # 不认识的后缀：按能打开的那个来判断，两边都打不开就交给调用方报错
    with contextlib.suppress(Exception):
        raster.inspect(str(path))
        return "raster"
    with contextlib.suppress(Exception):
        vector.inspect(str(path))
        return "vector"
    return ""


def _stamp(path):
    # 文件刚被删掉、被独占锁住都算"取不到"，对照表里留空就好，不必让整张表失败
    try:
        info = os.stat(path)
    except OSError:
        return 0, ""
    return int(info.st_size), time.strftime("%Y-%m-%d %H:%M", time.localtime(info.st_mtime))


def _bytes(n):
    if not n:
        return ""
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} MB"
    return f"{n / 1024:.0f} KB"


def _num(v, digits=6):
    if v is None or isinstance(v, str):
        return "" if v is None else v
    with contextlib.suppress(TypeError, ValueError):
        return f"{float(v):.{digits}f}".rstrip("0").rstrip(".")
    return str(v)


def _box(box):
    """范围写成一句话。矢量那边给的是 {left,right,bottom,top}，栅格这边是四元组，
    两种形状都收，界面上就不必关心来源。"""
    if not box:
        return ""
    if isinstance(box, dict):
        values = [box.get(k) for k in ("left", "bottom", "right", "top")]
    else:
        values = list(box)[:4]
    if len(values) < 4 or any(v is None for v in values):
        return ""
    return "  ".join(_num(v) for v in values)


def _open(target):
    real = vector.read_target(str(target))
    return vector._open_vector(real)  # pi-lens-ignore: python-unreachable -- 同包内的打开函数，失败返回 None


def _points(geom):
    """几何的点数：面与集合要先钻进子几何，环上的点才是顶点。"""
    if geom is None:
        return 0
    n = geom.GetPointCount()
    if n:
        return n
    total = 0
    for i in range(geom.GetGeometryCount()):
        total += _points(geom.GetGeometryRef(i))
    return total


def _cell(feat, index, width=60):
    try:
        if not feat.IsFieldSetAndNotNull(index):
            return ""
        value = feat.GetField(index)
    except Exception:  # noqa: BLE001  （单个字段取不出来就当空值）
        return ""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return f"<{len(value)} 字节>"
    text = str(value)
    return text if len(text) <= width else text[: width - 3] + "..."


def _vector_side(path, layer_index):
    target = str(path)
    try:
        info = vector.inspect(target)
    except InspectError:
        raise
    except Exception as exc:  # noqa: BLE001  （打不开就换成一句人话）
        raise CompareError("这份矢量打不开", detail=str(exc)[:300],
                           hint="确认文件还在、没有被别的程序锁住；损坏的文件可以先用数据体检看一遍。") from None
    layers = info.get("layers") or []
    if not layers:
        raise CompareError("没有可读的图层", detail=os.path.basename(target),
                           hint="空文件、或者这份数据里没有任何要素图层。")
    index = layer_index if 0 <= layer_index < len(layers) else 0
    layer = layers[index]
    fields = layer.get("fields") or []

    ds = _open(target)
    if ds is None:
        raise CompareError("这份矢量打不开", detail=os.path.basename(target),
                           hint="换一个文件试试；如果它本来就是坏文件，数据体检里能看出原因。")
    rows = []
    vertices = 0
    scanned = 0
    partial = False
    began = time.monotonic()
    lyr = ds.GetLayerByIndex(index)
    if lyr is not None:
        lyr.ResetReading()
        for feat in lyr:
            vertices += _points(feat.GetGeometryRef())
            if len(rows) < SAMPLE_ROWS:
                rows.append([_cell(feat, i) for i in range(len(fields))])
            scanned += 1
            if scanned >= SCAN_FEATURES:
                partial = True
                break
            if scanned % 2000 == 0 and time.monotonic() - began > SCAN_SECONDS:
                partial = True
                break
        lyr.ResetReading()
    del ds

    size, mtime = _stamp(target)
    crs = layer.get("crs") or {}
    return {
        "kind": "vector",
        "path": target,
        "name": os.path.basename(target.rstrip("\\/")) or target,
        "size": _bytes(size),
        "mtime": mtime,
        "driver": info.get("driver_label") or info.get("driver") or "",
        "layer_count": info.get("layer_count") or 0,
        "layer_index": index,
        "layer_name": layer.get("name") or "",
        "geometry": layer.get("geometry_type_label") or "",
        "features": layer.get("feature_count"),
        "extent": layer.get("extent"),
        "extent_wgs84": layer.get("extent_wgs84"),
        "crs": crs.get("label") or "",
        "crs_epsg": crs.get("epsg"),
        "unit": layer.get("unit_label") or "",
        "fields": fields,
        "rows": rows,
        "vertices": vertices,
        "scanned": scanned,
        "partial": partial,
    }


def _band_stats(band):
    stats = band.get("statistics") or {}
    out = []
    for key in ("min", "max", "mean"):
        if stats.get(key) is not None:
            out.append(f"{_num(stats.get(key), 4)}")
    return " / ".join(out)


def _raster_side(path):
    target = str(path)
    try:
        info = raster.inspect(target)
    except InspectError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise CompareError("这份影像打不开", detail=str(exc)[:300],
                           hint="确认文件还在、没有被别的程序锁住。") from None
    size, mtime = _stamp(target)
    bands = info.get("bands") or []
    crs = info.get("crs") or {}
    return {
        "kind": "raster",
        "path": target,
        "name": os.path.basename(target.rstrip("\\/")) or target,
        "size": _bytes(size),
        "mtime": mtime,
        "driver": info.get("driver_label") or info.get("driver") or "",
        "width": info.get("width"),
        "height": info.get("height"),
        "band_count": info.get("band_count"),
        "data_types": info.get("data_types") or "",
        "pixel_size": info.get("pixel_size_label") or "",
        "extent": info.get("extent"),
        "extent_wgs84": info.get("extent_wgs84"),
        "crs": crs.get("label") or "",
        "crs_epsg": crs.get("epsg"),
        "nodata": info.get("nodata_values"),
        "compression": info.get("compression_label") or "",
        "overviews": info.get("overview_levels") or [],
        "bands": bands,
    }


def _same(a, b):
    return str(a or "") == str(b or "")


def _row(label, a, b):
    return {"label": label, "a": a, "b": b, "same": _same(a, b)}


def _vector_meta(a, b):
    rows = [
        _row("文件大小", a["size"], b["size"]),
        _row("修改时间", a["mtime"], b["mtime"]),
        _row("格式", a["driver"], b["driver"]),
        _row("图层数", a["layer_count"], b["layer_count"]),
        _row("图层名", a["layer_name"], b["layer_name"]),
        _row("几何类型", a["geometry"], b["geometry"]),
        _row("要素个数", a["features"], b["features"]),
        _row("顶点总数", a["vertices"], b["vertices"]),
        _row("字段个数", len(a["fields"]), len(b["fields"])),
        _row("范围", _box(a["extent"]), _box(b["extent"])),
        _row("经纬度范围", _box(a["extent_wgs84"]), _box(b["extent_wgs84"])),
        _row("坐标系", a["crs"], b["crs"]),
    ]
    if a["partial"] or b["partial"]:
        note = f"顶点只统计到第 {min(a['scanned'], b['scanned'])} 个要素"
        rows.append(_row("顶点统计口径", note if a["partial"] else "", note if b["partial"] else ""))
    return rows


def _raster_meta(a, b):
    rows = [
        _row("文件大小", a["size"], b["size"]),
        _row("修改时间", a["mtime"], b["mtime"]),
        _row("格式", a["driver"], b["driver"]),
        _row("像素尺寸", f"{a['width']} × {a['height']}", f"{b['width']} × {b['height']}"),
        _row("波段数", a["band_count"], b["band_count"]),
        _row("数据类型", a["data_types"], b["data_types"]),
        _row("像元大小", a["pixel_size"], b["pixel_size"]),
        _row("范围", _box(a["extent"]), _box(b["extent"])),
        _row("经纬度范围", _box(a["extent_wgs84"]), _box(b["extent_wgs84"])),
        _row("坐标系", a["crs"], b["crs"]),
        _row("无数据值", a["nodata"], b["nodata"]),
        _row("压缩", a["compression"], b["compression"]),
        _row("金字塔", "、".join(str(x) for x in a["overviews"]) or "无",
             "、".join(str(x) for x in b["overviews"]) or "无"),
    ]
    count = min(len(a["bands"]), len(b["bands"]))
    for i in range(count):
        ba, bb = a["bands"][i], b["bands"][i]
        rows.append(_row(f"波段 {i + 1} · 类型", ba.get("type_label") or ba.get("type"),
                         bb.get("type_label") or bb.get("type")))
        rows.append(_row(f"波段 {i + 1} · 统计", _band_stats(ba), _band_stats(bb)))
    if len(a["bands"]) != len(b["bands"]):
        rows.append(_row("波段数量差异", f"{len(a['bands'])} 个", f"{len(b['bands'])} 个"))
    return rows


def _field_diff(a, b):
    fa = {f.get("name"): f for f in a["fields"]}
    fb = {f.get("name"): f for f in b["fields"]}
    only_a = [n for n in fa if n not in fb]
    only_b = [n for n in fb if n not in fa]
    changed = []
    for name, left in fa.items():
        right = fb.get(name)
        if right is None:
            continue
        diffs = []
        if left.get("type") != right.get("type"):
            diffs.append({"what": "类型", "a": left.get("type"), "b": right.get("type")})
        if left.get("width") != right.get("width"):
            diffs.append({"what": "宽度", "a": left.get("width"), "b": right.get("width")})
        if left.get("precision") != right.get("precision"):
            diffs.append({"what": "小数位", "a": left.get("precision"), "b": right.get("precision")})
        if diffs:
            changed.append({"name": name, "diffs": diffs})
    order_same = [n for n in fa if n in fb] == [n for n in fb if n in fa]
    return {"only_a": only_a, "only_b": only_b, "changed": changed, "order_same": order_same}


def _sample_diff(a, b):
    names_a = [f.get("name") for f in a["fields"]]
    names_b = [f.get("name") for f in b["fields"]]
    index_b = {n: i for i, n in enumerate(names_b)}
    common = [n for n in names_a if n in index_b]
    limit = min(len(a["rows"]), len(b["rows"]), SAMPLE_ROWS)
    cells = []
    rows_diff = 0
    for r in range(limit):
        differ = False
        for name in common:
            va = a["rows"][r][names_a.index(name)]
            vb = b["rows"][r][index_b[name]]
            if va == vb:
                continue
            differ = True
            if len(cells) < MAX_CELLS:
                cells.append({"row": r + 1, "field": name, "a": va, "b": vb})
        if differ:
            rows_diff += 1
    if not common:
        # 两边连一个同名字段都没有，逐格比就成了空转，结论得直说，
        # 否则界面会写"对比的 4 行属性完全一致"，看着像真的一致
        return {
            "rows_compared": 0,
            "rows_diff": 0,
            "cells": [],
            "cells_truncated": False,
            "common_fields": 0,
            "note": "两边没有同名字段，属性内容无法按行对齐；先看上面的字段结构差异。",
        }
    return {
        "rows_compared": limit,
        "rows_diff": rows_diff,
        "cells": cells,
        "cells_truncated": len(cells) >= MAX_CELLS,
        "common_fields": len(common),
        "note": "按行号对齐（第 1 行对第 1 行），不按主键配对",
    }


def compare(path_a, path_b, layer_a=0, layer_b=0):
    """把两边各自的结论并成一张对照表。"""
    left, right = str(path_a or "").strip(), str(path_b or "").strip()
    if not left or not right:
        raise CompareError("还没有选够两份文件", detail="左边和右边各要一份。",
                           hint="当前打开的那份会填进左侧，右侧点“选择文件”挑另一份。")
    for p in (left, right):
        if not os.path.exists(p):
            raise CompareError("文件找不到了", detail=p,
                               hint="它可能被移走或改名了，重新选一次。")
    kind_a, kind_b = _kind(left), _kind(right)
    if not kind_a or not kind_b:
        raise CompareError("有一份文件打不开", detail="\n".join(x for x in (left, right) if os.path.basename(x)),
                           hint="换一份能打开的文件再对比。")
    if kind_a != kind_b:
        name = {"vector": "矢量", "raster": "影像"}
        raise CompareError("两份不是同一类", detail=f"左边是{name[kind_a]}，右边是{name[kind_b]}。",
                           hint="同一条数据选两种不同格式来比，才能逐项对上。")

    if kind_a == "vector":
        a = _vector_side(left, layer_a)
        b = _vector_side(right, layer_b)
        meta = _vector_meta(a, b)
        fields = _field_diff(a, b)
        sample = _sample_diff(a, b)
        same_kind = "vector"
    else:
        a = _raster_side(left)
        b = _raster_side(right)
        meta = _raster_meta(a, b)
        fields = {"only_a": [], "only_b": [], "changed": [], "order_same": True}
        sample = {"rows_compared": 0, "rows_diff": 0, "cells": [], "cells_truncated": False,
                  "common_fields": 0, "note": ""}
        same_kind = "raster"

    diff_meta = [r for r in meta if not r["same"]]
    diff_fields = len(fields["only_a"]) + len(fields["only_b"]) + len(fields["changed"])
    total = len(diff_meta) + diff_fields + sample["rows_diff"]
    return {
        "kind": same_kind,
        "a": a,
        "b": b,
        "rows": meta,
        "fields": fields,
        "sample": sample,
        "diff": {
            "meta": len(diff_meta),
            "fields": diff_fields,
            "sample_rows": sample["rows_diff"],
            "total": total,
        },
        "summary": _summary(old=len(diff_meta), fields=diff_fields,
                            rows=sample["rows_diff"], kind=same_kind,
                            rows_compared=sample["rows_compared"]),
    }


def _summary(old, fields, rows, kind, rows_compared):
    if not old and not fields and not rows:
        if kind == "raster":
            return "两份影像的表头信息一致。像素上的差异不在这张表里，得叠在一起看。"
        return f"表头、字段与对比的 {rows_compared} 行属性都一致。"
    parts = []
    if old:
        parts.append(f"{old} 项表头不同")
    if fields:
        parts.append(f"{fields} 处字段结构不同")
    if rows:
        parts.append(f"{rows} 行属性不同")
    return "，".join(parts) + "。"
