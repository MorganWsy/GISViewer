"""矢量元数据。字段宽度、几何类型分布这些都要从 OGR 直接取。"""

import functools
import json
import os
import re
import threading
from pathlib import Path

from . import bootstrap
from . import dwg as _dwg
from . import labels
from . import vindex
from .errors import InspectError
from .crs import bounds_to_wgs84, describe, extent_warning

ogr = bootstrap.ogr
osr = bootstrap.osr
gdal = bootstrap.gdal

# GDAL 的同一个数据源不保证多线程安全：属性表、地图取数、整列复制同时进来时，
# 实测会让引擎进程直接崩掉（服务端只能重启它，页面那边就断了）。
# 这里把几个重读取函数串起来，代价是并发请求排队，换来的是不会莫名断线。
_READ_LOCK = threading.Lock()


# 表格型数据（CSV/XLSX）的 XY 列猜测：列名像经纬度、WKT 就自动当几何用。
# 打开选项别的驱动不认识会忽略，对 shp/gpkg 等常规格式没有影响。
_XY_OPEN_OPTIONS = [
    "X_POSSIBLE_NAMES=lon,lng,long,longitude,x,经度",
    "Y_POSSIBLE_NAMES=lat,latitude,y,纬度",
    "GEOM_POSSIBLE_NAMES=wkt,the_geom,geom,geometry,shape,wkb_geometry",
]


# 这些格式的坐标按规范就是 WGS 84 经纬度，文件里不写坐标系也照样能画
DEFAULT_WGS84_DRIVERS = {"TopoJSON", "GeoJSON", "GeoJSONSeq", "tj2", "JSON"}

# 表格驱动（CSV/XLSX 这类）里没有声明坐标系的几何就是经纬度：
# XY 列、WKT 列认出来的坐标本来就是度，不能再走"本地坐标当作米"的兜底
_TABLE_WGS84_DRIVERS = DEFAULT_WGS84_DRIVERS | {"CSV", "XLSX", "XLS", "ODS"}

# XY 补几何只对电子表格驱动做：CSV 驱动自己就认上面的打开选项。
# 限制驱动是防止别的格式里恰好有叫 x/y 的普通数值列被误当坐标
_XY_SHEET_DRIVERS = {"XLSX", "XLS", "ODS"}

_X_FIELD_NAMES = ("lon", "lng", "long", "longitude", "x", "经度")
_Y_FIELD_NAMES = ("lat", "latitude", "y", "纬度")
_WKT_FIELD_NAMES = ("wkt", "the_geom", "geom", "geometry", "shape", "wkb_geometry")

# 补几何的内存数据源把原始驱动名记在这条元数据里，对外仍按来源驱动上报
_SOURCE_DRIVER_KEY = "TULAN_SOURCE_DRIVER"


def _driver_name(ds):
    name = ds.GetDriver().ShortName
    if name == "Memory":
        try:
            name = (ds.GetMetadata() or {}).get(_SOURCE_DRIVER_KEY) or name
        except Exception:
            pass
    return name


def _driver_long(ds):
    short = _driver_name(ds)
    if ds.GetDriver().ShortName == "Memory" and short != "Memory":
        try:
            other = ogr.GetDriverByName(short)
            if other is not None:
                return other.LongName
        except Exception:
            pass
    return ds.GetDriver().LongName


def _field_index(defn, names):
    """按列名找字段序号（去空格转小写后比对），找不到返回 -1。"""
    table = {}
    for k in range(defn.GetFieldCount()):
        table.setdefault(defn.GetFieldDefn(k).GetName().strip().lower(), k)
    for n in names:
        if n in table:
            return table[n]
    return -1


def _xy_number(feat, idx):
    """把字段读成数值；文本列里的"116.4"也能认，认不出的行不当坐标。"""
    if not feat.IsFieldSetAndNotNull(idx):
        return None
    t = feat.GetFieldDefnRef(idx).GetType()
    if t in (ogr.OFTInteger, ogr.OFTInteger64, ogr.OFTReal):
        return feat.GetFieldAsDouble(idx)
    s = feat.GetFieldAsString(idx).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _xy_upgrade(ds):
    """XLSX 这类表格驱动不认 XY 猜测的打开选项（CSV 认），打开后依旧没有几何。

    哪张表同时有经纬度两列（或带 WKT 列），就在内存里补出几何图层，
    后面读要素、画图、属性表、量算全都照常走；一列有效值都凑不齐就整体
    退回原样，同名的普通文本列不会被误当坐标。补出的几何不带坐标系定义，
    表格驱动的无坐标系几何按经纬度画，与 CSV 的 XY 列同一条路。"""
    try:
        if ds is None or ds.GetLayerCount() == 0:
            return ds
        if ds.GetDriver().ShortName not in _XY_SHEET_DRIVERS:
            return ds
        plans = []
        for i in range(ds.GetLayerCount()):
            lyr = ds.GetLayerByIndex(i)
            if lyr is None or lyr.GetGeomType() != ogr.wkbNone:
                continue
            defn = lyr.GetLayerDefn()
            xi = _field_index(defn, _X_FIELD_NAMES)
            yi = _field_index(defn, _Y_FIELD_NAMES)
            wi = _field_index(defn, _WKT_FIELD_NAMES)
            if (xi >= 0 and yi >= 0) or wi >= 0:
                plans.append((i, xi, yi, wi))
        if not plans:
            return ds
        mem = ogr.GetDriverByName("Memory").CreateDataSource("xy")
        if mem is None:
            return ds
        mem.SetMetadata({_SOURCE_DRIVER_KEY: ds.GetDriver().ShortName})
        plan_map = {p[0]: p for p in plans}
        made_any = False
        for i in range(ds.GetLayerCount()):
            src = ds.GetLayerByIndex(i)
            if src is None:
                continue
            if i not in plan_map:
                mem.CopyLayer(src, src.GetName())
                continue
            _i, xi, yi, wi = plan_map[i]
            out = mem.CreateLayer(src.GetName(), None,
                                  ogr.wkbUnknown if wi >= 0 else ogr.wkbPoint)
            src_defn = src.GetLayerDefn()
            for k in range(src_defn.GetFieldCount()):
                out.CreateField(src_defn.GetFieldDefn(k))
            src.ResetReading()
            while True:
                feat = src.GetNextFeature()
                if feat is None:
                    break
                # 个别单元格是坏值只跳过那一行，不放弃整张表
                try:
                    if wi >= 0:
                        raw = feat.GetFieldAsString(wi).strip() if feat.IsFieldSetAndNotNull(wi) else ""
                        geom = None
                        if raw:
                            try:
                                geom = ogr.CreateGeometryFromWkt(raw)
                            except Exception:
                                geom = None
                            if geom is None:
                                try:
                                    geom = ogr.CreateGeometryFromWkb(bytes.fromhex(raw))
                                except Exception:
                                    geom = None
                    else:
                        xv = _xy_number(feat, xi)
                        yv = _xy_number(feat, yi)
                        geom = None
                        if xv is not None and yv is not None:
                            geom = ogr.Geometry(ogr.wkbPoint)
                            geom.AddPoint_2D(xv, yv)
                    if geom is None:
                        continue
                    dup = ogr.Feature(out.GetLayerDefn())
                    dup.SetFrom(feat)
                    dup.SetGeometry(geom)
                    out.CreateFeature(dup)
                    made_any = True
                except Exception:
                    continue
            src.ResetReading()
        if not made_any:
            return ds
        return mem
    except Exception:
        return ds


def _open_vector(target):
    """优先带 XY 猜测打开，失败再按默认方式打开一次。

    OpenEx 在 gdal 模块上（ogr 没有）。XY 选项只有 CSV 驱动认，别的驱动
    收到会告警"不支持该选项"，所以只对 .csv 传；XLSX 哪条路都拿不到几何，
    打开后再补一次（见 _xy_upgrade）。"""
    options = _XY_OPEN_OPTIONS if str(target).lower().endswith(".csv") else None
    try:
        ds = gdal.OpenEx(target, gdal.OF_VECTOR | gdal.OF_READONLY,
                         open_options=options)
        if ds is not None:
            return _xy_upgrade(ds)
    except Exception:
        pass
    ds = ogr.Open(target)
    if ds is None:
        return None
    return _xy_upgrade(ds)


def _serialized(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _READ_LOCK:
            return fn(*args, **kwargs)
    return wrapper

MAX_LAYERS = 60
GEOM_SAMPLE = 2000
SAMPLE_FEATURES = 3
MAX_FEATURES_PER_REQUEST = 50000

_Z_FLAG = 0x80000000
_M_FLAG = 0x40000000
_SRID_FLAG = 0x20000000


def read_target(path):
    """取要素、点选、量算真正要读的文件：新版 DWG 的直读会失败，
    就先转成 DXF 再读（转换结果有缓存，和打开文件时共用同一份）。"""
    if not str(path).lower().endswith(".dwg"):
        return path
    try:
        ds = _open_vector(path)
        if ds is not None:
            ds = None
            return path
    except RuntimeError:
        pass
    return _dwg.convert(path) or path


_GEOM_NAMES = {
    # 一层里同时有多种几何类型时 OGR 报 wkbUnknown，中文写"类型混合"，英文跟着写 Mixed
    0: "Mixed", 1: "Point", 2: "Line String", 3: "Polygon", 4: "Multi Point",
    5: "Multi Line String", 6: "Multi Polygon", 7: "Geometry Collection",
    11: "Multi Surface", 12: "Curve Polygon", 13: "Multi Curve", 14: "Compound Curve",
    15: "Polyhedral Surface", 16: "TIN", 17: "Triangle",
    100: "None", 101: "Linear Ring",
}


def _geom_name(base):
    """不用 ogr.GeometryTypeToName，它遇到新式枚举值会 OverflowError。"""
    return _GEOM_NAMES.get(int(base), "Unknown")


def _split_geom_code(code):
    """把带 Z/M 标志的几何类型码拆成基础类型和维度说明。"""
    dims = []
    # 旧式带 Z 的编码（0x80000001）会返回成负数，先按 32 位无符号取回来
    base = int(code) & 0xFFFFFFFF
    if base & _SRID_FLAG:
        base &= ~_SRID_FLAG
    if base & _Z_FLAG:
        dims.append("含 Z 值")
        base &= ~_Z_FLAG
    if base & _M_FLAG:
        dims.append("含 M 值")
        base &= ~_M_FLAG
    # 老式编码把维度并进数值里：1003 = 三维面，2003 = 带 M 的面，3003 = 两者都有
    if base >= 3000:
        base -= 3000
        dims = ["含 Z 值", "含 M 值"]
    elif base >= 2000:
        base -= 2000
        dims = ["含 M 值"]
    elif base >= 1000:
        base -= 1000
        dims = ["含 Z 值"]
    return base, dims


def geom_type_label(code):
    base, dims = _split_geom_code(code)
    name = labels.GEOM_TYPE_LABELS.get(base)
    if not name:
        name = labels.geom_type(_geom_name(base))
    return name + ("·" + "·".join(dims) if dims else "")


def _field_defs(defn, samples):
    out = []
    for i in range(defn.GetFieldCount()):
        fd = defn.GetFieldDefn(i)
        name = fd.GetNameRef()
        item = {
            "index": i,
            "name": name,
            "type": fd.GetTypeName(),
            "type_label": labels.field_type(fd.GetTypeName()),
            "subtype": fd.GetSubType() if hasattr(fd, "GetSubType") else None,
            "width": fd.GetWidth(),
            "precision": fd.GetPrecision(),
            "nullable": bool(fd.IsNullable()) if hasattr(fd, "IsNullable") else None,
            "samples": [],
        }
        values = []
        for feat in samples:
            try:
                if feat.IsFieldSetAndNotNull(i):
                    v = feat.GetField(i)
                else:
                    v = None
            except Exception:
                v = None
            if v is not None:
                values.append(_short(v))
        item["samples"] = values[:SAMPLE_FEATURES]
        out.append(item)
    return out


def _short(value):
    text = str(value)
    if len(text) > 40:
        return text[:40] + "…"
    if isinstance(value, float):
        return round(value, 4)
    return text


def _sample_geom_types(lyr, limit=GEOM_SAMPLE):
    """图层声明的几何类型是混合或未限时，抽样统计实际类型分布。"""
    counts = {}
    read = 0
    lyr.ResetReading()
    try:
        while read < limit:
            feat = lyr.GetNextFeature()
            if feat is None:
                break
            read += 1
            g = feat.GetGeometryRef()
            key = "无几何" if g is None else geom_type_label(int(g.GetGeometryType()))
            counts[key] = counts.get(key, 0) + 1
    finally:
        lyr.ResetReading()
    return {
        "read": read,
        "distribution": counts,
        "full": read < GEOM_SAMPLE,
        "note": None if read < GEOM_SAMPLE else f"仅抽样前 {GEOM_SAMPLE} 个要素",
    }


def _layer_info(lyr, index, fallback_epsg=None, quick=False):
    defn = lyr.GetLayerDefn()
    geom_code = int(lyr.GetGeomType())
    base, dims = _split_geom_code(geom_code)
    name = lyr.GetName()
    # 个数和范围都要把文件从头读到尾，quick 模式直接跳过（页面上先显示"统计中"）
    count = None
    ext = None
    if not quick:
        try:
            count = int(lyr.GetFeatureCount())
            if count < 0:
                count = None
        except Exception:
            count = None

        try:
            raw = lyr.GetExtent()
            ext = [round(float(v), 6) for v in raw]
            if any(abs(v) > 1e12 for v in ext):
                raise ValueError("extent 未初始化")
        except Exception:
            try:
                ext = [round(float(v), 6) for v in lyr.GetExtent(force=1)]
            except Exception:
                ext = None

    srs = lyr.GetSpatialRef()
    wkt = srs.ExportToWkt() if srs else ""
    if not wkt and fallback_epsg and base != 100:
        # TopoJSON 之类不写坐标系，规范规定坐标就是 WGS 84 经纬度；
        # 表格驱动的 XY/WKT 列同理（无几何的纯表格不挂这套说法）
        crs = describe(fallback_epsg)
        crs["note"] = "文件没带坐标系定义，按格式规范默认 WGS 84 经纬度"
        wkt = crs.get("wkt") or ""
    else:
        crs = describe(wkt)
    info = {
        "index": index,
        "name": name,
        "feature_count": count,
        "geometry_type_code": geom_code,
        "geometry_type": _geom_name(base),
        "geometry_type_label": geom_type_label(geom_code),
        "geometry_is_mixed": base == 0,
        "geometry_column": lyr.GetGeometryColumn() if hasattr(lyr, "GetGeometryColumn") else None,
        "has_geometry": base != 100,
        "dimensions": dims,
        "has_z": "含 Z 值" in dims,
        "has_m": "含 M 值" in dims,
        "crs": crs,
        "extent": {
            "left": ext[0], "right": ext[1], "bottom": ext[2], "top": ext[3]
        } if ext and len(ext) == 4 and base != 100 else None,
        "extent_wgs84": None,
        "field_count": defn.GetFieldCount(),
        "fields": [],
        "fid_column": defn.GetFidColumn() if hasattr(defn, "GetFidColumn") else None,
        "style": None,
        "metadata": lyr.GetMetadata() or {},
        "capabilities": {},
        "geometry_sampling": None,
    }

    if ext and wkt and len(ext) == 4:
        info["extent_wgs84"] = bounds_to_wgs84(wkt, ext[0], ext[2], ext[1], ext[3])
    warn = extent_warning(info["crs"], info["extent"])
    if warn:
        info["warning"] = warn

    samples = []
    lyr.ResetReading()
    for _ in range(SAMPLE_FEATURES):
        feat = lyr.GetNextFeature()
        if feat is None:
            break
        samples.append(feat)
    lyr.ResetReading()

    info["fields"] = _field_defs(defn, samples)

    if base == 0 and count and not quick:
        info["geometry_sampling"] = _sample_geom_types(lyr)

    for cap, key in (
        (ogr.OLCFastFeatureCount, "快速要素计数"),
        (ogr.OLCFastGetExtent, "快速范围读取"),
        (ogr.OLCRandomRead, "随机读取"),
        (ogr.OLCFastSetNextByIndex, "快速跳转"),
        (ogr.OLCFastSpatialFilter, "空间过滤加速"),
    ):
        try:
            info["capabilities"][key] = bool(lyr.TestCapability(cap))
        except Exception:
            pass

    return info


@_serialized
def inspect(target, quick=False):
    """quick=True 时跳过要素个数与范围这两步全文件扫描。

    十万级 GeoJSON 光这两步就要三秒多，而打开文件的第一屏最要紧的是
    "这是个什么文件、有哪些字段"——个数和范围等取数回来再补（要素个数
    取数接口本来就带，范围用已绘制要素的）。quick 的结果单独缓存。"""
    if str(target).lower().endswith((".osm", ".osm.pbf", ".pbf")):
        # OSM 提取文件常不按节点编号排序，自定义索引会让 points 等图层直接读不出
        gdal.SetConfigOption("OSM_USE_CUSTOM_INDEXING", "NO")
    ds = _open_vector(target)
    if ds is None:
        raise ValueError("没有可识别的矢量图层")

    driver = _driver_name(ds)
    # 表格驱动补出的几何与 GeoJSON 同权：没写坐标系就按规范默认 WGS 84
    fallback = 4326 if driver in _TABLE_WGS84_DRIVERS else None
    total = ds.GetLayerCount()
    layers = []
    for i in range(min(total, MAX_LAYERS)):
        lyr = ds.GetLayerByIndex(i)
        if lyr is None:
            continue
        try:
            layers.append(_layer_info(lyr, i, fallback, quick=quick))
        except Exception as exc:
            layers.append({"index": i, "name": lyr.GetName(),
                           "error": labels.friendly_error(exc)[:200]})

    info = {
        "kind": "vector",
        "quick": bool(quick),
        "driver": driver,
        "driver_label": labels.driver(driver),
        "driver_long": _driver_long(ds),
        "layer_count": total,
        "layers": layers,
        "dataset_metadata": ds.GetMetadata() or {},
        "subdatasets": [k for k in (ds.GetMetadata("SUBDATASETS") or {})],
    }
    counts = [x.get("feature_count") or 0 for x in layers]
    info["feature_count_total"] = sum(counts)
    info["multi_layer"] = total > 1
    del ds
    return info


_SIMPLIFIABLE = (ogr.wkbPolygon, ogr.wkbMultiPolygon, ogr.wkbLineString, ogr.wkbMultiLineString)


_WGS84_REF = None


def _wgs84():
    """经纬度坐标系。全进程共用一份：每个要素都新建一个，十万要素光构建就够慢了。"""
    global _WGS84_REF
    if _WGS84_REF is None:
        ref = osr.SpatialReference()
        ref.ImportFromEPSG(4326)
        ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        _WGS84_REF = ref
    return _WGS84_REF


def _pair(wkt):
    """返回 (源坐标系, 经纬度坐标系, 转经纬度的转换器)；已经是 WGS84 时转换器为 None。"""
    src = osr.SpatialReference()
    src.SetFromUserInput(wkt)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst = _wgs84()
    try:
        if src.IsGeographic() and src.IsSame(dst):
            return src, dst, None
    except Exception:
        pass
    return src, dst, osr.CoordinateTransformation(src, dst)


def _rect_for_src(reverse, bbox, densify=2):
    """把经纬度视野框变到数据坐标系；沿边取点，斜经线投影下不会漏角。"""
    left, bottom, right, top = [float(v) for v in bbox]
    fx = [left + (right - left) * i / densify for i in range(densify + 1)]
    fy = [bottom + (top - bottom) * i / densify for i in range(densify + 1)]
    xs, ys = [], []
    for x, y in [(x, y) for x in fx for y in fy]:
        try:
            px, py, _ = reverse.TransformPoint(x, y)
        except Exception:
            return None
        xs.append(px)
        ys.append(py)
    return min(xs), min(ys), max(xs), max(ys)


_METRICS = {}
_METRICS_MAX = 30000


def _wgs_metrics(geom):
    """在 WGS 84 几何上算面积、周长。绘制时顺手算好带给界面，
    点开弹窗再量就不用回引擎重新解析整份大文件了。

    几何没有坐标系时 GeodesicArea 会直接抛错（"missing SRS"）：这是"能不能量"
    的问题，不该把要素本身也连累成读取失败，所以量不出来就留空。
    """
    base = _split_geom_code(int(geom.GetGeometryType()))[0]
    area = None
    length = None
    try:
        if base in (ogr.wkbPolygon, ogr.wkbMultiPolygon, ogr.wkbCurvePolygon, ogr.wkbMultiSurface):
            area = geom.GeodesicArea()
            length = geom.GeodesicLength()
        elif base in (ogr.wkbLineString, ogr.wkbMultiLineString, ogr.wkbCircularString,
                      ogr.wkbCompoundCurve, ogr.wkbMultiCurve):
            length = geom.GeodesicLength()
    except Exception:
        area = length = None
    if area is not None and area < 0:
        area = None
    if length is not None and length < 0:
        length = None
    return area, length


@_serialized
def _wgs_box(env, ct):
    """源坐标系的包络 (minx, miny, maxx, maxy) 转成经纬度包围盒；转不动返回 None。"""
    if not env or len(env) < 4:
        return None
    try:
        if ct is not None:
            p1 = ct.TransformPoint(float(env[0]), float(env[1]))
            p2 = ct.TransformPoint(float(env[2]), float(env[3]))
            return [min(p1[0], p2[0]), min(p1[1], p2[1]),
                    max(p1[0], p2[0]), max(p1[1], p2[1])]
        return [float(env[0]), float(env[1]), float(env[2]), float(env[3])]
    except Exception:
        return None


def _shape_item(fid, props, geom, ct, tolerance, target, index, stamp):
    """把一条要素做成接口返回的形状：几何转经纬度、按容差抽稀、带上量算值。

    索引取数和读原文件这两条路都走这里，两边结果才不会一边多一个字段、
    一边少算一个面积。返回 (item, 说明)，说明是 ok / simple / nogeom / failed。
    """
    if geom is None:
        return None, "nogeom"
    try:
        if ct is not None:
            geom = geom.Clone()
            if geom.Transform(ct) != 0:
                return None, "failed"
            # 坐标已经换成经纬度，坐标系也要跟着换：面积、周长按 WGS 84 的椭球算，
            # 留着源坐标系等于把"度"当源坐标系的米来量，出来的数会差好几个量级
            geom.AssignSpatialReference(_wgs84())
        # 量算要用原始几何；抽稀之后再算面积周长会偏小
        area = length = None
        mkey = None
        if fid is not None and fid >= 0:
            mkey = (str(target), index, int(fid)) + stamp
            hit = _METRICS.get(mkey)
            if hit is not None:
                area, length = hit
        if mkey is None or mkey not in _METRICS:
            area, length = _wgs_metrics(geom)
            if mkey is not None and len(_METRICS) < _METRICS_MAX:
                _METRICS[mkey] = (area, length)
        base = _split_geom_code(int(geom.GetGeometryType()))[0]
        simplified = False
        if tolerance and base in _SIMPLIFIABLE:
            # 用 WKB 字节数判断顶点有没有真被删掉：多面体的 GetPointCount
            # 只数几何个数，拿它比会一直得出"没抽稀"的错误结论
            before = 0
            try:
                before = geom.WkbSize()
            except Exception:
                pass
            geom = geom.SimplifyPreserveTopology(tolerance)
            after = 0
            try:
                after = geom.WkbSize()
            except Exception:
                pass
            simplified = before == 0 or after < before
        item = {"type": "Feature", "geometry": json.loads(geom.ExportToJson()),
                "properties": props}
        if fid is not None and fid >= 0:
            item["id"] = fid
        # 下划线开头：属性表、识别弹窗都不把它当业务字段显示
        if area is not None:
            props["_msr_area"] = area
        if length is not None:
            props["_msr_len"] = length
        return item, ("simple" if simplified else "ok")
    except Exception:
        return None, "failed"


def feature_props(feat, specs):
    """按字段表把一条要素的属性取成字典。specs 是 (序号, 名字, 是否布尔) 的列表。

    按序号取、不按名字：绑定自带的 ExportToJson 每个要素都按字段名重新线性查一遍，
    22 个字段的图层光这一步 5000 个要素就要十几秒。
    """
    out = {}
    for fi, fname, is_bool in specs:
        if not feat.IsFieldSet(fi):
            continue
        value = feat.GetField(fi)
        out[fname] = bool(value) if is_bool else value
    return out


def _src_rect(src, dst, ct, bbox, assumed_local):
    """经纬度视野框 -> 源坐标系矩形；没有视野框、或本地坐标摆法时返回 None。"""
    if not bbox or assumed_local:
        return None
    if ct is None:
        return [float(v) for v in bbox]
    rect = _rect_for_src(osr.CoordinateTransformation(dst, src), bbox)
    if rect is None:
        raise InspectError("这个坐标系转不到经纬度，画不了")
    return [float(v) for v in rect]


def _layer_from_desc(desc, index, bbox, layer_total_hint):
    """用索引里存的图层概况凑出与打开源文件同样的那份信息。"""
    src = dst = ct = None
    wkt = desc["srs"]
    if wkt:
        src, dst, ct = _pair(wkt)
    elif not desc["wgs84"]:
        # 建索引时源图层没有坐标系，且不是天然经纬度的格式：与读文件时一样，
        # 把原始坐标当成米按墨卡托摆上去
        local = osr.SpatialReference()
        local.ImportFromEPSG(3857)
        src, dst, ct = _pair(local.ExportToWkt())
    total = desc["total"]
    try:
        if layer_total_hint is not None:
            total = int(layer_total_hint)
    except (TypeError, ValueError):
        pass
    rect_src = _src_rect(src, dst, ct, bbox, desc["assumed_local"])
    return {
        "ds": None, "lyr": None, "index": index, "src": src, "dst": dst, "ct": ct,
        "assumed_local": desc["assumed_local"], "rect_src": rect_src,
        "layer_name": desc["layer_name"], "geometry_label": geom_type_label(desc["geom_type"]),
        "field_count": desc["field_count"], "layer_total": total,
        "in_bbox": total if rect_src is None else None,
    }


def _layer_from_file(target, layer_index, bbox, layer_total_hint):
    """打开源文件，把取数要用的东西一次备齐：图层、坐标系、字段表、视野矩形。"""
    ds = _open_vector(target)
    if ds is None:
        raise InspectError("没有可识别的矢量图层", hint="确认文件没损坏，伴生文件都在同一个文件夹里。")
    layers = ds.GetLayerCount()
    if layers < 1:
        raise InspectError("这个数据里没有矢量图层")
    index = max(0, min(int(layer_index or 0), layers - 1))
    lyr = ds.GetLayerByIndex(index)
    if lyr is None:
        raise InspectError("打不开这个图层")

    srs = lyr.GetSpatialRef()
    wkt = srs.ExportToWkt() if srs else ""
    assumed_local = False
    if not wkt:
        # TopoJSON 一类不写坐标系，格式规范规定坐标就是 WGS 84 经纬度；表格驱动的
        # XY/WKT 列补出来的几何同理，坐标本来就是度，直接按经纬度画
        if _driver_name(ds) in _TABLE_WGS84_DRIVERS:
            src = dst = ct = None
        else:
            # 没有坐标系的情况（多为 CAD 图纸、本地坐标）：把原始坐标当作米、
            # 按 Web 墨卡托的平面摆上去，先让用户看见图形本身。
            # 信息栏提示和地图说明里都会注明这是"临时摆放、仅供预览"
            local = osr.SpatialReference()
            local.ImportFromEPSG(3857)
            src, dst, ct = _pair(local.ExportToWkt())
            assumed_local = True
    else:
        src, dst, ct = _pair(wkt)

    # 数一遍要素数在 GeoJSON 这种没有索引的格式上就是重扫全文件（实测 3 秒），
    # 调用方一般已经带着缓存好的数字来了
    try:
        layer_total = int(layer_total_hint) if layer_total_hint is not None else None
    except (TypeError, ValueError):
        layer_total = None
    if layer_total is None:
        try:
            layer_total = int(lyr.GetFeatureCount())
            if layer_total < 0:
                layer_total = None
        except Exception:
            layer_total = None

    rect_src = _src_rect(src, dst, ct, bbox, assumed_local)
    in_bbox = None
    if rect_src:
        lyr.SetSpatialFilterRect(*rect_src)
        # 只有"数得快"的驱动才在这儿预数一遍；没有索引的格式，数一遍和全读一遍一样贵
        try:
            if lyr.TestCapability(ogr.OLCFastFeatureCount):
                in_bbox = int(lyr.GetFeatureCount())
        except Exception:
            in_bbox = None
    else:
        # 没有滤波器（没视野框，或本地坐标没法按视野筛）时，"视野内"就是全部
        in_bbox = layer_total

    defn = lyr.GetLayerDefn()
    field_specs = []
    for fi in range(defn.GetFieldCount()):
        fdef = defn.GetFieldDefn(fi)
        field_specs.append((fi, fdef.GetName(),
                            fdef.GetType() == ogr.OFTInteger
                            and fdef.GetSubType() == ogr.OFSTBoolean))

    return {
        "ds": ds, "lyr": lyr, "index": index, "src": src, "dst": dst, "ct": ct,
        "assumed_local": assumed_local, "rect_src": rect_src,
        "layer_name": lyr.GetName(), "geometry_label": geom_type_label(int(lyr.GetGeomType())),
        "field_count": defn.GetFieldCount(), "field_specs": field_specs,
        "layer_total": layer_total, "in_bbox": in_bbox,
    }


def _rows_from_index(idx, info, limit, offset):
    """按视野（或页码）从索引取行；有视野框就按框查，没有就按编号顺序取。"""
    rect_src = info["rect_src"]
    if rect_src:
        return vindex.rows_bbox(idx, rect_src, limit)
    return vindex.rows_page(idx, offset, limit)


def read_features(target, layer_index=0, bbox=None, limit=MAX_FEATURES_PER_REQUEST,
                  tolerance=0.0, offset=0, with_geometry=True, layer_total_hint=None):
    """按视野取要素，统一转成经纬度 GeoJSON，供地图绘制。

    tolerance 是面/线抽稀容差（单位：度），0 表示原样输出。
    offset/limit 供属性表分页；with_geometry=False 时只带属性，
    跳过坐标变换和几何序列化，大图层的翻页能快不少。
    layer_total_hint：调用方（服务端）从缓存的元数据里已经把总要素数带过来了，
    有它就不用再花几秒钟重新数一遍。
    """
    target = read_target(target)
    index = max(0, int(layer_index or 0))
    target_stamp = _stamp(target)   # 指纹每次请求算一次，别放在逐要素循环里

    # ---------- 先试索引：命中就不打开源文件 ----------
    # GeoJSON 这类没有空间索引的格式，打开一次就要把整份文件读进内存
    # （138 MB 约 3 秒），而索引里已经存了坐标系、图层名、字段表、要素总数
    idx = vindex.existing(target, index)
    desc = vindex.describe(idx) if idx else None
    info = _layer_from_desc(desc, index, bbox, layer_total_hint) if desc else None
    rows = None
    if info is not None:
        rows = _rows_from_index(idx, info, limit, offset)
        if rows is None:
            # 索引读不出来（被删、被改坏）：删掉它，退回源文件重来
            vindex.drop(idx)
            idx = None
            info = None

    if info is None:
        info = _layer_from_file(target, layer_index, bbox, layer_total_hint)
        index = info["index"]
        # 没有空间索引的大文件，第一次取数顺手建一份：后台建，这一次不等它，
        # 建好之后同一个文件的每次拖动、缩放都是几毫秒（见 vindex 的说明）
        if with_geometry and info["rect_src"] and vindex.suitable(target, info["lyr"]):
            vindex.ensure(target, index)
        elif not with_geometry and int(offset or 0) > 0:
            # 属性表翻到很深的页：有索引就按编号直接取，不必让驱动从头扫过去
            idx = vindex.existing(target, index)
        if idx:
            rows = _rows_from_index(idx, info, limit, offset)

    features = []
    scanned = 0
    no_geometry = 0
    failed = 0
    simplified_features = 0
    truncated = False
    lyr = info["lyr"]
    ct = info["ct"]
    assumed_local = info["assumed_local"]
    layer_total = info["layer_total"]
    in_bbox = info["in_bbox"]
    # 走索引时没有图层对象，字段表只有打开文件那条路上才有
    field_specs = info.get("field_specs") or []

    if rows is not None:
        # 走索引：要素和几何都已经在本地，不用再碰源文件
        scanned = len(rows)
        truncated = scanned >= limit
        for row in rows:
            fid_now = row["fid"]
            if with_geometry:
                item, why = _shape_item(fid_now, row["props"], row["geom"], ct, tolerance,
                                        target, index, target_stamp)
                if item is None:
                    if why == "nogeom":
                        no_geometry += 1
                    else:
                        failed += 1
                    continue
                if why == "simple":
                    simplified_features += 1
                features.append(item)
            else:
                if row["geom"] is None:
                    no_geometry += 1
                features.append({
                    "type": "Feature", "geometry": None, "properties": row["props"],
                    "fid": fid_now, "bbox": _wgs_box(row["bbox"], ct),
                })
    else:
        lyr.ResetReading()
        if offset:
            try:
                lyr.SetNextByIndex(int(offset))
            except Exception:
                # 个别驱动不支持直接跳转，退回逐个跳过
                for _ in range(int(offset)):
                    if lyr.GetNextFeature() is None:
                        break
        while True:
            feat = lyr.GetNextFeature()
            if feat is None:
                break
            scanned += 1
            if len(features) >= limit:
                truncated = True
                break
            geom = feat.GetGeometryRef()
            try:
                fid_now = int(feat.GetFID())
            except Exception:
                fid_now = -1
            if with_geometry:
                item, why = _shape_item(fid_now, feature_props(feat, field_specs), geom, ct, tolerance,
                                        target, index, target_stamp)
                if item is None:
                    if why == "nogeom":
                        no_geometry += 1
                    else:
                        failed += 1
                    continue
                if why == "simple":
                    simplified_features += 1
                features.append(item)
                continue
            # 只要属性。属性表双击定位要用这一行要素的范围，而这里的几何
            # 本来就已经解析过了——顺手取个包络，比双击时回原文件按编号扫一遍便宜得多
            row_box = None
            if geom is None:
                no_geometry += 1
            else:
                try:
                    # 空几何的包络是 0,0,0,0，照它定位会跳到几内亚湾去，宁可不给范围
                    env = None if geom.IsEmpty() else geom.GetEnvelope()
                    if env is not None:
                        if ct is not None:
                            # 只转两个对角：坐标变换下矩形不会保持矩形，但包围盒够用了
                            p1 = ct.TransformPoint(env[0], env[2])
                            p2 = ct.TransformPoint(env[1], env[3])
                            env = (min(p1[0], p2[0]), max(p1[0], p2[0]),
                                   min(p1[1], p2[1]), max(p1[1], p2[1]))
                        if all(v is not None for v in env):
                            row_box = [float(env[0]), float(env[2]),
                                       float(env[1]), float(env[3])]
                except Exception:
                    row_box = None
            try:
                # 属性表的每一行都带着编号与经纬度范围，双击定位不必再回读文件
                features.append({"type": "Feature", "geometry": None,
                                 "properties": feature_props(feat, field_specs), "fid": fid_now,
                                 "bbox": row_box})
            except Exception:
                failed += 1
                continue

    # 视野内的总数：数得快的驱动上面已经数过了；没索引的这类，
    # 上面那圈扫完没截断就说明全扫过了，直接用扫描数当结果
    if in_bbox is None and not truncated:
        in_bbox = scanned

    meta = {
        "layer_index": index,
        "layer_name": info["layer_name"],
        "geometry_type_label": info["geometry_label"],
        "layer_total": layer_total,
        "in_bbox": in_bbox,
        "bbox": [float(v) for v in bbox] if (bbox and not assumed_local) else None,
        "returned": len(features),
        "scanned": scanned,
        "truncated": truncated,
        "limit": limit,
        "offset": int(offset or 0),
        "tolerance": tolerance,
        "simplified": simplified_features > 0,
        "simplified_features": simplified_features,
        "no_geometry": no_geometry,
        "failed": failed,
        "reprojected": ct is not None,
        "assumed_local": assumed_local,
        "with_geometry": bool(with_geometry),
        "field_count": info["field_count"],
        # 这一次是否走了索引；indexing 表示正在后台建（建好之前的拖动还会慢）
        "indexed": bool(idx),
        "indexing": bool(not idx and vindex.building(target, index)),
    }
    # 数据集在这里就放掉：Windows 上句柄不松，用户删文件、覆盖文件都会被占用
    info["ds"] = None
    return {"type": "FeatureCollection", "features": features, "gisviewer": meta}


def count_cn(n):
    """数字按中文习惯带万/亿，跟界面上的数字写法保持一致。"""
    n = int(n)
    if n >= 100000000:
        return "%g 亿" % round(n / 100000000.0, 1)
    if n >= 10000:
        return "%g 万" % round(n / 10000.0, 1)
    return str(n)


@_serialized
def geom_type_counts(target, layer_index=0):
    """逐个数每个几何类型各有多少个要素。

    界面在信息栏里是"后台来问"的：混合类型的大图层扫全文件要几秒，
    不能让整个信息栏等它。数完由服务端缓存，重开不再数。
    """
    target = read_target(target)
    ds = _open_vector(target)
    if ds is None:
        raise InspectError("没有可识别的矢量图层", hint="确认文件没损坏，伴生文件都在同一个文件夹里。")
    total = ds.GetLayerCount()
    if total < 1:
        raise InspectError("这个数据里没有矢量图层")
    index = max(0, min(int(layer_index or 0), total - 1))
    lyr = ds.GetLayerByIndex(index)
    if lyr is None:
        raise InspectError("打不开这个图层")
    counts = {}
    zcount = 0
    scanned = 0
    lyr.ResetReading()
    while True:
        feat = lyr.GetNextFeature()
        if feat is None:
            break
        scanned += 1
        g = feat.GetGeometryRef()
        key = "无几何" if g is None else geom_type_label(int(g.GetGeometryType()))
        # CAD 数据一个文件里"线·含 Z 值"和"线"各一大堆，分开列出来一长串没法看。
        # 按基础类型归并（Z 值信息"Z 值坐标"那一行已经有了，这里不重复）
        if "含 Z 值" in key:
            zcount += 1
            key = key.replace("·含 Z 值", "")
        counts[key] = counts.get(key, 0) + 1
    del ds
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    text = " · ".join("%s %s" % (k, count_cn(v)) for k, v in ordered)
    return {"layer": index, "total": scanned,
            "types": [{"label": k, "count": v} for k, v in ordered],
            "counts_text": text,
            # 图层声明报不出 Z（混合类型常报 Unknown），逐要素数出来的才算数
            "has_z": zcount > 0}


def _stamp(target):
    """文件的修改时间和大小：变了就得把留底的索引丢掉。"""
    try:
        st = os.stat(target)
        return (int(st.st_mtime), st.st_size)
    except OSError:
        return (0, 0)


# 量算缓存：大 GeoJSON 每打开一次都要重新解析整份文件（133 MB、10.9 万要素实测 7 秒），
# 同一个文件的同一层只开一次，量过的要素把结果记住。只留最近一份文件，换文件就释放。
# 开文件和第一次按编号取要素是慢的那两下，之后面积、周长都是毫秒级
_MEASURE_LOCK = threading.Lock()
_MEASURE_SRC = {}
_MEASURE_HITS = {}
_MEASURE_HITS_MAX = 512


def _measure_layer(target, layer_index):
    target = read_target(target)
    key = (str(target), int(layer_index or 0)) + _stamp(target)
    if _MEASURE_SRC.get("key") == key:
        return _MEASURE_SRC["lyr"], _MEASURE_SRC["index"], _MEASURE_SRC["assume_local"]
    ds = _open_vector(target)
    if ds is None:
        raise InspectError("没有可识别的矢量图层", hint="确认文件没损坏，伴生文件都在同一个文件夹里。")
    layers = ds.GetLayerCount()
    if layers < 1:
        del ds
        raise InspectError("这个数据里没有矢量图层")
    index = max(0, min(int(layer_index or 0), layers - 1))
    lyr = ds.GetLayerByIndex(index)
    if lyr is None:
        del ds
        raise InspectError("打不开这个图层")
    srs = lyr.GetSpatialRef()
    # 和 read_features 里"本地坐标当作米"的约定保持一致，量算才不会把米当度算
    assume_local = (not (srs and srs.ExportToWkt())) and \
        _driver_name(ds) not in _TABLE_WGS84_DRIVERS
    _MEASURE_SRC.clear()
    _MEASURE_SRC.update({"key": key, "ds": ds, "lyr": lyr, "index": index,
                         "assume_local": assume_local})
    return lyr, index, assume_local


def measure_feature(target, layer_index=0, fid=0):
    """按要素编号回读原始几何，算真实的地面面积和周长，并给出经纬度包围盒。

    地图上画的几何是为显示抽稀过的，量算不能用它；这里回原文件重新读，
    统一转到 WGS 84 后按椭球算（面积用大地测量面积，和 GIS 桌面软件的口径一致）。
    点要素没有面积周长，返回 kind='point'，由前端决定怎么显示。
    """
    want = int(fid)
    hit_key = (str(target), int(layer_index or 0), want) + _stamp(target)
    cached = _MEASURE_HITS.get(hit_key)
    if cached is not None:
        return dict(cached)

    with _MEASURE_LOCK:
        cached = _MEASURE_HITS.get(hit_key)
        if cached is not None:
            return dict(cached)
        lyr, _index, assume_local = _measure_layer(target, layer_index)

        feat = None
        try:
            feat = lyr.GetFeature(want)
        except Exception:
            feat = None
        if feat is None:
            # 个别驱动不支持按编号直接取，退回顺序扫描比对 FID
            lyr.ResetReading()
            while True:
                item = lyr.GetNextFeature()
                if item is None:
                    break
                try:
                    if int(item.GetFID()) == want:
                        feat = item
                        break
                except Exception:
                    continue
        if feat is None:
            raise InspectError("没找到编号 " + str(want) + " 的要素")

        geom = feat.GetGeometryRef()
        if geom is None:
            raise InspectError("这个要素没有几何")
        geom = geom.Clone()
        base, _dims = _split_geom_code(int(geom.GetGeometryType()))

        srs = lyr.GetSpatialRef()
        wgs = _wgs84()
        if srs is not None:
            try:
                ct = osr.CoordinateTransformation(srs, wgs)
                if geom.Transform(ct) != 0:
                    raise InspectError("要素坐标转换失败")
            except InspectError:
                raise
            except Exception:
                raise InspectError("要素坐标转换失败")
        elif assume_local:
            # 本地坐标图层：原始坐标当时作米，"先摆到平面再转经纬度"和画图同一套换算，
            # 量出来的面积周长和图上看到的一致
            local = osr.SpatialReference()
            local.ImportFromEPSG(3857)
            try:
                if geom.Transform(osr.CoordinateTransformation(local, wgs)) != 0:
                    raise InspectError("要素坐标转换失败")
            except InspectError:
                raise
            except Exception:
                raise InspectError("要素坐标转换失败")
        geom.AssignSpatialReference(wgs)

        kind = "other"
        area = None
        length = None
        is_poly = base in (ogr.wkbPolygon, ogr.wkbMultiPolygon,
                           ogr.wkbCurvePolygon, ogr.wkbMultiSurface)
        is_line = base in (ogr.wkbLineString, ogr.wkbMultiLineString,
                           ogr.wkbCircularString, ogr.wkbCompoundCurve, ogr.wkbMultiCurve)
        is_point = base in (ogr.wkbPoint, ogr.wkbMultiPoint, ogr.wkbPoint25D)
        if is_poly:
            kind = "polygon"
            area = geom.GeodesicArea()
            length = geom.GeodesicLength()
        elif is_line:
            kind = "line"
            length = geom.GeodesicLength()
        elif is_point:
            kind = "point"

        if area is not None and area < 0:
            area = None
        if length is not None and length < 0:
            length = None
        env = geom.GetEnvelope()   # (minX, maxX, minY, maxY)
        result = {
            "kind": kind,
            "area_m2": area,
            "length_m": length,
            "bbox": [float(env[0]), float(env[2]), float(env[1]), float(env[3])],   # 左,下,右,上
        }
        if len(_MEASURE_HITS) >= _MEASURE_HITS_MAX:
            try:
                _MEASURE_HITS.pop(next(iter(_MEASURE_HITS)))
            except Exception:
                pass
        _MEASURE_HITS[hit_key] = result
        return dict(result)

@_serialized
def column_values(target, layer_index, field, limit=200000):
    """只取一列的取值，给"复制整列"用。

    属性表按页加载，复制整列时不能只复制已经加载的那几百行；
    走 read_features 会把几何和所有属性都序列化一遍，10 万级要素要一分钟。
    这里只遍历要素、只取一个字段，不构造几何，快一个数量级。
    """
    target = read_target(target)
    ds = _open_vector(target)
    if ds is None:
        raise ValueError("未找到可识别的矢量图层")
    lyr = ds.GetLayerByIndex(int(layer_index))
    if lyr is None:
        raise ValueError("该图层无法读取")
    lyr.ResetReading()
    values = []
    for feat in lyr:
        if len(values) >= limit:
            break
        try:
            v = feat.GetField(field)
        except Exception:
            v = None
        # JSON 里放不下 bytes，转成可读的占位
        if isinstance(v, (bytes, bytearray)):
            v = "<二进制>"
        values.append(v)
    return {"field": field, "values": values, "total": len(values), "limit": limit}

# ---------- 大 GeoJSON 的快速元数据：不走 GDAL，只解析文件头部 ----------
# GDAL 的 GeoJSON 驱动在 ogr.Open 时就把整份文档读完（132 MB 要三秒多），
# 而"先把元数据亮出来"只需要 type、crs 和第一个要素。头部里没有完整要素时退回完整检查。
_GEOJSON_HEAD_BYTES = 512 * 1024
_GEOJSON_MIN_BYTES = 256 * 1024
_GEOJSON_WKB = {  # GeoJSON 类型名 → OGR 几何类型码（_geom_name/_split_geom_code 吃这个）
    "Point": 1, "LineString": 2, "Polygon": 3, "MultiPoint": 4,
    "MultiLineString": 5, "MultiPolygon": 6, "GeometryCollection": 7,
}


def _balanced_json(text, start):
    """从 start 的 '{' 起截出一个配平的 JSON 对象，截不出来返回 None。"""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, min(len(text), start + 256 * 1024)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def quick_geojson(target):
    """大 GeoJSON 的快速检查：只读文件头。

    返回 None 表示"头部看不出来，请走完整检查"——文件太小、结构不是
    FeatureCollection、头部里截不出一个完整要素，都属于这种情况。
    """
    try:
        size = os.path.getsize(target)
        if size < _GEOJSON_MIN_BYTES:
            return None
        with open(target, "rb") as fh:
            head = fh.read(_GEOJSON_HEAD_BYTES).decode("utf-8", "replace")
    except OSError:
        return None
    if '"type"' not in head or '"Topology"' in head[:200]:
        return None
    m = re.search(r'"type"\s*:\s*"FeatureCollection"', head)
    if not m:
        return None
    # 第一个完整要素：定位 "features": [ 之后的第一个对象
    fm = re.search(r'"features"\s*:\s*\[\s*\{', head)
    if not fm:
        return None
    raw = _balanced_json(head, fm.end() - 1)
    if not raw:
        return None
    try:
        feat = json.loads(raw)
    except ValueError:
        return None
    props = feat.get("properties") or {}
    if not isinstance(props, dict):
        props = {}
    geom = feat.get("geometry") or {}
    gname = str(geom.get("type") or "")
    code = _GEOJSON_WKB.get(gname)
    if code is None:
        return None
    base, dims = _split_geom_code(code)

    fields = []
    for i, (name, value) in enumerate(props.items()):
        if isinstance(value, bool):
            ftype = "Integer"
        elif isinstance(value, (int, float)):
            ftype = "Real" if isinstance(value, float) else "Integer64"
        else:
            ftype = "String"
        fields.append({
            "index": i, "name": name, "type": ftype,
            "type_label": labels.field_type(ftype),
            "subtype": None, "width": 0, "precision": 0, "nullable": True,
            "samples": [], "guess": True,   # 类型是从首要素的值猜的，完整检查会校正
        })

    # GeoJSON 规范（RFC 7946）坐标就是 WGS 84 经纬度；老文件可能带 crs 块，
    # 快速检查不解析它，统一按规范默认值给，完整检查会把准确的带回来
    crs = describe(_wgs84().ExportToWkt())
    crs["note"] = "快速读取按 GeoJSON 规范默认 WGS 84 经纬度，完整检查在后头"

    layer = {
        "index": 0,
        "name": Path(target).stem,
        "feature_count": None,
        "geometry_type_code": code,
        "geometry_type": _geom_name(base),
        "geometry_type_label": geom_type_label(code),
        "geometry_is_mixed": False,
        "geometry_column": None,
        "has_geometry": gname != "None",
        "dimensions": " ".join(dims),
        "has_z": "含 Z 值" in dims,
        "has_m": "含 M 值" in dims,
        "crs": crs,
        "extent": None,
        "extent_wgs84": None,
        "field_count": len(fields),
        "fields": fields,
        "fid_column": None,
        "style": None,
        "metadata": {},
        "capabilities": {},
        "geometry_sampling": None,
        "quick": True,
    }
    return {
        "kind": "vector",
        "quick": True,
        "driver": "GeoJSON",
        "driver_label": labels.driver("GeoJSON"),
        "driver_long": "GeoJSON",
        "layer_count": 1,
        "layers": [layer],
        "dataset_metadata": {},
        "subdatasets": [],
        "feature_count_total": 0,
        "multi_layer": False,
    }
