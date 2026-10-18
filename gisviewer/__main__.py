"""命令行入口。同时充当界面文案的样稿。"""

import argparse
import json
import sys

from . import __version__
from . import inspect as engine
from . import labels


def _row(label, value):
    return f"{label:<7}{value}" if value not in (None, "", []) else None


def _fmt(value, digits=None):
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:,.{digits}f}" if digits else f"{value:g}"
    return str(value)


def _num(value, digits=6):
    """坐标和参数读数：大数用千分位，小数保留有效位，别用科学计数法。"""
    if value is None:
        return "—"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    a = abs(v)
    if a >= 10000:
        return f"{v:,.2f}"
    if 0 < a < 0.0001:
        return f"{v:.3e}"
    text = f"{v:,.{digits}f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _crs_lines(crs):
    out = [_row("坐标系", crs.get("label"))]
    parts = []
    if crs.get("method_label"):
        parts.append(crs["method_label"])
    if crs.get("kind_label"):
        parts.append(crs["kind_label"])
    if crs.get("unit_label"):
        parts.append(f"单位{crs['unit_label']}")
    if parts:
        out.append(_row("", " · ".join(parts)))
    params = crs.get("parameters") or []
    if params:
        text = "，".join(f"{p['label'] or p['key']} {_num(p['value'], 4)}" for p in params[:6])
        out.append(_row("", text))
    ell = crs.get("ellipsoid")
    if ell and ell.get("semi_major_m"):
        inv = f"，扁率 1/{ell['inverse_flattening']:g}" if ell.get("inverse_flattening") else ""
        out.append(_row("", f"椭球 {ell['name'] or '未命名'} · 长半轴 {_num(ell['semi_major_m'], 3)} 米{inv}"))
    geo = crs.get("geographic_crs")
    if geo and geo.get("name"):
        code = f"EPSG:{geo['epsg']}" if geo.get("epsg") else "无标准编码"
        out.append(_row("", f"基准 {geo.get('datum') or geo['name']}（{code}）"))
    return [x for x in out if x]


def _extent_line(extent, unit_label):
    if not extent:
        return None
    return _row("范围", f"左 {_num(extent['left'])} · 右 {_num(extent['right'])} · "
                        f"下 {_num(extent['bottom'])} · 上 {_num(extent['top'])}"
                        + (f"（{unit_label}）" if unit_label else ""))


def _wgs_line(w):
    if not w:
        return None
    return _row("", f"经纬度外包围 西 {_num(w[0])} · 南 {_num(w[1])} · 东 {_num(w[2])} · 北 {_num(w[3])}")


def render_variables(r):
    lines = [_row("格式", r.get("driver_label"))]
    vars_ = r.get("variables") or []
    lines.append(_row("变量", f"共 {len(vars_)} 个"))
    for v in vars_[:8]:
        s = v.get("summary") or {}
        bits = [str(v.get("label"))]
        if s.get("width"):
            bits.append(f"行 {s['height']} · 列 {s['width']}")
        if s.get("type_label"):
            bits.append(s["type_label"])
        st = s.get("statistics") or {}
        if st.get("minimum") is not None:
            bits.append(f"最小 {_num(st['minimum'], 4)} · 最大 {_num(st['maximum'], 4)}"
                        f" · 平均 {_num(st['mean'], 4)}")
        if s.get("crs_label"):
            bits.append(s["crs_label"])
        if v.get("error"):
            bits.append("读数失败")
        lines.append(_row("", " · ".join(bits)))
    if r.get("note"):
        lines.append(_row("提示", r["note"]))
    return [x for x in lines if x]


LEVELS = "▁▂▃▄▅▆▇█"


def _hist_line(hist, width=32):
    if not hist or not hist.get("counts"):
        return None, None
    counts = hist["counts"]
    peak = max(counts) or 1
    step = max(1, len(counts) // width)
    bar = "".join(LEVELS[min(7, int(c / peak * 7.99))] for c in counts[::step][:width])
    note = (f"{hist['bins']} 箱 · 范围 {_num(hist['min'], 4)} ~ {_num(hist['max'], 4)}"
            f" · 箱宽 {_num(hist['bin_width'], 4)}"
            + (" · 降采样估算" if hist.get("approximate") else "")
            + (" · 按整数值分箱" if hist.get("per_value_bins") else ""))
    return bar, note


def render_raster(r):
    if r.get("multi_variable"):
        return render_variables(r)
    lines = []
    crs = r.get("crs") or {}
    unit = crs.get("unit_label")
    band = (r.get("bands") or [{}])[0]
    flavor = (r.get("tif_flavor") or {}).get("flavor")
    lines.append(_row("格式", " · ".join(x for x in [r.get("driver_label"), flavor] if x)))
    lines.append(_row("行列号", f"行 {r['rows']} · 列 {r['cols']}"))
    lines.append(_row("像元总数", labels.human_count(r["pixels"])))
    lines.append(_row("波段数量", str(r["band_count"])))
    names = [n for n in (r.get("band_names") or []) if n]
    if names:
        lines.append(_row("波段名称", "、".join(str(n) for n in names[:8])))
    types = r.get("data_types") or []
    type_text = r.get("type_label") or ""
    if len(types) > 1:
        type_text += "（各波段：" + "、".join(labels.data_type(t) for t in types[:4]) + "）"
    lines.append(_row("数据类型", type_text))
    lines += _crs_lines(crs)
    ext = _extent_line(r.get("extent"), unit)
    if ext:
        lines.append(ext)
    lines.append(_wgs_line(r.get("extent_wgs84")))
    if r.get("no_georeference"):
        lines.append(_row("范围", "无地理坐标"))
    if r.get("pixel_size_label"):
        extra = f"（约 {_num(r['pixel_size_deg'], 6)} 度）" if r.get("pixel_size_deg") else ""
        lines.append(_row("像元大小", r["pixel_size_label"] + extra))
    if band.get("nodata_is_nan"):
        lines.append(_row("NoData", "非数（NaN）"))
    else:
        shown = [x for x in (r.get("nodata_values") or []) if x is not None]
        lines.append(_row("NoData", _num(shown[0]) if shown else "未记录"))
    multi = r["band_count"] > 1
    for b in r.get("bands") or []:
        tag = f"（波段 {b['index']}）" if multi else ""
        st = b.get("statistics")
        if st:
            valid = (f" · 有效像元占比 {_num(st['valid_percent'], 2)}%"
                     if st.get("valid_percent") is not None else "")
            lines.append(_row("统计值" + tag,
                              f"最小 {_num(st['minimum'], 4)} · 最大 {_num(st['maximum'], 4)} · "
                              f"平均 {_num(st['mean'], 4)} · 标准差 {_num(st['stddev'], 4)}" + valid))
            lines.append(_row("统计来源" + tag, st.get("source_label") or "未记录"))
        bar, note = _hist_line(b.get("histogram"))
        if bar:
            lines.append(_row("值分布" + tag, bar))
            lines.append(_row("分布参数" + tag, note))
    lines.append(_row("压缩算法", r.get("compression_label") or "未记录"))
    lines.append(_row("存储组织", r.get("storage_layout") or "未记录"))
    lines.append(_row("金字塔", f"{band['overviews']} 级 · 重采样 {band['overview_resampling']}"
                                 if band.get("overviews") else "无"))
    interleave = {"BAND": "波段顺序存放", "PIXEL": "像元顺序存放"}.get(r.get("interleave"))
    if interleave:
        lines.append(_row("波段排布", interleave))
    if r.get("uncompressed_bytes") and r.get("file_size"):
        base = labels.human_size(r["uncompressed_bytes"])
        if r.get("uncompressed_with_overviews"):
            base += f"（含 {r['overview_levels']} 级金字塔 " \
                    f"{labels.human_size(r['uncompressed_with_overviews'])}）"
        lines.append(_row("文件大小", labels.human_size(r["file_size"])))
        lines.append(_row("未压缩大小", base))
        lines.append(_row("压缩比", r.get("compression_ratio_label") or "—"))
    if r.get("warning"):
        lines.append(_row("提示", r["warning"]))
    return [x for x in lines if x]


def render_vector(v):
    lines = []
    layers = v.get("layers") or []
    lines.append(_row("格式", v.get("driver_label")))
    if v.get("layer_count", 1) > 1:
        lines.append(_row("图层", f"共 {v['layer_count']} 个"))
    for lyr in layers[:6]:
        if lyr.get("error"):
            lines.append(_row("图层", f"{lyr.get('name')}：读取失败 {lyr['error']}"))
            continue
        bits = [f"{lyr.get('name') or '默认图层'}"]
        bits.append(f"{labels.human_count(lyr.get('feature_count') or 0)} 个要素")
        bits.append(lyr.get("geometry_type_label"))
        if lyr.get("geometry_sampling"):
            gs = lyr["geometry_sampling"]
            dist = "、".join(f"{k} {v}" for k, v in list(gs["distribution"].items())[:4])
            scope = "全部要素" if gs.get("full") else f"抽样 {gs['read']} 个"
            bits.append(f"实际类型 {dist}（{scope}）")
        lines.append(_row("图层", " · ".join(bits)))
        lines += _crs_lines(lyr.get("crs") or {})
        ext = _extent_line(lyr.get("extent"), (lyr.get("crs") or {}).get("unit_label"))
        if ext:
            lines.append(ext)
        if lyr.get("extent_wgs84"):
            lines.append(_wgs_line(lyr["extent_wgs84"]))
        if lyr.get("warning"):
            lines.append(_row("提示", lyr["warning"]))
        fields = lyr.get("fields") or []
        if fields:
            head = "、".join(f"{f['name']}（{f.get('type_label') or f['type']}）" for f in fields[:8])
            more = f" 等 {len(fields)} 个" if len(fields) > 8 else ""
            lines.append(_row("字段", head + more))
            shown = [(f["name"], f.get("samples") or []) for f in fields[:4] if f.get("samples")]
            if shown:
                sample = "｜".join(f"{n}={v[0]}" for n, v in shown)
                lines.append(_row("示例值", sample))
    side = v.get("sidecars")
    if side:
        have = [f["suffix"] for f in side["files"] if f["exists"]]
        miss_req = side.get("missing_required") or []
        miss_imp = side.get("missing_important") or []
        if miss_req:
            text = "缺必需文件 " + "、".join(miss_req) + "，属性表可能读不出来"
        elif miss_imp:
            text = ("有：" + "、".join(have) + "；缺 " + "、".join(
                f"{m['suffix']}（{m['purpose']}）" for m in miss_imp) + "，对应信息看不到")
        else:
            text = "齐全：" + "、".join(have)
        lines.append(_row("伴生文件", text))
    return [x for x in lines if x]


def render(result):
    if not result.get("ok"):
        err = result.get("error") or {}
        out = [_row("出错", err.get("title")), _row("说明", err.get("detail")), _row("建议", err.get("hint"))]
        return [x for x in out if x]

    f = result.get("file") or {}
    lines = [_row("文件", f"{f.get('name')} · {f.get('size_label')} · 改动 {f.get('modified')}")]
    if f.get("is_dir") and f.get("item_count"):
        lines.append(_row("内含文件", f"{labels.human_count(f['item_count'])} 个"))
    kind = result.get("kind")
    if kind == "archive":
        lines.append(_row("压缩包", f"{result.get('member_count')} 个成员，解压后 "
                                    f"{result.get('uncompressed_label')}，含 "
                                    f"{result.get('data_entry_count')} 份数据"))
        for lyr in result.get("layers") or []:
            if lyr.get("ok") is False:
                lines.append(_row("图层", f"{lyr.get('member')}：{lyr['error']['title']}"))
            elif lyr.get("kind") == "raster":
                lines.append(_row("栅格", lyr.get("member")))
                lines += render_raster(lyr)
            else:
                lines.append(_row("矢量", lyr.get("member")))
                lines += render_vector(lyr)
    elif kind == "raster":
        lines += render_raster(result)
    elif kind == "vector":
        lines += render_vector(result)
    elif kind == "tileset":
        zooms = result.get("zooms") or []
        lines.append(_row("格式", result.get("driver_label")))
        lines.append(_row("组织方式", f"瓦片金字塔 {result.get('scheme')}，后缀 {result.get('tile_ext')}"))
        lines.append(_row("缩放级别", f"{result.get('zoom_min')} ~ {result.get('zoom_max')}"
                                      f"（{len(zooms)} 级：{'、'.join(str(z) for z in zooms)}）"))
        lines.append(_row("瓦片总数", labels.human_count(result.get("tile_count"))))
        if result.get("tile_bytes_sample"):
            lines.append(_row("单张大小", labels.human_size(result["tile_bytes_sample"]) + "（抽样）"))
        lines.append(_wgs_line(result.get("extent_wgs84")))
        for t in result.get("layers") or []:
            lines.append(_row("切片图层", f"{t.get('name')} · {t.get('geometry_type_label')} · "
                                          f"{t.get('field_count')} 个字段 · 单张 {t.get('features_in_tile')} 要素"))
    elif kind == "json":
        lines.append(_row("类型", result.get("top_level")))
        lines.append(_row("地理数据", "是" if result.get("is_geographic") else "不是"))
        if result.get("keys"):
            lines.append(_row("字段", "、".join(result["keys"][:12])))
        if result.get("feature_count_estimate"):
            lines.append(_row("要素", labels.human_count(result["feature_count_estimate"]) + " 个"))
        if result.get("note"):
            lines.append(_row("说明", result["note"]))
    conv = result.get("conversion")
    if conv:
        lines.append(_row("转换", f"{conv.get('version') or '版本未知'} · {conv.get('note')}"))
    lines.append(_row("耗时", f"{result.get('elapsed_ms')} 毫秒"))
    return [x for x in lines if x]


def _jsonable(obj):
    """清掉 NaN 和无穷，保证输出能被任何 JSON 解析器读。"""
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, float) and (obj != obj or obj in (float("inf"), float("-inf"))):
        return None
    return obj


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gisviewer", description="快速查看 GIS 文件信息")
    parser.add_argument("--version", action="version", version="图览 " + __version__)
    parser.add_argument("paths", nargs="+", help="文件或文件夹路径")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON")
    parser.add_argument("--no-stats", action="store_true", help="跳过缺失统计值的计算")
    args = parser.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    results = [engine.safe_inspect(raw, compute_stats=not args.no_stats)
               for raw in args.paths]
    if args.json:
        payload = results[0] if len(results) == 1 else [_jsonable(r) for r in results]
        print(json.dumps(_jsonable(payload), ensure_ascii=False, indent=2, default=str))
    else:
        for result in results:
            print("=" * 72)
            for line in render(result):
                print(line)
    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
