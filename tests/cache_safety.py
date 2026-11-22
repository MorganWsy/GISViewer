"""缓存目录安全回归：自定义位置不能被直接当成缓存根，清空不能动用户文件。

背景：早先缓存根就是用户选的目录本身，`clear()` 直接 rmtree；
用户把缓存位置指到一个已有资料的文件夹后，点"清空缓存"会把原文件一起删掉。

用法：
    dist\\runtime\\python.exe tests\\cache_safety.py

测试在临时数据目录里跑，不碰真实配置和缓存。
"""

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 必须在 import server 之前定数据目录：config_dir() 读这个变量
TMP = Path(tempfile.mkdtemp(prefix="tulan-cache-test-"))
os.environ["GISVIEWER_DATA_DIR"] = str(TMP / "data")

from gisviewer import cache, server  # noqa: E402

DATA = Path(os.environ["GISVIEWER_DATA_DIR"])
_checks = 0


def check(cond, msg):
    global _checks
    _checks += 1
    if not cond:
        raise AssertionError(msg)
    print("  ok  " + msg)


def cfg(cache_root):
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "config.json").write_text(
        json.dumps({"cache_root": str(cache_root)}), encoding="utf-8")


def fresh(label):
    p = TMP / label
    p.mkdir(parents=True, exist_ok=True)
    return p


def main():
    # 1. 所选目录只作为父目录：真正的缓存落在 TulanCache 子目录
    chosen = fresh("资料")
    (chosen / "keep.txt").write_text("keep", encoding="utf-8")
    (chosen / "notes.docx").write_bytes(b"doc")
    cfg(chosen)
    server._cache_root_used = None
    check(server.cache_root_dir() == chosen / "TulanCache",
          "cache_root_dir() 指向所选目录下的 TulanCache")
    target, note = server.apply_cache_root()
    check(target == chosen / "TulanCache", "apply_cache_root() 使用 TulanCache 子目录")
    check((chosen / "keep.txt").is_file(), "原文件 keep.txt 未被移动/删除")
    check((chosen / "notes.docx").is_file(), "原文件 notes.docx 未被移动/删除")
    check((target / server.CACHE_MARK).is_file(), "标记写在 TulanCache 里")

    cache.save_json("inspect", "a" * 40, {"ok": True})
    check((target / "inspect").is_dir(), "缓存确实写进了 TulanCache")

    # 2. 清空缓存只删缓存子目录，父目录里的文件必须原样保留
    cache.clear()
    check((chosen / "keep.txt").is_file(), "清空后 keep.txt 还在")
    check((chosen / "notes.docx").is_file(), "清空后 notes.docx 还在")
    check((target / server.CACHE_MARK).is_file(), "清空后标记还在")
    check(not (target / "inspect").exists(), "清空后缓存子目录被删除")

    # 3. 切换缓存位置：旧 TulanCache 里的缓存清掉，两个父目录的用户文件都不动
    chosen2 = fresh("资料2")
    (chosen2 / "keep2.txt").write_text("keep2", encoding="utf-8")
    cfg(chosen2)
    server.apply_cache_root()
    check((chosen / "keep.txt").is_file(), "切换后旧父目录文件还在")
    check((chosen2 / "keep2.txt").is_file(), "切换后新父目录文件还在")
    check(not (chosen / "TulanCache" / "inspect").exists(), "切换后旧缓存子目录已清空")

    # 4. 旧版本直接摊在父目录里的缓存：只清已知缓存子目录
    legacy = fresh("legacy")
    (legacy / server.CACHE_MARK).write_text("tulan", encoding="utf-8")
    (legacy / "keep.txt").write_text("keep", encoding="utf-8")
    (legacy / "inspect").mkdir()
    (legacy / "inspect" / "x.json").write_text("{}", encoding="utf-8")
    freed = server._clear_cache_dir(legacy)
    check(freed >= 0, "带标记的旧目录允许清理")
    check((legacy / "keep.txt").is_file(), "旧目录里的用户文件不被删除")
    check(not (legacy / "inspect").exists(), "旧目录里的缓存子目录被删除")

    # 5. 纯缓存老目录在升级时自动清理，用户目录不动
    legacy2 = fresh("legacy2")
    (legacy2 / server.CACHE_MARK).write_text("tulan", encoding="utf-8")
    (legacy2 / "inspect").mkdir()
    (legacy2 / "inspect" / "x.json").write_text("{}", encoding="utf-8")
    cfg(legacy2)
    server.apply_cache_root()
    check(not (legacy2 / "inspect").exists(), "纯缓存老目录升级后自动清理")
    check((legacy2 / server.CACHE_MARK).is_file(), "清理后标记保留")

    # 6. 所选位置不可用：退回默认目录并给出明确标记
    bad = TMP / "bad"
    bad.write_text("not a directory", encoding="utf-8")
    cfg(bad)
    target2, note2 = server.apply_cache_root()
    check(target2 == DATA / "cache", "不可用时退回默认缓存目录")
    check(server._cache_fell_back is True, "回退标志为真")
    check("不可用" in note2, "回退说明包含原因")

    # 7. 视野贴图落盘：重启后回到同一视野不该重算
    view_key = cache.key("view", str(ROOT / "tests" / "fixtures" / "mixed.geojson"),
                         "bands=1;max=1024;bbox=1,2,3,4")
    png = bytes([137, 80, 78, 71, 13, 10, 26, 10]) + b"0" * 200
    cache.save_view_png(view_key, png)
    disk_copy = cache.blob_path("view", view_key)
    check(disk_copy is not None and disk_copy.is_file(), "视野贴图写进了 view 分片")
    # 后面几条要反复问这个路径存不存在；上面那条已经断言过不是 None
    saved_file = disk_copy if disk_copy is not None else Path()
    # 只清内存那一层，模拟"进程刚重启、内存是空的"
    cache.drop_view_memory()
    check(cache.load_view_png(view_key, disk=False) is None, "临时副本不落盘时不读磁盘")
    check(cache.load_view_png(view_key) == png, "重启后从磁盘读回同一张")

    # 8. view 有自己的预算：不能被普通 256 MB 预算连带删掉
    for i in range(6):
        cache.save_json("inspect", str(i) * 40, {"i": i})
    cache.prune(max_bytes=1)
    check(saved_file.is_file(), "view 不计入普通预算，prune 不删它")
    cache.clear()
    check(not saved_file.exists(), "清空缓存时 view 一起删")

    # 9. 清空默认目录同样安全
    cache.save_json("inspect", "b" * 40, {"ok": True})
    cache.clear()
    check((DATA / "cache" / server.CACHE_MARK).is_file(), "默认目录清空后标记还在")

    print(f"\ncache safety: {_checks} checks passed")


if __name__ == "__main__":
    main()
