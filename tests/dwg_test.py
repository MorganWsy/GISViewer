"""DWG 临时目录生命周期：失败清理、退出兜底、单位读取。

不依赖真实 DWG 转换：临时目录的清理可以直接构造；单位读取用样本，样本
不存在就跳过（打包/CI 精简环境）。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from gisviewer import dwg  # noqa: E402

checks = 0


def ok(cond, name):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(name)
    print(f"  ok  {name}")


def main():
    tmp = tempfile.mkdtemp(prefix="tulan-dwg-test-")
    dwg._TEMP_DIRS.add(tmp)
    dwg._cleanup()
    ok(not os.path.exists(tmp), "退出清理删掉临时目录")
    ok(tmp not in dwg._TEMP_DIRS, "清理后登记表不再留路径")

    bad = Path(tempfile.mkdtemp(prefix="tulan-dwg-bad-")) / "bad.dwg"
    bad.write_bytes(b"not a dwg")
    before = set(dwg._TEMP_DIRS)
    ok(dwg.convert(str(bad)) is None, "坏 DWG 转换返回 None")
    ok(set(dwg._TEMP_DIRS) == before, "失败不遗留临时目录")

    sample = ROOT / "data" / "samples" / "architectural.dwg"
    if sample.exists() and dwg.available():
        got = dwg.insunits(str(sample))
        ok(got is not None and got[0] > 0, "样本 $INSUNITS 能读出正系数")
        dwg._cleanup()
        ok(not any(os.path.exists(p) for p in before), "样本转换目录可清")
    print(f"\nDWG lifecycle: {checks} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
