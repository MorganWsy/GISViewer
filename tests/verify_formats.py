"""格式验证：对 samples/formats 里的每个样例跑一遍 safe_inspect，输出支持情况表。

用法：D:/GISViewer/dist/runtime/python.exe tests/verify_formats.py
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("TULAN_DATA", str(ROOT / "data"))

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
            extra = f"{info.get('width', 0)}x{info.get('height', 0)}x{info.get('band_count', 0)}"
        elif kind == "vector":
            extra = f"{layers} 层 {sum(x.get('feature_count') or 0 for x in info.get('layers') or [])} 要素"
    except Exception as exc:
        ok, kind, driver, extra = False, "-", "-", str(exc)[:60]
    rows.append((p.name, ok, kind, driver, extra, (time.perf_counter() - t) * 1000))

print(f"{'样例':<24} {'结果':<6} {'种类':<10} {'驱动':<14} {'规模':<22} {'耗时':>8}")
bad = 0
for name, ok, kind, driver, extra, ms in rows:
    print(f"{name:<24} {'PASS' if ok else 'FAIL':<6} {kind:<10} {driver:<14} {extra:<22} {ms:>6.0f} ms")
    if not ok:
        bad += 1
print(f"\n共 {len(rows)} 个：通过 {len(rows) - bad}，失败 {bad}")
sys.exit(0)
