"""色带：自动挑选、按名字识别、界面指定与非法回退。

手工跑：app\\runtime\\python.exe tests\\ramp_test.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.transform import from_bounds  # noqa: E402

from gisviewer import cache, formats, raster, server  # noqa: E402

CHECKS: list[str] = []
FAILED: list[str] = []
WORK = Path(tempfile.mkdtemp(prefix="tulan-ramp-"))


def check(name: str, ok: bool, detail: str = "") -> None:
    (CHECKS if ok else FAILED).append(f"{name}{(' — ' + detail) if detail else ''}")
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))


def make(name: str, data, *, colormap=None):
    """造一张小栅格：EPSG:4326，值就是传进来的数组。"""
    path = WORK / name
    array = np.asarray(data)
    profile = {
        "driver": "GTiff",
        "width": array.shape[1],
        "height": array.shape[0],
        "count": 1,
        "dtype": str(array.dtype),
        "crs": "EPSG:4326",
        "transform": from_bounds(100.0, 20.0, 104.0, 24.0, array.shape[1], array.shape[0]),
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(array, 1)
        if colormap:
            dst.write_colormap(1, colormap)
    return path


def ramp_of(path):
    info = raster.inspect(path)
    return info.get("ramp") or {}


def hex_of(color) -> str:
    """把 (r, g, b) 与 "#1e502d" 两种写法归成小写十六进制。"""
    if isinstance(color, str):
        return color.lower()
    r, g, b = (int(v) for v in color[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def main() -> int:
    rng = np.random.default_rng(7)

    check("色带数量 ≥ 26", len(formats.RAMPS) >= 26, f"{len(formats.RAMPS)} 套")
    missing = [k for k in formats.RAMPS if k not in formats.RAMP_LABEL_EN]
    check("英文名覆盖全部色带", not missing, ",".join(missing))

    ndvi = make("NDVI_2020_07.tif", rng.random((64, 64)).astype("float32"))
    check("按名字认 NDVI", ramp_of(ndvi).get("ramp") == "ndvi", str(ramp_of(ndvi)))

    precip = make("precip_2020.tif", rng.random((64, 64)).astype("float32"))
    check("按名字认降水", ramp_of(precip).get("ramp") == "precip")

    night = make("night_lights.tif", rng.random((64, 64)).astype("float32"))
    check("按名字认夜间灯光", ramp_of(night).get("ramp") == "night")

    dem = make("DEM_30m.tif", (rng.random((64, 64)) * 900).astype("float32"))
    check("按名字认高程", ramp_of(dem).get("ramp") == "terrain")

    slope = make("slope_2020.tif", (rng.random((64, 64)) * 30).astype("float32"))
    check("按名字认坡度", ramp_of(slope).get("ramp") == "slope")

    land = make("landuse.tif", (rng.random((64, 64)) * 100).astype("float32"))
    check("按名字认地表覆盖", ramp_of(land).get("ramp") == "tab10")

    plain = make("random_field.tif", rng.random((64, 64)).astype("float32"))
    got = ramp_of(plain)
    check("认不出的走默认色带", got.get("ramp") == formats.RAMP_DEFAULT and got.get("basis") == "default", str(got))

    # 自带调色板：分类图优先用定性色带
    palette = {i: ((i * 40) % 256, (255 - i * 30) % 256, (i * 70) % 256, 255) for i in range(6)}
    table = make("paletted.tif", (rng.integers(0, 6, (64, 64))).astype("uint8"), colormap=palette)
    got = ramp_of(table)
    check("有调色板当分类数据", got.get("ramp") == "set1" and got.get("basis") == "colortable", str(got))

    # 整型且取值很少：当分类数据；取值多就换十色
    few = make("few_values.tif", (rng.integers(1, 6, (64, 64))).astype("uint8"))
    got = ramp_of(few)
    check("整型少取值当分类数据", got.get("ramp") == "set1" and got.get("basis") == "values", str(got))

    many = make("many_values.tif", (rng.integers(1, 13, (64, 64))).astype("uint8"))
    check("整型十二类用十色", ramp_of(many).get("ramp") == "tab10")

    # classify 用的是指定色带的颜色
    info = raster.inspect(dem)
    hist = raster.band_histogram(dem, 1, info["height"], info["width"], info["bands"][0]["type"],
                                 nodata=None)
    a = raster.classify(hist, 5, "terrain")
    b = raster.classify(hist, 5, "viridis")
    ca = cb = None
    if a and b:
        ac = a.get("classes") or []
        bc = b.get("classes") or []
        if ac and bc:
            ca = ac[0].get("color")
            cb = bc[0].get("color")
    ok = bool(ca) and ca != cb and hex_of(ca) == hex_of(formats.RAMPS["terrain"][0])
    check("分级上色用指定色带", ok)

    # 界面指定色带：生效并回显
    got = server.band_stats_and_hist(dem, info, 1, ramp="terrain")
    check("请求带 ramp 时按它上色", got.get("ramp") == "terrain")
    bad = server.band_stats_and_hist(dem, info, 1, ramp="nope")
    check("色带名写错回退默认", bad.get("ramp") == formats.RAMP_DEFAULT, str(bad.get("ramp")))

    # 缓存包装也要带上色带
    cache.init(WORK / "cache")
    got = server.cached_band_stats(dem, info, 1, ramp="inferno")
    check("缓存接口沿用指定色带", got.get("ramp") == "inferno")
    again = server.cached_band_stats(dem, info, 1, ramp="inferno")
    check("同一色带第二次命中缓存", bool(again.get("cached")), str(again.get("cached")))

    print(f"\n{len(CHECKS)} checks passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print("  FAILED " + name)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
