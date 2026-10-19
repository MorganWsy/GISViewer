"""建矢量索引的独立进程入口：python -m gisviewer.vindex_run <文件> <图层序号> <索引文件>

为什么单开一个进程：建一份 138 MB GeoJSON 的索引要把一个核占满二十来秒。
放在引擎进程里（无论线程还是同步）都会和正在取数的请求抢 CPU，
用户那几次拖动的等待会翻倍。子进程各用各的核，前台一点不受影响。
"""

import sys

from . import vindex


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) < 3:
        return 2
    try:
        layer = int(argv[1])
    except ValueError:
        return 2
    try:
        vindex.build(argv[0], layer, argv[2])
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
