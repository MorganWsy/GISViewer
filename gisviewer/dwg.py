"""新版 DWG 的读取兜底：GDAL 自带的 CAD 驱动只到 AutoCAD 2000，
遇到更新的版本就用 libredwg 的 dwg2dxf 先转成 DXF，再走正常读取。"""

import atexit
import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path

_TIMEOUT = 180
_MAX_CONVERTED = 32
_TEMP_DIRS = set()

# 同一份 DWG 没改过就只转一次：打开文件、画图层、点选各处的转换结果共用一份，
# 不然每取一次要素就多转一遍、临时目录也会越积越多
_CONVERTED = OrderedDict()

# 正在跑的转换：路径 -> (Popen, 开始时间, 目标 DXF)；状态轮询和取消都靠它
_PROCS = {}
_CANCELLED = set()
_PROC_LOCK = threading.Lock()

# DXF $INSUNITS（组码 70）到米：CAD 图纸常以毫米为单位，不换算会被当成千米
_UNITS = {
    1: (0.0254, "英寸"), 2: (0.3048, "英尺"), 3: (1609.344, "英里"),
    4: (0.001, "毫米"), 5: (0.01, "厘米"), 6: (1.0, "米"),
    7: (1000.0, "千米"), 8: (2.54e-8, "微英寸"), 9: (2.54e-5, "密尔"),
    10: (0.9144, "码"), 11: (1e-10, "埃"), 12: (1e-9, "纳米"),
    13: (1e-6, "微米"), 14: (0.1, "分米"), 15: (10.0, "十米"),
    16: (100.0, "百米"),
}


def tool_path():
    """dwg2dxf 的位置：优先随程序一起发布的那个，其次 PATH。"""
    base = Path(sys.prefix) / "Library" / "bin"
    names = ("dwg2dxf.exe", "dwg2dxf") if os.name == "nt" else ("dwg2dxf",)
    for name in names:
        cand = base / name
        if cand.is_file():
            return str(cand)
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def available():
    return tool_path() is not None


def _cleanup(paths=None):
    """退出时（或条目超限时）删掉自己建的 DXF 临时目录；失败也清。"""
    for folder in list(_TEMP_DIRS if paths is None else paths):
        # 退出清理：文件被别的进程占用时删不掉，也不该在这里报错
        with contextlib.suppress(OSError):
            shutil.rmtree(folder, ignore_errors=True)  # pi-lens-ignore: unchecked-throwing-call-python
        _TEMP_DIRS.discard(folder)


atexit.register(_cleanup)


def _key(dwg_path):
    try:
        st = os.stat(dwg_path)
    except OSError:
        return None
    try:
        mtime = int(st.st_mtime)
    except (TypeError, ValueError, OverflowError):
        return None
    return (os.path.abspath(dwg_path), mtime, st.st_size)


def status(dwg_path):
    """给界面轮询：这份 DWG 现在是否在转、已经转了多少秒。"""
    key = _key(dwg_path)
    if key is None:
        return {"running": False, "elapsed": 0.0}
    with _PROC_LOCK:
        hit = _PROCS.get(key)
    if not hit:
        return {"running": False, "elapsed": 0.0}
    return {"running": True, "elapsed": round(time.time() - hit[1], 1),
            "target": hit[2]}


def cancel(dwg_path):
    """取消正在进行的转换；没有在转也返回 True（幂等）。"""
    key = _key(dwg_path)
    if key is None:
        return False
    with _PROC_LOCK:
        hit = _PROCS.get(key)
        if hit:
            _CANCELLED.add(key)
            with contextlib.suppress(OSError):
                hit[0].kill()
    return True


def convert(dwg_path):
    """转成临时 DXF，返回路径；转不出来/被取消返回 None。"""
    tool = tool_path()
    if not tool:
        return None
    # 记账的键带上修改时间和大小：文件改过就重新转，没改过直接拿上次的
    key = _key(dwg_path)
    if key is None:
        return None
    hit = _CONVERTED.get(key)
    if hit and os.path.isfile(hit):
        _CONVERTED.move_to_end(key)
        return hit
    stem = Path(str(dwg_path).replace("\\", "/")).stem
    folder = tempfile.mkdtemp(prefix="gisviewer-dwg-")
    _TEMP_DIRS.add(folder)
    target = os.path.join(folder, stem + ".dxf")
    proc = None
    try:
        proc = subprocess.Popen([tool, "-o", target, str(dwg_path)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with _PROC_LOCK:
            _PROCS[key] = (proc, time.time(), target)
        try:
            proc.communicate(timeout=_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
    except (OSError, subprocess.SubprocessError):
        _cleanup({folder})
        return None
    finally:
        with _PROC_LOCK:
            _PROCS.pop(key, None)
        cancelled = key in _CANCELLED
        _CANCELLED.discard(key)
    if cancelled:
        _cleanup({folder})
        return None
    if os.path.isfile(target) and os.path.getsize(target) > 0:
        out = target.replace("\\", "/")
        _CONVERTED[key] = out
        _CONVERTED.move_to_end(key)
        while len(_CONVERTED) > _MAX_CONVERTED:
            _old_key, old = _CONVERTED.popitem(last=False)
            _cleanup({os.path.dirname(old)})
        return out
    _cleanup({folder})
    return None


def version_label(dwg_path):
    """读文件头的版本标记，给人一句话说明这是哪一版 DWG。"""
    acd = {"AC1009": "AutoCAD R11/R12", "AC1012": "AutoCAD R13", "AC1014": "AutoCAD R14",
           "AC1015": "AutoCAD 2000/2002", "AC1018": "AutoCAD 2004~2006",
           "AC1021": "AutoCAD 2007~2009", "AC1024": "AutoCAD 2010~2012",
           "AC1027": "AutoCAD 2013~2017", "AC1032": "AutoCAD 2018 及以后"}
    try:
        with open(dwg_path, "rb") as fh:  # pi-lens-ignore: python-path-traversal -- 只读用户自己打开的图纸
            head = fh.read(16)
        for key in sorted(acd, reverse=True):
            if head.startswith(key.encode("ascii")):
                return acd[key]
    except OSError:
        return None
    return None


def insunits(path):
    """读 DXF/DWG 的 $INSUNITS，返回 (换算到米的系数, 中文单位)；读不到返回 None。

    DWG 先按需转成 DXF，再读文本头。只读前 256 KB：$INSUNITS 在 HEADER 段，
    不会藏在文件尾。DXF 的组码和值各占一行，逐行读比正则稳。
    """
    p = str(path or "")
    if p.lower().endswith(".dwg"):
        p = convert(p) or ""
    if not p:
        return None
    try:
        raw = Path(p).read_bytes()[:262144]
    except OSError:
        return None
    lines = [ln.strip() for ln in raw.decode("utf-8", "ignore").splitlines()]
    for i, line in enumerate(lines):
        if line != "$INSUNITS":
            continue
        if i + 2 < len(lines) and lines[i + 1] == "70":
            try:
                return _UNITS.get(int(lines[i + 2]))
            except ValueError:
                return None
        return None
    return None
