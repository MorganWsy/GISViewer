"""接口冒烟：起一个真服务，把界面会用的几条接口全打一遍，任何一条不合约定就退出 1。

引擎 sweep（tests\\sweep.py）验的是"文件读得对不对"，这里验的是"HTTP 这一层通不通"：
参数解析、缓存命中、图片响应、配置落盘。

用法：
    D:\\miniAnaconda\\envs\\gisviewer\\python.exe tests\\api_smoke.py
    ... tests\\api_smoke.py -k identify    # 只跑名字含这个片段的检查

服务跑在随机端口上，数据目录用临时目录，不碰用户设置与缓存。
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("TULAN_DATA") or ROOT.parent / "GISViewer-data")
SAMPLES = DATA / "samples"
FIXTURES = ROOT / "tests" / "fixtures"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Client:
    def __init__(self, base):
        self.base = base

    def get(self, route, **params):
        url = self.base + route
        if params:
            url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        return self._open(url)

    def post(self, route, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + route, data=body,
                                     headers={"Content-Type": "application/json"})
        return self._open(req)

    @staticmethod
    def _open(target):
        with urllib.request.urlopen(target, timeout=180) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype:
                return resp.status, json.loads(raw.decode("utf-8")), ctype
            return resp.status, raw, ctype


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def first_point(geom):
    """从 GeoJSON 几何里取第一个顶点。"""
    kind, coord = geom["type"], geom["coordinates"]
    if kind == "Point":
        return coord[0], coord[1]
    if kind in ("MultiPoint", "LineString"):
        return coord[0][0], coord[0][1]
    if kind in ("Polygon", "MultiLineString"):
        return coord[0][0][0], coord[0][0][1]
    if kind == "MultiPolygon":
        return coord[0][0][0][0], coord[0][0][0][1]
    raise AssertionError("没见过的几何类型：%s" % kind)


def wait_ready(base, deadline=60.0):
    started = time.perf_counter()
    while time.perf_counter() - started < deadline:
        try:
            with urllib.request.urlopen(base + "/api/formats", timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("服务 %.0f 秒内没有起来" % deadline)


def main(argv=None):
    parser = argparse.ArgumentParser(description="接口冒烟")
    parser.add_argument("-k", dest="filter", default="", help="只跑名字含这个片段的检查")
    args = parser.parse_args(argv)

    tif = SAMPLES / "pre_2000_01.tif"
    geojson = SAMPLES / "wuningGEP.json"
    gpkg = FIXTURES / "two_layer.gpkg"
    for path in (tif, geojson, gpkg):
        if not path.exists():
            print("缺文件：%s（样例见 TULAN_DATA，固件见 tests\\make_fixtures.py）" % path, file=sys.stderr)
            return 2

    port = free_port()
    base = "http://127.0.0.1:%d" % port
    tmp = tempfile.mkdtemp(prefix="tulan-api-")
    env = dict(os.environ, GISVIEWER_DATA_DIR=tmp, PYTHONIOENCODING="utf-8")
    log = open(os.path.join(tmp, "server.log"), "w", encoding="utf-8")
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

    @check("inspect 栅格")
    def _(cli):
        status, data, _ = cli.get("/api/inspect", path=str(tif))
        need(status == 200 and data.get("ok"), "读取失败：%s" % data.get("error"))
        need(data["kind"] == "raster" and data["width"] > 9000, "不是预期的 9665×10509")
        need(round(data["elapsed_ms"]) >= 0, "没有耗时")

    @check("inspect 大 GeoJSON（10.9 万要素）")
    def _(cli):
        status, data, _ = cli.get("/api/inspect", path=str(geojson))
        need(status == 200 and data.get("ok"), "读取失败：%s" % data.get("error"))
        need(data["feature_count_total"] == 109007, "要素数不对：%s" % data.get("feature_count_total"))

    @check("vector 按视野取要素")
    def _(cli):
        status, data, _ = cli.get("/api/vector", path=str(geojson), layer=0, limit=100, tolerance=0)
        need(status == 200 and data.get("ok"), "取数失败：%s" % data.get("error"))
        need(data.get("features"), "一个要素都没返回")
        need(len(data["features"]) <= 100, "超过 limit")

    @check("histogram 直方图")
    def _(cli):
        status, data, _ = cli.get("/api/histogram", path=str(tif), band=1)
        need(status == 200 and data.get("ok"), "失败：%s" % data.get("error"))
        hist = data.get("histogram") or {}
        need(len(hist.get("counts") or []) > 1, "分箱为空")
        need(hist.get("bins") == len(hist["counts"]), "分箱数和方法给的对不上")
        need(hist.get("max", 0) > hist.get("min", 0), "值域不合理")

    @check("thumbnail 返回 PNG")
    def _(cli):
        status, body, ctype = cli.get("/api/thumbnail", path=str(tif), bands=1)
        need(status == 200 and ctype.startswith("image/png"), "不是 PNG：%s" % ctype)
        need(body[:8] == b"\x89PNG\r\n\x1a\n", "PNG 头不对")

    @check("identify 点选（矢量）")
    def _(cli):
        # 点一个真实要素的顶点。界面上矢量走的是 MapLibre 的 queryRenderedFeatures，
        # 这个接口主要给栅格和脚本用；给一点容差，避免投影往返的舍入把点甩到界外
        _, page, _ = cli.get("/api/vector", path=str(gpkg), layer=0, limit=1, tolerance=0)
        lng, lat = first_point(page["features"][0]["geometry"])
        status, data, _ = cli.get("/api/identify", path=str(gpkg), layer=0,
                                  lng=lng, lat=lat, tol=0.002)
        need(status == 200 and data.get("ok"), "识别失败：%s" % data.get("error"))
        got = data.get("identify") or {}   # 前端读的也是这一层
        need(got.get("features"), "点在要素顶点上却没识别出来")

    @check("measure 按原始几何量算")
    def _(cli):
        # 要素编号不一定是 0（GPKG 从 1 起），先从地图取数拿真实的 id
        _, page, _ = cli.get("/api/vector", path=str(gpkg), layer=0, limit=1, tolerance=0)
        fid = page["features"][0]["id"]
        status, data, _ = cli.get("/api/measure", path=str(gpkg), layer=0, fid=fid)
        need(status == 200 and data.get("ok"), "量算失败：%s" % data.get("error"))
        need(data.get("area_m2") is not None or data.get("length_m") is not None, "没有面积也没有长度")

    @check("geomtypes 几何类型计数")
    def _(cli):
        status, data, _ = cli.get("/api/geomtypes", path=str(gpkg), layer=0)
        need(status == 200 and data.get("ok"), "统计失败：%s" % data.get("error"))
        need(data.get("types"), "没有类型分布")

    @check("cache 报告占用与真实路径")
    def _(cli):
        status, data, _ = cli.get("/api/cache")
        need(status == 200 and data.get("ok"), "查询失败")
        need(data.get("data_dir"), "没有 data_dir")
        need(Path(data["data_dir"]) == Path(tmp), "数据目录没有隔离：%s" % data["data_dir"])

    @check("POST /api/path 与 GET inspect 等价")
    def _(cli):
        status, data, _ = cli.post("/api/path", {"path": str(tif)})
        need(status == 200 and data.get("ok"), "失败：%s" % data.get("error"))
        need(data["kind"] == "raster", "种类不对")

    @check("不存在的路径给可读错误")
    def _(cli):
        status, data, _ = cli.get("/api/inspect", path=str(SAMPLES / "没有这个文件.shp"))
        need(status == 200 and data.get("ok") is False, "居然成功了")
        need((data.get("error") or {}).get("title"), "没有错误标题")

    try:
        wait_ready(base)
        c = Client(base)
        print("服务已就绪：%s，数据目录 %s\n" % (base, tmp))
        for name, fn in checks:
            if args.filter.lower() and args.filter.lower() not in name.lower():
                continue
            started = time.perf_counter()
            try:
                fn(c)
                ok, note = True, ""
            except AssertionError as exc:
                ok, note = False, str(exc)
            except Exception as exc:  # 连接断了、JSON 坏了，都算失败
                ok, note = False, "%s: %s" % (type(exc).__name__, exc)
            took = (time.perf_counter() - started) * 1000
            print("%s  %-34s %7.0f ms  %s" % ("PASS" if ok else "FAIL", name, took, note))
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
    print("%d 项检查：%d 通过，%d 失败" % (len(results), len(results) - len(failed), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
