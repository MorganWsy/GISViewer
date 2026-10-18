"""数据缓存：同一个文件没变过，就直接搬上次的结果，不再重读一遍。

谁在用：
  ① 主信息读取（/api/path、/api/histogram 里的 safe_inspect）
  ② 每个波段的值分布直方图
  ③ 缩略图 PNG（合成底图、按分级上色的影像）
不缓存：/api/vector（跟着当前视野走）、量算、点选识别（都是即时的）、
底图瓦片（amap.py 自己有一套磁盘缓存）。

键 = 用途 + 参数 + 规范化路径 + 文件指纹（大小、修改时间；目录把内容也算上）。
文件一改，指纹就变，旧键自然不命中；残留的旧条目交给容量清理。
写盘用"临时文件 + os.replace"原子替换，多线程下不会读到写了一半的文件。

缓存目录在 config_dir()/cache/ 里，跟着 GISVIEWER_DATA_DIR 走，
测试实例不会碰到用户真正的缓存。超过总容量上限时，按最后用过的时间
从旧到新删（读取命中时会刷新文件的修改时间，当"最近使用"的记号）。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

MAX_BYTES = 256 * 1024 * 1024   # 磁盘缓存总容量上限
MEM_ITEMS = 48                  # 进程内热点条数（打开过的文件再接再开就是零等待）
SCAN_FILES = 50000              # 目录指纹最多数这么多文件，超大瓦片目录不细算

_lock = threading.Lock()
_mem = OrderedDict()            # (kind, key) -> 值；只放 JSON 结果，PNG 不进内存
_ROOT = None                    # server 启动时 init() 一次


def init(root):
    """由 server 在启动时指一次缓存根目录（通常是 config_dir）。"""
    global _ROOT
    _ROOT = Path(root) / "cache"
    _ROOT.mkdir(parents=True, exist_ok=True)


def _root():
    global _ROOT
    if _ROOT is None:
        # 没被显式初始化过（比如单元测试直接调），就跟着引擎的配置目录走
        from .server import config_dir
        init(config_dir())
    return _ROOT


# ---------- 指纹与键 ----------

def _stamp(path):
    """给文件/目录做一份"变没变过"的指纹。

    文件用大小 + 修改时间。目录不能只看自己的修改时间——那只在增删文件时变，
    改里面某个已有文件的内容是不动的，所以目录要把全部子文件扫一遍求和取最新。
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISDIR(st.st_mode):
        return ("f", st.st_size, st.st_mtime_ns)
    total = 0
    count = 0
    newest = st.st_mtime_ns
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                fst = os.stat(os.path.join(root, name))
            except OSError:
                continue
            total += fst.st_size
            newest = max(newest, fst.st_mtime_ns)
            count += 1
            if count >= SCAN_FILES:
                break
        if count >= SCAN_FILES:
            break
    return ("d", newest, total, count)


def key(kind, path, extra=""):
    """拼缓存键。文件不可访问时返回 None——都判断不了它变没变，就别用缓存。"""
    from . import __version__
    stamp = _stamp(path)
    if stamp is None:
        return None
    norm = os.path.normcase(os.path.abspath(str(path)))
    raw = "|".join([kind, __version__, norm, repr(stamp), str(extra)])
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()


# ---------- 内存层 ----------

def _mem_get(k):
    with _lock:
        if k in _mem:
            _mem.move_to_end(k)
            return _mem[k]
    return None


def _mem_put(k, v):
    with _lock:
        _mem[k] = v
        _mem.move_to_end(k)
        while len(_mem) > MEM_ITEMS:
            _mem.popitem(last=False)


# ---------- 磁盘层 ----------

def _entry(kind, key_hex, ext):
    """条目路径按键的前两位分子目录，免得单目录里堆几万个文件。"""
    root = _root() / kind
    return root / key_hex[:2] / (key_hex + ext)


def _touch(path):
    """读取命中时把修改时间刷新成现在，当"最近用过"的记号给清理用。"""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _write(path, body):
    """原子写：缓存写不进去（磁盘满、目录被移走）不该影响正常读取，静默放过。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=str(path.parent), prefix=".tmp-", delete=False) as fh:
            fh.write(body)
            tmp = fh.name
        os.replace(tmp, path)
    except OSError:
        pass


def load_json(kind, key_hex, mem=True):
    """mem=False：跳过内存层直接读盘。矢量响应这类单条就能有几 MB，
    全塞进内存 LRU 会把内存吃爆，磁盘读一次一百毫秒，足够了。"""
    if not key_hex:
        return None
    if mem:
        hit = _mem_get((kind, key_hex))
        if hit is not None:
            return hit
    path = _entry(kind, key_hex, ".json")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    _touch(path)
    if mem:
        _mem_put((kind, key_hex), value)
    return value


def save_json(kind, key_hex, value, mem=True):
    if not key_hex:
        return
    if mem:
        _mem_put((kind, key_hex), value)
    _write(_entry(kind, key_hex, ".json"),
           json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


def load_blob(kind, key_hex):
    if not key_hex:
        return None
    path = _entry(kind, key_hex, ".bin")
    try:
        body = path.read_bytes()
    except OSError:
        return None
    if not body:
        return None
    _touch(path)
    return body


def save_blob(kind, key_hex, body):
    if not key_hex:
        return
    _write(_entry(kind, key_hex, ".bin"), body)


# ---------- 容量与统计 ----------

def stats():
    """缓存占了多少、有几条。设置页要用。"""
    total = 0
    count = 0
    root = _root()
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
                count += 1
        except OSError:
            continue
    return {"bytes": total, "count": count}


def prune(max_bytes=MAX_BYTES):
    """超容量就清：按修改时间（=最后用过的时间）从旧到新删，留出余量。"""
    root = _root()
    entries = []
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                st = path.stat()
                entries.append((st.st_mtime, st.st_size, path))
                total += st.st_size
        except OSError:
            continue
    if total <= max_bytes:
        return total
    entries.sort(key=lambda item: item[0])
    for _mtime, size, path in entries:
        if total <= max_bytes * 0.8:
            break
        try:
            path.unlink()
            total -= size
        except OSError:
            continue
    with _lock:
        _mem.clear()
    return total


def clear():
    """设置页的"清空缓存"：内存和磁盘一起清，清完目录留着。"""
    with _lock:
        _mem.clear()
    root = _root()
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
