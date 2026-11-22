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


def shuffled_copy(target: Path) -> Path:
    """把第一条要素挪到最后，并把「河流」的分值改掉。

    行号对齐会报"全都不同"，按字段配对只该报出一处：这一个要素被用来
    验证"配对方式真的换了比较口径"，而不是只换了个标题。
    """
    data = json.loads(MIXED.read_text(encoding="utf-8"))
    feats = data["features"]
    for feature in feats:
        props = feature.get("properties") or {}
        if props.get("名称") == "河流":
            props["分值"] = 9.9
    feats.append(feats.pop(0))
    target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return target


def extended_copy(target: Path) -> Path:
    """多一个要素：按字段配对时应该报"1 个键只在右边"。"""
    data = json.loads(MIXED.read_text(encoding="utf-8"))
    extra = json.loads(json.dumps(data["features"][0]))
    extra["properties"] = dict(extra["properties"] or {})
    extra["properties"]["名称"] = "只在新版里"
    data["features"].append(extra)
    target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return target


def projected_copy(target: Path) -> Path:
    """造一份投影坐标系的矢量（EPSG:3857，一栋 100 米见方的楼）。

    用来验证两件事：坐标系那行要写明"投影坐标系"，范围要换成左右上下。
    地理坐标系那份（mixed.geojson）走的是另一套标签，两边都能覆盖到。
    """
    from osgeo import ogr, osr

    drv = ogr.GetDriverByName("GPKG")
    ds = drv.CreateDataSource(str(target))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    lyr = ds.CreateLayer("building", srs, ogr.wkbPolygon)
    lyr.CreateField(ogr.FieldDefn("name", ogr.OFTString))
    feat = ogr.Feature(lyr.GetLayerDefn())
    feat.SetField("name", "building")
    feat.SetGeometry(ogr.CreateGeometryFromWkt(
        "POLYGON((12000000 3000000, 12000100 3000000, 12000100 3000100, "
        "12000000 3000100, 12000000 3000000))"))
    lyr.CreateFeature(feat)
    ds = None
    return target


def main():
    from gisviewer import compare

    same = compare.compare(str(MIXED), str(MIXED))
    check("同一份文件：表头没有差异", same["diff"]["meta"] == 0, same["summary"])
    check("同一份文件：字段没有差异", same["diff"]["fields"] == 0)
    check("同一份文件：属性没有差异", same["diff"]["sample_rows"] == 0)
    check("同一份文件：结论说明一致", "一致" in same["summary"], same["summary"])
    meta = rows_of(same)
    check("表头有 11 行", len(same["rows"]) == 11, str(len(same["rows"])))
    check("几何类型写在表头里", "几何类型" in meta)
    check("顶点总数写在表头里", int(meta.get("顶点总数", {}).get("a") or 0) == 8,
          str(meta.get("顶点总数")))
    check("要素个数写在表头里", int(meta.get("要素个数", {}).get("a") or 0) == 4,
          str(meta.get("要素个数")))
    box = meta.get("范围", {})
    check("范围带方向标签：地理坐标系用东南西北",
          box.get("a", "").startswith("(西 ") and "北 " in box.get("a", ""), box.get("a"))
    check("坐标系那行写明是地理坐标系",
          "地理坐标系" in meta.get("坐标系", {}).get("a", ""), meta.get("坐标系", {}).get("a"))

    with tempfile.TemporaryDirectory() as tmp:
        proj = projected_copy(Path(tmp) / "building.gpkg")
        info = compare.compare(str(proj), str(proj))
        rows = rows_of(info)
        check("坐标系那行写明是投影坐标系",
              "投影坐标系" in rows.get("坐标系", {}).get("a", ""),
              rows.get("坐标系", {}).get("a"))
        check("投影坐标系的范围用左右上下",
              rows.get("范围", {}).get("a", "").startswith("(左 "),
              rows.get("范围", {}).get("a"))

    only = compare.keys(str(MIXED), str(MIXED))
    check("只读字段名：给出共有字段", only["ready"] and "名称" in only["common"], str(only.get("common")))
    check("只读字段名：影像没有可配对字段", compare.keys(str(TIFF), str(TIFF))["ready"] is False)

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
    rbox = rows_of(raster).get("范围", {})
    # 这份影像是什么坐标系，标签就该是那一套：投影用左右上下，地理用东南西北
    side = compare._raster_side(str(TIFF))  # noqa: SLF001 - 测试要拿到这一侧自己的坐标系
    want = {"projected": ("左", "上"), "geographic": ("西", "北")}.get(side["crs_kind"], ())
    check("范围带方向标签与坐标系一致：投影左右上下，地理东南西北",
          bool(want) and rbox.get("a", "").startswith(f"({want[0]} ") and f"{want[1]} " in rbox.get("a", ""),
          f"{side['crs_kind']} / {rbox.get('a')}")

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

    with tempfile.TemporaryDirectory() as tmp:
        moved = shuffled_copy(Path(tmp) / "shuffled.geojson")
        by_row = compare.compare(str(MIXED), str(moved))
        by_key = compare.compare(str(MIXED), str(moved), key="名称")
        check("打乱顺序后按行号比：报出多处不同", by_row["diff"]["sample_rows"] >= 3,
              str(by_row["diff"]))
        check("打乱顺序后按字段比：只剩一处不同", by_key["diff"]["sample_rows"] == 1,
              str(by_key["diff"]))
        check("按字段比：配对方式写进结果", by_key["sample"]["mode"] == "key",
              str(by_key["sample"]["mode"]))
        check("按字段比：结论提到字段名", "名称" in by_key["summary"], by_key["summary"])
        check("按字段比：没有只在一边的键", by_key["diff"]["only_a"] == 0
              and by_key["diff"]["only_b"] == 0, str(by_key["diff"]))
        check("按字段比：选项列表里有这个字段", "名称" in by_key["sample"]["common_fields_list"],
              str(by_key["sample"]["common_fields_list"]))

        longer = extended_copy(Path(tmp) / "longer.geojson")
        grown = compare.compare(str(MIXED), str(longer), key="名称")
        check("按字段比：报出只在右边的键", grown["diff"]["only_b"] == 1, str(grown["diff"]))
        check("按字段比：结论提到只在一边", "只在一边" in grown["summary"], grown["summary"])

        try:
            compare.compare(str(MIXED), str(moved), key="没有这个字段")
            check("按字段比：字段不存在时拒绝", False)
        except compare.CompareError as exc:
            check("按字段比：字段不存在时拒绝", "字段" in exc.title, exc.title)

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
