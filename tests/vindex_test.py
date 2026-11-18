"""索引生命周期回归：建、查、锁、清缓存不误删。

只用一份 4 要素的小 GeoJSON，不碰 138 MB 的样例，几秒内跑完。
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

checks = 0


def ok(cond, name):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(name)
    print(f"  ok  {name}")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="tulan-vindex-"))
    old_data = os.environ.get("GISVIEWER_DATA_DIR")
    os.environ["GISVIEWER_DATA_DIR"] = str(tmp)
    try:
        from gisviewer import cache, vindex

        cache.init(tmp)
        fixture = ROOT / "tests" / "fixtures" / "mixed.geojson"
        path = vindex.path_of(str(fixture), 0)
        assert path is not None
        ok(bool(path), "索引路径可计算")

        n = vindex.build(str(fixture), 0, path)
        ok(n == 4, "build 写入 4 个要素")
        ok(vindex.count(path) == 4, "count 读回 4")
        rows = vindex.rows_page(path, 0, 10)
        ok(rows is not None and len(rows) == 4, "rows_page 读回 4")
        ok(vindex.existing(str(fixture), 0) == str(path), "existing 命中")
        ok(vindex.count_bbox(path, (114.0, 29.0, 116.0, 30.0)) == 3, "count_bbox 全量=3（第 4 个是空几何）")
        from gisviewer import vector
        got = vector.read_features(str(fixture), 0, bbox=(114.0, 29.0, 116.0, 30.0), limit=10)
        ok(got["gisviewer"]["in_bbox"] == 3, "索引 bbox 回填 in_bbox=3")
        ok(got["gisviewer"]["indexed"] is True, "索引 bbox 走 indexed 路径")

        lock = vindex._acquire_lock(path)
        assert lock is not None
        ok(bool(lock), "抢到建索引锁")
        ok(vindex.building(str(fixture), 0) is True, "锁存在时 building=True")
        vindex._release_lock(lock)
        ok(vindex.building(str(fixture), 0) is False, "释放后 building=False")

        lock = vindex._acquire_lock(path)
        assert lock is not None
        stale = time.time() - vindex.LOCK_STALE - 10
        os.utime(lock, (stale, stale))
        ok(vindex.building(str(fixture), 0) is False, "过期锁不再算 building")
        lock2 = vindex._acquire_lock(path)
        assert lock2 is not None
        ok(bool(lock2), "过期锁能被接手")
        vindex._release_lock(lock2)

        # 造一条比上限还大的旧缓存，prune 必须删它、但不能删索引
        old = cache._entry("inspect", "f" * 40, ".json")
        old.parent.mkdir(parents=True, exist_ok=True)
        old.write_text('{"x": "' + "y" * 4096 + '"}', encoding="utf-8")
        old.touch()
        cache.prune(max_bytes=1)
        ok(Path(path).exists(), "prune 后索引仍在")
        ok(not old.exists(), "prune 删掉了普通缓存")
        print(f"\nvindex lifecycle: {checks} checks passed")
    finally:
        if old_data is None:
            os.environ.pop("GISVIEWER_DATA_DIR", None)
        else:
            os.environ["GISVIEWER_DATA_DIR"] = old_data
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
