"""GeoParquet 读写。

GeoParquet 就是 Parquet 列存加一列 WKB 几何，再在文件级元数据里写一条 `geo`：

    {"version":"1.1.0","primary_column":"geometry",
     "columns":{"geometry":{"encoding":"WKB","geometry_types":["Polygon"],
                            "crs":{...PROJJSON...},"bbox":[xmin,ymin,xmax,ymax]}}}

本机这套 GDAL 3.10 没有编译 Parquet 驱动（`ogr.GetDriverByName("Parquet")` 为空），
所以 Parquet 那一层借 duckdb 做：读用 `read_parquet`，写用 `COPY ... (FORMAT PARQUET,
KV_METADATA {geo: '...'})`。几何交给 OGR 的 WKB 编解码，两边按上面这套约定对接。

读：parquet → 临时 GeoJSON（文件名带源文件指纹），之后照常走 OGR 那条路，
    属性表、检索、体检、转换都不用另开分支。
写：OGR 图层 → 逐要素取 WKB 与属性 → duckdb 建表 → COPY 成 parquet。

百万级要素不适合走这条路：两边都是一次性进内存。
"""

import contextlib
import json
import os
import time

from . import bootstrap, cache

ogr = bootstrap.ogr
osr = bootstrap.osr

EXT = (".parquet", ".geoparquet")
# 临时的 GeoJSON 留多久：缓存目录里按最后访问时间清
_KEEP_DAYS = 3.0

# OGR 字段类型 → duckdb 列类型。列表类统一按 TEXT 存 JSON，
# parquet 里是普通的字符串列，读回来照样能看
_SQL_TYPE = {
    ogr.OFTInteger: "INTEGER",
    ogr.OFTInteger64: "BIGINT",
    ogr.OFTReal: "DOUBLE",
    ogr.OFTString: "VARCHAR",
    ogr.OFTWideString: "VARCHAR",
    ogr.OFTDate: "DATE",
    ogr.OFTTime: "TIME",
    ogr.OFTDateTime: "TIMESTAMP",
    ogr.OFTBinary: "BLOB",
    ogr.OFTStringList: "VARCHAR",
    ogr.OFTIntegerList: "VARCHAR",
    ogr.OFTRealList: "VARCHAR",
}

# duckdb 列类型（前缀）→ OGR 字段类型
_OFT_TYPE = (
    ("BIGINT", ogr.OFTInteger64),
    ("UBIGINT", ogr.OFTInteger64),
    ("HUGEINT", ogr.OFTInteger64),
    ("INTEGER", ogr.OFTInteger),
    ("UINTEGER", ogr.OFTInteger),
    ("SMALLINT", ogr.OFTInteger),
    ("TINYINT", ogr.OFTInteger),
    ("BOOLEAN", ogr.OFTInteger),
    ("DOUBLE", ogr.OFTReal),
    ("FLOAT", ogr.OFTReal),
    ("DECIMAL", ogr.OFTReal),
    ("TIMESTAMP", ogr.OFTDateTime),
    ("DATE", ogr.OFTDate),
    ("TIME", ogr.OFTTime),
    ("BLOB", ogr.OFTBinary),
    ("BINARY", ogr.OFTBinary),
)

_GEOM_NAMES = {
    "POINT": "Point",
    "MULTIPOINT": "MultiPoint",
    "LINESTRING": "LineString",
    "MULTILINESTRING": "MultiLineString",
    "POLYGON": "Polygon",
    "MULTIPOLYGON": "MultiPolygon",
    "GEOMETRYCOLLECTION": "GeometryCollection",
}

_NAME_TO_WKB = {
    "Point": ogr.wkbPoint,
    "MultiPoint": ogr.wkbMultiPoint,
    "LineString": ogr.wkbLineString,
    "MultiLineString": ogr.wkbMultiLineString,
    "Polygon": ogr.wkbPolygon,
    "MultiPolygon": ogr.wkbMultiPolygon,
    "GeometryCollection": ogr.wkbGeometryCollection,
}


def is_parquet(path):
    p = str(path or "").strip().lower()
    if not p or p.startswith("/vsizip/"):
        return False
    return p.endswith(EXT)


def _duckdb():
    """按需导入：没有 duckdb 时给一句能读懂的话，不让整个引擎起不来。"""
    try:
        import duckdb  # pyright: ignore[reportMissingImports]
    except Exception as exc:
        raise RuntimeError(f"缺少 Parquet 读写组件（duckdb）：{exc}") from None
    return duckdb


def _lit(text):
    """SQL 里的字符串字面量。Windows 路径的反斜杠原样写会当转义，统一换成正斜杠。"""
    return "'" + str(text).replace("\\", "/").replace("'", "''") + "'"


def geo_meta(path):
    """读文件级 `geo` 元数据；不是 GeoParquet 就返回 None。"""
    duckdb = _duckdb()
    con = duckdb.connect()
    try:
        # 路径走占位符，SQL 是固定的
        rows = con.execute("SELECT key, value FROM parquet_kv_metadata(?)", [str(path)]).fetchall()
    finally:
        con.close()
    for key, val in rows:
        k = key.decode("utf-8", "replace") if isinstance(key, bytes) else str(key)
        if k == "geo":
            text = val.decode("utf-8", "replace") if isinstance(val, bytes) else str(val)
            try:
                return json.loads(text)
            except ValueError:
                return None
    return None


def _srs_from_meta(meta, col):
    """geo 元数据里的 crs 是 PROJJSON；没写就按规范当 OGC:CRS84（经纬度）。"""
    raw = col.get("crs")
    srs = osr.SpatialReference()
    if raw:
        # 元数据里的 crs 写法五花八门，认不出来就退回 CRS84
        with contextlib.suppress(Exception):
            srs.SetFromUserInput(raw if isinstance(raw, str) else json.dumps(raw))
            srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            return srs
    srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs


def _oft(sql_type):
    up = str(sql_type or "").upper()
    for prefix, oft in _OFT_TYPE:
        if up.startswith(prefix):
            return oft
    return ogr.OFTString


def _plain(value):
    """duckdb 回来的值换成 OGR 收得下的：日期时间原样，Decimal/列表/字典降级。"""
    if value is None or isinstance(value, (str, int, float, bytes, bool)):
        return value
    if isinstance(value, (list, tuple, dict)):
        return json.dumps(value, ensure_ascii=False)
    low = type(value).__name__.lower()
    if "decimal" in low:
        return float(value)  # pi-lens-ignore: unchecked-numeric-parse-python -- duckdb 的 Decimal，转换不会失败
    if "date" in low or "time" in low:
        return value
    if "uuid" in low:
        return str(value)
    return str(value)


def read_to_geojson(src, dst):
    """把 GeoParquet 摊成一份 GeoJSON（带 crs member），返回 (要素数, 图层名)。"""
    duckdb = _duckdb()
    meta = geo_meta(src)
    if not meta:
        raise ValueError("这个文件里没有 GeoParquet 的几何元数据，按普通表格处理不了。")
    geom_col = meta.get("primary_column") or "geometry"
    col = (meta.get("columns") or {}).get(geom_col) or {}
    enc = str(col.get("encoding") or "WKB").upper()
    if enc != "WKB":
        raise ValueError(f"几何列用的是 {enc} 编码，当前只认 WKB。")

    name = os.path.splitext(os.path.basename(str(src)))[0]
    con = duckdb.connect()
    try:
        desc = con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(src)]).fetchall()
        names = [str(r[0]) for r in desc]
        if geom_col not in names:
            raise ValueError(f"元数据指的几何列 {geom_col} 不在文件里。")
        picks = []
        for col_name, _col_type in [(str(r[0]), str(r[1])) for r in desc]:
            # 列名来自文件本身，双引号里再转义一次，值一律不进 SQL
            q = '"' + col_name.replace('"', '""') + '"'
            if col_name == geom_col:
                picks.append(f"CAST({q} AS BLOB) AS {q}")
            else:
                picks.append(q)
        # 列名来自文件自身的 schema，路径走占位符
        # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query
        sql = f"SELECT {', '.join(picks)} FROM read_parquet(?)"  # noqa: S608 - 拼的是列名，不是值
        # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
        rows = con.execute(sql, [str(src)]).fetchall()  # pi-lens-ignore: python-sql-injection
    finally:
        con.close()

    srs = _srs_from_meta(meta, col)
    types = [t for t in (col.get("geometry_types") or []) if t in _NAME_TO_WKB]
    geom_type = _NAME_TO_WKB[types[0]] if len(types) == 1 else ogr.wkbUnknown

    driver = ogr.GetDriverByName("GeoJSON")
    if os.path.exists(dst):
        with contextlib.suppress(OSError):
            os.remove(dst)  # pi-lens-ignore: unchecked-throwing-call-python, python-path-traversal -- 缓存目录里自己生成的临时文件
    ds = driver.CreateDataSource(dst)  # pi-lens-ignore: unchecked-throwing-call-python, python-path-traversal -- 缓存目录里自己生成的临时文件
    if ds is None:
        raise RuntimeError(f"无法创建临时 GeoJSON：{dst}")
    try:
        lyr = ds.CreateLayer(name or "parquet", srs=srs, geom_type=geom_type)
        fields = []
        for col_name, col_type in [(str(r[0]), str(r[1])) for r in desc]:
            if col_name == geom_col:
                continue
            fd = ogr.FieldDefn(col_name, _oft(col_type))
            if fd.GetType() == ogr.OFTString:
                fd.SetWidth(0)   # 0 = 不限长，别让驱动按默认 80 截断
            lyr.CreateField(fd)
            fields.append(col_name)
        defn = lyr.GetLayerDefn()
        idx = names.index(geom_col)
        written = 0
        for row in rows:
            feat = ogr.Feature(defn)
            blob = row[idx]
            if blob:
                geom = ogr.CreateGeometryFromWkb(bytes(blob))
                if geom is not None:
                    feat.SetGeometry(geom)
            for j, col_name in enumerate(fields):
                val = _plain(row[j] if j < idx else row[j + 1])
                if val is None:
                    continue
                try:
                    feat.SetField(col_name, val)
                except Exception:
                    feat.SetField(col_name, str(val))
            lyr.CreateFeature(feat)
            written += 1
        lyr.SyncToDisk()
    finally:
        ds = None
    return written, (name or "parquet")


def _fingerprint(path):
    try:
        st = os.stat(path)
        return f"{st.st_size}_{st.st_mtime_ns}"
    except OSError:
        return "0_0"


def _prune(folder):
    now = time.time()
    with contextlib.suppress(OSError):   # 目录刚被清掉就当没有要清的
        for name in os.listdir(folder):  # pi-lens-ignore: unchecked-throwing-call-python
            if not name.endswith(".geojson"):
                continue
            full = os.path.join(folder, name)
            with contextlib.suppress(OSError):
                if now - os.path.getmtime(full) > _KEEP_DAYS * 86400:  # pi-lens-ignore: unchecked-throwing-call-python
                    os.remove(full)  # pi-lens-ignore: python-path-traversal -- 缓存目录里自己的临时文件


def materialize(src):
    """把 GeoParquet 摊成 GeoJSON 缓存起来，返回可以交给 OGR 的路径。

    缓存键是"路径 + 大小 + 纳秒修改时间"，文件一变自然不命中。"""
    folder = cache._root() / "parquet"
    folder.mkdir(parents=True, exist_ok=True)
    stem = os.path.splitext(os.path.basename(str(src).rstrip("\\/")))[0]
    safe = "".join(c for c in stem if c not in '\\/:*?"<>|')[:40] or "data"
    dst = str(folder / f"{safe}_{_fingerprint(src)}.geojson")
    if os.path.isfile(dst) and os.path.getsize(dst) > 0:
        with contextlib.suppress(OSError):
            os.utime(dst, None)   # 当"最近用过"的记号，别被清掉
        return dst
    _prune(str(folder))
    read_to_geojson(src, dst)
    return dst


def write(lyr, out_path, layer_name):
    """把 OGR 图层写成 GeoParquet，返回 (写出要素数, 丢掉的字段数)。"""
    duckdb = _duckdb()
    defn = lyr.GetLayerDefn()
    fields = []
    for i in range(defn.GetFieldCount()):
        fd = defn.GetFieldDefn(i)
        fields.append((fd.GetNameRef(), _SQL_TYPE.get(fd.GetType(), "VARCHAR")))

    # 几何列名：表里已经有同名列时退到 geom，别把属性覆盖掉
    geom_col = "geometry"
    lower = {n.lower() for n, _ in fields}
    if geom_col in lower:
        geom_col = "geom"

    con = duckdb.connect()
    try:
        cols = ['"' + geom_col + '" BLOB'] + [
            '"' + n.replace('"', '""') + '" ' + t for n, t in fields
        ]
        # 列名只能拼进 DDL（SQL 不支持给标识符占位），值全部走下面的 ? 占位符
        # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query
        ddl = f"CREATE TABLE t ({', '.join(cols)})"  # noqa: S608 - 拼的是列名，不是值
        # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
        con.execute(ddl)  # pi-lens-ignore: python-sql-injection
        marks = ", ".join(["?"] * (len(fields) + 1))
        sql = f"INSERT INTO t VALUES ({marks})"  # noqa: S608 - 只有 ? 占位符
        batch = []
        written = 0
        geom_names = []
        lyr.ResetReading()
        while True:
            feat = lyr.GetNextFeature()
            if feat is None:
                break
            geom = feat.GetGeometryRef()
            if geom is not None and geom.IsEmpty():
                geom = None
            if geom is not None:
                gname = str(geom.GetGeometryName()).upper()
                if gname not in geom_names:
                    geom_names.append(gname)
                blob = bytes(geom.ExportToWkb())
            else:
                blob = None
            row: list = [blob]
            for i in range(len(fields)):
                if feat.IsFieldNull(i):
                    row.append(None)
                    continue
                ftype = defn.GetFieldDefn(i).GetType()
                try:
                    if ftype in (ogr.OFTStringList, ogr.OFTIntegerList, ogr.OFTRealList):
                        row.append(json.dumps(feat.GetField(i), ensure_ascii=False))
                    elif ftype == ogr.OFTBinary:
                        row.append(feat.GetFieldAsBinary(i))
                    else:
                        row.append(feat.GetField(i))
                except Exception:
                    row.append(feat.GetFieldAsString(i))
            batch.append(row)
            written += 1
            if len(batch) >= 2000:
                con.executemany(sql, batch)  # pi-lens-ignore: python-sql-injection
                batch = []
        if batch:
            con.executemany(sql, batch)  # pi-lens-ignore: python-sql-injection

        # 属性列建不出来时 duckdb 在 CREATE TABLE 就报错，走不到这里；字段照源定义建齐
        try:
            extent = lyr.GetExtent(force=1)
        except Exception:
            extent = None
        srs = lyr.GetSpatialRef()
        try:
            crs = json.loads(srs.ExportToPROJJSON()) if srs is not None else None
        except Exception:
            crs = None
        gtypes = []
        for gname in geom_names:
            nice = _GEOM_NAMES.get(gname)
            if nice and nice not in gtypes:
                gtypes.append(nice)
        meta = {
            "version": "1.1.0",
            "primary_column": geom_col,
            "columns": {
                geom_col: {
                    "encoding": "WKB",
                    "geometry_types": gtypes,
                    "crs": crs,
                    "bbox": ([float(extent[0]), float(extent[2]), float(extent[1]), float(extent[3])]
                            if extent else None),
                }
            },
        }
        text = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
        # COPY 的目标路径与元数据都只能写成字面量；路径经 _lit 转义，text 里的单引号已翻倍
        # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query
        copy_sql = (
            f"COPY (SELECT * FROM t) TO {_lit(out_path)}"  # noqa: S608 - 没有外部输入
            f"(FORMAT PARQUET, KV_METADATA {{geo: '{text}'}})"
        )
        con.execute(copy_sql)  # pi-lens-ignore: python-sql-injection
    finally:
        con.close()
    return written, 0
