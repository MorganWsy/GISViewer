"""数据缓存：同一个文件没变过，就直接搬上次的结果，不再重读一遍。

谁在用：
  ① 主信息读取（/api/path、/api/histogram 里的 safe_inspect）
  ② 每个波段的值分布直方图
  ③ 缩略图 PNG（合成底图、按分级上色的影像）
不缓存：量算、点选识别（都是即时的）、底图瓦片（amap.py 自己有一套磁盘缓存）。
/api/vector 按视野缓存（见 server.py），只进进程内 LRU，不落盘：单条几 MB，
落盘既会把 prune 的 256 MB 预算吃光，也会在下次启动时和索引抢删除顺序。
索引（vindex/）不参与 prune：它按“最后修改时间”淘汰会误删最该留的东西，
只在用户点“清空缓存”时删。

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
from contextlib import suppress
from pathlib import Path

MAX_BYTES = 256 * 1024 * 1024   # 磁盘缓存总容量上限（不含 vindex/pyramid）
# 金字塔副本单独一份预算：建一次要几秒到几十秒，按“最旧”删掉很浪费，
# 只在总量超过这条线时从最久没用的开始删
PYRAMID_BYTES = 2 * 1024 * 1024 * 1024
# 视野贴图也留一份到磁盘：重启软件后回到同一个视野（窗口大小没变、框也没变）
# 就不用重算，直接读回上一张。单独一份预算，避免拖来拖去把普通缓存挤掉
VIEW_BYTES = 128 * 1024 * 1024
MEM_ITEMS = 48                  # 进程内热点条数（打开过的文件再接再开就是零等待）
VIEW_MEM_ITEMS = 24             # 视野贴图：来回拖一下重复率高，20 来张够用
VIEW_MEM_BYTES = 48 * 1024 * 1024  # 视野贴图内存上限
VEC_MEM_ITEMS = 8               # 矢量视野响应：条数少，单条大
VEC_MEM_BYTES = 64 * 1024 * 1024  # 矢量响应内存上限
VEC_BYTES = 256 * 1024 * 1024    # 落盘的那份：单独预算，不挤信息栏那些小条目
VEC_MAX_SAVE = 16 * 1024 * 1024  # 单条超过这个就不落盘（多半是容差被设成 0）
SCAN_FILES = 500                # 目录指纹最多数这么多文件，再大就退回目录 mtime
# 载荷结构版本：缓存里存的东西改了形状（信息栏多一行、直方图多一项）就加一。
# 只靠版本号不够——同一个版本号下 rebuild 过、装了不同构建的副本，
# 旧结果会带着缺字段的样子被搬出来（实测：加了"属性表编码"，旧缓存里没有这一项）
SCHEMA = 2
# 缓存根下只认这几种子目录。clear()/切换目录时按白名单删，绝不整个 rmtree——
# 用户可能把缓存位置指到一个已经有资料的文件夹，根目录本身不是我们的。
KINDS = ("inspect", "hist", "gtypes", "vec", "thumb", "view", "vindex", "tiles", "pyramid")

_lock = threading.Lock()
_mem = OrderedDict()            # (kind, key) -> 值；只放 JSON 结果，PNG 不进内存
_vec_mem = OrderedDict()        # key -> (响应, 字节数)；只进内存，不落盘
_vec_bytes = 0
_view_mem = OrderedDict()       # key -> PNG 字节；视野贴图同样只进内存
_view_bytes = 0
_ROOT: Path | None = None       # server 启动时 init() 一次


def init(root):
    """由 server 在启动时指一次缓存根目录（通常是 config_dir）。"""
    repoint(Path(root) / "cache")


def repoint(path):
    """直接把缓存目录指到 path 本身（设置里自定义了位置时用这个）。
    建不出来就保持原样，由调用方决定要不要退回默认。"""
    global _ROOT
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    _ROOT = p


def _root() -> Path:
    if _ROOT is None:
        # 没被显式初始化过（比如单元测试直接调），就跟着引擎的配置目录走
        from .server import config_dir
        init(config_dir())
    if _ROOT is None:  # 初始化过还是空：只能是配置目录不可写
        raise RuntimeError("缓存目录没有初始化成功")
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
                # 超大目录（瓦片缓存常见）不再逐个扫：文件内容变化不会改目录
                # mtime，但这里只拿它当缓存指纹，宁可偶尔失效也不要每次几万次 stat。
                return ("d", st.st_mtime_ns, -1)
    return ("d", newest, total, count)


def key(kind, path, extra=""):
    """拼缓存键。文件不可访问时返回 None——都判断不了它变没变，就别用缓存。"""
    from . import __version__
    stamp = _stamp(path)
    if stamp is None:
        return None
    norm = os.path.normcase(os.path.abspath(str(path)))
    raw = "|".join([kind, __version__, str(SCHEMA), norm, repr(stamp), str(extra)])
    return hashlib.blake2b(raw.encode("utf-8", "replace"),
                           digest_size=20).hexdigest()


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


def load_vec(k, disk=True):
    """矢量响应：先内存，再磁盘。

    disk=False 用于临时副本（每轮路径都不一样，落盘只会白占预算）。
    磁盘命中顺手塞回内存，连着平移时就不用反复解析 JSON。
    """
    if not k:
        return None
    with _lock:
        item = _vec_mem.get(k)
        if item is not None:
            _vec_mem.move_to_end(k)
            return item[0]
    if not disk:
        return None
    path = _entry("vec", k, ".json")
    try:
        with open(path, encoding="utf-8") as fh:  # noqa: PTH123
            value = json.load(fh)
    except (OSError, ValueError):
        return None
    with suppress(OSError):
        os.utime(path, None)   # 读过就算用过，prune 按 mtime 从旧到新删
    if isinstance(value, dict):
        _remember_vec(k, value, path.stat().st_size)
    return value


def save_vec(k, value, size, disk=True):
    """存一份矢量响应：内存 + 磁盘（超过 VEC_MAX_SAVE 只进内存）。"""
    if not k:
        return
    if disk and size <= VEC_MAX_SAVE:
        path = _entry("vec", k, ".json")
        tmp = path.with_suffix(".part")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(value, ensure_ascii=False, default=str), encoding="utf-8")
            os.replace(tmp, path)
        except (OSError, TypeError, ValueError):
            with suppress(OSError):
                tmp.unlink()
    _remember_vec(k, value, size)


def _remember_vec(k, value, size):
    """内存那一层的淘汰：条数和字节双限，单条大响应不挤掉一堆小响应。"""
    global _vec_bytes
    with _lock:
        old = _vec_mem.pop(k, None)
        if old is not None:
            _vec_bytes -= old[1]
        _vec_mem[k] = (value, size)
        _vec_bytes += size
        while len(_vec_mem) > VEC_MEM_ITEMS or _vec_bytes > VEC_MEM_BYTES:
            _old_key, (_, old_size) = _vec_mem.popitem(last=False)
            _vec_bytes -= old_size



def load_view(k):
    """按视野渲染出来的贴图：只进内存，磁盘上一张不留。

    每次拖动的视野都不同，落盘只会把 thumb 分片灌满，下次启动又被 prune 清掉；
    可"放大一级再缩回来""来回拖一下"重复率高，留在内存里就够了。
    """
    if not k:
        return None
    with _lock:
        png = _view_mem.get(k)
        if png is None:
            return None
        _view_mem.move_to_end(k)
        return png


def load_view_png(k, disk=True):
    """视野贴图：先看内存，再看磁盘。磁盘命中时回填内存，后面几次拖动就是零等待。

    disk=False 给临时副本用：那些路径每轮都不一样，存了也永远不会被读到。"""
    png = load_view(k)
    if png is not None:
        return png
    if not disk:
        return None
    png = load_blob("view", k)
    if png is not None:
        save_view(k, png)
    return png


def drop_view_memory():
    """只清内存里那份视野贴图，磁盘留着（重启后照样能读回来）。"""
    global _view_bytes
    with _lock:
        _view_mem.clear()
        _view_bytes = 0


def save_view_png(k, png, disk=True):
    """视野贴图两头都放：内存给同一会话，磁盘给下一次启动。"""
    save_view(k, png)
    if disk:
        save_blob("view", k, png)


def save_view(k, png):
    """存一张视野贴图；按条数与总字节双重淘汰，单张超过 16 MB 的不存。"""
    global _view_bytes
    if not k or not png:
        return
    size = len(png)
    if size > 16 * 1024 * 1024:
        return
    with _lock:
        old = _view_mem.pop(k, None)
        if old is not None:
            _view_bytes -= len(old)
        _view_mem[k] = png
        _view_bytes += size
        while len(_view_mem) > VIEW_MEM_ITEMS or _view_bytes > VIEW_MEM_BYTES:
            _old_key, old_png = _view_mem.popitem(last=False)
            _view_bytes -= len(old_png)

# ---------- 磁盘层 ----------

def _entry(kind, key_hex, ext):
    """条目路径按键的前两位分子目录，免得单目录里堆几万个文件。"""
    root = _root() / kind
    return root / key_hex[:2] / (key_hex + ext)


def _touch(path):
    """读取命中时把修改时间刷新成现在，当"最近用过"的记号给清理用。"""
    with suppress(OSError):
        os.utime(path, None)


def _write(path, body):
    """原子写：缓存写不进去（磁盘满、目录被移走）不该影响正常读取，静默放过。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=str(path.parent), prefix=".tmp-", delete=False) as fh:
            fh.write(body)
            tmp = fh.name
        os.replace(tmp, path)
    except OSError:
        pass  # pi-lens-ignore: python-empty-except -- 写不进缓存就当没缓存，功能照跑


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


def blob_path(kind, key_hex, ext=".bin"):
    """给"要落一个大文件、得直接往上写"的用法返回路径（矢量索引就是这样）。
    父目录一并建好；键为空时返回 None，调用方照旧走原路。"""
    if not key_hex:
        return None
    path = _entry(kind, key_hex, ext)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return path


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
    """超容量就清：按修改时间（=最后用过的时间）从旧到新删，留出余量。

    vindex/ 不参与：索引只在读时打开，mtime 不会刷新，按“最旧”删会先删
    最该留的索引；它的体积单独算，用户在设置页点“清空缓存”时才删。"""
    root = _root()
    entries = []
    total = 0
    index_bytes = 0
    pyramid_entries = []
    pyramid_bytes = 0
    view_entries = []
    view_bytes = 0
    vec_entries = []
    vec_bytes = 0
    for path in root.rglob("*"):
        try:
            if not path.is_file():
                continue
            st = path.stat()
            rel = path.relative_to(root)
            if rel.parts and rel.parts[0] == "vindex":
                index_bytes += st.st_size
                continue
            if rel.parts and rel.parts[0] == "view":
                # 视野贴图单独一份预算：一张 0.3–3 MB，拖几十次就过百兆，
                # 混在总预算里会把信息栏、直方图这些真正小又常用的条目挤掉
                view_entries.append((st.st_mtime, st.st_size, path))
                view_bytes += st.st_size
                continue
            if rel.parts and rel.parts[0] == "vec":
                # 视野响应也有自己的一份预算：一条 0.5–2 MB，混进总预算会把
                # 信息栏、直方图那些几十 KB 又常用的条目先挤出去
                vec_entries.append((st.st_mtime, st.st_size, path))
                vec_bytes += st.st_size
                continue
            if rel.parts and rel.parts[0] == "pyramid":
                # 金字塔副本按自己的预算单独收（见 PYRAMID_BYTES），
                # 和索引一样不能按“最旧”删：刚用过才读过，mtime 只反映启动时的触碰
                pyramid_entries.append((st.st_mtime, st.st_size, path))
                pyramid_bytes += st.st_size
                continue
            entries.append((st.st_mtime, st.st_size, path))
            total += st.st_size
        except OSError:
            continue
    pyramid_entries.sort(key=lambda item: item[0])
    for _mtime, size, path in pyramid_entries:
        if pyramid_bytes <= PYRAMID_BYTES:
            break
        try:
            path.unlink()
            pyramid_bytes -= size
        except OSError:
            continue
    vec_entries.sort(key=lambda item: item[0])
    for _mtime, size, path in vec_entries:
        if vec_bytes <= VEC_BYTES:
            break
        try:
            path.unlink()
            vec_bytes -= size
        except OSError:
            continue
    view_entries.sort(key=lambda item: item[0])
    for _mtime, size, path in view_entries:
        if view_bytes <= VIEW_BYTES:
            break
        try:
            path.unlink()
            view_bytes -= size
        except OSError:
            continue
    if total <= max_bytes:
        return total + index_bytes
    entries.sort(key=lambda item: item[0])
    for _mtime, size, path in entries:
        if total <= max_bytes * 0.8:
            break
        # 标记文件（.tulan-cache）和写了一半的临时文件不参与清理，
        # 否则清完容量反而丢了"这是我的缓存目录"的凭据。
        if path.name.startswith("."):
            continue
        try:
            path.unlink()
            total -= size
        except OSError:
            continue
    with _lock:
        _mem.clear()
    return total + index_bytes


def clear():
    """设置页的"清空缓存"：内存和磁盘一起清，清完目录留着。

    只删 KINDS 里的子目录。早先这里直接 rmtree(root)，用户把缓存位置指到
    一个已有资料的文件夹后，点一次"清空"就把人家的原文件一起删了——
    缓存目录可以是用户选的，根目录从来不是我们的。"""
    with _lock:
        _mem.clear()
        _vec_mem.clear()
        _view_mem.clear()
    global _vec_bytes, _view_bytes
    _vec_bytes = 0
    _view_bytes = 0
    root = _root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    for kind in KINDS:
        # 缓存子目录可能正被索引子进程占着（Windows 上文件有锁），
        # 删不掉就留给下次清理，不能因此让"清空缓存"整个失败。
        try:
            shutil.rmtree(root / kind, ignore_errors=True)
        except OSError:
            continue
