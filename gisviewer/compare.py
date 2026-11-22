"""两份同类文件的对照：元信息、字段结构、内容抽样、顶点数量。

定位是"快速阅览"，所以这里只做只读对照：

- 元信息：大小、修改时间、格式、图层、几何类型、要素个数、顶点总数、范围、坐标系
- 字段：名称、类型、宽度、精度，标出只在一边出现的、类型或宽度不同的
- 内容：前若干行逐格对照。**按行号配对**，不做按唯一字段的配对。真要逐要素比对，
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


# 范围里四个数的顺序固定是 左、下、右、上（也就是 minX、minY、maxX、maxY）。
# 投影坐标系用"左右上下"，地理坐标系用"西东南北"——同一件事两种行话说；
# 读的人如果分不清哪个数是经度、哪个是纬度，这一行就等于白给。
BOX_LABELS = {
    "projected": ("左", "下", "右", "上"),
    "geographic": ("西", "南", "东", "北"),
}


def _box(box, kind=""):
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
    names = BOX_LABELS.get(kind or "")
    if names:
        return "(" + ", ".join(f"{n} {_num(v)}" for n, v in zip(names, values, strict=True)) + ")"
    # 坐标系没记下来时不贴方向：随便标一个就是编
    return "(" + ", ".join(_num(v) for v in values) + ")"


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


def _vector_side(path, layer_index, key=None):
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
    names = [(f.get("name") or "") for f in fields]
    key_at = None
    if key:
        if key not in names:
            raise CompareError(f"{os.path.basename(target)}里没有「{key}」这个字段",
                               detail="两份要按同一个字段配对，所以这个字段两边都得有。",
                               hint="换一个两边都有的字段，或者改回按行号配对。")
        key_at = names.index(key)
    rows = []
    keyed = {}
    dup_keys = 0
    vertices = 0
    scanned = 0
    partial = False
    began = time.monotonic()
    lyr = ds.GetLayerByIndex(index)
    if lyr is not None:
        lyr.ResetReading()
        for feat in lyr:
            vertices += _points(feat.GetGeometryRef())
            if key_at is None:
                if len(rows) < SAMPLE_ROWS:
                    rows.append([_cell(feat, i) for i in range(len(fields))])
            else:
                # 同一个取值出现多次时只留第一个：按唯一字段配对本就假定它唯一，
                # 重复的事实计下来告诉用户，别悄悄覆盖掉
                value = _cell(feat, key_at)
                if value in keyed:
                    dup_keys += 1
                else:
                    keyed[value] = [_cell(feat, i) for i in range(len(fields))]
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
        "crs_kind": crs.get("kind") or "",
        "crs_kind_label": crs.get("kind_label") or "",
        "crs_epsg": crs.get("epsg"),
        "unit": layer.get("unit_label") or "",
        "fields": fields,
        "rows": rows,
        "keyed": keyed,
        "key": key or "",
        "dup_keys": dup_keys,
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
        "crs_kind": crs.get("kind") or "",
        "crs_kind_label": crs.get("kind_label") or "",
        "crs_epsg": crs.get("epsg"),
        "nodata": info.get("nodata_values"),
        "compression": info.get("compression_label") or "",
        "overviews": info.get("overview_levels") or [],
        "bands": bands,
    }


def _crs_text(side):
    """坐标系那一行：名字后面带上它属于哪一类。

    只写"EPSG:3857 · WGS 84 / Pseudo-Mercator"时，读的人还得自己分辨这是投影还是地理，
    而这一条恰恰决定了门口那行范围该用米还是用度。"""
    parts = [side.get("crs") or "", side.get("crs_kind_label") or ""]
    text = " · ".join(x for x in parts if x)
    return text or "未记录坐标系"


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
        _row("范围", _box(a["extent"], a["crs_kind"]), _box(b["extent"], b["crs_kind"])),
        _row("坐标系", _crs_text(a), _crs_text(b)),
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
        _row("范围", _box(a["extent"], a["crs_kind"]), _box(b["extent"], b["crs_kind"])),
        _row("坐标系", _crs_text(a), _crs_text(b)),
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


def _common_fields(a, b):
    # names_b 必须是列表：下面要按它的下标取单元格，用 set 会按任意顺序枚举，
    # 取出来的值就串行了（同一份文件自比都会报"4 行不同"）
    names_a = [f.get("name") for f in a["fields"]]
    names_b = [f.get("name") for f in b["fields"]]
    have = set(names_b)
    return names_a, names_b, [n for n in names_a if n in have]


def _keyed_diff(a, b, names_a, names_b, common, key):
    """按用户指定的字段配对：同一个值算同一个要素。

    键重复时只比第一个，重复的次数写进备注；只在一侧出现的键单独计数，
    这种"多出来 / 少掉"的结论按行号配对是看不出来的。
    """
    index_a = {n: i for i, n in enumerate(names_a)}
    index_b = {n: i for i, n in enumerate(names_b)}
    ka, kb = a["keyed"], b["keyed"]
    cells = []
    rows_diff = 0
    compared = 0
    for k in ka:
        if k not in kb:
            continue
        compared += 1
        ra, rb = ka[k], kb[k]
        differ = False
        for name in common:
            if name == key:
                continue
            if ra[index_a[name]] == rb[index_b[name]]:
                continue
            differ = True
            if len(cells) < MAX_CELLS:
                cells.append({"row": k, "field": name,
                              "a": ra[index_a[name]], "b": rb[index_b[name]]})
        if differ:
            rows_diff += 1
    only_a = [k for k in ka if k not in kb]
    only_b = [k for k in kb if k not in ka]
    notes = [f"按字段「{key}」配对"]
    if a["dup_keys"] or b["dup_keys"]:
        notes.append(f"同名取值只比第一个（左 {a['dup_keys']} 处、右 {b['dup_keys']} 处重复）")
    if only_a or only_b:
        notes.append(f"{len(only_a)} 个字段只在左边，{len(only_b)} 个只在右边")
    return {
        "mode": "key",
        "key": key,
        "rows_compared": compared,
        "rows_diff": rows_diff,
        "cells": cells,
        "cells_truncated": len(cells) >= MAX_CELLS,
        "common_fields": len(common),
        "common_fields_list": common,
        "only_a_count": len(only_a),
        "only_b_count": len(only_b),
        "note": "；".join(notes),
    }


def _sample_diff(a, b, key=None):
    names_a, names_b, common = _common_fields(a, b)
    if key:
        return _keyed_diff(a, b, names_a, names_b, common, key)
    index_a = {n: i for i, n in enumerate(names_a)}
    index_b = {n: i for i, n in enumerate(names_b)}
    limit = min(len(a["rows"]), len(b["rows"]), SAMPLE_ROWS)
    cells = []
    rows_diff = 0
    for r in range(limit):
        differ = False
        for name in common:
            va = a["rows"][r][index_a[name]]
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
            "mode": "row",
            "key": "",
            "rows_compared": 0,
            "rows_diff": 0,
            "cells": [],
            "cells_truncated": False,
            "common_fields": 0,
            "common_fields_list": [],
            "note": "两边没有同名字段，属性内容无法按行对齐；先看上面的字段结构差异。",
        }
    return {
        "mode": "row",
        "key": "",
        "rows_compared": limit,
        "rows_diff": rows_diff,
        "cells": cells,
        "cells_truncated": len(cells) >= MAX_CELLS,
        "common_fields": len(common),
        "common_fields_list": common,
        "note": "",
    }


def keys(path_a, path_b, layer_a=0, layer_b=0):
    """只取两边共有的字段名，给"配对方式"那枚下拉用。

    这里不扫要素：开一次图层、读一遍字段定义就够，几十万要素的文件也是毫秒级。
    """
    left, right = str(path_a or "").strip(), str(path_b or "").strip()
    if not left or not right:
        return {"kind": "", "common": [], "ready": False}
    for p in (left, right):
        if not os.path.exists(p):
            return {"kind": "", "common": [], "ready": False, "reason": "有一份文件找不到了"}
    kind_a, kind_b = _kind(left), _kind(right)
    if kind_a != kind_b:
        return {"kind": kind_a or kind_b or "", "common": [], "ready": False, "reason": "两份不是同一类"}
    if kind_a != "vector":
        return {"kind": kind_a or "", "common": [], "ready": False, "reason": "影像没有要素可配对"}

    names = []
    for path, index in ((left, layer_a), (right, layer_b)):
        src = _open(vector.read_target(path))
        if src is None:
            return {"kind": "vector", "common": [], "ready": False, "reason": "有一份文件打不开"}
        if index < 0 or index >= src.GetLayerCount():
            return {"kind": "vector", "common": [], "ready": False, "reason": "图层序号超出了范围"}
        defn = src.GetLayerByIndex(index).GetLayerDefn()
        names.append([defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())])
    common = [n for n in names[0] if n in names[1]]
    return {"kind": "vector", "common": common, "ready": bool(common),
            "fields_a": len(names[0]), "fields_b": len(names[1])}


def compare(path_a, path_b, layer_a=0, layer_b=0, key=None):
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
        a = _vector_side(left, layer_a, key)
        b = _vector_side(right, layer_b, key)
        meta = _vector_meta(a, b)
        fields = _field_diff(a, b)
        sample = _sample_diff(a, b, key)
        same_kind = "vector"
    else:
        a = _raster_side(left)
        b = _raster_side(right)
        meta = _raster_meta(a, b)
        fields = {"only_a": [], "only_b": [], "changed": [], "order_same": True}
        sample = {"mode": "row", "key": "", "rows_compared": 0, "rows_diff": 0, "cells": [],
                  "cells_truncated": False, "common_fields": 0, "common_fields_list": [],
                  "note": ""}
        same_kind = "raster"

    diff_meta = [r for r in meta if not r["same"]]
    diff_fields = len(fields["only_a"]) + len(fields["only_b"]) + len(fields["changed"])
    # 只在一边出现的键也是差异，和逐格比出来的差异一起算进总数
    lonely = sample.get("only_a_count", 0) + sample.get("only_b_count", 0)
    total = len(diff_meta) + diff_fields + sample["rows_diff"] + lonely
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
            "only_a": sample.get("only_a_count", 0),
            "only_b": sample.get("only_b_count", 0),
            "total": total,
        },
        "summary": _summary(len(diff_meta), diff_fields, sample, same_kind),
    }


def _summary(old, fields, sample, kind):
    rows = sample["rows_diff"]
    only_a = sample.get("only_a_count", 0)
    only_b = sample.get("only_b_count", 0)
    # 结论一律以配对方式开头：同一份数据换一种配对，结论可以完全不同，
    # 不写清楚的话看的人不知道这句是"按行号"还是"按某个字段"得来的
    lead = "按「" + str(sample.get("key")) + "」配对" if sample.get("mode") == "key" else "按行号配对"
    if not old and not fields and not rows and not only_a and not only_b:
        if kind == "raster":
            return "两份影像的表头信息一致。像素上的差异不在这张表里，得叠在一起看。"
        if sample.get("mode") == "key":
            return f"{lead}，表头、字段与 {sample['rows_compared']} 个要素都一致。"
        return f"{lead}，表头、字段与对比的 {sample['rows_compared']} 行属性都一致。"
    parts = []
    if old:
        parts.append(f"{old} 项表头不同")
    if fields:
        parts.append(f"{fields} 处字段结构不同")
    if rows:
        if sample.get("mode") == "key":
            parts.append(f"{rows} 个要素的属性不同")
        else:
            parts.append(f"{rows} 行属性不同")
    if only_a or only_b:
        parts.append(f"另有 {only_a + only_b} 个要素只在一边")
    return lead + "，" + "，".join(parts) + "。"
