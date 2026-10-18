"""坐标系信息。用 GDAL 自带的 OSR 解析，不再引入第二份 PROJ。

国内数据的常态是自定义投影、没有 EPSG 编码，这块必须优雅处理。
"""

import re

from . import bootstrap
from . import labels

osr = bootstrap.osr

_PROJ_RE = re.compile(r'PROJECTION\["([^"]+)"')
_PARAM_RE = re.compile(r'PARAMETER\["([^"]+)",\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\]')
_AXIS_RE = re.compile(r'AXIS\["([^"]+)",\s*([A-Za-z_]+)\]')
_UNIT_RE = re.compile(r'UNIT\["([^"]+)"')


def _key(text):
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def _authority(srs):
    """投影坐标系自己的编码优先，其次地理坐标系的。"""
    for node in ("PROJCS", "GEOGCS"):
        try:
            code = srs.GetAuthorityCode(node)
        except Exception:
            code = None
        if code:
            try:
                return node, int(code)
            except ValueError:
                return node, code
    return None, None


def describe(source):
    result = {
        "label": "未记录坐标系",
        "name": None,
        "epsg": None,
        "code": None,
        "kind": "unknown",
        "kind_label": "未记录",
        "unit": None,
        "unit_label": None,
        "unit_factor_m": None,
        "method": None,
        "method_label": None,
        "parameters": [],
        "geographic_crs": None,
        "ellipsoid": None,
        "axes": [],
        "is_custom": False,
        "wkt": None,
    }
    if not source:
        return result

    srs = osr.SpatialReference()
    try:
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        if isinstance(source, osr.SpatialReference):
            srs = source
        elif isinstance(source, int):
            if srs.ImportFromEPSG(int(source)) != 0:
                return result
        else:
            srs.SetFromUserInput(str(source))
    except Exception:
        result["label"] = "坐标系定义无法识别"
        result["raw"] = str(source)[:400]
        return result

    try:
        wkt = srs.ExportToWkt()
    except Exception:
        wkt = str(source)
    result["wkt"] = wkt

    if srs.IsProjected():
        kind, kind_label = "projected", "投影坐标系"
    elif srs.IsGeographic():
        kind, kind_label = "geographic", "地理坐标系"
    elif srs.IsVertical():
        kind, kind_label = "vertical", "高程坐标系"
    else:
        kind, kind_label = "other", "其它坐标系"

    node, code = _authority(srs)
    epsg = code if node == "GEOGCS" and kind == "geographic" else (code if node == "PROJCS" else None)
    if kind == "projected" and node == "GEOGCS":
        # 只有地理部分带编码，投影本身仍是自定义定义
        epsg = None

    unit_name, unit_factor = None, None
    try:
        if kind == "projected":
            unit_name = srs.GetAttrValue("UNIT") or None
            if not unit_name:
                found = _UNIT_RE.findall(wkt)
                unit_name = found[-1] if found else None
            factor = srs.GetLinearUnits()
            unit_factor = round(float(factor), 8) if factor else None
        elif kind == "geographic":
            unit_name = "degree"
    except Exception:
        pass

    proj_match = _PROJ_RE.search(wkt)
    method_raw = proj_match.group(1) if proj_match else None
    params = []
    for name, value in _PARAM_RE.findall(wkt):
        key = _key(name)
        params.append({
            "key": key,
            "label": labels.param(key) or labels.param(name),
            "value": float(value),
        })
    if kind == "geographic":
        params = []

    axes = [{"name": n, "direction": d} for n, d in _AXIS_RE.findall(wkt)][:4]

    ellipsoid = None
    try:
        a = srs.GetSemiMajor()
        b = srs.GetSemiMinor()
        inv = srs.GetInvFlattening()
        if a:
            ellipsoid = {
                "name": srs.GetAttrValue("SPHEROID") or None,
                "semi_major_m": round(a, 3),
                "semi_minor_m": round(b, 3),
                "inverse_flattening": round(inv, 4) if inv else None,
            }
    except Exception:
        pass

    geo = None
    try:
        g = srs.GetGeogCS()
        if g is not None:
            gcode = None
            try:
                gcode = g.GetAuthorityCode("GEOGCS")
            except Exception:
                pass
            geo = {
                "name": g.GetName() or g.GetAttrValue("GEOGCS"),
                "epsg": int(gcode) if gcode and str(gcode).isdigit() else None,
                "datum": g.GetAttrValue("DATUM") or None,
            }
    except Exception:
        pass

    result.update({
        "name": srs.GetName() or srs.GetAttrValue("PROJCS") or srs.GetAttrValue("GEOGCS"),
        "epsg": epsg,
        "code": f"EPSG:{epsg}" if isinstance(epsg, int) else None,
        "kind": kind,
        "kind_label": kind_label,
        "unit": unit_name,
        "unit_label": labels.unit(unit_name),
        "unit_factor_m": unit_factor,
        "method": method_raw,
        "method_label": labels.method(method_raw),
        "parameters": params,
        "geographic_crs": geo,
        "ellipsoid": ellipsoid,
        "axes": axes,
        "is_custom": epsg is None,
    })

    if result["code"]:
        result["label"] = f"{result['code']} · {result['name']}"
    elif kind == "geographic":
        result["label"] = f"{result['name']} · 经纬度坐标系，无标准编码"
    elif kind == "projected":
        result["label"] = f"{result['name']} · 自定义投影，无标准编码"
    else:
        result["label"] = f"{result['name']} · 无标准编码"
    return result


def extent_warning(crs, extent):
    """坐标数值和声明的坐标系明显矛盾时给一句提示。"""
    if not crs or not extent:
        return None
    vals = [extent.get(k) for k in ("left", "right", "bottom", "top")]
    if any(v is None for v in vals):
        return None
    kind = crs.get("kind")
    if kind == "geographic":
        if any(abs(v) > 180 for v in vals[:2]) or any(abs(v) > 90 for v in vals[2:]):
            return "坐标值超出经纬度范围，文件声明的坐标系可能有误（常见于把投影坐标当成经纬度存盘）"
    elif kind == "projected" and crs.get("unit_label") == "m":
        if all(abs(v) <= 180 for v in vals):
            return "坐标值看着像经纬度，但文件声明的是以米为单位的投影坐标系"
    return None


def transform_points(src_wkt, pts):
    """把一组平面坐标点转到经纬度，任意一个失败就返回 None。"""
    if not src_wkt or not pts:
        return None
    src = osr.SpatialReference()
    dst = osr.SpatialReference()
    try:
        src.SetFromUserInput(src_wkt)
        dst.ImportFromEPSG(4326)
        src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        ct = osr.CoordinateTransformation(src, dst)
        out = []
        for x, y in pts:
            lon, lat, _ = ct.TransformPoint(float(x), float(y))
            if lon is None or lat is None:
                return None
            out.append([round(float(lon), 6), round(float(lat), 6)])
        return out
    except Exception:
        return None


def ring_to_wgs84(src_wkt, left, bottom, right, top, densify=4):
    """把外包框四条边加密再转经纬度，得到真实轮廓环（圆锥投影下边是弧）。"""
    if not src_wkt:
        return None
    fx = [left + (right - left) * i / densify for i in range(densify + 1)]
    fy = [bottom + (top - bottom) * i / densify for i in range(densify + 1)]
    pts = ([(x, top) for x in fx] + [(right, y) for y in reversed(fy)]
           + [(x, bottom) for x in reversed(fx)] + [(left, y) for y in fy])
    ring = transform_points(src_wkt, pts)
    if ring:
        ring.append(ring[0])
    return ring


def bounds_to_wgs84(src_wkt, left, bottom, right, top, densify=3):
    """把数据范围转成经纬度外包围，供地图定位用。

    圆锥投影下四条边是弧线，只转四个角会漏掉弧顶，所以沿边取若干点。
    """
    if not src_wkt:
        return None
    src = osr.SpatialReference()
    dst = osr.SpatialReference()
    try:
        src.SetFromUserInput(src_wkt)
        dst.ImportFromEPSG(4326)
        src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        ct = osr.CoordinateTransformation(src, dst)
    except Exception:
        return None

    fx = [left + (right - left) * i / max(1, densify) for i in range(densify + 1)]
    fy = [bottom + (top - bottom) * i / max(1, densify) for i in range(densify + 1)]
    pts = [(x, y) for x in fx for y in (bottom, top)] + [(x, y) for y in fy for x in (left, right)]

    lons, lats = [], []
    for x, y in pts:
        try:
            lon, lat, _ = ct.TransformPoint(x, y)
        except Exception:
            return None
        if lon is None or lat is None:
            return None
        lons.append(lon)
        lats.append(lat)
    if not lons:
        return None
    return [round(min(lons), 6), round(min(lats), 6), round(max(lons), 6), round(max(lats), 6)]
