"""GISViewer 引擎：把一个 GIS 文件的元数据一次性读出来。"""

import time as _time
from typing import TYPE_CHECKING

# 引擎的计时起点；GISVIEWER_TIMING=1 时各阶段按这个报耗时
T_START = _time.perf_counter()

__version__ = "0.17"

# GDAL 一家的导入是启动耗时的大头，谁真正要用数据接口了再导
_HEAVY = {"configure", "inspect_file", "safe_inspect", "InspectError"}


def __getattr__(name):
    if name not in _HEAVY:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from .bootstrap import configure
    from .inspect import InspectError, inspect_file, safe_inspect
    found = {"configure": configure, "InspectError": InspectError,
             "inspect_file": inspect_file, "safe_inspect": safe_inspect}
    globals().update(found)
    return found[name]


if TYPE_CHECKING:
    # 下面这几个名字由 __getattr__ 按需导入，运行时不在这里；
    # 声明进来是为了让类型检查能认得出 __all__ 里的名字，不会在本文件真正导入 GDAL
    from .bootstrap import configure
    from .inspect import InspectError, inspect_file, safe_inspect


__all__ = ["inspect_file", "safe_inspect", "InspectError", "configure",
           "__version__", "T_START"]
