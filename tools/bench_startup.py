"""启动与加载耗时分解：找出慢在哪一步，别凭感觉优化。

用法：
  python tools/bench_startup.py            # 完整链路
  python tools/bench_startup.py --gdal     # 只量 GDAL 导入与驱动注册
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# 样例数据在源码树之外（见 PLAN §11），换位置时用 TULAN_DATA 指过去
DATA = os.environ.get("TULAN_DATA") or os.path.join(os.path.dirname(ROOT), "GISViewer-data")


def ms(t0):
    return (time.perf_counter() - t0) * 1000.0


def show(label, t0):
    print("%-30s %8.0f ms" % (label, ms(t0)))
    return time.perf_counter()


def bench_gdal():
    """单独一个子进程，只导入 GDAL，看驱动注册吃掉多少。"""
    code = (
        "import time; t=time.perf_counter()\n"
        "from osgeo import gdal\n"
        "a=time.perf_counter()\n"
        "n=gdal.GetDriverCount()\n"
        "b=time.perf_counter()\n"
        "print('import osgeo.gdal  %6.0f ms  (驱动 %d)' % ((a-t)*1000, n))\n"
        "print('GetDriverCount     %6.0f ms' % ((b-a)*1000))\n"
    )
    subprocess.run([sys.executable, "-c", code])
    # 只留栅格+常用矢量驱动，看能省多少
    code2 = ("import os\n"
             "os.environ['GDAL_DATA']=r'" + os.path.join(ROOT, 'x') + "'\n") + code
    subprocess.run([sys.executable, "-c", code2])


def bench_full(paths):
    t = time.perf_counter()
    subprocess.run([sys.executable, "-c", "pass"])
    t = show("解释器冷启动（子进程）", t)

    from gisviewer import bootstrap
    t = show("import gisviewer.bootstrap", t)
    bootstrap.configure()
    t = show("configure()", t)

    from osgeo import gdal
    t = show("import osgeo.gdal", t)
    n = gdal.GetDriverCount()
    t = show("驱动枚举（共 %d 个）" % n, t)

    from gisviewer import inspect as insp, raster
    t = show("import inspect/raster", t)

    for p in paths:
        if not os.path.exists(p):
            print("跳过（不存在）", p)
            continue
        t0 = time.perf_counter()
        d = insp.inspect_file(p)
        took = ms(t0)
        kind = d.get("kind")
        extra = ""
        if kind == "raster" and d.get("height"):
            t1 = time.perf_counter()
            hist = raster.band_histogram(d.get("read_path") or d["file"]["path"],
                                         1, d["height"], d["width"],
                                         d["bands"][0]["type"])
            extra = "  直方图 %6.0f ms（%d 个分箱）" % (ms(t1), len(hist["counts"]) if hist else 0)
        print("%-28s %6.0f ms  %s%s" % (os.path.basename(p), took, kind, extra))
    return 0


if __name__ == "__main__":
    if "--gdal" in sys.argv:
        bench_gdal()
        raise SystemExit(0)
    files = [a for a in sys.argv[1:] if not a.startswith("-")] or [
        os.path.join(DATA, "samples", "pre_2000_01.tif"),
        os.path.join(DATA, "samples", "China2019.zip"),
        os.path.join(DATA, "samples", "wuningGEP.json"),
        os.path.join(DATA, "samples", "architectural.dwg"),
    ]
    raise SystemExit(bench_full(files))
