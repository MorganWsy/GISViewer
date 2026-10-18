"""格式验证：对 samples/formats 里的每个样例跑一遍 safe_inspect，输出支持情况表。

用法：D:/GISViewer/dist/runtime/python.exe tests/verify_formats.py
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("TULAN_DATA", str(ROOT.parent / "GISViewer-data"))

DATA = Path(os.environ["TULAN_DATA"]) / "samples" / "formats"
SKIP_SUFFIX = {".prj", ".dat", ".id", ".map", ".xsd", ".mid", ".hdr"}

from gisviewer import safe_inspect  # noqa: E402

rows = []
for p in sorted(DATA.iterdir()):
    if not p.is_file() or p.suffix.lower() in SKIP_SUFFIX or p.name.endswith(".aux.xml"):
        continue
    t = time.perf_counter()
    try:
        info = safe_inspect(str(p))
        ok = bool(info.get("ok"))
        kind = info.get("kind") or "-"
        driver = info.get("driver_label") or info.get("driver") or "-"
        layers = info.get("layer_count") or (len(info.get("layers") or []) if ok else 0)
        extra = ""
        if kind == "raster":
            b = (info.get("bands") or [{}])[0]
            extra = "%dx%dx%d" % (info.get("width", 0), info.get("height", 0), info.get("band_count", 0))
        elif kind == "vector":
            extra = "%s 层 %s 要素" % (layers, sum(x.get("feature_count") or 0 for x in info.get("layers") or []))
    except Exception as exc:
        ok, kind, driver, extra = False, "-", "-", str(exc)[:60]
    rows.append((p.name, ok, kind, driver, extra, (time.perf_counter() - t) * 1000))

print("%-24s %-6s %-10s %-14s %-22s %8s" % ("样例", "结果", "种类", "驱动", "规模", "耗时"))
bad = 0
for name, ok, kind, driver, extra, ms in rows:
    print("%-24s %-6s %-10s %-14s %-22s %6.0f ms" % (name, "PASS" if ok else "FAIL", kind, driver, extra, ms))
    if not ok:
        bad += 1
print("\n共 %d 个：通过 %d，失败 %d" % (len(rows), len(rows) - bad, bad))
sys.exit(0)
