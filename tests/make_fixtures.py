"""生成本地测试样例，覆盖 samples 里没有到的分支。可重复执行。

用法：conda run -n gisviewer --no-capture-output python tests/make_fixtures.py
"""

import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gisviewer import bootstrap  # noqa: E402

gdal = bootstrap.gdal
osr = bootstrap.osr

FIXTURES = Path(__file__).resolve().parent / "fixtures"
# 样例数据在源码树之外（见 PLAN §11），换位置时用 TULAN_DATA 指过去
DATA = Path(os.environ.get("TULAN_DATA") or Path(__file__).resolve().parent.parent.parent / "GISViewer-data")
SAMPLES = DATA / "samples"


def _array(shape, dtype, seed=7):
    import numpy as np

    rng = np.random.default_rng(seed)
    return rng.integers(0, 60000, size=shape).astype(dtype)


def _write_tif(name, data, epsg, dtype_code, options=None, nodata=None,
               color=None, ulr=(115.0, 29.5, 114.4, 28.8), gt=None, build_overviews=False):
    path = FIXTURES / name
    if path.exists():
        path.unlink()
    bands = 1 if data.ndim == 2 else data.shape[0]
    h, w = data.shape[-2:]
    drv = gdal.GetDriverByName("GTiff")
    ds = drv.Create(str(path), w, h, bands, dtype_code, options=options or [])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(epsg)
    ds.SetProjection(srs.ExportToWkt())
    ds.SetGeoTransform(gt or [ulr[0], (ulr[0] - ulr[2]) / w, 0, ulr[1], 0, -(ulr[1] - ulr[3]) / h])
    for i in range(bands):
        band = ds.GetRasterBand(i + 1)
        band.WriteArray(data[i] if data.ndim == 3 else data)
        if nodata is not None:
            band.SetNoDataValue(nodata)
        if color:
            band.SetColorInterpretation(color[i])
    ds.FlushCache()
    if build_overviews:
        ds.BuildOverviews("AVERAGE", [2, 4, 8])
    del ds
    return path


def make_rasters():
    import numpy as np

    made = []
    rgb = _array((3, 400, 600), np.uint16)
    made.append(_write_tif(
        "rgb_uint16_deflate.tif", rgb, 4326, gdal.GDT_UInt16,
        options=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=2", "BLOCKXSIZE=256", "BLOCKYSIZE=256"],
        nodata=0, color=[gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand],
        build_overviews=True))

    gray = _array((300, 500), np.int16, seed=11)
    made.append(_write_tif("int16_uncompressed.tif", gray, 32650, gdal.GDT_Int16,
                           options=["COMPRESS=NONE"], gt=[400000, 30, 0, 3400000, 0, -30]))

    floating = _array((200, 200), np.float32, seed=13).astype(np.float32) / 100.0
    floating[5:40, 5:40] = np.nan
    path = FIXTURES / "nan_float.tif"
    if path.exists():
        path.unlink()
    ds = gdal.GetDriverByName("GTiff").Create(str(path), 200, 200, 1, gdal.GDT_Float32,
                                              options=["COMPRESS=LZW"])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    ds.SetProjection(srs.ExportToWkt())
    ds.SetGeoTransform([114.4, 0.005, 0, 29.5, 0, -0.005])
    band = ds.GetRasterBand(1)
    band.SetNoDataValue(float("nan"))
    band.WriteArray(floating)
    band.SetStatistics(float(np.nanmin(floating)), float(np.nanmax(floating)),
                       float(np.nanmean(floating)), float(np.nanstd(floating)))
    ds.FlushCache()
    del ds
    made.append(path)

    envi = _array((1, 120, 160), np.uint8, seed=17)
    path = FIXTURES / "palette_byte.tif"
    if path.exists():
        path.unlink()
    ds = gdal.GetDriverByName("GTiff").Create(str(path), 160, 120, 1, gdal.GDT_Byte,
                                             options=["COMPRESS=PACKBITS"])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32649)
    ds.SetProjection(srs.ExportToWkt())
    ds.SetGeoTransform([500000, 20, 0, 3500000, 0, -20])
    band = ds.GetRasterBand(1)
    band.WriteArray(envi[0])
    band.SetColorTable(_palette())
    band.SetCategoryNames(["", "水田", "林地", "草地", "建设用地"])
    del ds
    made.append(path)
    return made


def _palette():
    ct = gdal.ColorTable()
    for i in range(256):
        ct.SetColorEntry(i, (i, 255 - i, 64, 255))
    return ct


def make_shapefile_without_prj():
    out = FIXTURES / "no_prj"
    out.mkdir(exist_ok=True)
    src = SAMPLES / "China2019.zip"
    if not src.exists():
        return []
    made = []
    with zipfile.ZipFile(src) as zf:
        for member in zf.infolist():
            if member.filename.lower().endswith((".shp", ".shx", ".dbf")):
                target = out / Path(member.filename).name
                with open(target, "wb") as fh:
                    fh.write(zf.read(member))
                made.append(target)
    return made


def make_vector_conversions():
    made = []
    base = FIXTURES / "no_prj" / "China2019.shp"
    if not base.exists():
        return made
    jobs = [
        (["-f", "GPKG", str(FIXTURES / "two_layer.gpkg"), str(base), "China2019"], "GPKG 单层"),
        (["-f", "KML", str(FIXTURES / "china.kml"), str(base), "China2019"], "KML"),
        (["-f", "GeoJSON", "-lco", "COORDINATE_PRECISION=5",
          str(FIXTURES / "china_small.geojson"), str(base), "China2019"], "GeoJSON 小样"),
    ]
    for args, _desc in jobs:
        target = args[2]
        if os.path.exists(target):
            os.unlink(target)
        try:
            subprocess.run(["ogr2ogr"] + args, check=True, capture_output=True)
            made.append(Path(target))
        except Exception as exc:
            print(f"  跳过 {target}: {exc}")
    gpkg = FIXTURES / "two_layer.gpkg"
    if gpkg.exists():
        # 再加一个图层，造出多图层容器
        subprocess.run(["ogr2ogr", "-update", "-append", str(gpkg), str(base), "-nln", "省界副本"],
                       check=False, capture_output=True)
        made.append(gpkg)
    return made


def make_mixed_geojson():
    path = FIXTURES / "mixed.geojson"
    data = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [
            {"type": "Feature", "properties": {"名称": "观察点", "分值": 12.5},
             "geometry": {"type": "Point", "coordinates": [115.09, 29.12]}},
            {"type": "Feature", "properties": {"名称": "河流", "分值": 3.25},
             "geometry": {"type": "LineString", "coordinates": [[115.0, 29.1], [115.2, 29.2]]}},
            {"type": "Feature", "properties": {"名称": "保护区", "分值": None},
             "geometry": {"type": "Polygon", "coordinates": [
                 [[115.05, 29.05], [115.15, 29.05], [115.15, 29.15], [115.05, 29.15], [115.05, 29.05]]]}},
            {"type": "Feature", "properties": {"名称": "无几何记录", "分值": 0}, "geometry": None},
        ],
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return [path]


def make_plain_json():
    path = FIXTURES / "config_plain.json"
    payload = {
        "project": "武宁生态系统核算",
        "year": 2021,
        "layers": ["水源涵养", "土壤保持", "固碳", "雨洪调蓄"],
        "limits": {"max": 1.0, "min": 0.0},
        "records": [{"id": 1, "value": 3.5}, {"id": 2, "value": 8.1}],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return [path]


def make_broken():
    src = SAMPLES / "pre_2000_01.tif"
    out = FIXTURES / "truncated.tif"
    if not src.exists():
        return []
    with open(src, "rb") as fh, open(out, "wb") as dst:
        dst.write(fh.read(200_000))
    return [out]


def make_multivar_nc():
    path = FIXTURES / "multi_var.nc"
    if path.exists():
        return [path]
    try:
        from netCDF4 import Dataset as NC
    except Exception:
        print("  跳过 netCDF 多变量样例：本环境没有 netCDF4 库，请用带 netCDF4 的解释器单独生成")
        return []
    import numpy as np

    nc = NC(str(path), "w", format="NETCDF4")
    nc.createDimension("lat", 60)
    nc.createDimension("lon", 80)
    for name, unit in (("precipitation", "mm"), ("temperature", "K")):
        var = nc.createVariable(name, "f4", ("lat", "lon"))
        var.units = unit
        var[:] = np.arange(60 * 80, dtype="f4").reshape(60, 80) / 100
    nc.close()
    return [path]


def make_big_sparse_tif():
    """2.25 亿像元的稀疏栅格，用来压测降采样估算这条分支。"""
    import numpy as np

    path = FIXTURES / "big_sparse.tif"
    if path.exists():
        return [path]
    size = 15000
    ds = gdal.GetDriverByName("GTiff").Create(str(path), size, size, 1, gdal.GDT_Byte,
                                              options=["COMPRESS=LZW", "TILED=YES"])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    ds.SetProjection(srs.ExportToWkt())
    ds.SetGeoTransform([114.4, 0.0001, 0, 29.6, 0, -0.0001])
    blank = np.zeros((1000, size), dtype=np.uint8)
    for row in range(size // 1000):
        ds.GetRasterBand(1).WriteArray(blank, 0, row * 1000)
    ds.FlushCache()
    del ds
    return [path]


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    made = []
    for step in (make_rasters, make_shapefile_without_prj, make_vector_conversions,
                 make_mixed_geojson, make_plain_json, make_broken, make_multivar_nc,
                 make_big_sparse_tif):
        try:
            made += step() or []
        except Exception as exc:
            print(f"  {step.__name__} 失败：{type(exc).__name__} {exc}")
    print(f"已生成 {len(made)} 个文件，位于 {FIXTURES}")
    for p in made:
        try:
            print(f"  {p.name:<28} {p.stat().st_size / 1024:>9,.1f} KB")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
