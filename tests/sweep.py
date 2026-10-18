"""全格式回归 sweep：把引擎按格式过一遍，任何一条不达标就以非零码退出。

用法（在 gisviewer 环境里跑）：
    D:\\miniAnaconda\\envs\\gisviewer\\python.exe tests\\sweep.py
    ... tests\\sweep.py -k raster      # 只跑名字里含 raster 的
    ... tests\\sweep.py --list         # 只列用例
    ... tests\\sweep.py --twice        # 每条读两遍，顺便核对两次结果是否一致

样例数据在源码树之外（见 PLAN §11）：默认 ..\\GISViewer-data\\samples，用 TULAN_DATA 覆盖。
固件在 tests\\fixtures，由 tests\\make_fixtures.py 生成；缺了会提示先跑生成脚本。
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DATA = Path(os.environ.get("TULAN_DATA") or ROOT.parent / "GISViewer-data")
SAMPLES = DATA / "samples"
FIXTURES = ROOT / "tests" / "fixtures"

# 用例：(相对路径, 期望种类, 额外断言)
# 期望种类写 None 表示"种类不校验"，只要求读得成功且结构完整。
# 额外断言是 (取值路径, 判断函数)，路径用点分，列表取长度。
CASES = [
    # ---- 用户真实样例 ----
    ("samples/pre_2000_01.tif", "raster", [
        ("width", lambda v: v > 9000), ("band_count", lambda v: v == 1),
        ("compression_label", lambda v: "LZW" in str(v)),
    ]),
    ("samples/wuningGEP.json", "vector", [
        ("feature_count_total", lambda v: v == 109007),
        ("layers.0.geometry_is_mixed", lambda v: v is True),
    ]),
    ("samples/China2019.zip", "archive", [
        ("member_count", lambda v: v >= 5), ("layers.0.feature_count_total", lambda v: v == 35),
    ]),
    ("samples/GISProject.gdb", None, [("layers", lambda v: len(v) == 7)]),
    ("samples/architectural.dwg", "vector", [("feature_count_total", lambda v: v > 1000)]),
    ("samples/Cars.dxf", "vector", [("feature_count_total", lambda v: v > 0)]),
    ("samples/cropland-pbf", "tileset", [("tile_count", lambda v: v > 0)]),
    ("samples/SimpleFileBlock1-none.osm.pbf", None, []),

    # ---- 本地固件：栅格分支 ----
    ("fixtures/rgb_uint16_deflate.tif", "raster", [("band_count", lambda v: v == 3)]),
    ("fixtures/class_palette.tif", "raster", []),
    ("fixtures/palette_byte.tif", "raster", []),
    ("fixtures/multi_bands.tif", "raster", [("band_count", lambda v: v > 1)]),
    ("fixtures/nan_float.tif", "raster", []),
    ("fixtures/int16_uncompressed.tif", "raster", []),
    ("fixtures/big_sparse.tif", "raster", []),
    ("fixtures/multi_var.nc", None, []),

    # ---- 本地固件：矢量分支 ----
    ("fixtures/two_layer.gpkg", "vector", [("layer_count", lambda v: v == 2)]),
    ("fixtures/china.kml", "vector", []),
    ("fixtures/mixed.geojson", "vector", []),
    ("fixtures/no_prj", None, []),

    # ---- 应当友好失败，不能炸 ----
    ("fixtures/truncated.tif", "error", []),
    ("__nonexistent__/nothing.shp", "error", []),
    ("", "error", []),
]


# 这个 OSM 是故意损坏的样本：整体不能炸，逐层带错误是预期结果
LAYER_ERROR_OK = {"samples/SimpleFileBlock1-none.osm.pbf"}


def _dig(obj, path):
    for part in path.split("."):
        if isinstance(obj, list):
            obj = obj[int(part)]
        else:
            obj = obj[part]
    return obj


def _resolve(rel):
    if not rel:
        return ""
    head, _, tail = rel.partition("/")
    base = SAMPLES if head == "samples" else FIXTURES
    return str(base / tail) if tail else str(base)


def _err_title(info):
    err = info.get("error") or {}
    return err.get("title") or err.get("detail") or "（没有给出原因）"


def _normalize(info):
    """去掉耗时和缓存标记，用来比较两次读取是否一致。"""
    def walk(node):
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items() if k not in ("elapsed_ms", "cached")}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node
    return walk(info)


def check_case(inspect_fn, name, path, expect, extra):
    """跑一条用例，返回 (是否通过, 说明, 耗时毫秒)。"""
    if not path:
        info = inspect_fn("")
    elif not Path(path).exists():
        info = inspect_fn(path)
    else:
        info = inspect_fn(path, compute_stats=True)
    took = float(info.get("elapsed_ms") or 0)

    if expect == "error":
        if info.get("ok"):
            return False, "应当失败，却读成功了（kind=%s）" % info.get("kind"), took
        if not (info.get("error") or {}).get("title"):
            return False, "失败但没给出可读的原因", took
        return True, "已友好拒绝：%s" % _err_title(info)[:40], took

    if not info.get("ok"):
        return False, "读取失败：%s" % _err_title(info)[:80], took

    kind = info.get("kind")
    if expect not in (None, "error") and kind != expect:
        return False, "种类不对：期望 %s，实际 %s" % (expect, kind), took

    # 结构完整性：认得出的种类必须有它该有的字段
    note_extra = ""
    if kind == "raster":
        missing = [k for k in ("width", "height", "band_count", "crs") if k not in info]
        if missing:
            return False, "栅格缺字段：%s" % ", ".join(missing), took
        variables = info.get("variables") or []
        if variables:
            # 多变量 netCDF：顶层没有单一网格，尺寸写在每个变量的 summary 里
            for var in variables:
                summary = var.get("summary") or {}
                if not all(summary.get(k) for k in ("width", "height", "band_count")):
                    return False, "变量 %s 缺尺寸" % var.get("label"), took
            note_extra = "  多变量 %d 个" % len(variables)
        else:
            if not all(isinstance(info.get(k), int) and info[k] > 0
                       for k in ("width", "height", "band_count")):
                return False, "栅格的尺寸或波段数不合理", took
            # 没有坐标系的影像（无 prj 的原始文件）本来就没有范围，不算缺陷；
            # 有坐标系就必须给出范围，缺了才是真问题
            crs = info.get("crs") or {}
            if (crs.get("epsg") or crs.get("wkt")) and not info.get("extent"):
                return False, "有坐标系却没有范围", took
    elif kind in ("vector", "archive", "tileset"):
        layers = info.get("layers") or []
        if not layers:
            return False, "没有解析出任何图层", took
        bad = [l for l in layers if l.get("error")]
        if bad and name not in LAYER_ERROR_OK:
            return False, "有 %d 个图层带错误：%s" % (len(bad), str(bad[0].get("error"))[:60]), took
        if bad:
            good = len(layers) - len(bad)
            if good <= 0:
                return False, "所有图层都读不出来", took
            note_extra = "  %d 层可读、%d 层如实报错（预期）" % (good, len(bad))

    for key, want in extra:
        try:
            value = _dig(info, key)
        except Exception:
            return False, "断言取不到字段 %s" % key, took
        try:
            if not want(value):
                return False, "%s 不符合预期：%r" % (key, value), took
        except Exception:
            return False, "%s 断言本身出错：%r" % (key, value), took

    bits = ["kind=%s" % kind]
    if kind == "raster" and info.get("width"):
        bits.append("%d×%d×%d" % (info["width"], info["height"], info["band_count"]))
    if info.get("layers"):
        bits.append("%d 层" % len(info["layers"]))
    if info.get("feature_count_total"):
        bits.append("%d 要素" % info["feature_count_total"])
    return True, "  ".join(bits).rstrip() + note_extra, took


def main(argv=None):
    parser = argparse.ArgumentParser(description="全格式回归 sweep")
    parser.add_argument("-k", dest="filter", default="", help="只跑路径里含这个片段的用例")
    parser.add_argument("--list", action="store_true", help="只列用例，不执行")
    parser.add_argument("--twice", action="store_true", help="每条读两遍并核对结果一致")
    parser.add_argument("--keep-cache", action="store_true", help="沿用现有数据目录，不隔离")
    args = parser.parse_args(argv)

    cases = [c for c in CASES if args.filter.lower() in c[0].lower()]
    if args.list:
        for rel, expect, _ in cases:
            print("%-46s %s" % (rel, expect or "any"))
        return 0

    if not SAMPLES.is_dir():
        print("找不到样例数据目录：%s" % SAMPLES, file=sys.stderr)
        print("把样例放到这里，或设 TULAN_DATA 指向放样例的上级目录。", file=sys.stderr)
        return 2

    missing = [rel for rel, _, _ in cases
               if rel and not rel.startswith("__") and not Path(_resolve(rel)).exists()]
    if any(rel.startswith("fixtures/") for rel in missing):
        print("缺少测试固件，先跑：python tests\\make_fixtures.py", file=sys.stderr)
        return 2
    for rel in missing:
        print("缺用例文件，跳过：%s" % rel, file=sys.stderr)
    cases = [c for c in cases if c[0] not in set(missing)]

    # 隔离数据目录：回归不该改写用户调好的设置，也不该吃他攒的缓存
    tmp = None
    if not args.keep_cache:
        tmp = tempfile.mkdtemp(prefix="tulan-sweep-")
        os.environ["GISVIEWER_DATA_DIR"] = tmp

    from gisviewer import bootstrap  # noqa: E402
    bootstrap.configure()
    from gisviewer import safe_inspect  # noqa: E402

    failed = []
    started = time.perf_counter()
    print("用例 %d 条，数据目录 %s\n" % (len(cases), os.environ.get("GISVIEWER_DATA_DIR", "默认")))
    try:
        for rel, expect, extra in cases:
            path = _resolve(rel)
            try:
                ok, note, took = check_case(safe_inspect, rel, path, expect, extra)
            except Exception:
                ok, note, took = False, "检查过程抛异常：\n" + traceback.format_exc(limit=3), 0.0

            if ok and args.twice and path and Path(path).exists():
                again = safe_inspect(path, compute_stats=True)
                if _normalize(again) != _normalize(safe_inspect(path, compute_stats=True)):
                    ok, note = False, "两次读取结果不一致（%s）" % note

            print("%s  %-44s %7.0f ms  %s" % ("PASS" if ok else "FAIL", rel or "（空路径）", took, note))
            if not ok:
                failed.append((rel or "（空路径）", note))
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

    total = (time.perf_counter() - started)
    print()
    print("%d 条用例：%d 通过，%d 失败，用时 %.1f s"
          % (len(cases), len(cases) - len(failed), len(failed), total))
    if failed:
        print()
        print("失败明细：")
        for name, note in failed:
            print("  - %s：%s" % (name, note))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
