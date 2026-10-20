"""体检报告的落盘与打包：命令行（--out/--diff/--diagnose）和界面共用这一份。

界面要和命令行做到一样的事，代码上就必须是同一个实现，否则两边会慢慢跑偏：
这里管三件事——展开文件夹、把结果存成报告（供以后对比）、把结果和环境打成诊断包。
"""

import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

from . import __version__
from . import inspect as engine

SKIP_EXT = {".hdr", ".ovr", ".rrd"}    # 只是配件，不单独体检
DIR_LIMIT = 500                        # 一个文件夹最多体检这么多，超了先给前 500 个


def expand_paths(paths, limit=DIR_LIMIT):
    """把普通文件夹展开成里面的数据文件；.gdb / .zarr 这类目录本身就是一份数据。
    伴生文件按 is_primary 排掉，再排掉 .hdr / .ovr 这些只是配件的后缀。
    返回 (路径列表, 是否被上限截断)——截断了要告诉用户，不然他会以为就这么多。"""
    out = []
    truncated = False
    for raw in paths:
        low = str(raw).lower().rstrip("/\\")
        if os.path.isdir(raw) and not low.endswith((".gdb", ".zarr")):
            hits = []
            for root, dirs, names in os.walk(raw):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for name in sorted(names):
                    full = os.path.join(root, name)
                    if name.startswith(".") or os.path.splitext(name)[1].lower() in SKIP_EXT:
                        continue
                    if engine.is_primary(full):
                        hits.append(full)
                if len(hits) >= limit:
                    break
            if len(hits) >= limit:
                truncated = True
            out.extend(hits[:limit])
        else:
            out.append(raw)
    return out, truncated


def jsonable(obj):
    """清掉 NaN 和无穷，保证输出能被任何 JSON 解析器读。"""
    if isinstance(obj, dict):
        return {k: jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, float) and (obj != obj or obj in (float("inf"), float("-inf"))):
        return None
    return obj


def build(results):
    """报告外壳：比结果本身多一层，对比时认版本、认时间。"""
    return {
        "app": "图览 " + __version__,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "files": [jsonable(r) for r in results],
    }


def norm(path):
    return str(path or "").replace("\\", "/").casefold()


def save(report, path):
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, default=str)
    return path


def load(path):
    """读一份报告的全文；文件不存在或坏了返回 None。"""
    try:
        with io.open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def load_by_path(path):
    """读一份以前存下的报告，按文件路径索引；文件坏了就当没有。"""
    data = load(path) or {}
    files = data.get("files") if isinstance(data, dict) else data
    out = {}
    for item in files or []:
        if isinstance(item, dict) and item.get("file"):
            out[norm(item["file"].get("path"))] = item
    return out


def environment_text():
    """诊断包里的环境部分：出问题时这几行最先要看。"""
    import platform
    rows = [("图览版本", __version__), ("操作系统", platform.platform()),
            ("Python", sys.version.split()[0])]
    try:
        from osgeo import gdal, osr
        rows.append(("GDAL", gdal.VersionInfo("RELEASE_NAME")))
        rows.append(("PROJ", "%d.%d.%d" % (osr.GetPROJVersionMajor(),
                                          osr.GetPROJVersionMinor(),
                                          osr.GetPROJVersionMicro())))
        rows.append(("GDAL 数据目录", gdal.GetConfigOption("GDAL_DATA") or ""))
        rows.append(("PROJ 数据目录", ";".join(osr.GetPROJSearchPaths() or [])))
    except Exception as exc:
        rows.append(("GDAL", f"读不到：{exc}"))
    try:
        from . import cache
        st = cache.stats()
        rows.append(("缓存目录", str(st.get("path") or "")))
        rows.append(("缓存占用", str(st.get("size_label") or "")))
    except Exception:
        pass
    return "".join(f"{k}：{v}\n" for k, v in rows if v)


def write_zip(results, zip_path):
    """诊断包：环境 + 完整结果 + 一句说明。日志不打包（引擎不落日志文件）。"""
    payload = json.dumps(jsonable(build(results)), ensure_ascii=False, indent=2, default=str)
    note = ("这个包里没有源数据，只有环境信息和图览读到的结果。\n"
            "反馈问题时把整个 zip 发过来即可，里面不含你的文件内容。\n")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("环境.txt", environment_text())
        z.writestr("体检结果.json", payload)
        z.writestr("说明.txt", note)
    return zip_path


def default_zip_name():
    return "图览诊断包-%s.zip" % time.strftime("%Y%m%d-%H%M%S")


def write_zip_at(results, folder):
    """把诊断包放到指定文件夹；文件夹是 None 就返回 None。"""
    if not folder:
        return None
    try:
        Path(folder).mkdir(parents=True, exist_ok=True)
        return write_zip(results, os.path.join(folder, default_zip_name()))
    except OSError:
        return None
