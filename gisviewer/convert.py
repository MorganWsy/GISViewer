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
from . import labels
from . import vector

ogr = bootstrap.ogr
gdal = bootstrap.gdal

# 目标格式。ext 是输出文件的后缀，driver 是 OGR 驱动名。
FORMATS = [
    {"key": "shp", "label": "ESRI Shapefile", "ext": ".shp", "driver": "ESRI Shapefile",
     "note": "字段名最长 10 个字符，超出会被截断；编码写成 UTF-8 并附 .cpg"},
    {"key": "geojson", "label": "GeoJSON", "ext": ".geojson", "driver": "GeoJSON",
     "note": "文本格式，坐标精度按 GeoJSON 默认保留"},
    {"key": "gpkg", "label": "GeoPackage", "ext": ".gpkg", "driver": "GPKG",
     "note": "单文件容纳多图层，字段名不限长"},
    {"key": "kml", "label": "KML", "ext": ".kml", "driver": "KML",
     "note": "谷歌地球通用；按规范只存 WGS 84 经纬度，投影坐标写不了（本功能不做重投影）"},
    {"key": "gml", "label": "GML", "ext": ".gml", "driver": "GML",
     "note": "OGC 通用交换格式，同目录另存 .xsd"},
    {"key": "csv", "label": "CSV（几何写成 WKT 列）", "ext": ".csv", "driver": "CSV",
     "note": "表格软件可直接打开；几何是一列 WKT 文本，坐标系另存同名 .prj"},
    {"key": "fgb", "label": "FlatGeobuf", "ext": ".fgb", "driver": "FlatGeobuf",
     "note": "单文件二进制，适合大数据量分发"},
    {"key": "tab", "label": "MapInfo TAB", "ext": ".tab", "driver": "MapInfo File",
     "note": "MapInfo 旧格式，同目录有 dat/id/map 三个配套文件"},
    {"key": "sqlite", "label": "SQLite", "ext": ".sqlite", "driver": "SQLite",
     "note": "通用数据库容器，字段名不限长"},
    {"key": "gpx", "label": "GPX", "ext": ".gpx", "driver": "GPX",
     "note": "轨迹格式：点、线、多线各存各的图层，按规范只存 WGS 84 经纬度；面与无几何要素存不了；自定义字段写进扩展节点"},
    {"key": "dxf", "label": "DXF", "ext": ".dxf", "driver": "DXF",
     "note": "CAD 交换格式，只写几何；属性表字段保存不了"},
]

_FMT = {f["key"]: f for f in FORMATS}

# 哪些目标格式收不下面与无几何要素
_SKIP_GEOM = ("gpx",)
# 字段名被硬性截断的目标
_NAME_LIMIT = {"shp": 10}
# 按规范只认 WGS 84 经纬度、坐标数值不做转换的目标
_WGS84_ONLY = ("kml", "gpx")

# GPX 按几何类型分图层：点→waypoints，线→routes，多线→tracks
_GPX_LAYERS = (
    ("waypoints", ogr.wkbPoint),
    ("routes", ogr.wkbLineString),
    ("tracks", ogr.wkbMultiLineString),
)


def formats():
    """给界面的格式清单（不带驱动名这种内部细节）。"""
    return [{"key": f["key"], "label": f["label"], "note": f["note"]} for f in FORMATS]


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
    if srs is None:
        return True
    try:
        code = srs.GetAuthorityCode(None)
        if code and str(code) == "4326":
            return True
    except Exception:
        pass
    return False


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


def _precheck(src_lyr, fmt):
    """转换前把这一版会付的代价说清楚，都是能提前算出来的。"""
    out = []
    defn = src_lyr.GetLayerDefn()
    fields = [defn.GetFieldDefn(i).GetNameRef() for i in range(defn.GetFieldCount())]
    if fmt["key"] in ("shp", "tab"):
        non_ascii = [n for n in fields if not n.isascii()]
        if non_ascii:
            out.append("字段名不是 ASCII 字符，转换为 %s 时会被改写：%s"
                       % (fmt["label"], "、".join(non_ascii[:6])))
    limit = _NAME_LIMIT.get(fmt["key"])
    if limit:
        over = [n for n in fields if len(n) > limit]
        if over:
            out.append("字段名超过 %d 个字符，转换后会被截断：%s" % (limit, "、".join(over[:6])))
    if fmt["key"] in _SKIP_GEOM:
        out.append("GPX 放不下面与无几何要素，这些会被跳过")
    if fmt["key"] == "dxf" and fields:
        out.append("DXF 只写几何，%d 个属性字段保存不了" % len(fields))
    if fmt["key"] == "csv":
        out.append("几何写成 WKT 文本列，坐标系另存为同名 .prj")
    if fmt["key"] in _WGS84_ONLY and not _srs_is_wgs84(src_lyr.GetSpatialRef()):
        out.append("该格式按规范只认 WGS 84 经纬度，坐标数值不做转换，位置会偏移")
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
        return {"ok": False, "error": {"title": "不认识的目标格式", "hint": "从列表里选一个格式。"}}
    src = str(src or "").strip()
    if not src:
        return {"ok": False, "error": {"title": "未指定源文件"}}

    with vector._READ_LOCK:
        ds = vector._open_vector(src)
        if ds is None:
            return {"ok": False, "error": {"title": "这份数据读不出矢量图层",
                                           "hint": "格式互转只接受矢量数据（shp、geojson、gpkg 这类）。"}}
        try:
            total = ds.GetLayerCount()
            if layer_index < 0 or layer_index >= total:
                return {"ok": False, "error": {"title": "图层序号超出范围"}}
            src_lyr = ds.GetLayerByIndex(layer_index)
            src_defn = src_lyr.GetLayerDefn()
            warnings = _precheck(src_lyr, fmt)

            stem = os.path.splitext(os.path.basename(src))[0]
            out_dir = str(out_dir or "").strip() or os.path.join(os.path.dirname(src) or ".", stem + "_转出")
            out_path = os.path.join(out_dir, stem + fmt["ext"])
            if os.path.exists(out_path):
                return {"ok": False, "error": {
                    "title": "输出位置已有同名文件",
                    "hint": "换一个输出目录，或先把 %s 移走。" % os.path.basename(out_path)}}

            before = _layer_summary(src_lyr, src, dbfenc.detect(src))
            # 坐标越界这件事预检就要说清：KML/GPX 按规范只存经纬度，转换时也是同一道拦
            if fmt["key"] in _WGS84_ONLY and _extent_out_of_lonlat(src_lyr):
                return {"ok": False, "error": {
                    "title": "%s 放不下这份数据的坐标" % fmt["label"],
                    "hint": "该格式按规范只存 WGS 84 经纬度（-180~180 / -90~90），"
                            "这份数据的坐标数值超出范围（像投影坐标）。本功能不做重投影，"
                            "请先在专业软件里把数据重投影到 WGS 84 再转。"}}
            if dry:
                return {"ok": True, "warnings": warnings, "before": before,
                        "format_note": fmt["note"], "dry": True}
            os.makedirs(out_dir, exist_ok=True)

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
                            out_ds, src_lyr, src_defn, gpx_lyrs)
                        if not written:
                            raise RuntimeError("GPX 放不下面与无几何要素，没有可写的要素")
                    else:
                        kw = {}
                        if layer_opts:
                            kw["options"] = layer_opts
                        out_lyr = out_ds.CreateLayer(
                            os.path.splitext(os.path.basename(out_path))[0],
                            srs=src_lyr.GetSpatialRef(), geom_type=src_lyr.GetGeomType(), **kw)
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
                            out_feat = ogr.Feature(out_defn)
                            _copy_feature(feat, out_feat, kept)
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
                        warnings.append("数据里有无几何要素，FlatGeobuf 不建空间索引以保留这些要素")
                        continue
                    if "GPX 放不下" in str(exc):
                        return {"ok": False, "error": {"title": "GPX 放不下面与无几何要素",
                                                       "hint": "这份数据没有点线要素可写，请换 GeoPackage 等格式。"}}
                    return {"ok": False, "error": {"title": "转换过程中出错", "hint": msg}}
            out_lyr = None
            gpx_lyrs.clear()
            out_ds = None

            if skipped:
                warnings.append("跳过了 %d 个面状要素（GPX 只放得下点与线）" % skipped)
            if no_geom:
                warnings.append("跳过了 %d 个没有几何的要素（%s 必须有几何）" % (no_geom, fmt["label"]))
            if dropped_fields:
                warnings.append("%d 个属性字段保存不了（%s 不支持）" % (dropped_fields, fmt["label"]))
            if fmt["key"] == "csv":
                _write_prj(out_path, src_lyr.GetSpatialRef())

            enc = dbfenc.detect(out_path) if fmt["key"] == "shp" else (
                "UTF-8" if fmt["key"] in ("geojson", "gpkg", "gml", "kml", "fgb", "gpx") else None)
            after = _after_summary(out_path, enc, fmt["key"])
            if after is None:
                return {"ok": False, "error": {"title": "输出文件写完后读不回来",
                                               "hint": "请检查输出目录是否可写。"}}
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


def _copy_feature(src_feat, out_feat, kept):
    """几何照搬，属性按 kept 的 (源序号, 目标序号) 对拷。"""
    geom = src_feat.GetGeometryRef()
    if geom is not None:
        out_feat.SetGeometry(geom.Clone())
    for src_i, out_i in kept:
        if src_feat.IsFieldNull(src_i):
            out_feat.SetFieldNull(out_i)
        elif src_feat.IsFieldSet(src_i):
            ftype = src_feat.GetFieldDefnRef(src_i).GetType()
            if ftype == ogr.OFTBinary:
                out_feat.SetField(out_i, src_feat.GetFieldAsBinary(src_i))
            else:
                out_feat.SetField(out_i, src_feat.GetField(src_i))


def _write_gpx(out_ds, src_lyr, src_defn, gpx_lyrs):
    """GPX 按几何类型分流：点→waypoints，线→routes，多线→tracks。

    返回 (写出数, 面跳过数, 无几何跳过数, 丢失字段数)。"""
    written = skipped = no_geom = 0
    dropped_fields = 0
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
            lyr = out_ds.CreateLayer(lkey, srs=src_lyr.GetSpatialRef(),
                                     geom_type=dict(_GPX_LAYERS)[lkey])
            if lyr is None:
                raise RuntimeError("GPX 建不出 %s 图层" % lkey)
            kept, dropped_fields = _copy_fields(src_defn, lyr, {"key": "gpx"})
            gpx_lyrs[lkey] = (lyr, kept)
        lyr, kept = gpx_lyrs[lkey]
        out_defn = lyr.GetLayerDefn()
        for g in subs:
            out_feat = ogr.Feature(out_defn)
            _copy_feature(feat, out_feat, kept)
            out_feat.SetGeometry(g.Clone())
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
