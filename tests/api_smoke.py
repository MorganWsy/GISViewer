"""接口冒烟：起一个真服务，把界面会用的几条接口全打一遍，任何一条不合约定就退出 1。

引擎 sweep（tests\\sweep.py）验的是"文件读得对不对"，这里验的是"HTTP 这一层通不通"：
参数解析、缓存命中、图片响应、配置落盘。

用法：
    D:\\miniAnaconda\\envs\\gisviewer\\python.exe tests\\api_smoke.py
    ... tests\\api_smoke.py -k identify    # 只跑名字含这个片段的检查

服务跑在随机端口上，数据目录用临时目录，不碰用户设置与缓存。
"""

import argparse
import http.client
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile
from pathlib import Path
from xml.parsers import expat

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("TULAN_DATA") or ROOT / "data")
SAMPLES = DATA / "samples"
FIXTURES = ROOT / "tests" / "fixtures"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Client:
    def __init__(self, base):
        parts = urllib.parse.urlsplit(base)
        if not parts.hostname or parts.port is None:
            raise ValueError(f"不是有效的本机地址：{base}")
        self.host = parts.hostname
        self.port = parts.port

    def get(self, route, **params):
        timeout = params.pop("timeout", 180)
        url = route
        if params:
            url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        return self._open("GET", url, timeout=timeout)

    def post(self, route, payload, timeout=180):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return self._open("POST", route, body=body,
                          headers={"Content-Type": "application/json"}, timeout=timeout)

    def _open(self, method, route, body=None, headers=None, timeout=180):
        # 4xx/5xx 也算响应：空路径这类用例要检查的是错误正文写得清不清楚，
        # 而不是抛一个异常就算过。连接不通、服务没起仍然会抛 OSError。
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        try:
            conn.request(method, route, body=body, headers=headers or {})
            resp = conn.getresponse()
            raw = resp.read()
            ctype = resp.getheader("Content-Type", "") or ""
            status = resp.status
        finally:
            conn.close()
        if "json" in ctype:
            return status, json.loads(raw.decode("utf-8")), ctype
        return status, raw, ctype


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _xml_sheets(data):
    """用 expat 读 XLSX 的工作表名：既验证良构，也不碰 ElementTree 的实体展开。"""
    names = []
    parser = expat.ParserCreate()

    def start(tag, attrs):
        if tag == "sheet":
            names.append(attrs["name"])

    parser.StartElementHandler = start
    parser.Parse(data, True)
    return names


def _assert_xml(data):
    """只验证良构性；数据是本机刚生成的测试夹具。"""
    expat.ParserCreate().Parse(data, True)


def wait_ready(base, deadline=60.0):
    client = Client(base)
    started = time.perf_counter()
    while time.perf_counter() - started < deadline:
        try:
            status, _, _ = client.get("/api/formats", timeout=2)
            if status == 200:
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"服务 {deadline:.0f} 秒内没有起来")


def main(argv=None):
    parser = argparse.ArgumentParser(description="接口冒烟")
    parser.add_argument("-k", dest="filter", default="", help="只跑名字含这个片段的检查")
    args = parser.parse_args(argv)

    tif = SAMPLES / "pre_2000_01.tif"
    geojson = SAMPLES / "wuningGEP.json"
    gpkg = FIXTURES / "two_layer.gpkg"
    china = FIXTURES / "china_small.geojson"
    for path in (tif, geojson, gpkg, china):
        if not path.exists():
            print(f"缺文件：{path}（样例见 TULAN_DATA，固件见 tests\\make_fixtures.py）", file=sys.stderr)
            return 2

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = tempfile.mkdtemp(prefix="tulan-api-")
    env = dict(os.environ, GISVIEWER_DATA_DIR=tmp, PYTHONIOENCODING="utf-8")
    log = open(os.path.join(tmp, "server.log"), "w", encoding="utf-8")  # noqa: SIM115 —— finally 里统一 close
    proc = subprocess.Popen([sys.executable, "-m", "gisviewer.server",
                             "--port", str(port), "--no-open"],
                            cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)

    checks = []
    results = []

    def check(name):
        def wrap(fn):
            checks.append((name, fn))
            return fn
        return wrap

    c = None

    @check("formats 列出支持的扩展名")
    def _(cli):
        status, data, _ = cli.get("/api/formats")
        need(status == 200 and data.get("ok"), "200/ok 不对")
        need(len(data.get("raster") or []) > 5 and len(data.get("vector") or []) > 5, "扩展名太少")
        menu = data.get("menu") or []
        need(len(menu) > 5 and all(m.startswith(".") for m in menu), "右键菜单的后缀清单不对")

    @check("config 读取并带色带端点色")
    def _(cli):
        status, data, _ = cli.get("/api/config")
        need(status == 200 and data.get("ok"), "200/ok 不对")
        need(data.get("ramps"), "没有色带")
        need(all(len(r["colors"]) >= 2 for r in data["ramps"]), "色带端点色不全")
        need(data.get("version"), "没有版本号")

    @check("config 写入后能读回")
    def _(cli):
        status, data, _ = cli.post("/api/config", {"theme": "dark"})
        need(status == 200 and data.get("ok"), "写入失败")
        need(data["config"]["theme"] == "dark", "写进去的值没生效")
        _, back, _ = cli.get("/api/config")
        need(back["config"]["theme"] == "dark", "读回来的不是刚写的值")
        cli.post("/api/config", {"theme": "auto"})

    @check("stamp 报文件大小与修改时间")
    def _(cli):
        status, data, _ = cli.get("/api/stamp", path=str(tif))
        need(status == 200 and data.get("ok"), "200/ok 不对")
        s = data.get("stamp") or {}
        need(s.get("exists") is True, "存在的文件被判成不存在")
        need(s.get("size") == tif.stat().st_size, "大小对不上")
        need(isinstance(s.get("mtime_ns"), int), "没有纳秒级修改时间")
        _, gone, _ = cli.get("/api/stamp", path=str(tif) + ".nope")
        need((gone.get("stamp") or {}).get("exists") is False, "不存在的文件应报 exists=false")

    @check("inspect 栅格")
    def _(cli):
        status, data, _ = cli.get("/api/inspect", path=str(tif))
        need(status == 200 and data.get("ok"), "读取失败：{}".format(data.get("error")))
        need(data["kind"] == "raster" and data["width"] > 9000, "不是预期的 9665×10509")
        need(round(data["elapsed_ms"]) >= 0, "没有耗时")

    @check("inspect 大 GeoJSON（10.9 万要素）")
    def _(cli):
        status, data, _ = cli.get("/api/inspect", path=str(geojson))
        need(status == 200 and data.get("ok"), "读取失败：{}".format(data.get("error")))
        need(data["feature_count_total"] == 109007, "要素数不对：{}".format(data.get("feature_count_total")))

    @check("vector 按视野取要素，重复视野走内存")
    def _(cli):
        status, data, _ = cli.get("/api/vector", path=str(geojson), layer=0, limit=100, tolerance=0)
        need(status == 200 and data.get("ok"), "取数失败：{}".format(data.get("error")))
        need(data.get("features"), "一个要素都没返回")
        need(len(data["features"]) <= 100, "超过 limit")
        status, again, _ = cli.get("/api/vector", path=str(geojson), layer=0, limit=100, tolerance=0)
        need(status == 200 and again.get("ok"), "第二次取数失败")
        need((again.get("gisviewer") or {}).get("cached") is True, "同一视野第二次没有命中内存缓存")
        vec_dir = Path(tmp) / "cache" / "vec"
        need(not vec_dir.exists() or not list(vec_dir.rglob("*.json")), "vector 结果不该落盘")

    @check("histogram 直方图")
    def _(cli):
        status, data, _ = cli.get("/api/histogram", path=str(tif), band=1)
        need(status == 200 and data.get("ok"), "失败：{}".format(data.get("error")))
        hist = data.get("histogram") or {}
        need(len(hist.get("counts") or []) > 1, "分箱为空")
        need(hist.get("bins") == len(hist["counts"]), "分箱数和方法给的对不上")
        need(hist.get("max", 0) > hist.get("min", 0), "值域不合理")

    @check("thumbnail 返回 PNG")
    def _(cli):
        status, body, ctype = cli.get("/api/thumbnail", path=str(tif), bands=1)
        need(status == 200 and ctype.startswith("image/png"), f"不是 PNG：{ctype}")
        need(body[:8] == b"\x89PNG\r\n\x1a\n", "PNG 头不对")

    @check("identify 点选（栅格）")
    def _(cli):
        # 用经纬度范围的中心（投影坐标范围是米，不能直接当经纬度用）
        _, info, _ = cli.get("/api/inspect", path=str(tif))
        ext = info.get("extent_wgs84") or info.get("extent")
        need(ext, "没有范围信息")
        if isinstance(ext, dict):
            lng = (ext["left"] + ext["right"]) / 2
            lat = (ext["bottom"] + ext["top"]) / 2
        else:
            lng, lat = (ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2
        status, data, _ = cli.get("/api/identify", path=str(tif), kind="raster", lng=lng, lat=lat)
        need(status == 200 and data.get("ok"), "识别失败：{}".format(data.get("error")))
        got = data.get("identify") or {}
        need(got.get("inside") is True, "中心点不在影像内")
        need(got.get("row") is not None and got.get("col") is not None, "没有行列号")

    @check("measure 按原始几何量算")
    def _(cli):
        # 要素编号不一定是 0（GPKG 从 1 起），先从地图取数拿真实的 id
        _, page, _ = cli.get("/api/vector", path=str(gpkg), layer=0, limit=1, tolerance=0)
        fid = page["features"][0]["id"]
        status, data, _ = cli.get("/api/measure", path=str(gpkg), layer=0, fid=fid)
        need(status == 200 and data.get("ok"), "量算失败：{}".format(data.get("error")))
        need(data.get("area_m2") is not None or data.get("length_m") is not None, "没有面积也没有长度")

    @check("geomtypes 几何类型计数")
    def _(cli):
        status, data, _ = cli.get("/api/geomtypes", path=str(gpkg), layer=0)
        need(status == 200 and data.get("ok"), "统计失败：{}".format(data.get("error")))
        need(data.get("types"), "没有类型分布")

    @check("cache 报告占用与真实路径")
    def _(cli):
        status, data, _ = cli.get("/api/cache")
        need(status == 200 and data.get("ok"), "查询失败")
        need(data.get("data_dir"), "没有 data_dir")
        need(Path(data["data_dir"]) == Path(tmp), "数据目录没有隔离：{}".format(data["data_dir"]))
        need(Path(data.get("cache_dir") or "") == Path(tmp) / "cache",
             f"默认缓存目录不对：{data.get('cache_dir')}")

    @check("自定义缓存位置只清缓存，不动用户文件")
    def _(cli):
        chosen = Path(tmp) / "资料"
        chosen.mkdir()
        keep = chosen / "keep.txt"
        keep.write_text("keep", encoding="utf-8")
        status, data, _ = cli.post("/api/config", {"cache_root": str(chosen)})
        need(status == 200 and data.get("ok"), "写缓存位置失败")
        need(Path(data.get("cache_effective") or "") == chosen / "TulanCache",
             f"自定义缓存没有落到 TulanCache 子目录：{data.get('cache_effective')}")
        need(data.get("cache_fallback") is False, "正常目录不该报回退")
        status, data, _ = cli.post("/api/cache", {})
        need(status == 200 and data.get("ok"), "清空失败")
        need(Path(data.get("cache_dir") or "") == chosen / "TulanCache",
             f"清空后回报的目录不对：{data.get('cache_dir')}")
        need(keep.is_file(), "清空缓存把用户文件删了")
        # 恢复默认，后面的用例继续用 tmp/cache
        status, data, _ = cli.post("/api/config", {"cache_root": ""})
        need(status == 200 and data.get("ok"), "恢复默认缓存位置失败")
        need(keep.is_file(), "切回默认时把用户文件删了")

    @check("POST /api/path 与 GET inspect 等价")
    def _(cli):
        status, data, _ = cli.post("/api/path", {"path": str(tif)})
        need(status == 200 and data.get("ok"), "失败：{}".format(data.get("error")))
        need(data["kind"] == "raster", "种类不对")

    @check("不存在的路径给可读错误")
    def _(cli):
        status, data, _ = cli.get("/api/inspect", path=str(SAMPLES / "没有这个文件.shp"))
        need(status == 200 and data.get("ok") is False, "居然成功了")
        need((data.get("error") or {}).get("title"), "没有错误标题")

    @check("check 批量体检与两次对比")
    def _(cli):
        status, data, _ = cli.post("/api/check", {"paths": [str(gpkg)]})
        need(status == 200 and data.get("ok"), "体检失败：{}".format(data.get("error")))
        files = data.get("files") or []
        need(len(files) == 1, f"文件数不对：{len(files)}")
        need(files[0].get("level") in ("bad", "warn", "ok"), "级别不对：{}".format(files[0].get("level")))
        need(files[0].get("items"), "没有结论条目")
        # 只查一个文件时要带完整体检表，界面靠它铺"可读性/坐标系/要素数…"逐行
        need(files[0].get("rows"), "单文件没有体检表")
        need(all(r.get("label") for r in files[0]["rows"]), "体检表缺项目名")
        need(files[0].get("facts"), "单文件没有基本情况")
        need(data.get("report_path"), "报告没落盘，下次没法对比")
        # 再跑一次：上一次的报告当对照，这份数据没动就该比出"没变化"
        _, again, _ = cli.post("/api/check", {"paths": [str(gpkg)]})
        need(again.get("prev_at"), "第二次体检没有对照时间")
        need((again["files"][0].get("changes") or []) == [], "数据没动却比出了差异")

    @check("check 空路径给可读错误")
    def _(cli):
        status, data, _ = cli.post("/api/check", {"paths": []})
        need(status == 400 and data.get("ok") is False, "空路径不该成功")
        need((data.get("error") or {}).get("title"), "没有错误标题")

    @check("diagnose 导出诊断包")
    def _(cli):
        status, data, _ = cli.post("/api/diagnose", {"paths": [str(tif)]})
        need(status == 200 and data.get("ok"), "诊断包失败：{}".format(data.get("error")))
        zp = Path(data.get("path") or "")
        need(zp.is_file(), f"zip 没写出来：{zp}")
        need(zp.stat().st_size > 100, "zip 太小，多半是空的")
        need(data.get("size_label"), "没有大小标签")
        # 包里同时给 json 与 xlsx：两份都得在，xlsx 还得是能被读的表格
        names = set(zipfile.ZipFile(zp).namelist())
        need("体检结果.json" in names, f"包里没有 json：{sorted(names)}")
        need("体检结果.xlsx" in names, f"包里没有 xlsx：{sorted(names)}")
        need("说明.md" in names, f"包里没有说明：{sorted(names)}")
        book = zipfile.ZipFile(io.BytesIO(zipfile.ZipFile(zp).read("体检结果.xlsx")))
        root = book.read("xl/workbook.xml")
        sheets = _xml_sheets(root)
        need(sheets == ["概览", "文件清单", "体检明细"], f"工作表不对：{sheets}")
        sheet = book.read("xl/worksheets/sheet3.xml")
        _assert_xml(sheet)   # 每个部件都必须是良构 XML，否则 Excel 打不开
        shared = book.read("xl/sharedStrings.xml").decode("utf-8")
        need("检查项目" in shared, "明细表没有表头文字")
        need("可读性" in shared, "明细表没有检查项目")

    @check("convert_formats 列出互转目标")
    def _(cli):
        status, data, _ = cli.get("/api/convert_formats")
        need(status == 200 and data.get("ok"), "200/ok 不对")
        fmts = data.get("formats") or []
        need(len(fmts) >= 13, f"目标格式太少：{len(fmts)}")
        keys = {f.get("key") for f in fmts}
        need({"shp", "geojson", "gpkg", "topojson", "geoparquet"} <= keys,
             f"常用格式不齐：{sorted(keys)}")
        # 说明是给用户看的代价提示；CSV 已按要求去掉那段说明，其余都得有
        need(all(f.get("note") for f in fmts if f.get("key") != "csv"), "有格式没写代价说明")
        need(not next(f for f in fmts if f.get("key") == "csv").get("note"), "CSV 说明应当为空")
        labels = [f.get("label") for f in fmts]
        need(labels == sorted(labels, key=str.lower), f"格式没按字母顺序：{labels}")

    def _lonlat_geojson(name, count=3):
        """在临时目录写一份合法的 WGS 84 经纬度 GeoJSON。"""
        feats = []
        for i in range(count):
            feats.append({
                "type": "Feature", "properties": {"name": f"P{i}", "v": i},
                "geometry": {"type": "Polygon", "coordinates": [[
                    [110.0 + i * 0.1, 30.0], [110.05 + i * 0.1, 30.0],
                    [110.05 + i * 0.1, 30.05], [110.0 + i * 0.1, 30.0]]]},
            })
        p = Path(tmp, name)
        p.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                ensure_ascii=False), encoding="utf-8")
        return p

    @check("convert 预检不落文件、转换有前后对比")
    def _(cli):
        out = Path(tmp, "conv-out")
        src = _lonlat_geojson("conv-src.geojson")
        body = {"path": str(src), "layer": 0, "fmt": "geojson",
                "out_dir": str(out), "dry": True}
        status, data, _ = cli.post("/api/convert", body)
        need(status == 200 and data.get("ok"), "预检失败：{}".format(data.get("error")))
        need(not out.exists(), "预检不该建输出目录")
        need(data.get("before", {}).get("feature_count") == 3, "转换前要素数不对")
        body["dry"] = False
        status, data, _ = cli.post("/api/convert", body)
        need(status == 200 and data.get("ok"), "转换失败：{}".format(data.get("error")))
        cmp = {r["name"]: r for r in data.get("compare") or []}
        need(cmp.get("要素数", {}).get("same") is True, "要素数没对上：{}".format(cmp.get("要素数")))
        need(Path(data.get("out_path") or "").is_file(), "输出文件没写出来")
        # 同名不覆盖：再转一次必须明确拒绝
        status, data, _ = cli.post("/api/convert", body)
        need(status == 200 and not data.get("ok"), "同名文件被覆盖了")
        need("同名" in (data.get("error") or {}).get("title", ""), "没说清是同名冲突：{}".format(data.get("error")))

    @check("convert 支持 TopoJSON 输出")
    def _(cli):
        src = Path(tmp, "topo-src.geojson")
        src.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": "甲"},
             "geometry": {"type": "Polygon", "coordinates": [
                 [[116.0, 39.0], [116.1, 39.0], [116.1, 39.1], [116.0, 39.1], [116.0, 39.0]]]}},
            {"type": "Feature", "properties": {"name": "乙"},
             "geometry": {"type": "Point", "coordinates": [116.05, 39.05]}},
        ]}, ensure_ascii=False), encoding="utf-8")
        out = Path(tmp, "topo-out")
        status, data, _ = cli.post("/api/convert",
                                   {"path": str(src), "layer": 0, "fmt": "topojson", "out_dir": str(out)})
        need(status == 200 and data.get("ok"), "TopoJSON 转换失败：{}".format(data.get("error")))
        cmp = {r["name"]: r for r in data.get("compare") or []}
        need(cmp["要素数"]["same"], "要素数没对上：{}".format(cmp["要素数"]))
        need(cmp["字段数"]["same"], "字段数没对上：{}".format(cmp["字段数"]))
        need(cmp["坐标系"]["same"], "坐标系没对上：{}".format(cmp["坐标系"]))
        out_path = Path(data.get("out_path") or "")
        need(out_path.is_file(), "TopoJSON 文件没写出来")
        doc = json.loads(out_path.read_text(encoding="utf-8"))
        need(doc.get("type") == "Topology" and doc.get("arcs"), "不是 TopoJSON 结构")

    @check("convert 源坐标与坐标系不符时，只收经纬度的格式明确拒绝")
    def _(cli):
        # china_small.geojson 是米制数值却没有坐标系记录（GeoJSON 按规范默认 WGS 84）。
        # 这种文件转成只收经纬度的格式会把"米"当成"度"写进去，必须拒绝而不是照抄
        out = Path(tmp, "bad-crs-out")
        for fmt in ("geojson", "kml", "geoparquet"):
            status, data, _ = cli.post("/api/convert",
                                       {"path": str(china), "layer": 0, "fmt": fmt,
                                        "out_dir": str(out), "dry": True})
            need(status == 200 and not data.get("ok"),
                 f"{fmt} 居然接受了坐标与坐标系不符的数据")
            need("无法" in (data.get("error") or {}).get("title", ""),
                 "{} 的拒绝理由不对：{}".format(fmt, data.get("error")))

    @check("convert 支持 GeoParquet 输出，且能当矢量再打开")
    def _(cli):
        out = Path(tmp, "parquet-out")
        status, data, _ = cli.post("/api/convert",
                                   {"path": str(_lonlat_geojson("pq-src.geojson")), "layer": 0, "fmt": "geoparquet",
                                    "out_dir": str(out)})
        need(status == 200 and data.get("ok"), "GeoParquet 转换失败：{}".format(data.get("error")))
        cmp = {r["name"]: r for r in data.get("compare") or []}
        need(cmp["要素数"]["same"], "要素数没对上：{}".format(cmp["要素数"]))
        need(cmp["字段数"]["same"], "字段数没对上：{}".format(cmp["字段数"]))
        need(cmp["坐标系"]["same"], "坐标系没对上：{}".format(cmp["坐标系"]))
        out_path = Path(data.get("out_path") or "")
        need(out_path.is_file() and out_path.suffix == ".parquet", "parquet 文件没写出来")
        need(out_path.read_bytes()[:4] == b"PAR1", "不是 Parquet 文件头")
        # 写出来的东西必须能被软件当矢量打开：驱动按 GeoParquet 报，属性编码 UTF-8
        status, info, _ = cli.get("/api/inspect", path=str(out_path))
        need(status == 200 and info.get("ok"), "GeoParquet 打不开：{}".format(info.get("error")))
        need(info.get("driver") == "Parquet", "驱动报错了：{}".format(info.get("driver")))
        need(info.get("driver_label") == "GeoParquet", "格式名报错了：{}".format(info.get("driver_label")))
        need(info.get("feature_count_total") == 3, "读回要素数不对：{}".format(info.get("feature_count_total")))
        need(info["layers"][0].get("attr_encoding") == "UTF-8", "属性编码没给出来")

    @check("convert 投影坐标转 KML 会重投影到 WGS 84")
    def _(cli):
        src = Path(tmp, "gk-src.geojson")
        src.write_text(json.dumps({
            "type": "FeatureCollection",
            "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::4547"}},
            "features": [
                {"type": "Feature", "properties": {"name": "甲"},
                 "geometry": {"type": "Point", "coordinates": [500000.0, 3320113.398]}},
                {"type": "Feature", "properties": {"name": "乙"},
                 "geometry": {"type": "Point", "coordinates": [547999.761, 3375648.033]}},
            ]}, ensure_ascii=False), encoding="utf-8")
        out = Path(tmp, "kml-out")
        status, data, _ = cli.post("/api/convert",
                                   {"path": str(src), "layer": 0, "fmt": "kml", "out_dir": str(out)})
        need(status == 200 and data.get("ok"), "投影坐标转 KML 失败：{}".format(data.get("error")))
        # 提示里不再重复"将重投影"（格式说明已有），这里直接核对输出坐标本身
        need(not [w for w in (data.get("warnings") or []) if "重投影" in w],
             "不该再重复重投影提示：{}".format(data.get("warnings")))
        text = Path(data.get("out_path") or "").read_text(encoding="utf-8", errors="replace")
        import re
        pairs = re.findall(r"<coordinates>\s*([-\d.eE+]+),([-\d.eE+]+)", text)
        need(pairs, "KML 里没找到坐标")
        for lon, lat in pairs:
            need(-180 <= float(lon) <= 180 and -90 <= float(lat) <= 90,
                 f"KML 里还是投影坐标：{lon},{lat}")

    @check("convert 没有坐标系记录的投影数据要明确拒绝")
    def _(cli):
        src = Path(tmp, "nocrs-src.geojson")
        src.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": "甲"},
             "geometry": {"type": "Point", "coordinates": [500000.0, 3320113.398]}}]},
            ensure_ascii=False), encoding="utf-8")
        status, data, _ = cli.post("/api/convert",
                                   {"path": str(src), "layer": 0, "fmt": "kml",
                                    "out_dir": str(Path(tmp, "kml-out2"))})
        need(status == 200 and not data.get("ok"), "没有坐标系也照写了")
        need("坐标系" in (data.get("error") or {}).get("hint", ""), "没说清缺的是坐标系")

    @check("convert 目标格式支持投影坐标系时保持原坐标系")
    def _(cli):
        src = Path(tmp, "keep-src.geojson")
        src.write_text(json.dumps({
            "type": "FeatureCollection",
            "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::4547"}},
            "features": [
                {"type": "Feature", "properties": {"name": "甲"},
                 "geometry": {"type": "Point", "coordinates": [500000.0, 3320113.398]}},
                {"type": "Feature", "properties": {"name": "乙"},
                 "geometry": {"type": "Point", "coordinates": [547999.761, 3375648.033]}},
            ]}, ensure_ascii=False), encoding="utf-8")
        # 只有按规范只收经纬度的三种格式才换算，其余一律照搬源坐标系
        for fmt in ("gpkg", "shp", "geoparquet"):
            out = Path(tmp, "keep-" + fmt)
            status, data, _ = cli.post("/api/convert",
                                       {"path": str(src), "layer": 0, "fmt": fmt, "out_dir": str(out)})
            need(status == 200 and data.get("ok"), "{} 转换失败：{}".format(fmt, data.get("error")))
            need(all(r["same"] for r in data.get("compare") or [] if r["name"] == "坐标系"),
                 "{} 把源坐标系改掉了：{}".format(fmt, data.get("compare")))
            status, info, _ = cli.get("/api/inspect", path=str(data.get("out_path")))
            # 单图层的矢量，坐标系在顶层；多图层的在第一个图层里
            crs = info.get("crs") or ((info.get("layers") or [{}])[0].get("crs") or {})
            need("4547" in str(crs.get("code") or crs.get("label") or ""),
                 f"{fmt} 输出不是 EPSG:4547：{crs}")

    @check("convert 混合几何按类型分开写出，不丢要素")
    def _(cli):
        src = Path(tmp, "mixed-src.geojson")
        src.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"n": 1},
             "geometry": {"type": "Point", "coordinates": [116.0, 39.0]}},
            {"type": "Feature", "properties": {"n": 2},
             "geometry": {"type": "LineString", "coordinates": [[116.0, 39.0], [116.2, 39.2]]}},
            {"type": "Feature", "properties": {"n": 3},
             "geometry": {"type": "Polygon", "coordinates": [
                 [[116.3, 39.3], [116.4, 39.3], [116.4, 39.4], [116.3, 39.3]]]}},
        ]}, ensure_ascii=False), encoding="utf-8")
        out = Path(tmp, "mixed-out")
        status, data, _ = cli.post("/api/convert",
                                   {"path": str(src), "layer": 0, "fmt": "shp", "out_dir": str(out)})
        need(status == 200 and data.get("ok"), "混合几何转换失败：{}".format(data.get("error")))
        paths = data.get("out_paths") or []
        need(len(paths) == 3, f"没按几何类型拆开：{paths}")
        need(all(Path(p).is_file() for p in paths), f"有分片没写出来：{paths}")
        cmp = {r["name"]: r for r in data.get("compare") or []}
        need(cmp["要素数"]["same"], "要素数没对上：{}".format(cmp["要素数"]))
        need(cmp["几何类型"]["same"], "分开写出被当成了差异：{}".format(cmp["几何类型"]))

    @check("convert 文件名后缀：留空按 _转出，填了接在源文件名后面")
    def _(cli):
        src = Path(tmp, "suffix-src.geojson")
        src.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": "甲"},
             "geometry": {"type": "Point", "coordinates": [116.0, 39.0]}},
            {"type": "Feature", "properties": {"name": "乙"},
             "geometry": {"type": "Point", "coordinates": [116.1, 39.1]}},
        ]}, ensure_ascii=False), encoding="utf-8")
        out = Path(tmp, "suffix-out")
        base = {"path": str(src), "layer": 0, "fmt": "geojson", "out_dir": str(out)}
        status, data, _ = cli.post("/api/convert", dict(base))
        need(status == 200 and data.get("ok"), "转换失败：{}".format(data.get("error")))
        need(Path(data["out_path"]).name == "suffix-src_转出.geojson",
             "留空没按 _转出：{}".format(data["out_path"]))
        status, data, _ = cli.post("/api/convert", dict(base, suffix="_2024"))
        need(status == 200 and data.get("ok"), "带后缀转换失败：{}".format(data.get("error")))
        need(Path(data["out_path"]).name == "suffix-src_2024.geojson",
             "后缀没接上去：{}".format(data["out_path"]))
        # 预检要把最终文件名带回来，界面靠它显示"这次会写成 …"
        status, data, _ = cli.post("/api/convert", dict(base, suffix="_甲", dry=True))
        need(status == 200 and data.get("ok"), "预检失败：{}".format(data.get("error")))
        need(Path(data.get("out_path") or "").name == "suffix-src_甲.geojson",
             "预检没给出最终文件名：{}".format(data.get("out_path")))
        # 文件名里不能用的字符一律拒收：界面按这条规则先把错误说清楚，
        # 引擎也不悄悄改名——用户看到的落点就是真写出来的那个
        status, data, _ = cli.post("/api/convert", dict(base, suffix=" a/b:c ", dry=True))
        need(not data.get("ok"), "非法后缀居然被接受了")
        need((data.get("error") or {}).get("title") == "文件后缀不合法",
             "没说清是后缀不合法：{}".format(data.get("error")))
        # 合法的写法照常接上去（换一个没用过的后缀，避免撞上前面写出的文件）
        status, data, _ = cli.post("/api/convert", dict(base, suffix="  _2025  ", dry=True))
        need(Path(data.get("out_path") or "").name == "suffix-src_2025.geojson",
             "首尾空白没清掉：{}".format(data.get("error")))

    @check("convert 源文件是 .zip 时按包内成员转换")
    def _(cli):
        import zipfile
        inner = Path(tmp, "包内数据.geojson")
        inner.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": "甲"},
             "geometry": {"type": "Point", "coordinates": [116.0, 39.0]}},
            {"type": "Feature", "properties": {"name": "乙"},
             "geometry": {"type": "Point", "coordinates": [116.1, 39.1]}},
        ]}, ensure_ascii=False), encoding="utf-8")
        zpath = Path(tmp, "打包.zip")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(inner, "包内数据.geojson")
        # 图层清单要能列出包内成员，用户按成员选
        status, info, _ = cli.get("/api/inspect", path=str(zpath))
        need(status == 200 and info.get("kind") == "archive", "压缩包没按压缩包打开")
        need((info.get("layers") or [{}])[0].get("member"), "图层清单里没有包内成员")
        out = Path(tmp, "zip-out")
        status, data, _ = cli.post("/api/convert",
                                   {"path": str(zpath), "layer": 0, "fmt": "shp", "out_dir": str(out)})
        need(status == 200 and data.get("ok"), "压缩包转换失败：{}".format(data.get("error")))
        need(Path(data.get("out_path") or "").is_file(), "输出文件没写出来")
        need("/vsizip" not in (data.get("out_path") or ""), "输出落进了包内的虚拟路径")
        need(data["after"]["feature_count"] == 2, "要素数不对：{}".format(data["after"]))

    @check("convert 同名文件默认拒绝，勾了覆盖才重写")
    def _(cli):
        src = Path(tmp, "over-src.geojson")
        src.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": "甲"},
             "geometry": {"type": "Point", "coordinates": [116.0, 39.0]}}]},
            ensure_ascii=False), encoding="utf-8")
        out = Path(tmp, "over-out")
        body = {"path": str(src), "layer": 0, "fmt": "shp", "out_dir": str(out)}
        status, data, _ = cli.post("/api/convert", dict(body))
        need(status == 200 and data.get("ok"), "第一次转换失败：{}".format(data.get("error")))
        target = Path(data["out_path"])
        keep = target.read_bytes()
        status, data, _ = cli.post("/api/convert", dict(body))
        need(not data.get("ok"), "同名文件没被拦住")
        need("同名" in (data.get("error") or {}).get("title", ""), "没说清是同名：{}".format(data.get("error")))
        need(target.read_bytes() == keep, "拒绝之后文件反而被改了")
        # 勾了覆盖就是用户自己的决定，不该再弹一句"会覆盖"
        status, data, _ = cli.post("/api/convert", dict(body, dry=True, overwrite=True))
        need(data.get("ok"), "勾了覆盖预检还失败：{}".format(data.get("error")))
        need(not [w for w in (data.get("warnings") or []) if "覆盖" in w],
             "勾了覆盖还在提示覆盖：{}".format(data.get("warnings")))
        status, data, _ = cli.post("/api/convert", dict(body, overwrite=True))
        need(status == 200 and data.get("ok"), "勾了覆盖仍然失败：{}".format(data.get("error")))
        need(target.is_file(), "覆盖之后文件不见了")

    @check("convert 栅格文件要明说不能互转")
    def _(cli):
        status, data, _ = cli.post("/api/convert", {
            "path": str(tif), "layer": 0, "fmt": "shp",
            "out_dir": str(Path(tmp, "ras-out")), "dry": True})
        # 以前这里抛异常回 500，界面只能显示"预检未完成"，看不出是栅格
        need(status == 200, f"接口回了 {status}，异常没被吃掉")
        need(not data.get("ok"), "栅格竟然通过了预检")
        err = data.get("error") or {}
        need("栅格" in err.get("title", ""), f"没说清是栅格：{err}")

    try:
        wait_ready(base)
        c = Client(base)
        print(f"服务已就绪：{base}，数据目录 {tmp}\n")
        for name, fn in checks:
            if args.filter.lower() and args.filter.lower() not in name.lower():
                continue
            started = time.perf_counter()
            try:
                fn(c)
                ok, note = True, ""
            except AssertionError as exc:
                ok, note = False, str(exc)
            except Exception as exc:  # noqa: BLE001 —— 连接断了、JSON 坏了，都算失败
                ok, note = False, f"{type(exc).__name__}: {exc}"
            took = (time.perf_counter() - started) * 1000
            print(f"{'PASS' if ok else 'FAIL'}  {name:<34} {took:>7.0f} ms  {note}")
            results.append((name, ok, note))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        if any(not ok for _, ok, _ in results):
            text = Path(tmp, "server.log").read_text(encoding="utf-8", errors="replace")
            print("\n服务日志末尾：\n" + "\n".join(text.splitlines()[-15:]))
        shutil.rmtree(tmp, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print()
    print(f"\n{len(results)} 项检查：{len(results) - len(failed)} 通过，{len(failed)} 失败")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
