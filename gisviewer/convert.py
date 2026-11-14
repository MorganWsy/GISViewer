# -*- coding: utf-8 -*-
"""矢量格式互转（可选模块）。

只做"同一份几何与属性换一种文件格式存放"：坐标系、几何、属性一律照搬，
不做重投影、裁剪、合并、简化。默认输出到新目录，已存在的文件不覆盖；
转换前先给出该格式的已知代价（字段名截断这类），转换后再读一遍结果，
把要素数、字段、坐标系与源数据并排比对。

这一块是可选能力：删掉本文件、去掉 server.py 的两个接口与界面入口，
其余功能不受影响。
"""

import os

from . import bootstrap
from . import encoding as dbfenc
from . import geoparquet
from . import labels
from . import topojson
from . import vector

ogr = bootstrap.ogr
gdal = bootstrap.gdal

# 目标格式。ext 是输出文件的后缀，driver 是 OGR 驱动名（TopoJSON 自己写，不用驱动）。
FORMATS = [
    {"key": "shp", "label": "ESRI Shapefile", "ext": ".shp", "driver": "ESRI Shapefile",
     "note": "字段名最长 10 个字符，超出部分会被截断；属性编码写为 UTF-8，并附带 .cpg 文件。"},
    {"key": "geojson", "label": "GeoJSON", "ext": ".geojson", "driver": "GeoJSON",
     "note": "文本格式，字段名不限长，坐标为原始数值。"},
    {"key": "gpkg", "label": "GeoPackage", "ext": ".gpkg", "driver": "GPKG",
     "note": "单文件可容纳多个图层，字段名不限长。"},
    {"key": "kml", "label": "KML", "ext": ".kml", "driver": "KML",
     "note": "Google Earth 通用格式；按规范仅支持 WGS 84 经纬度，投影坐标无法写入（本功能不做重投影）。"},
    {"key": "gml", "label": "GML", "ext": ".gml", "driver": "GML",
     "note": "OGC 通用交换格式，同目录另存 .xsd 结构文件。"},
    {"key": "csv", "label": "CSV", "ext": ".csv", "driver": "CSV", "note": ""},
    {"key": "fgb", "label": "FlatGeobuf", "ext": ".fgb", "driver": "FlatGeobuf",
     "note": "单文件二进制格式，适合大数据量分发。"},
    {"key": "tab", "label": "MapInfo TAB", "ext": ".tab", "driver": "MapInfo File",
     "note": "MapInfo 旧版格式，同目录包含 tab、dat、id、map 四个文件。"},
    {"key": "sqlite", "label": "SQLite", "ext": ".sqlite", "driver": "SQLite",
     "note": "通用数据库容器，字段名不限长。"},
    {"key": "gpx", "label": "GPX", "ext": ".gpx", "driver": "GPX",
     "note": "轨迹格式：点、线、多线分别存为独立图层，按规范仅支持 WGS 84 经纬度；面与无几何要素无法保存；自定义字段写入扩展节点。"},
    {"key": "topojson", "label": "TopoJSON", "ext": ".topojson", "driver": "TopoJSON",
     "note": "文本格式，相邻要素的公共边界合并为同一条弧，文件比 GeoJSON 小；按规范仅支持 WGS 84 经纬度。"},
    {"key": "geoparquet", "label": "GeoParquet", "ext": ".parquet", "driver": "Parquet",
     "note": "列式存储，几何以 WKB 写入并记录坐标系与范围，属性按列保存；单文件，适合大体量数据与跨工具交换。"},
    {"key": "dxf", "label": "DXF", "ext": ".dxf", "driver": "DXF",
     "note": "CAD 交换格式，仅保存几何，属性字段无法保留。"},
]

_FMT = {f["key"]: f for f in FORMATS}

# 哪些目标格式收不下面与无几何要素
_SKIP_GEOM = ("gpx",)
# 字段名被硬性截断的目标
_NAME_LIMIT = {"shp": 10}
# 按规范只认 WGS 84 经纬度、坐标数值不做转换的目标
_WGS84_ONLY = ("kml", "gpx", "topojson")
# 一个图层只放得下一种几何的目标：混合几何的数据要挑占多数的那种建图层
_SINGLE_GEOM = ("shp", "tab", "dxf")

# GPX 按几何类型分图层：点→waypoints，线→routes，多线→tracks
_GPX_LAYERS = (
    ("waypoints", ogr.wkbPoint),
    ("routes", ogr.wkbLineString),
    ("tracks", ogr.wkbMultiLineString),
)


def formats():
    """给界面的格式清单（不带驱动名这种内部细节）。按字母顺序，下拉里好找。"""
    rows = [{"key": f["key"], "label": f["label"], "note": f["note"]} for f in FORMATS]
    return sorted(rows, key=lambda r: r["label"].lower())


def _srs_name(lyr):
    srs = lyr.GetSpatialRef()
    return _srs_label(srs)


def _srs_label(srs):
    if srs is None:
        return None
    name = srs.GetName() or srs.GetAttrValue("PROJCS") or srs.GetAttrValue("GEOGCS")
    if not name or name == "unnamed":
        # MapInfo TAB 这类格式不记坐标系名字，但基准还在；照基准称呼它
        name = (srs.GetAttrValue("DATUM") or "").replace("D_", "").replace("_", " ") or "未记名"
        return name
    auth = srs.GetAuthorityCode(None)
    return (name or "未命名") + ("（EPSG:%s）" % auth if auth else "")


def _crs_same(wkt_a, wkt_b):
    """坐标系是否同一套：按定义比（DATUM/WKT），不按名字比。

    MapInfo TAB 读回来叫 "unnamed"，但基准仍是 WGS_1984，
    字符串比会误报"坐标系变了"。"""
    if not wkt_a and not wkt_b:
        return True
    if not wkt_a or not wkt_b:
        return False
    try:
        a = bootstrap.osr.SpatialReference()
        b = bootstrap.osr.SpatialReference()
        a.ImportFromWkt(wkt_a)
        b.ImportFromWkt(wkt_b)
        a.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
        b.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
        return bool(a.IsSame(b))
    except Exception:
        return wkt_a == wkt_b


def _srs_is_wgs84(srs):
    """是不是 WGS 84 经纬度。按定义比，不看有没有 EPSG 编号。"""
    if srs is None:
        return True
    try:
        wgs = bootstrap.osr.SpatialReference()
        wgs.ImportFromEPSG(4326)
        wgs.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
        probe = srs.Clone()
        probe.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
        return bool(probe.IsSame(wgs))
    except Exception:
        pass
    try:
        return str(srs.GetAuthorityCode(None) or "") == "4326"
    except Exception:
        return False


def _to_wgs84(srs):
    """源坐标系 → WGS 84 经纬度的转换器。

    KML / GPX / TopoJSON 按规范只收经纬度，源数据是投影坐标时只能先换过来；
    换的时候按传统轴序（经度在前），否则高斯-克吕格那类会写成"纬度 经度"。
    """
    wgs = bootstrap.osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
    src = srs.Clone()
    src.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
    return bootstrap.osr.CoordinateTransformation(src, wgs)


_WGS84_SRS = None


def _wgs84_srs():
    """全进程共用一份 WGS 84：每个图层新建一次没必要。"""
    global _WGS84_SRS
    if _WGS84_SRS is None:
        srs = bootstrap.osr.SpatialReference()
        srs.ImportFromEPSG(4326)
        srs.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
        _WGS84_SRS = srs
    return _WGS84_SRS


def _layer_summary(lyr, path, encoding_label):
    defn = lyr.GetLayerDefn()
    fields = [defn.GetFieldDefn(i).GetNameRef() for i in range(defn.GetFieldCount())]
    srs = lyr.GetSpatialRef()
    return {
        "feature_count": int(lyr.GetFeatureCount()),
        "field_count": len(fields),
        "fields": fields,
        "geometry": vector.geom_type_label(int(lyr.GetGeomType())),
        "crs": _srs_label(srs),
        "crs_wkt": srs.ExportToWkt() if srs is not None else None,
        "encoding": encoding_label,
        "size": _total_size(path),
    }


def _after_summary(path, encoding_label, fmt_key=""):
    """把输出读回来汇总。GPX 一份文件分好几个图层，这里按总数合并。"""
    ds = vector._open_vector(path)
    if ds is None:
        return None
    fields = []
    total = 0
    geoms = []
    crs = None
    crs_wkt = None
    try:
        for i in range(ds.GetLayerCount()):
            lyr = ds.GetLayerByIndex(i)
            if fmt_key == "gpx" and lyr.GetName() in ("route_points", "track_points"):
                continue   # GPX 驱动读回时给轨迹另铺的顶点层，数进去要素数会翻倍
            defn = lyr.GetLayerDefn()
            for j in range(defn.GetFieldCount()):
                name = defn.GetFieldDefn(j).GetNameRef()
                # GML 读回来自带 gml_id，是格式给要素挂的编号，不是源数据的属性
                if fmt_key == "gml" and name == "gml_id":
                    continue
                # TopoJSON 读回时按要素补一个 id 字段，同样不是源数据的属性
                if fmt_key == "topojson" and name == "id":
                    continue
                if name not in fields:
                    fields.append(name)
            total += int(lyr.GetFeatureCount())
            g = vector.geom_type_label(int(lyr.GetGeomType()))
            if g not in geoms:
                geoms.append(g)
            if crs is None:
                srs = lyr.GetSpatialRef()
                crs = _srs_label(srs)
                crs_wkt = srs.ExportToWkt() if srs is not None else None
    finally:
        ds = None
    if crs is None:
        crs = _crs_from_prj(path)
    if crs is None and fmt_key == "topojson":
        # TopoJSON 文件里不记坐标系，按规范就是 WGS 84；写在这里是为了对比表能判"同一套"
        srs = bootstrap.osr.SpatialReference()
        srs.ImportFromEPSG(4326)
        srs.SetAxisMappingStrategy(bootstrap.osr.OAMS_TRADITIONAL_GIS_ORDER)
        crs = "WGS 84（格式规范）"
        crs_wkt = srs.ExportToWkt()
    return {
        "feature_count": total,
        "field_count": len(fields),
        "fields": fields,
        "geometry": "/".join(geoms) or "无",
        "crs": crs,
        "crs_wkt": crs_wkt,
        "encoding": encoding_label,
        "size": _total_size(path),
    }


def _crs_from_prj(path):
    """CSV 这类不带坐标系的格式，读同名 .prj（我们自己写的那份）。"""
    prj = os.path.splitext(str(path))[0] + ".prj"
    if not os.path.isfile(prj):
        return None
    try:
        srs = bootstrap.osr.SpatialReference()
        with open(prj, encoding="utf-8") as fh:
            srs.ImportFromWkt(fh.read())
        return _srs_label(srs) or "已写入 .prj"
    except Exception:
        return "已写入 .prj"


def _total_size(path):
    """shp 有 shx/dbf/prj 等一堆配套文件，按前缀合计才算得上"这份数据多大"。"""
    p = str(path)
    if os.path.isdir(p):
        base = os.path.join(p, os.path.splitext(os.path.basename(p.rstrip("\\/")))[0])
    else:
        base = os.path.splitext(p)[0]
    folder = os.path.dirname(base) or "."
    stem = os.path.splitext(os.path.basename(base))[0]
    total = 0
    try:
        for name in os.listdir(folder):
            if name.split(".")[0].lower() == stem.lower() and os.path.isfile(os.path.join(folder, name)):
                total += os.path.getsize(os.path.join(folder, name))
    except OSError:
        pass
    return total or (os.path.getsize(p) if os.path.isfile(p) else 0)


def _source_base(src):
    """源文件所在目录与文件名主干。

    压缩包里的数据是 /vsizip/包.zip/成员.shp 这种虚拟路径，目录并不存在，
    默认输出要落回包旁边，不能顺着虚拟路径去建。"""
    zipped = dbfenc._zip_parts(src)
    real = zipped[0] if zipped else src
    name = zipped[1] if zipped else src
    folder = os.path.dirname(real) or "."
    return folder, os.path.splitext(os.path.basename(name))[0]


def _precheck(src_lyr, fmt):
    """转换前把这一版会付的代价说清楚，都是能提前算出来的。"""
    out = []
    defn = src_lyr.GetLayerDefn()
    fields = [defn.GetFieldDefn(i).GetNameRef() for i in range(defn.GetFieldCount())]
    if fmt["key"] in ("shp", "tab"):
        non_ascii = [n for n in fields if not n.isascii()]
        if non_ascii:
            out.append("字段名含非 ASCII 字符，转换成 %s 时会被改写：%s。"
                       % (fmt["label"], "、".join(non_ascii[:6])))
    limit = _NAME_LIMIT.get(fmt["key"])
    if limit:
        over = [n for n in fields if len(n) > limit]
        if over:
            out.append("字段名超过 %d 个字符，转换后会被截断：%s。"
                       % (limit, "、".join(over[:6])))
    if fmt["key"] in _SKIP_GEOM:
        out.append("GPX 不支持面与无几何要素，这些要素将被跳过。")
    if fmt["key"] == "dxf" and fields:
        out.append("DXF 仅保存几何，%d 个属性字段无法保留。" % len(fields))
    if fmt["key"] in _SINGLE_GEOM and ogr.GT_Flatten(src_lyr.GetGeomType()) == ogr.wkbUnknown:
        out.append("%s 每个图层只能存一种几何，这份数据含多种几何，"
                   "将按占多数的那种写出，其余要素跳过。" % fmt["label"])
    if fmt["key"] in _WGS84_ONLY and not _srs_is_wgs84(src_lyr.GetSpatialRef()):
        out.append("源坐标系为 %s，写入时将重投影到 WGS 84（该格式按规范只收经纬度）。"
                   % (_srs_label(src_lyr.GetSpatialRef()) or "未记录"))
    return out


def _gpx_target(geom):
    """面要素分到哪个 GPX 图层。返回 (图层名, [几何])，放不下返回 None。"""
    if geom is None:
        return None
    gt = ogr.GT_Flatten(geom.GetGeometryType())
    if gt == ogr.wkbPoint:
        return "waypoints", [geom]
    if gt == ogr.wkbMultiPoint:
        return "waypoints", [geom.GetGeometryRef(i) for i in range(geom.GetGeometryCount())]
    if gt == ogr.wkbLineString:
        return "routes", [geom]
    if gt == ogr.wkbMultiLineString:
        return "tracks", [geom]
    return None


def convert(src, layer_index=0, fmt_key="geojson", out_dir=None, dry=False):
    """把 src 的第 layer_index 个图层转成 fmt_key 指定的格式，写到 out_dir。

    dry=True 只做预检：给出现阶段算得出的代价与转换前的概况，不写任何文件。
    返回 {ok, out_path, out_files, warnings, before, after, compare}。
    任何一步失败都不留半成品：写过的输出文件就地删掉。"""
    fmt = _FMT.get(str(fmt_key or "").strip())
    if not fmt:
        return {"ok": False, "error": {"title": "目标格式无法识别",
                                       "hint": "请从列表中选择一种格式。"}}
    src = str(src or "").strip()
    if not src:
        return {"ok": False, "error": {"title": "未填写源文件",
                                       "hint": "请先选择要转换的文件。"}}

    with vector._READ_LOCK:
        ds = vector._open_vector(src)
        if ds is None:
            return {"ok": False, "error": {"title": "无法读取矢量图层",
                                           "hint": "格式互转仅支持矢量数据，例如 Shapefile、GeoJSON、GeoPackage。"}}
        try:
            total = ds.GetLayerCount()
            if layer_index < 0 or layer_index >= total:
                return {"ok": False, "error": {"title": "图层序号超出范围",
                                               "hint": "请重新选择图层。"}}
            src_lyr = ds.GetLayerByIndex(layer_index)
            src_defn = src_lyr.GetLayerDefn()
            warnings = _precheck(src_lyr, fmt)

            folder, stem = _source_base(src)
            out_dir = str(out_dir or "").strip() or os.path.join(folder, stem + "_转出")
            out_path = os.path.join(out_dir, stem + fmt["ext"])
            if os.path.exists(out_path):
                return {"ok": False, "error": {
                    "title": "输出位置已存在同名文件",
                    "hint": "请更换输出目录，或先移动 %s。" % os.path.basename(out_path)}}

            before = _layer_summary(src_lyr, src, dbfenc.detect(src))
            # 只收经纬度的格式：源数据是投影坐标就换算过去；没有坐标系记录的没法换
            xf = None
            only_geom = None
            out_srs = src_lyr.GetSpatialRef()
            if fmt["key"] in _WGS84_ONLY and not _srs_is_wgs84(out_srs):
                if out_srs is None:
                    return {"ok": False, "error": {
                        "title": "%s 无法存放这份数据的坐标" % fmt["label"],
                        "hint": "该格式按规范只收 WGS 84 经纬度，而这份数据没有记录坐标系，"
                                "无法判断该怎么换算。请先在其他软件中补上坐标系并投影到 WGS 84。"}}
                try:
                    xf = _to_wgs84(out_srs)
                except Exception as exc:
                    return {"ok": False, "error": {
                        "title": "无法重投影到 WGS 84",
                        "hint": labels.friendly_error(exc)[:200]}}
                out_srs = _wgs84_srs()
            elif fmt["key"] in _WGS84_ONLY and _extent_out_of_lonlat(src_lyr):
                # 坐标系写着 WGS 84（或压根没写，GeoJSON 按规范默认 WGS 84），
                # 数值却是米制——这种文件只能先让人改正，猜一个坐标系去换更危险
                return {"ok": False, "error": {
                    "title": "%s 无法存放这份数据的坐标" % fmt["label"],
                    "hint": "坐标数值超出经纬度范围（-180~180 / -90~90），而坐标系记录为 WGS 84 "
                            "或没有记录，无法据此换算。请先确认坐标系标注是否正确，"
                            "或先在其它软件中投影到 WGS 84。"}}
            if dry:
                return {"ok": True, "warnings": warnings, "before": before,
                        "format_note": fmt["note"], "dry": True}
            os.makedirs(out_dir, exist_ok=True)

            if fmt["key"] == "topojson":
                # GDAL 的 TopoJSON 驱动只读，这一份自己写（见 topojson 模块）
                gdal.SetConfigOption("SHAPE_ENCODING", None)
                out_lyr = None
                gpx_lyrs = {}
                out_ds = None
                written = skipped = no_geom = dropped_fields = 0
                try:
                    written, skipped, dropped_fields = topojson.write(
                        src_lyr, out_path, src_lyr.GetName() or stem, xf=xf)
                except Exception as exc:
                    _cleanup(out_path)
                    return {"ok": False, "error": {
                        "title": "转换未完成",
                        "hint": labels.friendly_error(exc)[:200]}}
            elif fmt["key"] == "geoparquet":
                # 本机的 GDAL 没有 Parquet 驱动，写出走 duckdb（见 geoparquet 模块）
                out_ds = None
                out_lyr = None
                gpx_lyrs = {}
                written = skipped = no_geom = dropped_fields = 0
                try:
                    written, dropped_fields = geoparquet.write(src_lyr, out_path, stem)
                except Exception as exc:
                    _cleanup(out_path)
                    return {"ok": False, "error": {
                        "title": "转换未完成",
                        "hint": labels.friendly_error(exc)[:200]}}
            else:
                driver = ogr.GetDriverByName(fmt["driver"])
                if driver is None:
                    return {"ok": False, "error": {"title": "本机 GDAL 没有 %s 驱动" % fmt["label"]}}
                gdal.SetConfigOption("SHAPE_ENCODING", None)   # 写出一律走 UTF-8，别受上次读取影响
                layer_opts = []
                if fmt["key"] == "shp":
                    layer_opts.append("ENCODING=UTF-8")
                if fmt["key"] == "csv":
                    layer_opts.append("GEOMETRY=AS_WKT")
                if fmt["key"] == "tab":
                    bounds = _extent_option(src_lyr)
                    if bounds:
                        layer_opts.append(bounds)   # MapInfo 默认 (-1000,-1000)-(1000,1000)，米制坐标会被写坏
                ds_opts = ["GPX_USE_EXTENSIONS=YES"] if fmt["key"] == "gpx" else None
                # 混合几何 + 只存一种几何的格式：按占多数的那种建图层，其余跳过
                out_geom = src_lyr.GetGeomType()
                if fmt["key"] in _SINGLE_GEOM and ogr.GT_Flatten(out_geom) == ogr.wkbUnknown:
                    only_geom = _dominant_geom(src_lyr)
                    if only_geom is not None:
                        out_geom = only_geom

                attempt = 0
                while True:
                    attempt += 1
                    out_lyr = None
                    gpx_lyrs = {}
                    written = skipped = no_geom = dropped_fields = 0
                    try:
                        out_ds = (driver.CreateDataSource(out_path, options=ds_opts) if ds_opts
                                  else driver.CreateDataSource(out_path))
                        if out_ds is None:
                            raise RuntimeError("创建输出文件失败")
                        if fmt["key"] == "gpx":
                            written, skipped, no_geom, dropped_fields = _write_gpx(
                                out_ds, src_lyr, src_defn, gpx_lyrs, xf)
                            if not written:
                                raise RuntimeError("GPX 放不下面与无几何要素，没有可写的要素")
                        else:
                            kw = {}
                            if layer_opts:
                                kw["options"] = layer_opts
                            out_lyr = out_ds.CreateLayer(
                                os.path.splitext(os.path.basename(out_path))[0],
                                srs=out_srs, geom_type=out_geom, **kw)
                            if out_lyr is None:
                                raise RuntimeError("驱动没有建出图层")
                            kept, dropped_fields = _copy_fields(src_defn, out_lyr, fmt)
                            out_defn = out_lyr.GetLayerDefn()
                            src_lyr.ResetReading()
                            while True:
                                feat = src_lyr.GetNextFeature()
                                if feat is None:
                                    break
                                if fmt["key"] == "dxf" and feat.GetGeometryRef() is None:
                                    no_geom += 1   # DXF 必须有几何才写得出实体
                                    continue
                                if only_geom is not None:
                                    g = feat.GetGeometryRef()
                                    if g is None:
                                        no_geom += 1
                                        continue
                                    if ogr.GT_Flatten(g.GetGeometryType()) != only_geom:
                                        skipped += 1
                                        continue
                                out_feat = ogr.Feature(out_defn)
                                _copy_feature(feat, out_feat, kept, xf)
                                out_lyr.CreateFeature(out_feat)
                                written += 1
                            out_lyr.SyncToDisk()
                        out_ds.FlushCache()
                        break
                    except Exception as exc:
                        # 先撒手图层再关数据源，否则 Windows 上文件还占着，半成品删不掉
                        out_lyr = None
                        gpx_lyrs.clear()
                        out_ds = None
                        _cleanup(out_path)
                        msg = labels.friendly_error(exc)[:200]
                        if (fmt["key"] == "fgb" and attempt == 1
                                and "spatial index" in str(exc).lower()):
                            # FlatGeobuf 带空间索引时容不下无几何要素；放弃索引把要素全留下
                            layer_opts.append("SPATIAL_INDEX=NO")
                            warnings.append("数据中包含无几何要素，FlatGeobuf 已关闭空间索引以保留这些要素。")
                            continue
                        if "GPX 放不下" in str(exc):
                            return {"ok": False, "error": {
                                "title": "没有可写入 GPX 的要素",
                                "hint": "GPX 仅支持点与线，这份数据没有可用的点线要素，请改选 GeoPackage 等格式。"}}
                        return {"ok": False, "error": {"title": "转换未完成", "hint": msg}}

            out_lyr = None
            gpx_lyrs.clear()
            out_ds = None

            if skipped:
                if only_geom is not None:
                    warnings.append("这份数据含多种几何，%s 每个图层只能存一种，"
                                    "已按占多数的%s写出，其余 %d 个要素跳过。"
                                    % (fmt["label"], vector.geom_type_label(int(only_geom)), skipped))
                elif fmt["key"] == "topojson":
                    warnings.append("已跳过 %d 个无几何要素（TopoJSON 要求要素带几何）。" % skipped)
                else:
                    warnings.append("已跳过 %d 个面状要素（GPX 仅支持点与线）。" % skipped)
            if no_geom:
                warnings.append("已跳过 %d 个无几何要素（%s 要求要素带几何）。" % (no_geom, fmt["label"]))
            if dropped_fields:
                warnings.append("%d 个属性字段无法保存（%s 不支持）。" % (dropped_fields, fmt["label"]))
            if xf is not None:
                warnings.append("坐标已从 %s 重投影到 WGS 84。" % (before.get("crs") or "源坐标系"))
            if fmt["key"] == "csv":
                _write_prj(out_path, src_lyr.GetSpatialRef())

            enc = dbfenc.detect(out_path) if fmt["key"] == "shp" else (
                "UTF-8" if fmt["key"] in ("geojson", "gpkg", "gml", "kml", "fgb", "gpx",
                                          "topojson", "geoparquet") else None)
            # 预检里"将要…"那两句，转换完已经有实际结果，留着就是同一件事说两遍
            warnings = [w for w in warnings
                        if "将按占多数的那种写出" not in w and "写入时将重投影到" not in w]
            after = _after_summary(out_path, enc, fmt["key"])
            if after is None:
                return {"ok": False, "error": {"title": "输出文件读取失败",
                                               "hint": "请检查输出目录是否可写、文件是否被其他程序占用。"}}
            compare = [
                {"name": "要素数", "before": before["feature_count"], "after": after["feature_count"],
                 "same": before["feature_count"] == after["feature_count"]},
                {"name": "字段数", "before": before["field_count"], "after": after["field_count"],
                 "same": before["field_count"] == after["field_count"]},
                {"name": "几何类型", "before": before["geometry"], "after": after["geometry"],
                 "same": before["geometry"] == after["geometry"]},
                {"name": "坐标系", "before": before["crs"] or "未记录", "after": after["crs"] or "未记录",
                 "same": _crs_same(before.get("crs_wkt"), after.get("crs_wkt"))},
            ]
            return {
                "ok": True,
                "out_path": out_path,
                "out_files": _side_files(out_path),
                "warnings": warnings,
                "before": before,
                "after": after,
                "compare": compare,
                "format_note": fmt["note"],
            }
        finally:
            ds = None


def _dominant_geom(lyr):
    """混合几何里占多数的那一种（扁平类型码）。

    Shapefile、MapInfo TAB、DXF 一个图层只存得下一种几何，先看一眼再建图层，
    总比建到一半被驱动拒掉、整份回滚好。抽样上限与信息栏统计一致。"""
    counts = {}
    lyr.ResetReading()
    for _ in range(2000):
        feat = lyr.GetNextFeature()
        if feat is None:
            break
        geom = feat.GetGeometryRef()
        if geom is None:
            continue
        code = ogr.GT_Flatten(geom.GetGeometryType())
        counts[code] = counts.get(code, 0) + 1
    lyr.ResetReading()
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _extent_out_of_lonlat(lyr):
    """坐标数值是否超出经纬度范围（像投影坐标）。"""
    try:
        xmin, xmax, ymin, ymax = lyr.GetExtent()
    except Exception:
        return False
    return max(abs(xmin), abs(xmax)) > 180 or max(abs(ymin), abs(ymax)) > 90


def _extent_option(lyr):
    """MapInfo TAB 的 BOUNDS 图层选项：把图层实际范围告诉驱动。

    驱动默认按 (-1000,-1000)-(1000,1000) 建表，超出的坐标会被写坏。"""
    try:
        xmin, xmax, ymin, ymax = lyr.GetExtent()
    except Exception:
        return None
    return "BOUNDS=%s,%s,%s,%s" % (xmin, ymin, xmax, ymax)


def _copy_fields(src_defn, out_lyr, fmt):
    """按源顺序建字段。DXF 这类驱动不收任意字段，丢几个数几个。

    返回 ([(源字段序号, 目标字段序号), ...], 丢失数量)。目标字段序号按
    "建字段前已有的字段数 + 第几个建出来"算：GPX 图层自带 23 个固定字段，
    按源序号硬搬会把值写进 ele 那些航点标准列；shp 又会把中文字段名改写，
    按名字对不上，所以只认位置。"""
    kept = []
    dropped = 0
    base = out_lyr.GetLayerDefn().GetFieldCount()
    for i in range(src_defn.GetFieldCount()):
        fd = src_defn.GetFieldDefn(i)
        nf = ogr.FieldDefn(fd.GetNameRef(), fd.GetType())
        nf.SetWidth(fd.GetWidth())
        nf.SetPrecision(fd.GetPrecision())
        try:
            nf.SetSubType(fd.GetSubType())
        except Exception:
            pass
        try:
            err = out_lyr.CreateField(nf)
        except Exception:
            err = 1
        if err:
            dropped += 1
        else:
            kept.append((i, base + len(kept)))
    return kept, dropped


def _copy_feature(src_feat, out_feat, kept, xf=None):
    """几何照搬（需要时先换算到 WGS 84），属性按 kept 的 (源序号, 目标序号) 对拷。"""
    geom = src_feat.GetGeometryRef()
    if geom is not None:
        dup = geom.Clone()
        if xf is not None:
            dup.Transform(xf)
        out_feat.SetGeometry(dup)
    for src_i, out_i in kept:
        if src_feat.IsFieldNull(src_i):
            out_feat.SetFieldNull(out_i)
        elif src_feat.IsFieldSet(src_i):
            ftype = src_feat.GetFieldDefnRef(src_i).GetType()
            if ftype == ogr.OFTBinary:
                out_feat.SetField(out_i, src_feat.GetFieldAsBinary(src_i))
            else:
                out_feat.SetField(out_i, src_feat.GetField(src_i))


def _write_gpx(out_ds, src_lyr, src_defn, gpx_lyrs, xf=None):
    """GPX 按几何类型分流：点→waypoints，线→routes，多线→tracks。

    返回 (写出数, 面跳过数, 无几何跳过数, 丢失字段数)。"""
    written = skipped = no_geom = 0
    dropped_fields = 0
    srs = _wgs84_srs() if xf is not None else src_lyr.GetSpatialRef()
    src_lyr.ResetReading()
    while True:
        feat = src_lyr.GetNextFeature()
        if feat is None:
            break
        geom = feat.GetGeometryRef()
        if geom is None:
            no_geom += 1
            continue
        plan = _gpx_target(geom)
        if plan is None:
            skipped += 1
            continue
        lkey, subs = plan
        if lkey not in gpx_lyrs:
            lyr = out_ds.CreateLayer(lkey, srs=srs, geom_type=dict(_GPX_LAYERS)[lkey])
            if lyr is None:
                raise RuntimeError("GPX 建不出 %s 图层" % lkey)
            kept, dropped_fields = _copy_fields(src_defn, lyr, {"key": "gpx"})
            gpx_lyrs[lkey] = (lyr, kept)
        lyr, kept = gpx_lyrs[lkey]
        out_defn = lyr.GetLayerDefn()
        for g in subs:
            out_feat = ogr.Feature(out_defn)
            _copy_feature(feat, out_feat, kept)
            dup = g.Clone()
            if xf is not None:
                dup.Transform(xf)
            out_feat.SetGeometry(dup)
            lyr.CreateFeature(out_feat)
            written += 1
    return written, skipped, no_geom, dropped_fields


def _write_prj(out_path, srs):
    if srs is None:
        return
    try:
        with open(os.path.splitext(out_path)[0] + ".prj", "w", encoding="utf-8") as fh:
            fh.write(srs.ExportToWkt())
    except OSError:
        pass


def _side_files(path):
    folder = os.path.dirname(path) or "."
    stem = os.path.splitext(os.path.basename(path))[0]
    out = []
    try:
        for name in sorted(os.listdir(folder)):
            if name.split(".")[0].lower() == stem.lower() and os.path.isfile(os.path.join(folder, name)):
                out.append(os.path.join(folder, name))
    except OSError:
        pass
    return out or [path]


def _cleanup(path):
    for f in _side_files(path):
        try:
            os.remove(f)
        except OSError:
            pass
