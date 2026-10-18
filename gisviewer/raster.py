"""栅格元数据。压缩信息只在 dataset 级的 IMAGE_STRUCTURE 域里，不在波段级。"""

from . import bootstrap
from . import labels
from .crs import bounds_to_wgs84, describe, extent_warning, ring_to_wgs84, transform_points
from .formats import CLASS_DEFAULT, RAMPS, RAMP_DEFAULT

gdal = bootstrap.gdal
osr = bootstrap.osr

# 超过这个像元数就不做全图扫描，改用降采样估算
FULL_SCAN_LIMIT = 40_000_000
SAMPLE_TARGET_PIXELS = 3_000_000
# 直方图默认分箱数，和最多计算几个波段
HIST_BINS = 64
MAX_HIST_BANDS = 8
# 全图逐像元直方图的像元上限，超过就退回快速抽样
EXACT_HISTOGRAM_LIMIT = 400_000_000
# 点选识别最多读几个波段（默认分级数见 formats.CLASS_DEFAULT）
MAX_IDENTIFY_BANDS = 6


def _number(value, digits=6):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return round(f, digits)


def _clean(value):
    """无数据值这类读数：NaN 和无穷会让 JSON 失效，一律变 None。"""
    if value is None:
        return None
    if isinstance(value, int):
        return value
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f) if float(f).is_integer() and abs(f) < 1e15 else f


def _tif_flavor(real_path):
    """直接读文件头判断经典 TIFF 还是 BigTIFF，以及字节序。"""
    try:
        with open(real_path, "rb") as fh:
            head = fh.read(8)
    except OSError:
        return None
    if len(head) < 4 or head[:2] not in (b"II", b"MM"):
        return None
    little = head[:2] == b"II"
    order = "小端" if little else "大端"
    version = int.from_bytes(head[2:4], "little" if little else "big")
    kind = "BigTIFF" if version == 43 else ("经典 TIFF" if version == 42 else f"TIFF 版本 {version}")
    return {"byte_order": order, "flavor": kind}


def list_variables(sub):
    """netCDF/HDF 的变量清单，路径直接可以再次打开。键名是单数 SUBDATASET_i_*。"""
    out, idx = [], 1
    while f"SUBDATASET_{idx}_NAME" in sub:
        name = sub[f"SUBDATASET_{idx}_NAME"]
        desc = sub.get(f"SUBDATASET_{idx}_DESCRIPTION", "")
        out.append({"path": name, "label": desc or name.split(":")[-1]})
        idx += 1
    return out


def _stored_stats(band):
    md = band.GetMetadata() or {}
    got = {k[len("STATISTICS_"):]: v for k, v in md.items() if k.startswith("STATISTICS_")}
    if "MINIMUM" not in got or "MAXIMUM" not in got:
        return None
    approximate = str(got.get("APPROXIMATE", "")).upper() == "YES"

    def num(key, digits=8):
        return _number(got.get(key), digits)

    return {
        "minimum": num("MINIMUM"),
        "maximum": num("MAXIMUM"),
        "mean": num("MEAN"),
        "stddev": num("STDDEV"),
        "valid_percent": num("VALID_PERCENT", 2),
        "source": "approximate" if approximate else "file",
        "source_label": "文件内已有（近似值）" if approximate else "文件内已有",
    }


def _computed_stats(band):
    """让 GDAL 自己选：有金字塔就走金字塔，否则全图扫描。"""
    try:
        mn, mx, mean, sd = band.GetStatistics(1, 1)
    except Exception:
        return None
    has_overviews = band.GetOverviewCount() > 0
    return {
        "minimum": _number(mn, 8),
        "maximum": _number(mx, 8),
        "mean": _number(mean, 8),
        "stddev": _number(sd, 8),
        "valid_percent": None,
        "source": "overviews" if has_overviews else "full_scan",
        "source_label": "按金字塔快速计算" if has_overviews else "全图扫描计算",
    }


def _bin_plan(dtype_name, lo, hi, want=HIST_BINS):
    """整数栅格按整数值分箱，边界才会是整齐的数而不是 0.5 到 1.27。"""
    integer = not dtype_name.lower().startswith("float")
    if integer and lo is not None and hi is not None:
        span = int(hi) - int(lo)
        if span <= want:
            return max(1, span + 1), int(lo), int(hi) + 1, True
    return want, lo, hi, False


def _sample_band(target, band_index, height, width, dtype_name):
    """降采样读一次，统计值和值分布一起拿到，避免大文件重复读。"""
    import numpy as np
    import rasterio

    ratio = max(1, int((height * width / SAMPLE_TARGET_PIXELS) ** 0.5) + 1)
    out_h, out_w = max(1, height // ratio), max(1, width // ratio)
    try:
        with rasterio.open(target) as src:
            arr = src.read(band_index, out_shape=(out_h, out_w), masked=True)
    except Exception:
        return None
    flat = arr.compressed()
    label = (f"降采样估算 · 约 1/{ratio} 分辨率 · {out_h}×{out_w} 像元" if ratio > 1
             else f"全图逐像元统计 · {out_h}×{out_w} 像元")
    if flat.size == 0:
        return {
            "stats": {"minimum": None, "maximum": None, "mean": None, "stddev": None,
                      "valid_percent": 0.0, "source": "sampled",
                      "source_label": f"降采样估算 · 全部为无数据 · {out_h}×{out_w} 像元",
                      "sample_ratio": ratio},
            "histogram": None,
        }
    lo, hi = float(flat.min()), float(flat.max())
    bins, edge_lo, edge_hi, per_value = _bin_plan(dtype_name, lo, hi)
    if per_value:
        counts, bounds = np.histogram(flat, bins=np.arange(edge_lo, edge_hi + 1))
    else:
        counts, bounds = np.histogram(flat, bins=bins)
    return {
        "stats": {
            "minimum": _number(lo, 8),
            "maximum": _number(hi, 8),
            "mean": _number(float(np.mean(flat)), 8),
            "stddev": _number(float(np.std(flat)), 8),
            "valid_percent": _number(flat.size / (out_h * out_w) * 100, 2),
            "source": "sampled",
            "source_label": label,
            "sample_ratio": ratio,
        },
        "histogram": {
            "bins": int(len(counts)),
            "min": _number(float(bounds[0]), 8),
            "max": _number(float(bounds[-1]), 8),
            "bin_width": _number((float(bounds[-1]) - float(bounds[0])) / max(1, len(counts)), 8),
            "counts": [int(c) for c in counts],
            "total": int(flat.size),
            "per_value_bins": per_value,
            "first_bin_center": _number(float(bounds[0]), 8),
            "approximate": ratio > 1,
            "source": "sampled",
            "source_label": label,
        },
    }


def inspect(target, real_path=None, file_size=None):
    """target 可以是普通路径或 /vsizip/ 之类的虚拟路径；real_path 用于读文件头。"""
    ds = gdal.Open(target, gdal.GA_ReadOnly)
    if ds is None:
        raise ValueError("没有可识别的栅格数据")

    width, height, count = ds.RasterXSize, ds.RasterYSize, ds.RasterCount
    driver_short = ds.GetDriver().ShortName
    sub = ds.GetMetadata("SUBDATASETS") or {}
    variables = list_variables(sub)
    if count == 0:
        if not variables:
            del ds
            raise ValueError("里面没有栅格波段")
        # netCDF/HDF 这类多变量文件，外层只有变量清单
        info = {
            "kind": "raster",
            "driver": driver_short,
            "driver_label": labels.driver(driver_short),
            "driver_long": ds.GetDriver().LongName,
            "width": None, "height": None, "pixels": None, "band_count": None,
            "multi_variable": True,
            "variables": variables,
            "note": "这是一个多变量文件，需要选一个变量才能看数值范围",
            "crs": describe(ds.GetProjection() or ""),
            "file_size": file_size,
        }
        del ds
        return info
    img_struct = ds.GetMetadata("IMAGE_STRUCTURE") or {}
    compress_raw = img_struct.get("COMPRESSION")
    gt = ds.GetGeoTransform(can_return_null=True)
    wkt = ds.GetProjection() or ""

    info = {
        "kind": "raster",
        "driver": driver_short,
        "driver_label": labels.driver(driver_short),
        "driver_long": ds.GetDriver().LongName,
        "width": width,
        "height": height,
        "rows": height,
        "cols": width,
        "pixels": width * height,
        "band_count": count,
        "crs": describe(wkt),
        "image_structure": img_struct,
        "compression_raw": compress_raw,
        "compression_label": labels.compression(compress_raw),
        "interleave": img_struct.get("INTERLEAVE"),
        "layout": img_struct.get("LAYOUT"),
        "file_size": file_size,
        "dataset_metadata": ds.GetMetadata() or {},
    }

    if gt:
        x_span = gt[1] * width + gt[2] * height
        y_span = gt[4] * width + gt[5] * height
        info["geotransform"] = [_number(v, 9) for v in gt]
        info["pixel_size"] = {"x": _number(gt[1], 9), "y": _number(-gt[5], 9)}
        info["rotation"] = {"x": _number(gt[2], 9), "y": _number(gt[4], 9)}
        info["origin"] = [_number(gt[0], 6), _number(gt[3], 6)]
        info["extent"] = {
            "left": _number(min(gt[0], gt[0] + x_span), 6),
            "right": _number(max(gt[0], gt[0] + x_span), 6),
            "top": _number(max(gt[3], gt[3] + y_span), 6),
            "bottom": _number(min(gt[3], gt[3] + y_span), 6),
        }
        unit = info["crs"].get("unit_label") or ""
        px = info["pixel_size"]
        # 度不隔空格（0.004°），米这类单位隔一个（30 m）
        gap = "" if unit == "°" else " "
        info["pixel_size_label"] = f"{px['x']:g} × {px['y']:g}{gap}{unit}".strip()
        if info["crs"]["kind"] == "projected" and px["x"]:
            info["pixel_size_deg"] = _number(px["x"] / 111319.49, 8)
        if wkt:
            e = info["extent"]
            box = bounds_to_wgs84(wkt, e["left"], e["bottom"], e["right"], e["top"], densify=16)
            info["extent_wgs84"] = box
            if info["crs"]["kind"] != "projected":
                # 已经是经纬度：四个角单独转，斜切（旋转）影像才能贴合真实位置
                info["corners_wgs84"] = transform_points(wkt, [
                    (gt[0], gt[3]),
                    (gt[0] + gt[1] * width, gt[3] + gt[4] * width),
                    (gt[0] + gt[1] * width + gt[2] * height, gt[3] + gt[4] * width + gt[5] * height),
                    (gt[0] + gt[2] * height, gt[3] + gt[5] * height),
                ])
            elif box:
                # 投影栅格出图前会先重投影到经纬度，贴图的四个角就是这个正南北包围盒
                info["corners_wgs84"] = [[box[0], box[3]], [box[2], box[3]],
                                         [box[2], box[1]], [box[0], box[1]]]
            info["extent_ring_wgs84"] = ring_to_wgs84(wkt, e["left"], e["bottom"], e["right"], e["top"])
        warn = extent_warning(info["crs"], info.get("extent"))
        if warn:
            info["warning"] = warn
    else:
        info["geotransform"] = None
        info["extent"] = None
        info["no_georeference"] = True

    bands = []
    total_bytes = 0
    for i in range(1, count + 1):
        b = ds.GetRasterBand(i)
        type_name = gdal.GetDataTypeName(b.DataType)
        bits = gdal.GetDataTypeSize(b.DataType)
        block = list(b.GetBlockSize())
        overviews = b.GetOverviewCount()
        color_name = gdal.GetColorInterpretationName(b.GetColorInterpretation())
        ct = b.GetColorTable()
        resampling = None
        if overviews:
            try:
                resampling = b.GetOverview(0).GetMetadataItem("RESAMPLING", "IMAGE_STRUCTURE")
            except Exception:
                resampling = None
        raw_nodata = b.GetNoDataValue()
        bands.append({
            "index": i,
            "description": b.GetDescription() or None,
            "type": type_name,
            "type_label": labels.data_type(type_name),
            "bits": bits,
            "color_interp": color_name,
            "color_interp_label": labels.color_interp(color_name),
            "nodata": _clean(raw_nodata),
            "nodata_raw": None if raw_nodata is None else str(raw_nodata),
            "nodata_is_nan": raw_nodata is not None and _clean(raw_nodata) is None,
            "has_nodata": raw_nodata is not None,
            "block_size": block,
            "tiled": block[1] != 1 and block[0] < width,
            "overviews": overviews,
            "overview_resampling": resampling,
            "scale": _clean(b.GetScale()) or None,
            "offset": _clean(b.GetOffset()) or None,
            "unit_type": b.GetUnitType() or None,
            "palette_count": ct.GetCount() if ct else 0,
            "categories": (b.GetCategoryNames() or [])[:8] or None,
            "statistics": _stored_stats(b),
            "histogram": None,
        })
        total_bytes += width * height * max(1, bits // 8)

    info["bands"] = bands
    info["data_types"] = sorted({x["type"] for x in bands})
    info["bits"] = bands[0]["bits"] if bands else None
    info["type_label"] = bands[0]["type_label"] if bands else None
    info["nodata_values"] = [x["nodata"] for x in bands]
    info["band_names"] = [x["description"] or x["color_interp_label"] for x in bands]
    info["uncompressed_bytes"] = total_bytes
    first = bands[0] if bands else {}
    block0 = first.get("block_size") or []
    if first.get("tiled"):
        info["storage_layout"] = f"分块存储 {block0[0]}×{block0[1]}"
    elif len(block0) == 2 and block0[1] > 1:
        info["storage_layout"] = f"多行条带（每 {block0[1]} 行）"
    elif block0:
        info["storage_layout"] = f"逐行条带 {block0[0]}×1"
    if not compress_raw and file_size and total_bytes and file_size >= total_bytes * 0.97:
        info["compression_label"] = "未压缩"
    info["overview_levels"] = max((x["overviews"] for x in bands), default=0)
    # 金字塔本身也要占存储，约多三分之一；含金字塔时用更大的基数算压缩率
    if info["overview_levels"]:
        info["uncompressed_with_overviews"] = int(total_bytes * 4 / 3)
    baseline = info.get("uncompressed_with_overviews") or total_bytes
    if file_size and baseline:
        info["size_baseline_bytes"] = baseline
        info["compression_ratio"] = _number(file_size / baseline * 100, 2)
        info["space_saved_percent"] = _number(100 - file_size / baseline * 100, 2)
        if file_size:
            info["compression_ratio_label"] = f"{baseline / file_size:.2f}:1"
    if real_path and driver_short in ("GTiff", "COG"):
        info["tif_flavor"] = _tif_flavor(real_path)

    info["variables"] = variables
    info["is_multidimensional"] = bool(variables)

    del ds
    return info


def fill_band_numbers(info, target, histograms=True):
    """补齐统计值与值分布。统计值优先用文件内已有的，直方图按降采样读一次得到。

    像元数不超过采样目标时读的就是全图，分布是精确值而不是估算。
    直方图要读像元数据，界面默认单独请求，所以这里给开关。
    """
    pixels = info["width"] * info["height"]
    small = pixels <= FULL_SCAN_LIMIT
    cache = {}

    def sampled(index, dtype_name):
        if index not in cache:
            cache[index] = _sample_band(target, index, info["height"], info["width"], dtype_name)
        return cache[index]

    for pos, band in enumerate(info["bands"]):
        if band["statistics"] is None:
            got = None
            if small:
                ds = gdal.Open(target, gdal.GA_ReadOnly)
                try:
                    got = _computed_stats(ds.GetRasterBand(band["index"]))
                finally:
                    del ds
            if got is None:
                data = sampled(band["index"], band["type"])
                got = data["stats"] if data else None
            band["statistics"] = got
        if histograms and pos < MAX_HIST_BANDS and not band.get("histogram"):
            data = sampled(band["index"], band["type"])
            if data:
                band["histogram"] = data["histogram"]
                _check_stats_match(band)
    return info


def _check_stats_match(band):
    """文件内统计值与实测分布明显不一致时标注出来。"""
    st, hist = band.get("statistics"), band.get("histogram")
    if not st or not hist or st.get("minimum") is None or hist.get("min") is None:
        return
    span = max(1e-9, float(st["maximum"]) - float(st["minimum"]))
    outside = (float(st["minimum"]) - float(hist["min"])) + (float(hist["max"]) - float(st["maximum"]))
    if outside / span > 0.25:
        band["statistics_mismatch"] = (
            f"文件内统计值区间 {_nstr(st['minimum'])} ~ {_nstr(st['maximum'])}，"
            f"实测值分布区间 {_nstr(hist['min'])} ~ {_nstr(hist['max'])}，两者不一致")


def _nstr(value):
    text = f"{float(value):,.4f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def band_histogram(target, band_index, height, width, dtype_name, exact=True):
    """值分布。默认全图逐像元扫描，只有超大文件才退回抽样。"""
    ds = gdal.Open(target, gdal.GA_ReadOnly)
    if ds is None:
        return None
    band = ds.GetRasterBand(band_index)
    if band is None:
        del ds
        return None
    total_pixels = max(1, int(width) * int(height))
    approx = bool(not exact or total_pixels > EXACT_HISTOGRAM_LIMIT)
    try:
        mn, mx, _, _ = band.GetStatistics(0, 1)
    except Exception:
        mn = mx = None
    bins, edge_lo, edge_hi, per_value = _bin_plan(dtype_name, _clean(mn), _clean(mx))
    if edge_lo is None or edge_hi is None or edge_hi <= edge_lo:
        bins, edge_lo, edge_hi, per_value = HIST_BINS, 0.0, 1.0, False
    try:
        counts = band.GetHistogram(edge_lo, edge_hi, bins, 0, 1 if approx else 0)
    except Exception:
        counts = None
    finally:
        del ds
    if not counts or sum(counts) <= 0:
        data = _sample_band(target, band_index, height, width, dtype_name)
        return data["histogram"] if data else None
    valid = int(sum(counts))
    step = (float(edge_hi) - float(edge_lo)) / max(1, len(counts))
    first = next(i for i, c in enumerate(counts) if c)
    last = len(counts) - 1 - next(i for i, c in enumerate(reversed(counts)) if c)
    if per_value:
        lo = float(edge_lo) + first * step
        hi = float(edge_lo) + (last + 1) * step
    else:
        lo = float(edge_lo) + first * step
        hi = float(edge_lo) + (last + 1) * step
    label = (f"全图逐像元统计 · {int(width)}×{int(height)} 共 {labels.human_count(total_pixels)}像元"
             if not approx else
             f"快速抽样估算（未逐像元）· 参与统计 {labels.human_count(valid)}像元")
    return {
        "bins": int(len(counts)),
        "min": _number(lo, 8),
        "max": _number(hi, 8),
        "bin_width": _number(step, 8),
        "counts": [int(c) for c in counts],
        "total": valid,
        "valid_percent": _number(valid / total_pixels * 100.0, 2),
        "per_value_bins": per_value,
        "first_bin_center": _number(lo + step / 2.0, 8),
        "approximate": approx,
        "source": "sampled" if approx else "full_scan",
        "source_label": label,
    }


def ramp_colors(k=5, ramp=RAMP_DEFAULT):
    """在选定色带上等距取 k 个颜色。"""
    stops = RAMPS.get(ramp) or RAMPS[RAMP_DEFAULT]
    k = max(2, min(int(k), 12))
    out = []
    for i in range(k):
        t = i / (k - 1) * (len(stops) - 1)
        a = int(t)
        b = min(a + 1, len(stops) - 1)
        frac = t - a
        rgb = tuple(round(stops[a][c] + (stops[b][c] - stops[a][c]) * frac) for c in range(3))
        out.append("#%02x%02x%02x" % rgb)
    return out


def natural_breaks(hist, k=CLASS_DEFAULT):
    """自然间断点分级（Fisher-Jenks 加权动态规划），直接在分箱计数上算。"""
    counts = [int(c) for c in (hist.get("counts") or [])]
    n = len(counts)
    if n < 4:
        return None
    k = max(2, min(int(k), n))
    sw = [0.0] * (n + 1)
    swx = [0.0] * (n + 1)
    swx2 = [0.0] * (n + 1)
    for i, w in enumerate(counts):
        x = float(i)
        sw[i + 1] = sw[i] + w
        swx[i + 1] = swx[i] + w * x
        swx2[i + 1] = swx2[i] + w * x * x
    if sw[n] <= 0:
        return None

    def sse(i, j):
        w = sw[j] - sw[i - 1]
        if w <= 0:
            return 0.0
        sx = swx[j] - swx[i - 1]
        return max(0.0, (swx2[j] - swx2[i - 1]) - sx * sx / w)

    inf = float("inf")
    mat = [[inf] * (n + 1) for _ in range(k + 1)]
    low = [[1] * (n + 1) for _ in range(k + 1)]
    mat[1][1] = 0.0
    for j in range(2, n + 1):
        mat[1][j] = sse(1, j)
    for g in range(2, k + 1):
        for j in range(g + 1, n + 1):
            best, at = inf, g - 1
            for i in range(g - 1, j):
                v = mat[g - 1][i] + sse(i + 1, j)
                if v < best:
                    best, at = v, i
            mat[g][j] = best
            low[g][j] = at + 1
    starts = []
    j = n
    for g in range(k, 1, -1):
        lo_idx = low[g][j] - 1
        starts.append(lo_idx)
        j = low[g][j] - 1
        if j <= 1:
            break
    starts = sorted(set([0] + starts + [n]))
    lo0 = float(hist.get("min") or 0.0)
    step = float(hist.get("bin_width") or 0.0)
    if step <= 0:
        return None
    return [lo0 + i * step for i in starts]


def classify(hist, k=CLASS_DEFAULT, ramp=RAMP_DEFAULT):
    """分级结果：每级的上下界、颜色、像元数。图例和影像渲染共用这一份。"""
    edges = natural_breaks(hist, k)
    if not edges or len(edges) < 3:
        return None
    colors = ramp_colors(len(edges) - 1, ramp)
    counts = hist.get("counts") or []
    lo0 = float(hist.get("min") or 0.0)
    step = float(hist.get("bin_width") or 0.0)
    out = []
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        pixels = 0
        for c, e in enumerate(counts):
            center = lo0 + (c + 0.5) * step
            if a <= center < b or (i == len(edges) - 2 and center >= a):
                pixels += int(e)
        out.append({
            "index": i + 1,
            "lo": _number(a, 4),
            "hi": _number(b, 4),
            "color": colors[i],
            "pixels": pixels,
        })
    return {"classes": out, "method": "natural_breaks", "k": len(out)}


def band_color_table(target, band_index, limit=80):
    """带调色板的分类栅格：分级和颜色直接照调色板走，不做人为分级。

    调色板常按 256 项补齐，只列实际出现的那几类，否则图例会长得没法看。"""
    ds = gdal.Open(target, gdal.GA_ReadOnly)
    if ds is None:
        return None
    try:
        band = ds.GetRasterBand(band_index)
        table = band.GetColorTable() if band else None
        if table is None or table.GetCount() < 1:
            return None
        try:
            # GetStatistics 一次给四个值，只取最小最大
            stats = band.GetStatistics(0, 1)
            lo_v, hi_v = stats[0], stats[1]
        except Exception:
            lo_v, hi_v = 0.0, table.GetCount() - 1
        low = max(0, int(lo_v))
        high = min(table.GetCount() - 1, int(round(hi_v)))
        used = high - low + 1
        if not (1 <= used <= limit):
            return None
        colors = []
        for i in range(low, high + 1):
            e = table.GetColorEntry(i)
            colors.append("#%02x%02x%02x" % (int(e[0]), int(e[1]), int(e[2])))
        return {"edges": [float(i) for i in range(low, high + 2)],
                "colors": colors, "kind": "color_table"}
    finally:
        del ds


def identify_value(target, lon, lat):
    """点选识别：把经纬度换算到栅格自己的坐标系，读那一个像元。"""
    import numpy as np

    ds = gdal.Open(target, gdal.GA_ReadOnly)
    if ds is None:
        return None
    try:
        wkt = ds.GetProjectionRef()
        src = osr.SpatialReference()
        src.SetFromUserInput(wkt or "")
        src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        dst = osr.SpatialReference()
        dst.ImportFromEPSG(4326)
        dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        ct = osr.CoordinateTransformation(dst, src)
        x, y, _ = ct.TransformPoint(float(lon), float(lat))
        gt = ds.GetGeoTransform()
        if not gt or not gt[1] or not gt[5]:
            return None
        col = int((x - gt[0]) / gt[1])
        row = int((y - gt[3]) / gt[5])
        if not (0 <= col < ds.RasterXSize and 0 <= row < ds.RasterYSize):
            return {"inside": False, "col": col, "row": row}
        out = []
        for index in range(1, min(ds.RasterCount, MAX_IDENTIFY_BANDS) + 1):
            band = ds.GetRasterBand(index)
            data = band.ReadAsArray(col, row, 1, 1)
            value = None if data is None else np.asarray(data).reshape(-1)[0]
            nodata = band.GetNoDataValue()
            dead = value is None or (nodata is not None and float(value) == float(nodata))
            out.append({
                "index": index,
                "description": band.GetDescription() or f"波段 {index}",
                "value": None if dead else _number(value, 8),
                "nodata": bool(dead),
            })
        return {"inside": True, "col": col, "row": row, "bands": out,
                "source_xy": [_number(x, 6), _number(y, 6)]}
    finally:
        del ds



