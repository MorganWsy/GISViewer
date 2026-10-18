"""GDAL 运行环境引导。

必须在导入 osgeo / rasterio / pyogrio 之前先执行本模块。
用户机器上存在指向别处的持久 PROJ_DATA / GDAL_DATA 环境变量，
不重写的话所有 EPSG 定义都查不到。
"""

import ctypes
import os
import sys
from pathlib import Path

_configured = False


def _first_dir(*candidates):
    for c in candidates:
        if c and Path(c).is_dir():
            return Path(c)
    return None


def configure():
    """把数据目录和插件目录指向当前环境自身。"""
    global _configured
    if _configured:
        return
    _configured = True

    prefix = Path(sys.prefix)
    # conda 环境在 Windows 上是 <prefix>/Library/...，conda-pack 解包后同样保留该布局
    lib = prefix / "Library" if (prefix / "Library").is_dir() else prefix

    bindir = _first_dir(lib / "bin", prefix)
    share = _first_dir(lib / "share", prefix / "Library" / "share")

    proj = _first_dir(share / "proj") if share else None
    gdaldata = _first_dir(share / "gdal") if share else None
    plugins = _first_dir(lib / "lib" / "gdalplugins", prefix / "lib" / "gdalplugins")

    if bindir and os.name == "nt":
        try:
            os.add_dll_directory(str(bindir))
        except OSError:
            pass
        os.environ["PATH"] = str(bindir) + os.pathsep + os.environ.get("PATH", "")
        # 先把本环境的 gdal.dll 装进进程。机器上别处装了 GDAL 时（ArcGIS、QGIS、
        # 别的 conda 环境），_gdal.pyd 可能抢到另一套同名库，报"找不到指定的程序"。
        for name in ("gdal.dll", "proj.dll", "hdf5.dll"):
            dll = bindir / name
            if dll.is_file():
                try:
                    ctypes.WinDLL(str(dll))
                except OSError:
                    pass

    if proj:
        os.environ["PROJ_DATA"] = str(proj)
    # 新旧两个名字都要清掉，否则别处的安装会赢
    os.environ.pop("PROJ_LIB", None)
    if gdaldata:
        os.environ["GDAL_DATA"] = str(gdaldata)
    if plugins:
        os.environ["GDAL_DRIVER_PATH"] = str(plugins)

    os.environ.setdefault("GDAL_NUM_THREADS", "ALL_CPUS")


configure()

from osgeo import gdal, ogr, osr  # noqa: E402

gdal.UseExceptions()

__all__ = ["gdal", "ogr", "osr", "configure"]
