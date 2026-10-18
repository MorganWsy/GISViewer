"""新版 DWG 的读取兜底：GDAL 自带的 CAD 驱动只到 AutoCAD 2000，
遇到更新的版本就用 libredwg 的 dwg2dxf 先转成 DXF，再走正常读取。"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_TIMEOUT = 180

# 同一份 DWG 没改过就只转一次：打开文件、画图层、点选各处的转换结果共用一份，
# 不然每取一次要素就多转一遍、临时目录也会越积越多
_CONVERTED = {}


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


def convert(dwg_path):
    """转成临时 DXF，返回路径；转不出来返回 None。"""
    tool = tool_path()
    if not tool:
        return None
    # 记账的键带上修改时间和大小：文件改过就重新转，没改过直接拿上次的
    try:
        st = os.stat(dwg_path)
        key = (os.path.abspath(dwg_path), int(st.st_mtime), st.st_size)
    except OSError:
        return None
    hit = _CONVERTED.get(key)
    if hit and os.path.isfile(hit):
        return hit
    stem = Path(str(dwg_path).replace("\\", "/")).stem
    folder = tempfile.mkdtemp(prefix="gisviewer-dwg-")
    target = os.path.join(folder, stem + ".dxf")
    try:
        subprocess.run([tool, "-o", target, str(dwg_path)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if os.path.isfile(target) and os.path.getsize(target) > 0:
        out = target.replace("\\", "/")
        _CONVERTED[key] = out
        return out
    return None


def version_label(dwg_path):
    """读文件头的版本标记，给人一句话说明这是哪一版 DWG。"""
    acd = {"AC1009": "AutoCAD R11/R12", "AC1012": "AutoCAD R13", "AC1014": "AutoCAD R14",
           "AC1015": "AutoCAD 2000/2002", "AC1018": "AutoCAD 2004~2006",
           "AC1021": "AutoCAD 2007~2009", "AC1024": "AutoCAD 2010~2012",
           "AC1027": "AutoCAD 2013~2017", "AC1032": "AutoCAD 2018 及以后"}
    try:
        with open(dwg_path, "rb") as fh:
            head = fh.read(16)
        for key in sorted(acd, reverse=True):
            if head.startswith(key.encode("ascii")):
                return acd[key]
    except OSError:
        return None
    return None
