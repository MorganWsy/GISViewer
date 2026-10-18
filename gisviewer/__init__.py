"""GISViewer 引擎：把一个 GIS 文件的元数据一次性读出来。"""

import time as _time

# 引擎的计时起点；GISVIEWER_TIMING=1 时各阶段按这个报耗时
T_START = _time.perf_counter()

__version__ = "0.12"

# GDAL 一家的导入是启动耗时的大头，谁真正要用数据接口了再导
_HEAVY = {"configure", "inspect_file", "safe_inspect", "InspectError"}


def __getattr__(name):
    if name not in _HEAVY:
        raise AttributeError("module %r has no attribute %r" % (__name__, name))
    from .bootstrap import configure
    from .inspect import InspectError, inspect_file, safe_inspect
    found = {"configure": configure, "InspectError": InspectError,
             "inspect_file": inspect_file, "safe_inspect": safe_inspect}
    globals().update(found)
    return found[name]


__all__ = ["inspect_file", "safe_inspect", "InspectError", "configure",
           "__version__", "T_START"]
