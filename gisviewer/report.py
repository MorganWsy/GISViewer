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
from . import verdict
from . import xlsx

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
                # .gdb / .zarr 本身就是一份数据：整份收下，不再钻进去把内部表当成散文件
                descend = []
                for d in dirs:
                    if d.startswith("."):
                        continue
                    if d.lower().endswith((".gdb", ".zarr")):
                        hits.append(os.path.join(root, d))
                        continue
                    descend.append(d)
                dirs[:] = descend
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


def build(results, with_verdict=False):
    """报告外壳：比结果本身多一层，对比时认版本、认时间。

    with_verdict 给诊断包用：包里那份 json 要能自己说清结论，不能只有一堆元数据
    等人去推。存成"上次报告"时不要——对比只看元数据，结论由 compare 现算。
    """
    files = [jsonable(r) for r in results]
    if with_verdict:
        for item, raw in zip(files, results):
            if isinstance(item, dict):
                item["verdict"] = jsonable(verdict.judge(raw))
    return {
        "app": "图览 " + __version__,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "files": files,
    }


def norm(path):
    return str(path or "").replace("\\", "/").casefold()


def clean_text(text):
    """把代理字符还原成原来的字节，再按 UTF-8 容错解码。

    有些驱动（MapInfo 的 .tab/.mif 之类）把中文元数据按本地代码页原样吐回来，
    Python 用代理字符记着那串字节。这种字符串写不进 UTF-8，写报告和回接口时
    都会抛 UnicodeEncodeError，一次就把整份结果带崩。坏字节换成替换符，其余照常。
    """
    return str(text).encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def save(report, path):
    text = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write(clean_text(text))
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


def diagnostic_note():
    """诊断包里的说明文件：用法 + 环境信息合在一份里，包里不再单放一个环境.txt。"""
    env = [line for line in environment_text().splitlines() if line.strip()]
    # 每段写成一整行，不手工折行：md 会被各种阅读器按自己的宽度重排，
    # 这里再断一次只会把句子切在两处
    lines = [
        "# 图览诊断包",
        "",
        "这个包用来排查“某个数据为什么读不出来、读出来为什么不对”。包里不含任何源数据，只有三份内容：本说明文件、体检结果.json、体检结果.xlsx。",
        "",
        "## 体检结果.json",
        "",
        "图览打开这些文件时读到的元数据（格式、图层、坐标系、范围、要素数、字段表、栅格波段与像元信息），以及每条体检结论。不包含几何、像元值和属性表内容。",
        "",
        "## 体检结果.xlsx",
        "",
        "和上面那份 json 是同一份结果，换个摆法给人看：概览、文件清单、体检明细三张表，后两张表头带筛选，按结论或按检查项目分堆看。不想开 json 的话，只看这张表就够。",
        "",
        "## 环境",
        "",
    ]
    lines.extend(env)
    lines.extend([
        "",
        "## 反馈方式",
        "",
        "把整个 zip 原样发给我们，并附一句话说明当时在做什么、期望看到什么。",
        "",
    ])
    return "\n".join(lines)


def check_workbook(results):
    """把体检结果摊成三张表：概览、文件清单、体检明细。

    xlsx 和 json 出自同一次计算，一份给程序读、一份给人看。用表格而不是纯文本，
    是因为几百个数据里"哪些没过"要能按列筛：Excel 里点一下表头就够了，
    而在一屏流水账里找红字，找着找着就漏了。
    """
    files = []
    for raw in results:
        said = verdict.judge(raw)
        f = raw.get("file") or {}
        path = f.get("path") or raw.get("input") or ""
        files.append({
            "name": f.get("name") or os.path.basename(str(path)) or "（未命名）",
            "path": str(path),
            "level": said["level"],
            "facts": " · ".join(verdict.facts(raw)),
            "rows": said.get("rows") or [],
            "items": said.get("items") or [],
        })
    counts = {"bad": 0, "warn": 0, "ok": 0}
    for f in files:
        counts[f["level"]] = counts.get(f["level"], 0) + 1

    overview = [
        [("图览版本", xlsx.BOLD), (__version__, xlsx.TEXT)],
        [("生成时间", xlsx.BOLD), (time.strftime("%Y-%m-%d %H:%M:%S"), xlsx.TEXT)],
        [("体检文件数", xlsx.BOLD), (len(files), xlsx.TEXT)],
        [("有问题", xlsx.BOLD), (counts["bad"], xlsx.TEXT)],
        [("要留意", xlsx.BOLD), (counts["warn"], xlsx.TEXT)],
        [("没发现问题", xlsx.BOLD), (counts["ok"], xlsx.TEXT)],
        [("结论分档", xlsx.BOLD),
         ("有问题：打开或使用会出错，需要处理；要留意：能用，但某些地方不理想；"
          "没发现问题：逐项核对都通过了。", xlsx.TEXT)],
        [("怎么看", xlsx.BOLD),
         ("“体检明细”一个数据占若干行，一行是一个检查项目，表头带筛选——按结论或按项目"
          "分堆看最快。“文件清单”一个数据一行，适合整体过一遍。同一个包里的 "
          "体检结果.json 是同一份数据的原始版本，供程序读取。", xlsx.TEXT)],
    ]

    listing = [[("序号", xlsx.HEAD), ("文件名", xlsx.HEAD), ("结论", xlsx.HEAD),
                ("格式与规模", xlsx.HEAD), ("路径", xlsx.HEAD)]]
    for i, f in enumerate(files, start=1):
        listing.append([(i, xlsx.NUM), (f["name"], xlsx.BOLD),
                        (verdict.LEVEL_LABEL.get(f["level"], ""), xlsx.NUM),
                        (f["facts"], xlsx.TEXT), (f["path"], xlsx.DIM)])

    detail = [[("序号", xlsx.HEAD), ("文件名", xlsx.HEAD), ("检查项目", xlsx.HEAD),
               ("结果", xlsx.HEAD), ("结论", xlsx.HEAD), ("说明", xlsx.HEAD),
               ("建议", xlsx.HEAD)]]
    for i, f in enumerate(files, start=1):
        rows = f["rows"] or [dict(it, label=it.get("cat_label") or "体检") for it in f["items"]]
        for row in rows:
            detail.append([(i, xlsx.NUM), (f["name"], xlsx.TEXT),
                           (row.get("label") or "", xlsx.TEXT),
                           (verdict.LEVEL_LABEL.get(row.get("level"), ""), xlsx.NUM),
                           (row.get("title") or "", xlsx.TEXT),
                           (row.get("detail") or "", xlsx.TEXT),
                           (row.get("hint") or "", xlsx.DIM)])

    return xlsx.build([
        {"name": "概览", "cols": [14, 82], "rows": overview},
        {"name": "文件清单", "cols": [6, 40, 10, 34, 62], "rows": listing,
         "head": 1, "filter": True},
        {"name": "体检明细", "cols": [6, 30, 10, 9, 34, 44, 40], "rows": detail,
         "head": 1, "filter": True},
    ])


def write_zip(results, zip_path):
    """诊断包：结论 json + 体检表 xlsx + 说明（环境信息并进说明里）。
    日志不打包（引擎不落日志文件）。

    json 和 xlsx 同时给：两者都只是这份结果的另一种摆法，加起来不到几十 KB，
    用户要发给别人看就发 xlsx，要自己排查就开 json，不必先选一次格式。
    """
    payload = json.dumps(jsonable(build(results, with_verdict=True)), ensure_ascii=False,
                         indent=2, default=str)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("体检结果.json", clean_text(payload))
        z.writestr("体检结果.xlsx", check_workbook(results))
        z.writestr("说明.md", diagnostic_note())
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
