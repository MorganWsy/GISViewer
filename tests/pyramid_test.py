"""金字塔副本：建得出来、挑得对、删得掉。

跑法：app\\runtime\\python.exe tests\\pyramid_test.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DATA = Path(tempfile.mkdtemp(prefix="tulan-pyr-test-"))
os.environ["GISVIEWER_DATA_DIR"] = str(DATA)

SAMPLE = ROOT / "data" / "samples" / "pre_2000_01.tif"
CHECKS: list[str] = []
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (CHECKS if ok else FAILED).append(name)
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))


def main() -> int:
    # 放在函数里：要先改好 sys.path 才能 import，模块级再 import 就被 E402 挡了
    from gisviewer import cache, pyramid

    if not SAMPLE.exists():
        print(f"SKIP 样本不存在：{SAMPLE}")
        return 0
    cache.init(DATA / "cache")

    st = pyramid.status(SAMPLE)
    check("大影像建议建金字塔", st["recommend"] is True, str(st["reason"])[:40])
    check("还没建时 pyramid.exists 为假", st["pyramid"]["exists"] is False)

    small = ROOT / "tests" / "fixtures" / "mixed.geojson"
    if small.exists():
        st_small = pyramid.status(SAMPLE.parent / "Cars.dxf")
        check("小文件不建议建", st_small["recommend"] is False, str(st_small["reason"])[:30])

    res = pyramid.build(SAMPLE, "average", blocking=True)
    check("副本建成功", res["ok"] is True and not res.get("error"), str(res.get("error", ""))[:60])
    kept = pyramid.current(SAMPLE)
    check("current() 能找到副本", kept is not None and Path(kept).exists())
    check("副本带层级", pyramid.status(SAMPLE)["pyramid"]["levels"] == list(pyramid.LEVELS),
          str(pyramid.status(SAMPLE)["pyramid"]["levels"]))

    # 挑源：视野很粗（要 8 个原图像元换 1 个输出像元）用副本；很细用原图
    check("往外拉视野时读副本", pyramid.pick(SAMPLE, 9665, 8.0) is not None)
    check("放大到细节时读原图", pyramid.pick(SAMPLE, 9665, 1.0) is None)

    # 原文件时间戳变了，旧副本自动作废
    st2 = pyramid.status(SAMPLE)
    check("副本体积合理", 0 < st2["pyramid"]["size"] < 60 * 1024 * 1024,
          f"{st2['pyramid']['size'] / 1e6:.0f} MB")

    # 清理：预算够时留着，超预算时从旧的开始删
    cache.prune()
    check("prune 不动金字塔", pyramid.current(SAMPLE) is not None)
    cache.PYRAMID_BYTES = 1                      # 临时压到 1 字节，逼它删
    cache.prune()
    check("超预算后金字塔被删", pyramid.current(SAMPLE) is None)
    cache.PYRAMID_BYTES = 2 * 1024 * 1024 * 1024

    # 再建一次，然后走“清空缓存”
    pyramid.build(SAMPLE, "nearest", blocking=True)
    check("换个采样方法能重建", pyramid.current(SAMPLE) is not None)
    cache.clear()
    check("清空缓存删掉金字塔", pyramid.current(SAMPLE) is None)

    # 取消：起一个立刻取消，最后不该留下半成品
    pyramid.build(SAMPLE, "average")
    pyramid.cancel(SAMPLE)
    for _ in range(60):
        if not pyramid.building(SAMPLE):
            break
        import time

        time.sleep(0.1)
    leftovers = list((DATA / "cache" / "pyramid").glob("*.part"))
    check("取消后不留半成品", not leftovers, f"{len(leftovers)} 个 .part")

    print()
    print(f"金字塔副本：{len(CHECKS)} 项通过，{len(FAILED)} 项失败")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    raise SystemExit(main())
