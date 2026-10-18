"""给打好的 runtime 做体检：一条命令验出免安装包还能不能干活。

用打包出来的解释器跑：dist\\runtime\\python.exe tools\\check_runtime.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 样例数据在源码树之外（见 PLAN §11），换位置时用 TULAN_DATA 指过去
DATA = Path(os.environ.get("TULAN_DATA") or ROOT.parent / "GISViewer-data")
SAMPLE = Path(sys.argv[1]) if len(sys.argv) > 1 else DATA / "samples"


def main():
    print("解释器", sys.executable)
    print("prefix", sys.prefix)
    ok = True

    def step(name, fn):
        nonlocal ok
        try:
            got = fn()
            print(("  通过  " if got else "  不通过 ") + name + ("：" + str(got) if got else ""))
            if not got:
                ok = False
        except Exception as exc:
            ok = False
            print("  失败  " + name + "：" + type(exc).__name__ + " " + str(exc)[:160])

    import numpy
    step("numpy", lambda: str(numpy.__version__))

    import gisviewer
    from gisviewer import bootstrap, server

    step("GDAL", lambda: bootstrap.gdal.__version__)
    step("PROJ", lambda: str(bootstrap.osr.GetPROJVersionMajor()) + "." +
         str(bootstrap.osr.GetPROJVersionMinor()))

    tif = str(SAMPLE / "pre_2000_01.tif")
    info = gisviewer.inspect_file(tif)
    step("GeoTIFF 元数据", lambda: str(info["band_count"]) + " 波段，" +
         str(info["width"]) + "×" + str(info["height"]))
    step("精确直方图", lambda: str(
        server.band_stats_and_hist(tif, info, 1)["histogram"]["bins"]) + " 个分箱")
    step("Shapefile 压缩包", lambda: gisviewer.inspect_file(
        str(SAMPLE / "China2019.zip"))["kind"])
    step("DWG 转换兜底", lambda: str(gisviewer.inspect_file(
        str(SAMPLE / "architectural.dwg"))["feature_count_total"]) + " 个要素")
    step("投影换算", lambda: str(info["extent_wgs84"][1]))

    print("结论：" + ("runtime 可用" if ok else "runtime 缺东西，看上面哪一项"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
