# -*- coding: utf-8 -*-
"""TopoJSON 写出。

GDAL 3.10 的 TopoJSON 驱动只读不写（驱动元数据里没有 DCAP_CREATE），
所以这一份自己写：把坐标量化到整数网格，按节点拆成弧段，相同（含反向）的弧
只存一次，对象里的几何按编号引用弧段。

只做"换一种文件存放"：不重投影、不简化、不合并要素，属性照原样写进 properties。
需要一次把图层读进内存（弧段要全部收齐才知道哪些重复），百万级要素的数据不适合转这个格式。
"""

import json
import math

from . import bootstrap

ogr = bootstrap.ogr

# 量化网格：按图层范围取相对精度 1e-7，全球数据约 4 米，县域数据在厘米级
QUANT = 10000000


class _Drop:
    """标记"这个值写不进 JSON"（二进制字段）。"""


_DROP = _Drop()


def _fmt_num(v):
    return float(v)


def _value(feat, i, ftype):
    try:
        if feat.IsFieldNull(i):
            return None
    except Exception:
        pass
    try:
        if ftype == ogr.OFTInteger:
            return int(feat.GetFieldAsInteger(i))
        if ftype == ogr.OFTInteger64:
            return int(feat.GetFieldAsInteger64(i))
        if ftype == ogr.OFTReal:
            v = float(feat.GetFieldAsDouble(i))
            return v if math.isfinite(v) else None
        if ftype == ogr.OFTString:
            return feat.GetFieldAsString(i)
        if ftype in (ogr.OFTDate, ogr.OFTTime, ogr.OFTDateTime):
            y, mo, d, hh, mi, ss, _tz = feat.GetFieldAsDateTime(i)
            if ftype == ogr.OFTDate:
                return "%04d-%02d-%02d" % (y, mo, d)
            if ftype == ogr.OFTTime:
                return "%02d:%02d:%02d" % (hh, mi, ss)
            return "%04d-%02d-%02dT%02d:%02d:%02d" % (y, mo, d, hh, mi, ss)
        if ftype == ogr.OFTStringList:
            return list(feat.GetFieldAsStringList(i) or [])
        if ftype == ogr.OFTIntegerList:
            return list(feat.GetFieldAsIntegerList(i) or [])
        if ftype == ogr.OFTRealList:
            return [float(x) for x in (feat.GetFieldAsDoubleList(i) or [])]
        if ftype == ogr.OFTInteger64List:
            return [int(x) for x in (feat.GetFieldAsInteger64List(i) or [])]
    except Exception:
        return None
    return _DROP


def _extent(lyr):
    """图层范围；空图层或算不出来时返回 None。"""
    try:
        ext = lyr.GetExtent(force=1)
    except TypeError:
        ext = lyr.GetExtent()
    except Exception:
        return None
    if not ext:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in ext):
        return None
    return ext


def _clean(pts, ring):
    """去掉连续重复点；环补上闭合点。点数不够的返回 None。"""
    out = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    if ring:
        if len(out) < 3:
            return None
        if out[0] != out[-1]:
            out.append(out[0])
        return out if len(out) >= 4 else None
    return out if len(out) >= 2 else None


class _Builder:
    def __init__(self, ext):
        xmin, xmax, ymin, ymax = ext
        self.x0, self.y0 = xmin, ymin
        self.sx = (xmax - xmin) / (QUANT - 1) if xmax > xmin else 1.0
        self.sy = (ymax - ymin) / (QUANT - 1) if ymax > ymin else 1.0
        self.arcs = []
        self.index = {}
        self.lines = []

    def q(self, p):
        return (int(round((p[0] - self.x0) / self.sx)),
                int(round((p[1] - self.y0) / self.sy)))

    # ---- 第一步：把 GeoJSON 几何换成"线对象"，顺手收集所有线 ----

    def prepare(self, g):
        if not isinstance(g, dict):
            return None
        t = g.get("type")
        c = g.get("coordinates")
        if t == "Point" and c:
            return ("Point", self.q(c))
        if t == "MultiPoint" and c:
            return ("MultiPoint", [self.q(p) for p in c])
        if t == "LineString":
            ln = self._line(c, False)
            return ("LineString", ln) if ln else None
        if t == "MultiLineString":
            lns = [x for x in (self._line(c2, False) for c2 in c) if x]
            return ("MultiLineString", lns) if lns else None
        if t == "Polygon":
            lns = [x for x in (self._line(r, True) for r in c) if x]
            return ("Polygon", lns) if lns else None
        if t == "MultiPolygon":
            polys = []
            for poly in c:
                lns = [x for x in (self._line(r, True) for r in poly) if x]
                if lns:
                    polys.append(lns)
            return ("MultiPolygon", polys) if polys else None
        if t == "GeometryCollection":
            nodes = [x for x in (self.prepare(x2) for x2 in (g.get("geometries") or [])) if x]
            return ("GeometryCollection", nodes) if nodes else None
        return None

    def _line(self, coords, ring):
        if not coords:
            return None
        pts = _clean([self.q(p) for p in coords if p], ring)
        if not pts:
            return None
        ln = _Line(pts, ring)
        self.lines.append(ln)
        return ln

    # ---- 第二步：找节点、拆弧段 ----

    def build_arcs(self):
        seg = {}
        for ln in self.lines:
            for a, b in zip(ln.pts, ln.pts[1:]):
                key = (a, b) if a <= b else (b, a)
                seg[key] = seg.get(key, 0) + 1
        deg = {}
        for a, b in seg:
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
        junctions = {p for p, d in deg.items() if d != 2}
        for ln in self.lines:
            ln.arcs = self._split(ln, junctions)

    def _split(self, ln, junctions):
        pts = ln.pts
        if ln.ring:
            core = pts[:-1]
            hits = [i for i, p in enumerate(core) if p in junctions]
            if not hits:
                return [self._add(core)]
            start = hits[0]
            seq = core[start:] + core[:start] + [core[start]]
        else:
            seq = pts
        out = []
        cur = [seq[0]]
        for p in seq[1:]:
            cur.append(p)
            if p in junctions:
                out.append(self._add(cur))
                cur = [p]
        if len(cur) > 1:
            out.append(self._add(cur))
        return out or [self._add(seq)]

    def _add(self, pts):
        key = tuple(pts)
        if key in self.index:
            return self.index[key]
        rkey = tuple(reversed(pts))
        if rkey in self.index:
            return ~self.index[rkey]   # 反向引用：TopoJSON 里 ~i 表示第 i 条弧倒着走
        idx = len(self.arcs)
        self.arcs.append(pts)
        self.index[key] = idx
        return idx

    # ---- 第三步：把线对象换回 TopoJSON 几何 ----

    def emit(self, node):
        t, v = node
        if t in ("Point", "MultiPoint"):
            return {"type": t, "coordinates": list(v)}
        if t == "LineString":
            return {"type": t, "arcs": v.arcs}
        if t == "MultiLineString":
            return {"type": t, "arcs": [ln.arcs for ln in v]}
        if t == "Polygon":
            return {"type": t, "arcs": [ln.arcs for ln in v]}
        if t == "MultiPolygon":
            return {"type": t, "arcs": [[ln.arcs for ln in poly] for poly in v]}
        return {"type": "GeometryCollection", "geometries": [self.emit(x) for x in v]}

    def encoded_arcs(self):
        out = []
        for pts in self.arcs:
            row = [list(pts[0])]
            prev = pts[0]
            for p in pts[1:]:
                row.append([p[0] - prev[0], p[1] - prev[1]])
                prev = p
            out.append(row)
        return out


class _Line:
    __slots__ = ("pts", "ring", "arcs")

    def __init__(self, pts, ring):
        self.pts = pts
        self.ring = ring
        self.arcs = []


def write(lyr, out_path, layer_name, xf=None):
    """把图层写成 TopoJSON。

    xf 是"换算到 WGS 84"的坐标转换器（KML/GPX/TopoJSON 这类按规范只收经纬度，
    源数据是投影坐标时要先换过来）。有 xf 时范围按换算后的几何现算，
    量化格网才对得上。

    返回 (写出要素数, 跳过的无几何要素数, 保存不了的字段数)。
    """
    defn = lyr.GetLayerDefn()
    fields = []
    dropped = 0
    for i in range(defn.GetFieldCount()):
        fd = defn.GetFieldDefn(i)
        if fd.GetType() == ogr.OFTBinary:
            dropped += 1
            continue
        fields.append((i, fd.GetNameRef(), fd.GetType()))

    ext = _extent(lyr)
    raw = []
    skipped = 0
    lyr.ResetReading()
    while True:
        feat = lyr.GetNextFeature()
        if feat is None:
            break
        geom = feat.GetGeometryRef()
        if geom is None or geom.IsEmpty():
            skipped += 1
            continue
        if xf is not None:
            geom = geom.Clone()
            try:
                geom.Transform(xf)
            except Exception:
                skipped += 1
                continue
            env = geom.GetEnvelope()   # (minx, maxx, miny, maxy)
            if not raw:
                ext = (env[0], env[1], env[2], env[3])
            else:
                ext = (min(ext[0], env[0]), max(ext[1], env[1]),
                       min(ext[2], env[2]), max(ext[3], env[3]))
            if not all(math.isfinite(v) for v in ext):
                raise RuntimeError("换算后的坐标不是有限数值，写不了 TopoJSON")
        try:
            text = geom.ExportToJson()
        except Exception:
            skipped += 1
            continue
        props = {}
        for idx, name, ftype in fields:
            v = _value(feat, idx, ftype)
            if v is not _DROP:
                props[name] = v
        raw.append((text, props))
    lyr.ResetReading()

    if not raw:
        raise RuntimeError("没有可写的要素")
    if ext is None:
        raise RuntimeError("这份数据没有可用的范围，写不了 TopoJSON")

    builder = _Builder(ext)
    items = []
    for text, props in raw:
        try:
            node = builder.prepare(json.loads(text))
        except Exception:
            node = None
        if node is None:
            skipped += 1
            continue
        items.append((node, props))
    if not items:
        raise RuntimeError("没有可写的要素")

    builder.build_arcs()
    geometries = []
    for node, props in items:
        g = builder.emit(node)
        g["properties"] = props
        geometries.append(g)

    doc = {
        "type": "Topology",
        "objects": {layer_name: {"type": "GeometryCollection", "geometries": geometries}},
        "arcs": builder.encoded_arcs(),
        "transform": {"scale": [builder.sx, builder.sy],
                      "translate": [builder.x0, builder.y0]},
        "bbox": [ext[0], ext[2], ext[1], ext[3]],
    }
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return len(items), skipped, dropped
