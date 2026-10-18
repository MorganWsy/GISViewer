"""瓦片金字塔目录（{z}/{x}/{y}.pbf 或 .png/.jpg）的识别与统计。

这类目录常见于自己缓存的矢量切片，GDAL 认单张瓦片，但整个金字塔要自己认。
"""

import math
import os

from . import bootstrap, labels

gdal = bootstrap.gdal

VECTOR_TILE_EXT = ".pbf"
RASTER_TILE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
TILE_EXTS = (VECTOR_TILE_EXT,) + RASTER_TILE_EXTS
SCAN_LIMIT = 300000


def _digit_dirs(path):
    out = []
    try:
        for name in os.listdir(path):
            if name.isdigit() and os.path.isdir(os.path.join(path, name)):
                out.append(int(name))
    except OSError:
        return []
    return sorted(out)


def _scan(path):
    """统计各扩展名的瓦片数。"""
    counts = {}
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in TILE_EXTS:
                counts[ext] = counts.get(ext, 0) + 1
                total += 1
        if total > SCAN_LIMIT:
            break
    return counts, total


def _tile_names(xdir, ext):
    """某个 x 目录下的 y 编号列表（瓦片是文件，不是目录）。"""
    out = []
    try:
        for name in os.listdir(xdir):
            stem, e = os.path.splitext(name)
            if e.lower() == ext and stem.isdigit():
                out.append(int(stem))
    except OSError:
        return []
    return sorted(out)


def _sample_tile(path, zoom, ext):
    """挑一张真实存在的瓦片，用来读图层名和字段。"""
    zdir = os.path.join(path, str(zoom))
    for x in _digit_dirs(zdir):
        found = _tile_names(os.path.join(zdir, str(x)), ext)
        if found:
            return zoom, x, found[0], os.path.join(zdir, str(x), f"{found[0]}{ext}")
    return None


def _axis_lon(x, z):
    return x / (2 ** z) * 360.0 - 180.0


def _axis_lat(y, z):
    n = math.pi * (1 - 2 * y / (2 ** z))
    return math.degrees(math.atan(math.sinh(n)))


def _bounds(zoom, xs, ys):
    """按这一级的瓦片编号范围算经纬度覆盖。"""
    return [round(_axis_lon(min(xs), zoom), 6),
            round(_axis_lat(max(ys) + 1, zoom), 6),
            round(_axis_lon(max(xs) + 1, zoom), 6),
            round(_axis_lat(min(ys), zoom), 6)]


def _zoom_extent(path, zoom, ext):
    zdir = os.path.join(path, str(zoom))
    xs = _digit_dirs(zdir)
    if not xs:
        return None
    ys = []
    for x in xs[:200]:
        ys.extend(_tile_names(os.path.join(zdir, str(x)), ext))
    if not ys:
        return None
    return _bounds(zoom, xs, ys)


def _tile_layers(sample_path, limit=12):
    """用单张瓦片读出切片里的图层和字段。"""
    from . import vector
    try:
        info = vector.inspect(sample_path)
    except Exception:
        return []
    out = []
    for L in (info.get("layers") or [])[:limit]:
        out.append({
            "name": L.get("name"),
            "geometry_type_label": L.get("geometry_type_label"),
            "field_count": L.get("field_count"),
            "fields": [f.get("name") for f in (L.get("fields") or [])][:12],
            "features_in_tile": L.get("feature_count"),
        })
    return out


def describe(path):
    """目录像瓦片金字塔就返回结果，不像就返回 None。"""
    zooms = _digit_dirs(path)
    if not zooms:
        return None
    counts, tiles = _scan(path)
    if not counts or tiles < 4:
        return None
    ext = max(counts, key=counts.get)
    zoom_min, zoom_max = zooms[0], zooms[-1]
    bounds = _zoom_extent(path, zoom_min, ext) or _zoom_extent(path, zoom_max, ext)
    sample = _sample_tile(path, zoom_min if bounds else zoom_max, ext)
    is_vector = ext == VECTOR_TILE_EXT
    avg = None
    if sample:
        avg = os.path.getsize(sample[3])
    result = {
        "kind": "tileset",
        "driver": "MVT" if is_vector else "XYZ",
        "driver_label": labels.driver("MVT") if is_vector else "瓦片影像",
        "tile_type": "vector" if is_vector else "raster",
        "tile_ext": ext,
        "scheme": "z/x/y",
        "zooms": zooms,
        "zoom_min": zoom_min,
        "zoom_max": zoom_max,
        "tile_count": tiles,
        "tile_bytes_sample": avg,
        "extent_wgs84": bounds,
        "tile_url": ("/api/tileset?path=" + _quote(path) + f"&z={{z}}&x={{x}}&y={{y}}&ext={ext}"),
        "layer_count": 0,
        "layers": [],
    }
    if sample:
        result["sample_tile"] = {"z": sample[0], "x": sample[1], "y": sample[2]}
        if is_vector:
            result["layers"] = _tile_layers(sample[3])
            result["layer_count"] = len(result["layers"])
    return result


def _quote(text):
    from urllib.parse import quote
    return quote(str(text), safe="")


def tile_path(root, z, x, y, ext):
    return os.path.join(str(root), str(int(z)), str(int(x)), f"{int(y)}{ext}")
