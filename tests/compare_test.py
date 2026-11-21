"""两份文件对比的回归。

对比功能只读两侧、不改任何文件，所以这里的断言集中在"结论对不对"上：
同一份文件必须逐项一致；改过一个字段类型的副本必须报出那处差异；
矢量对影像必须明确拒绝；顶点总数与要素个数要能对上。

用 app/runtime 那套解释器跑：
    app/runtime/python.exe tests/compare_test.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

MIXED = ROOT / "tests" / "fixtures" / "mixed.geojson"
TIFF = ROOT / "tests" / "fixtures" / "multi_bands.tif"
TIFF2 = ROOT / "tests" / "fixtures" / "int16_uncompressed.tif"

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))


def rows_of(result):
    return {row["label"]: row for row in result["rows"]}


def mutated_copy(target: Path) -> Path:
    """把 mixed.geojson 抄一份，只把「分值」改成整数字段，别的一字不动。

    用来验证"字段类型变了"这件事能被字段对照抓到；文件大小与修改时间
    必然也跟着变，那几行本来就该标成差异。
    """
    data = json.loads(MIXED.read_text(encoding="utf-8"))
    for feature in data["features"]:
        props = feature.get("properties") or {}
        if isinstance(props.get("分值"), (int, float)):
            props["分值"] = int(props["分值"])
    target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return target


def main():
    from gisviewer import compare

    same = compare.compare(str(MIXED), str(MIXED))
    check("同一份文件：表头没有差异", same["diff"]["meta"] == 0, same["summary"])
    check("同一份文件：字段没有差异", same["diff"]["fields"] == 0)
    check("同一份文件：属性没有差异", same["diff"]["sample_rows"] == 0)
    check("同一份文件：结论说明一致", "一致" in same["summary"], same["summary"])
    meta = rows_of(same)
    check("表头有 12 行", len(same["rows"]) == 12, str(len(same["rows"])))
    check("几何类型写在表头里", "几何类型" in meta)
    check("顶点总数写在表头里", int(meta.get("顶点总数", {}).get("a") or 0) == 8,
          str(meta.get("顶点总数")))
    check("要素个数写在表头里", int(meta.get("要素个数", {}).get("a") or 0) == 4,
          str(meta.get("要素个数")))

    with tempfile.TemporaryDirectory() as tmp:
        changed = mutated_copy(Path(tmp) / "mixed_int.geojson")
        diff = compare.compare(str(MIXED), str(changed))
        check("改过字段类型：报出字段差异", diff["diff"]["fields"] >= 1,
              str(diff["diff"]))
        check("改过字段类型：结论里提到字段", "字段" in diff["summary"], diff["summary"])
        names = [c["name"] for c in diff["fields"]["changed"]]
        check("改过字段类型：差异落在「分值」上", "分值" in names, str(names))
        check("改过字段类型：属性值跟着变了", diff["diff"]["sample_rows"] >= 1,
              str(diff["diff"]))

    raster = compare.compare(str(TIFF), str(TIFF))
    check("同一份影像：表头一致", raster["diff"]["meta"] == 0, raster["summary"])
    check("同一份影像：带波段信息", "波段数" in rows_of(raster), str(list(rows_of(raster))))
    check("同一份影像：不列属性段", raster["sample"]["rows_compared"] == 0)

    other = compare.compare(str(TIFF), str(TIFF2))
    check("两份影像：报出差异", other["diff"]["meta"] >= 1, other["summary"])

    try:
        compare.compare(str(MIXED), str(TIFF))
        check("矢量对影像：拒绝", False)
    except compare.CompareError as exc:
        check("矢量对影像：拒绝", "同一类" in exc.title, exc.title)

    try:
        compare.compare(str(MIXED), str(ROOT / "tests" / "fixtures" / "没有这个.geojson"))
        check("文件不存在：拒绝", False)
    except compare.CompareError as exc:
        check("文件不存在：拒绝", "找不" in exc.title, exc.title)

    # 顶点数必须 ≥ 要素数：面积数据一个面就有几十个顶点，这条能挡住"数错了"的实现
    counts = rows_of(same)
    verts = int(counts["顶点总数"]["a"])
    feats = int(counts["要素个数"]["a"])
    check("顶点数不少于要素数", verts >= feats, f"{verts} vs {feats}")

    failed = [c for c in CHECKS if not c[1]]
    for name, ok, detail in CHECKS:
        mark = "ok  " if ok else "FAIL"
        print(f"  {mark} {name}" + (f"  ({detail})" if detail and not ok else ""))
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
