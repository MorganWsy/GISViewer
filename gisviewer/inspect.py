"""入口：判断文件类型、处理压缩包和容器、给出人话错误。"""

import json
import os
import re
import time
import zipfile
from pathlib import Path

from . import bootstrap, dwg, labels, raster, tileset, vector
from .errors import InspectError
from .formats import HEAVY_ARCHIVE_EXT, JSON_EXT, RASTER_EXT, VECTOR_EXT, ZIP_LIKE

gdal = bootstrap.gdal

SHAPEFILE_SIDECARS = {
    ".shx": ("必需", "要素索引"),
    ".dbf": ("必需", "属性表"),
    ".prj": ("重要", "坐标系定义"),
    ".cpg": ("可选", "属性表文字编码"),
    ".sbn": ("可选", "空间索引"),
    ".sbx": ("可选", "空间索引数据"),
    ".shp.xml": ("可选", "元数据说明"),
}

# 一次拖多个文件时，只有主文件值得单独打开
NON_PRIMARY_EXT = set(SHAPEFILE_SIDECARS) | HEAVY_ARCHIVE_EXT | {".xml", ".tfw", ".aux.xml"}


def is_primary(path):
    """判断文件能否单独查看：Shapefile 伴生文件、压缩包外壳不算。"""
    low = str(path).lower().replace("\\", "/")
    if any(low.endswith(e) for e in ZIP_LIKE):
        return True
    suffix = Path(low).suffix
    if suffix in NON_PRIMARY_EXT:
        return False
    return suffix in RASTER_EXT or suffix in VECTOR_EXT or suffix in JSON_EXT


_friendly = labels.friendly_error


def _clean_input(raw):
    """拖拽和命令行传进来的路径都要洗一遍：去掉引号、展开 ~、转换 /d/xxx 这类写法。"""
    text = str(raw).strip().strip('"').strip("'")
    if text.lower().startswith("file://"):
        text = text[7:]
    # /vsi 开头是 GDAL 的虚拟路径，不能按本地文件系统规范化
    if text.startswith("/vsi"):
        return text
    text = os.path.expanduser(os.path.expandvars(text))
    if re.match(r"^/[a-zA-Z]/", text):
        text = text[1].upper() + ":" + text[2:]
    text = os.path.abspath(text)
    return text.replace("\\", "/")


def _is_archive(path):
    lower = str(path).lower()
    return any(lower.endswith(e) for e in ZIP_LIKE) or Path(lower).suffix in ZIP_LIKE


def _is_vsi(path):
    return str(path).startswith("/vsi")


def _vsi_exists(path):
    return gdal.VSIStatL(path) is not None


def _file_block(path):
    if _is_vsi(path):
        st = gdal.VSIStatL(path)
        size = int(st.size) if st is not None and getattr(st, "size", None) else None
        return {
            "path": path,
            "name": os.path.basename(str(path).rstrip("/\\")),
            "is_dir": False,
            "inside_archive": True,
            "size_bytes": size,
            "size_label": labels.human_size(size) if size else None,
            "modified": None,
        }
    st = os.stat(path)
    is_dir = os.path.isdir(path)
    items, total = (_dir_total(path) if is_dir else (None, None))
    return {
        "path": path,
        "name": os.path.basename(path.rstrip("/\\")),
        "is_dir": is_dir,
        "item_count": items,
        "size_bytes": total if is_dir else st.st_size,
        "size_label": (labels.human_size(total) if total else "空文件夹") if is_dir
        else labels.human_size(st.st_size),
        "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
    }


def _dir_total(path, limit=20000):
    """目录型数据（.gdb/.zarr/瓦片金字塔）给个总量，扫到上限就停。"""
    total, count = 0, 0
    for root, _, names in os.walk(path):
        for n in names:
            count += 1
            try:
                total += os.path.getsize(os.path.join(root, n))
            except OSError:
                continue
            if count >= limit:
                return count, total
    return count, total


def _sidecar_block(shp_path):
    """Shapefile 的伴生文件齐不齐，直接决定能看到哪些信息。"""
    base = Path(shp_path)
    if not base.is_absolute() or not base.parent.is_dir():
        return None
    files, missing, important = [], [], []
    for suffix, (level, purpose) in SHAPEFILE_SIDECARS.items():
        sib = base.with_suffix(suffix)
        exists = sib.is_file()
        item = {"suffix": suffix, "level": level, "purpose": purpose, "exists": exists}
        if exists:
            item["size_bytes"] = sib.stat().st_size
            item["size_label"] = labels.human_size(sib.stat().st_size)
        elif level == "必需":
            missing.append(suffix)
        elif level == "重要":
            important.append({"suffix": suffix, "purpose": purpose})
        files.append(item)
    return {"files": files, "missing_required": missing, "missing_important": important}


def _zip_entries(path, limit=500):
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            entries = [{
                "name": i.filename,
                "is_dir": i.is_dir(),
                "size_bytes": i.file_size,
                "size_label": labels.human_size(i.file_size),
                "stored_bytes": i.compress_size,
            } for i in infos[:limit]]
            return entries, sum(i.file_size for i in infos), len(infos)
    except zipfile.BadZipFile as exc:
        raise InspectError("压缩包打不开，可能已损坏", str(exc)[:200])
    except RuntimeError as exc:
        raise InspectError("这个压缩包有密码", str(exc)[:200], hint="请先解压成文件夹再拖入。")


def _spatial_members(entries):
    """从压缩包成员里挑出可以作为数据入口的文件，一套 shapefile 只留 .shp。"""
    primary, seen = [], set()
    for e in entries:
        name = e["name"]
        if e["is_dir"] or "__MACOSX" in name or Path(name).name.startswith("."):
            continue
        suffix = Path(name).suffix.lower()
        if suffix in SHAPEFILE_SIDECARS:
            continue
        if suffix not in RASTER_EXT and suffix not in VECTOR_EXT:
            continue
        key = str(Path(name).with_suffix("")).lower()
        if suffix in {".shp", ".kml", ".tab"} and key in seen:
            continue
        seen.add(key)
        primary.append(name)
    return primary


def _brief(info):
    """给变量清单里的每个变量留一行要点。"""
    if info.get("kind") != "raster":
        return {"kind": info.get("kind"), "feature_count": info.get("feature_count_total")}
    band = (info.get("bands") or [{}])[0]
    return {
        "width": info.get("width"),
        "height": info.get("height"),
        "band_count": info.get("band_count"),
        "type_label": info.get("type_label"),
        "nodata": band.get("nodata"),
        "statistics": band.get("statistics"),
        "crs_label": (info.get("crs") or {}).get("label"),
        "unit_label": (info.get("crs") or {}).get("unit_label"),
        "extent": info.get("extent"),
        "no_georeference": info.get("no_georeference"),
    }


def _inspect_target(target, head_path=None, file_size=None, compute_stats=True,
                  max_variables=8, histograms=True):
    """先按栅格试，再按矢量试。"""
    raster_error = None
    try:
        info = raster.inspect(target, real_path=head_path, file_size=file_size)
        if info.get("multi_variable"):
            for item in info["variables"][:max_variables]:
                try:
                    sub = _inspect_target(item["path"], compute_stats=compute_stats,
                                          max_variables=1, histograms=histograms)
                    item["summary"] = _brief(sub)
                except Exception as exc:
                    item["error"] = str(exc)[:160]
            return info
        if compute_stats:
            raster.fill_band_numbers(info, target, histograms=histograms)
        return info
    except Exception as exc:
        raster_error = str(exc)[:180]

    try:
        return vector.inspect(target)
    except Exception as exc:
        phrase = _friendly(raster_error or str(exc))
        hint = ("请在源软件里另存为更早的版本，或转成 Shapefile、GeoPackage 之后再来看。"
                if "版本" in phrase else "确认文件完整、伴生文件齐全；压缩包可以直接拖进来，不必解压。")
        raise InspectError("无法读取这个文件", detail=phrase, hint=hint)


_MULTIDRIVERS = {"nc": "netCDF", "nc4": "netCDF", "cdf": "netCDF", "hdf": "HDF4",
                 "h4": "HDF4", "h5": "HDF5", "hdf5": "HDF5", "he5": "HDF5"}


def _list_variables(target, ext):
    """多变量 netCDF/HDF 在外层打不开时，先用具体驱动把变量列出来。"""
    driver_name = _MULTIDRIVERS.get(ext.lstrip("."))
    if not driver_name:
        return None
    drv = bootstrap.gdal.GetDriverByName(driver_name)
    if drv is None:
        return {"driver": driver_name, "driver_label": labels.driver(driver_name),
                "note": "本程序未安装该格式的读取组件", "variables": []}
    try:
        ds = drv.Open(target, bootstrap.gdal.GA_ReadOnly)
    except Exception:
        ds = None
    if ds is None:
        return None
    variables = raster.list_variables(ds.GetMetadata("SUBDATASETS") or {})
    del ds
    if not variables:
        return None
    return {"driver": driver_name, "driver_label": labels.driver(driver_name), "variables": variables}


def _preview(data, depth=0):
    if depth > 1:
        return "…"
    if isinstance(data, dict):
        return {k: _preview(v, depth + 1) for k, v in list(data.items())[:12]}
    if isinstance(data, list):
        return [_preview(x, depth + 1) for x in data[:3]]
    if isinstance(data, str) and len(data) > 60:
        return data[:60] + "…"
    return data


def _count_feature_markers(path, chunk=1 << 20):
    """大 GeoJSON 整体解析太贵，按字节流数特征串。"""
    total, tail = 0, b""
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            buf = tail + block
            total += buf.count(b'"type":"Feature"') + buf.count(b'"type": "Feature"')
            tail = buf[-18:]
    return total


def _json_sniff(path):
    """GeoJSON 之外的 JSON：给出结构概要，并说清它是不是地理数据。"""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(4096).decode("utf-8-sig", errors="replace").lstrip()

    looks_geo = '"FeatureCollection"' in head or '"Feature"' in head or '"coordinates"' in head
    if looks_geo:
        return {
            "kind": "json",
            "is_geographic": True,
            "top_level": "GeoJSON 要素集合" if '"FeatureCollection"' in head else "GeoJSON",
            "feature_count_estimate": _count_feature_markers(path) if size > 20 * 1024 * 1024 else None,
            "note": "文件较大，按文本流统计要素数" if size > 20 * 1024 * 1024 else None,
        }
    if size > 20 * 1024 * 1024:
        return {"kind": "json", "is_geographic": False, "top_level": "文本",
                "note": f"共 {labels.human_size(size)}，没有 GeoJSON 结构，只读了开头",
                "head": head[:300]}
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            data = json.load(fh)
    except Exception as exc:
        return {"kind": "json", "is_geographic": False, "top_level": "文本",
                "note": "不是合法 JSON", "detail": str(exc)[:180], "head": head[:300]}

    kind_name = "对象" if isinstance(data, dict) else ("数组" if isinstance(data, list) else "标量")
    geo = isinstance(data, dict) and (
        data.get("type") in {"Feature", "GeometryCollection", "FeatureCollection"} or "coordinates" in data)
    return {
        "kind": "json",
        "is_geographic": bool(geo),
        "top_level": kind_name,
        "keys": list(data.keys())[:40] if isinstance(data, dict) else None,
        "item_count": len(data) if isinstance(data, (list, dict)) else None,
        "preview": _preview(data),
        "note": None if geo else "没有 GeoJSON 的 type/features/coordinates 结构，看起来不是地理数据",
    }


def _folder_candidates(path, limit=8):
    """普通文件夹里有哪些能直接打开的数据，用来给用户一个准话。"""
    picks = []
    try:
        names = sorted(os.listdir(path), key=str.lower)
    except OSError:
        return picks
    for name in names:
        full = os.path.join(path, name)
        if os.path.isdir(full):
            if name.lower().endswith((".gdb", ".zarr")):
                picks.append(full)
        elif is_primary(full):
            picks.append(full)
    return picks[:limit]


def _dwg_fallback(path, cause, compute_stats, histograms):
    """直接读不了的新版本 DWG：先转成 DXF 再读，读的还是用户给的那个文件。"""
    converted = dwg.convert(path)
    if not converted:
        raise InspectError(
            "无法读取这个文件", detail=_friendly(cause),
            hint="这个 DWG 的版本较新，直接读取不支持，转换读取也没有可用的组件。"
                 "请在 CAD 里另存为 DXF，或导出成 Shapefile、GeoPackage 之后再来看。")
    info = _inspect_target(converted, compute_stats=compute_stats, histograms=histograms)
    info["driver_label"] = "DWG · 经 DXF 转换"
    info["conversion"] = {
        "from": path,
        "via": "DXF",
        "version": dwg.version_label(path),
        "note": "这个 DWG 的版本较新，已先转换成 DXF 再读取；"
                "要素类型与数量来自转换结果，块引用等细节可能有丢失。",
    }
    return info


def inspect_file(raw, compute_stats=True, max_layers=8, histograms=True, quick=False):
    started = time.perf_counter()
    path = _clean_input(raw)
    if _is_vsi(path):
        if not _vsi_exists(path):
            raise InspectError("找不到这个文件", detail=path,
                               hint="压缩包内的写法：/vsizip/盘:/路径/包.zip/里面的文件.shp。")
    elif not os.path.exists(path):
        raise InspectError("找不到这个文件", detail=path,
                           hint="路径里多余的空格和引号要去掉；网络盘上的文件请先复制到本地。")

    result = {"ok": True, "file": _file_block(path)}
    ext = Path(path).suffix.lower()

    if os.path.isdir(path):
        if ext == ".gdb":
            result.update(vector.inspect(path, quick=quick))
        elif ext == ".zarr":
            result.update(_inspect_target(path, compute_stats=compute_stats,
                                          histograms=histograms))
        else:
            pyramid = tileset.describe(path)
            if pyramid:
                result.update(pyramid)
                result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
                return result
            picks = _folder_candidates(path)
            if len(picks) == 1:
                inner = inspect_file(picks[0], compute_stats=compute_stats,
                                     max_layers=max_layers, histograms=histograms)
                inner["opened_from"] = path
                return inner
            if picks:
                names = "、".join(Path(p).name for p in picks)
                raise InspectError("这是一个文件夹", detail=path,
                                   hint="文件夹内可查看的文件：" + names + "。请指定其中一个。")
            raise InspectError("这是一个文件夹", detail=path,
                               hint="文件夹内没有可识别的数据文件。.gdb、.zarr 这类目录型数据可以直接填写路径。")
        result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    size = result["file"]["size_bytes"]

    if ext == ".dwg":
        try:
            result.update(_inspect_target(path, file_size=size, compute_stats=compute_stats,
                                          histograms=histograms))
        except Exception as exc:
            result.update(_dwg_fallback(path, exc, compute_stats, histograms))
        result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    if _is_archive(path):
        entries, total_bytes, entry_count = _zip_entries(path)
        members = _spatial_members(entries)
        block = {
            "kind": "archive",
            "member_count": entry_count,
            "data_entry_count": len(members),
            "uncompressed_bytes": total_bytes,
            "uncompressed_label": labels.human_size(total_bytes),
            "members": members[:40],
            "layers": [],
        }
        target_base = f"/vsizip/{path}"
        if ext == ".kmz":
            block["layers"].append(_inspect_target(target_base, file_size=size, compute_stats=compute_stats))
        else:
            for member in members[:max_layers]:
                try:
                    payload = _inspect_target(f"{target_base}/{member}", file_size=size,
                                              compute_stats=compute_stats)
                except InspectError as exc:
                    block["layers"].append({"member": member, "ok": False, "error": {
                        "title": exc.title, "detail": exc.detail, "hint": exc.hint}})
                    continue
                payload["member"] = member
                payload["read_path"] = f"{target_base}/{member}"
                block["layers"].append(payload)
        result.update(block)
        result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    if str(path).lower().endswith(tuple(HEAVY_ARCHIVE_EXT)):
        raise InspectError(f"暂不支持 {ext} 压缩包", hint="请先解压成文件夹，再拖入里面的文件。")

    if ext in JSON_EXT:
        # 大 GeoJSON 走头部快查：GDAL 的驱动在 Open 时就读完整份文档，
        # 而第一屏要的只是"这是什么、有哪些字段"。头部看不出来再走完整检查
        if quick:
            fast = vector.quick_geojson(path)
            if fast:
                result.update(fast)
                result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
                return result
        try:
            result.update(vector.inspect(path, quick=quick))
        except Exception:
            result.update(_json_sniff(path))
        result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    try:
        payload = _inspect_target(path, head_path=path, file_size=size,
                                  compute_stats=compute_stats, histograms=histograms)
    except InspectError:
        if ext in _MULTIDRIVERS or ext == ".nc":
            listed = _list_variables(path, ext)
            if listed:
                result.update({"kind": "raster", "multi_variable": True, **listed})
                result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
                return result
        with open(path, "rb") as fh:
            starts_brace = fh.read(1) == b"{"
        if ext in JSON_EXT or starts_brace:
            result.update(_json_sniff(path))
            result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
            return result
        raise

    if payload["kind"] == "vector" and ext == ".shp":
        siblings = _sidecar_block(path)
        if siblings:
            payload["sidecars"] = siblings
    elif payload["kind"] == "raster":
        if payload.get("no_georeference"):
            payload["warning"] = "文件里没有地理坐标信息，只能看数值和分布"
        if payload.get("multi_variable"):
            payload["hint"] = "这个文件含多个变量，选择一个变量后才能看具体数值范围"
    result.update(payload)
    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return result


def error_block(exc, raw=None):
    """把异常换成前端能直接显示的结构：标题 + 说明 + 建议。"""
    if isinstance(exc, InspectError):
        payload = {"ok": False, "error": {"title": exc.title, "detail": exc.detail, "hint": exc.hint}}
    else:
        raw = f"{type(exc).__name__}: {exc}"
        payload = {"ok": False, "error": {"title": "读取时出了意外",
                                         "detail": raw[:300],
                                         "hint": _friendly(str(exc)) or "确认文件完整、格式在支持范围内。"}}
    if raw is not None:
        payload["input"] = str(raw)
    return payload


def safe_inspect(raw, **kwargs):
    """给服务层用：把异常也变成结构化结果。"""
    try:
        return inspect_file(raw, **kwargs)
    except Exception as exc:
        return error_block(exc, raw)
