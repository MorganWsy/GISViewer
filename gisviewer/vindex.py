"""给没有空间索引的大矢量文件建一份本地索引。

为什么需要：GeoJSON、KML 这类文本格式没有空间索引，OGR 的 SetSpatialFilterRect
只是"边读边筛"——取一个视野照样得把整份文件解析一遍。wuningGEP.json（138 MB、
10.9 万要素）实测一次取数 5~9 秒，拖一下地图就要等这么久。

做法：第一次按视野取数时，顺手把这批要素写进一个 SQLite 文件：
  要素编号、属性 JSON、WKB 几何，外加一棵 R*Tree。
之后的按视野取数变成一次索引查询（实测 410 个要素 6 毫秒）。
同一个文件再打开、再拖动，都不用重新解析源文件。

索引只当加速用：文件小于 MIN_BYTES、驱动本来就有空间索引、或者建不出来
（磁盘满、路径不可写），一律返回 None，调用方照旧读原文件。
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

from osgeo import ogr  # pyright: ignore[reportMissingImports]

from . import cache

MIN_BYTES = 8 * 1024 * 1024      # 小于 8 MB 的文件整份读也快，不值得建索引
SCHEMA_VERSION = 2         # 2：meta 里加了坐标系、字段表、要素总数，命中索引时不必再打开源文件
LOCK_STALE = 15 * 60      # 建索引的锁超过 15 分钟视为残留（正常一份 60~70 秒）

_lock = threading.Lock()
_procs = {}                      # 索引键 -> 正在建它的子进程；同一文件不重复建


def _as_int(value, default=0):
    """配置/URL 里来的层号、limit 可能是 None 或脏字符串；坏值退回默认，不抛。"""
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _size(target):
    try:
        return os.path.getsize(str(target))
    except OSError:
        return 0


def suitable(target, lyr):
    """这个文件值不值得建索引：够大，且驱动没有快速空间筛选。"""
    if _size(target) < MIN_BYTES:
        return False
    try:
        return not lyr.TestCapability(ogr.OLCFastSpatialFilter)
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return True


def key_of(target, layer_index):
    return cache.key("vindex", target, f"layer={_as_int(layer_index)};v={SCHEMA_VERSION}")


def path_of(target, layer_index):
    k = key_of(target, layer_index)
    if not k:
        return None
    return cache.blob_path("vindex", k, ".sqlite")


def existing(target, layer_index):
    """已经有了的索引文件；没有就返回 None（不会去建）。"""
    path = path_of(target, layer_index)
    return str(path) if path and path.exists() else None


def _connect(path, readonly=False):
    if readonly:
        uri = f"file:{str(path).replace(chr(92), '/')}?mode=ro"
        return sqlite3.connect(uri, uri=True, timeout=5.0)
    return sqlite3.connect(str(path), timeout=5.0)


def _field_specs(lyr):
    """字段的（序号, 名字, 是不是布尔）一次列好，与 vector 里那份同口径。
    空字段名照留：源文件里就有这种列，取数时出一模一样的结果才不会前后不一致。"""
    defn = lyr.GetLayerDefn()
    specs = []
    for i in range(defn.GetFieldCount()):
        fdef = defn.GetFieldDefn(i)
        specs.append((i, fdef.GetName(),
                      fdef.GetType() == ogr.OFTInteger and fdef.GetSubType() == ogr.OFSTBoolean))
    return specs


def build(target, layer_index, path):
    """把要素流式写进索引。

    索引里除了几何与属性，还存了坐标系、图层名、字段表、要素总数：
    有这些，命中索引时连源文件都不用打开（GeoJSON 驱动打开一次要把整份文件
    读进内存，138 MB 要 3 秒，而这正是索引要省掉的那一步）。

    返回写入的要素数。中途出错会把半成品删掉，不让它冒充可用索引。
    """
    from . import dwg, vector  # 延迟导入：vector 反过来要用本模块

    # DWG 新版要先转 DXF 才能被 OGR 打开；索引建在原始路径上，
    # 转换结果只在本函数内用
    if str(target).lower().endswith(".dwg"):
        target = dwg.convert(str(target)) or target

    tmp = str(path) + ".tmp"
    for stale in (tmp,):
        Path(stale).unlink(missing_ok=True)
    ds = vector._open_vector(target)
    if ds is None:
        return 0
    lyr = ds.GetLayerByIndex(_as_int(layer_index))
    if lyr is None:
        return 0
    specs = _field_specs(lyr)
    srs = lyr.GetSpatialRef()
    srs_wkt = srs.ExportToWkt() if srs else ""
    # 没有坐标系时，读文件那条路有两种处置：表格驱动的格式按经纬度直接用，
    # 其余（CAD 图纸、本地坐标）当成墨卡托平面临时摆上去。这里把当时的判断记下来，
    # 命中索引时才不用为了"该怎么摆"再去打开源文件
    wgs84 = assumed_local = False
    if srs_wkt:
        wgs84 = vector._pair(srs_wkt)[2] is None
    else:
        wgs84 = vector._driver_name(ds) in vector._TABLE_WGS84_DRIVERS
        assumed_local = not wgs84
        if assumed_local:
            # CAD 图纸按 $INSUNITS 缩小到米以后才摆到 3857；
            # 索引里也存这份带单位的 WKT，查询时才不会把毫米当米
            with contextlib.suppress(Exception):
                srs_wkt = vector._local_srs(target)[0].ExportToWkt()
    conn = None
    n = 0
    try:
        conn = _connect(tmp)
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("CREATE TABLE f (fid INTEGER PRIMARY KEY, props TEXT NOT NULL, wkb BLOB)")
        conn.execute("CREATE VIRTUAL TABLE g USING rtree(id, minx, maxx, miny, maxy)")
        conn.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)")
        conn.executemany("INSERT INTO meta VALUES (?, ?)", [
            ("layer", str(int(layer_index or 0))),
            ("srs", srs_wkt),
            ("geom_type", str(int(lyr.GetGeomType()))),
            ("layer_name", lyr.GetName() or ""),
            ("fields", json.dumps([[nm, bool(b)] for _, nm, b in specs], ensure_ascii=False)),
            ("wgs84", "1" if wgs84 else "0"),
            ("assumed_local", "1" if assumed_local else "0"),
        ])
        # SCHEMA_VERSION 是本文件的整数常量，不来自外部
        # PRAGMA 不吃参数占位符，这里拼的是本文件的整数常量，不来自外部
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")  # pi-lens-ignore: python.lang.security.audit.formatted-sql-query.formatted-sql-query, python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
        lyr.ResetReading()
        rows_f = []
        rows_g = []
        while True:
            feat = lyr.GetNextFeature()
            if feat is None:
                break
            try:
                fid = int(feat.GetFID())
            except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
                fid = n
            geom = feat.GetGeometryRef()
            blob = None
            env = None
            if geom is not None and not geom.IsEmpty():
                try:
                    blob = bytes(geom.ExportToWkb())
                    env = geom.GetEnvelope()   # (minX, maxX, minY, maxY)
                except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
                    blob = None
                    env = None
            rows_f.append((fid, json.dumps(vector.feature_props(feat, specs),
                                           ensure_ascii=False), blob))
            if env is not None and all(v is not None for v in env):
                # R*Tree 的 id 从 1 起，拿 fid+1 存，查出来再减回去
                rows_g.append((fid + 1, env[0], env[1], env[2], env[3]))
            n += 1
            # 攒一批再一次写入：逐条 execute 十万次要十几秒，批量只要两三秒
            if len(rows_f) >= 2000:
                conn.executemany("INSERT INTO f VALUES (?, ?, ?)", rows_f)  # pi-lens-ignore: python-sql-injection -- SQL 常量，值已绑定
                conn.executemany("INSERT INTO g VALUES (?, ?, ?, ?, ?)", rows_g)  # pi-lens-ignore: python-sql-injection -- SQL 常量，值已绑定
                rows_f, rows_g = [], []
        if rows_f:
            conn.executemany("INSERT INTO f VALUES (?, ?, ?)", rows_f)  # pi-lens-ignore: python-sql-injection -- SQL 常量，值已绑定
            conn.executemany("INSERT INTO g VALUES (?, ?, ?, ?, ?)", rows_g)  # pi-lens-ignore: python-sql-injection -- SQL 常量，值已绑定
        conn.execute("INSERT INTO meta VALUES ('total', ?)", (str(n),))
        conn.commit()
        conn.close()
        conn = None
        os.replace(tmp, path)
        return n
    except Exception:
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
        for stale in (tmp,):
            with contextlib.suppress(OSError):
                os.remove(stale)  # pi-lens-ignore: python-path-traversal -- 本函数自己建的临时文件
        raise
    finally:
        ds = None


def _lock_path(path):
    return str(path) + ".lock"


def _acquire_lock(path):
    """跨进程抢“建索引”的锁：拿到返回锁路径，别人在建设返回 None。
    锁文件里写 pid 与时间，进程被杀后最多等 LOCK_STALE 就能自动放行。"""
    lock = _lock_path(path)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)  # pi-lens-ignore: python-path-traversal -- 索引旁的锁文件
    except FileExistsError:  # pi-lens-ignore: unreachable-except -- FileExistsError 是 OSError 子类，必须先捕
        try:
            age = time.time() - os.path.getmtime(lock)
        except OSError:
            age = 0
        if age < LOCK_STALE:
            return None
        try:
            os.remove(lock)  # pi-lens-ignore: python-path-traversal -- 过期锁，路径由 path_of 决定
        except OSError:
            return None
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)  # pi-lens-ignore: python-path-traversal -- 索引旁的锁文件
        except OSError:
            return None
    except OSError:
        return None
    try:
        os.write(fd, f"{os.getpid()} {time.time()}\n".encode("ascii"))
    finally:
        os.close(fd)
    return lock


def _release_lock(lock):
    if lock:
        Path(lock).unlink(missing_ok=True)


def _watch(proc, lock, key):
    """子进程结束后释放锁；父进程被杀时留下锁，由 _acquire_lock 的超时处理。"""
    try:
        proc.wait()
    finally:
        _release_lock(lock)
        with _lock:
            _procs.pop(key, None)


def ensure(target, layer_index, wait=False):
    """要索引，没有就建一份。

    默认交给子进程去建：138 MB 的 GeoJSON 建一份要占满一个核二十来秒，
    放在引擎进程的线程里会和正在取数的请求抢 CPU，用户那几次拖动会慢一倍。
    子进程各用各的核，前台取数不受影响；建好之后的下一次拖动自动走索引。

    wait=True 时在本进程同步建完（命令行、测试用）。
    返回已存在的索引路径；正在建或建不出来时返回 None，调用方照旧读源文件。
    """
    if _size(target) < MIN_BYTES:
        return None
    path = path_of(target, layer_index)
    if not path:
        return None
    k = str(path)
    if os.path.exists(k):
        return k
    if wait:
        lock = _acquire_lock(k)
        if lock is None:
            return None
        try:
            build(target, layer_index, path)
        except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
            return None
        finally:
            _release_lock(lock)
        return k if os.path.exists(k) else None
    with _lock:
        proc = _procs.get(k)
        if proc is not None and proc.poll() is None:
            return None                 # 本进程正在建，别再起一个
    lock = _acquire_lock(k)
    if lock is None:
        return None                     # 别的进程正在建，等它

    args = [sys.executable, "-m", "gisviewer.vindex_run", str(target),
            str(_as_int(layer_index)), k]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt":
        # 后台建索引别跟首屏抢 CPU：低于正常优先级，前台拖动优先
        flags |= getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    log = None
    try:
        with open(k + ".log", "ab", buffering=0) as log:  # pi-lens-ignore: python-path-traversal -- 索引旁的日志
            proc = subprocess.Popen(args, creationflags=flags, cwd=root,
                                    stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=log,
                                    close_fds=True)
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        _release_lock(lock)
        return None
    with _lock:
        _procs[k] = proc
    threading.Thread(target=_watch, args=(proc, lock, k), daemon=True).start()  # pi-lens-ignore: python-thread-global-write
    return None


def building(target, layer_index):
    """这个文件此刻是否正在建索引（界面据此说明"为什么这次还慢"）。"""
    path = path_of(target, layer_index)
    if not path:
        return False
    lock = _lock_path(path)
    try:
        if time.time() - os.path.getmtime(lock) < LOCK_STALE:
            return True
    except OSError:
        pass  # pi-lens-ignore: python-empty-except -- 没有锁文件就是没在建
    with _lock:
        proc = _procs.get(str(path))
        return proc is not None and proc.poll() is None


def _srs_of(path, meta_cache):
    """索引里记的坐标系。几何从 WKB 还原时没人给它坐标系，
    而面积、周长要在带坐标系的几何上才算得出来（GeodesicArea 会直接报错）。"""
    wkt = meta_cache.get("srs") or ""
    if not wkt:
        return None
    try:
        from osgeo import osr  # pyright: ignore[reportMissingImports]
        ref = osr.SpatialReference()
        ref.SetFromUserInput(wkt)
        ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        return ref
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return None


def _rows(conn, sql, args, srs=None):
    out = []
    # sql 只由本模块的常量拼成，值一律走 args；这里不是用户输入
    for fid, props, wkb in conn.execute(sql, args):  # pi-lens-ignore: python-sql-injection -- sql 仅本模块常量，值走 args
        try:
            obj = json.loads(props)
        except ValueError:
            obj = {}
        geom = None
        if wkb:
            try:
                geom = ogr.CreateGeometryFromWkb(wkb)
                if geom is not None and srs is not None:
                    geom.AssignSpatialReference(srs)
            except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
                geom = None
        env = None
        if geom is not None:
            try:
                env = geom.GetEnvelope()
            except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
                env = None
        out.append({
            "fid": fid,
            "props": obj,
            "geom": geom,
            "bbox": [env[0], env[2], env[1], env[3]] if env else None,
        })
    return out


def count(path):
    try:
        conn = _connect(path, readonly=True)
        try:
            return int(conn.execute("SELECT COUNT(*) FROM f").fetchone()[0])
        finally:
            conn.close()
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return None


def _box_geom(rect):
    minx, miny, maxx, maxy = rect
    return ogr.CreateGeometryFromWkt(
        f"POLYGON(({minx!r} {miny!r},{maxx!r} {miny!r},"
        f"{maxx!r} {maxy!r},{minx!r} {maxy!r},{minx!r} {miny!r}))")


def count_bbox(path, rect):
    """rect 内真实相交的要素数（和 rows_bbox 同一口径，含逐要素精确相交）。

    只给"视野内 N 个"用；R*Tree 的候选包络会多算几条，所以这里不直接
    COUNT(*)，而是把候选的几何再判一次。视野大、候选多时由调用方决定是否用。
    """
    minx, miny, maxx, maxy = rect
    try:
        conn = _connect(path, readonly=True)
        try:
            srs = _srs_of(path, meta(path))
            rows = _rows(conn,
                         "SELECT f.fid, f.props, f.wkb FROM g JOIN f ON f.fid = g.id - 1 "
                         "WHERE g.minx <= ? AND g.maxx >= ? AND g.miny <= ? AND g.maxy >= ?",
                         (maxx, minx, maxy, miny), srs)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return None
    box = _box_geom(rect)
    n = 0
    for row in rows:
        g = row["geom"]
        if g is None:
            continue
        try:
            if g.Intersects(box):
                n += 1
        except Exception:  # noqa: BLE001, S112  （单条坏几何跳过，继续数）
            continue
    return n


def rows_bbox(path, rect, limit):
    """rect = (minx, miny, maxx, maxy)，源坐标系，和 SetSpatialFilterRect 同一口径。

    R*Tree 只会给出"包络与框相交"的候选，包络相交不等于要素相交
    （武宁那块样例里候选 412 条、真相交 410 条）。这里再逐个做一次精确相交，
    结果才和读源文件那条路一致——否则信息栏的"视野内 N 个"会和属性表行数对不上。
    """
    minx, miny, maxx, maxy = rect
    try:
        conn = _connect(path, readonly=True)
        try:
            srs = _srs_of(path, meta(path))
            rows = _rows(conn,
                         "SELECT f.fid, f.props, f.wkb FROM g JOIN f ON f.fid = g.id - 1 "
                         "WHERE g.minx <= ? AND g.maxx >= ? AND g.miny <= ? AND g.maxy >= ? "
                         "ORDER BY f.fid LIMIT ?",
                         (maxx, minx, maxy, miny, _as_int(limit) + 1), srs)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return None
    box = _box_geom(rect)
    kept = []
    for row in rows:
        g = row["geom"]
        if g is None:
            continue
        try:
            if not g.Intersects(box):
                continue
        except Exception:  # noqa: BLE001, S110  （坏几何保留，交给上层计数）
            pass  # pi-lens-ignore: python-empty-except
        kept.append(row)
        if len(kept) >= _as_int(limit):
            break
    return kept


def rows_page(path, offset, limit):
    try:
        conn = _connect(path, readonly=True)
        try:
            return _rows(conn,
                         "SELECT fid, props, wkb FROM f ORDER BY fid LIMIT ? OFFSET ?",
                         (int(limit), int(offset)), _srs_of(path, meta(path)))
        finally:
            conn.close()
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return None


def meta(path):
    try:
        conn = _connect(path, readonly=True)
        try:
            return dict(conn.execute("SELECT k, v FROM meta").fetchall())
        finally:
            conn.close()
    except Exception:  # noqa: BLE001  （回退路径，坏一份数据不影响整体）
        return {}


def describe(path):
    """索引里存的图层概况；缺项（旧版索引、文件坏了）返回 None，调用方退回读源文件。"""
    m = meta(path)
    if not m or "total" not in m or "fields" not in m:
        return None
    try:
        fields = json.loads(m.get("fields") or "[]")
        return {
            "layer_name": m.get("layer_name") or "",
            "geom_type": int(m.get("geom_type") or 0),
            "srs": m.get("srs") or "",
            "wgs84": m.get("wgs84") == "1",
            "assumed_local": m.get("assumed_local") == "1",
            "field_count": len(fields),
            "total": int(m.get("total") or 0),
        }
    except (TypeError, ValueError):
        return None


def drop(path):
    """索引读不出来就删掉，下次重新建一份。"""
    Path(path).unlink(missing_ok=True)
