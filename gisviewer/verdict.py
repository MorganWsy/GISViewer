"""体检结论：把一屏数字读成几句话——有没有问题、要不要紧、下一步怎么办。

信息栏给的是逐项事实，批量体检和命令行需要的是结论。本模块只做判断：
输入是 inspect_file 的结果字典，不读文件、不重新计算。
judge() 出结论，compare() 出两次体检的差异。
"""

LEVEL_ORDER = {"bad": 2, "warn": 1, "ok": 0}
LEVEL_LABEL = {"bad": "有问题", "warn": "要留意", "ok": "没发现问题"}

SIZE_BIG = 8 * 1024 * 1024        # 与 vindex 的门槛一致：超过它才值得建索引
PIXELS_MANY = 20 * 1000 * 1000    # 两千万像元以上，没有金字塔缩放会明显等

# 检查项目：界面按这张表逐行铺开（单文件体检报告），也按它把结论归位。
# 顺序就是报告的阅读顺序：先问能不能打开，再问位置对不对，最后才是数据本身。
ROWS = {
    "vector": [("read", "可读性"), ("crs", "坐标系"), ("extent", "位置范围"),
               ("layers", "图层结构"), ("count", "要素数"), ("fields", "字段表"),
               ("index", "空间索引")],
    "raster": [("read", "可读性"), ("crs", "坐标系"), ("pixels", "像元"),
               ("bands", "波段"), ("nodata", "无效值"), ("compress", "压缩方式"),
               ("pyramid", "金字塔")],
}
# 这一项没查出问题时怎么描述。写"正常"太空，写清楚核对的是什么
PASS_TEXT = {
    "read": "打开正常",
    # 只写"有定义"：有坐标系却算不出经纬度范围的情况确实存在（本地 CAD 坐标），
    # 写成"齐全"会和下一行"算不出经纬度范围"打架
    "crs": "有坐标系定义",
    "extent": "范围算得出来",
    "layers": "图层结构正常",
    "count": "图层里都有要素",
    "fields": "字段没有空名、没有重名",
    "index": "该格式带空间索引",
    "pixels": "像元尺寸正常",
    "bands": "波段齐全",
    "nodata": "设了无效值",
    "compress": "影像有压缩",
    "pyramid": "建了金字塔",
}
# 项目名：判据里用简称（read / crs…），界面和命令行要的是中文短标签
CAT_LABEL = dict((cat, label) for spec in ROWS.values() for cat, label in spec)


def _item(level, title, detail=None, hint=None, cat=None):
    out = {"level": level, "title": title}
    if detail:
        out["detail"] = detail
    if hint:
        out["hint"] = hint
    if cat:
        out["cat"] = cat
        # 项目名一起带出去：界面列表里要按"坐标系 / 图层结构"分列对齐，
        # 让前端自己维护一份对照表迟早会和这里的判据对不上
        out["cat_label"] = CAT_LABEL.get(cat) or cat
    return out



def _worst(items):
    level = "ok"
    for it in items:
        if LEVEL_ORDER[it["level"]] > LEVEL_ORDER[level]:
            level = it["level"]
    return level


def _vector(layer, result, items):
    count = layer.get("feature_count")
    if count == 0:
        items.append(_item("warn", "这个图层是空的",
                           "要素数为 0，画到地图上什么也看不到",
                           "确认导出时是否漏了数据，或过滤条件把所有要素都排除了",
                           cat="count"))
    if not layer.get("crs"):
        items.append(_item("warn", "没有坐标系",
                           "坐标只能按原始数值临时摆放，位置不可信，也没法和别的图层对齐",
                           "在数据源里补一份坐标系（.prj 或图层定义）后重新导出",
                           cat="crs"))
    elif layer.get("geometry_type_is_mixed") or layer.get("geometry_is_mixed"):
        items.append(_item("warn", "一个图层里混着多种几何类型",
                           "矢量的点、线、面混在同一层，绘制和统计都只能按各自类型分开看",
                           "一般不影响查看；要按类型统计的话建议拆层导出",
                           cat="layers"))
    names = [f.get("name") or "" for f in (layer.get("fields") or [])]
    blank = sum(1 for n in names if not n)
    if blank:
        items.append(_item("warn", "有 %d 个字段没有名字" % blank,
                           "空字段名会让属性表出现没有标题的列",
                           "在数据源里给字段改名，或导出时去掉这些列",
                           cat="fields"))
    dup = sorted({n for n in names if n and names.count(n) > 1})
    if dup:
        items.append(_item("warn", "字段名重复：%s" % "、".join(dup[:4]),
                           "同名列表里会有两列一样标题，取数时容易拿错",
                           "导出前把重名字段改名",
                           cat="fields"))
    caps = layer.get("capabilities") or {}
    size = (result.get("file") or {}).get("size_bytes") or 0
    if caps and caps.get("空间过滤加速") is False and size >= SIZE_BIG:
        items.append(_item("warn", "这个格式没有空间索引，文件又比较大",
                           "按视野取数时驱动只能从头扫，图览会顺手建一份本地索引，"
                           "建好之后拖动、缩放都是毫秒级",
                           "不用处理；第一次打开后稍等十来秒即可",
                           cat="index"))
    ext = layer.get("extent_wgs84")
    if layer.get("has_geometry") and not ext:
        items.append(_item("warn", "算不出经纬度范围",
                           "坐标系多半有问题，地图上无法正确定位",
                           "检查坐标系定义是否完整",
                           cat="extent"))


def _raster(result, items):
    pixels = result.get("pixels") or 0
    if not pixels:
        items.append(_item("bad", "影像没有任何像元", "宽或高为 0，读不出内容",
                           "确认文件是否完整", cat="pixels"))
    if not result.get("crs"):
        items.append(_item("warn", "没有坐标系",
                           "不知道影像在地球上的位置，只能看像素，不能和别的数据叠加",
                           "补一份坐标系（.prj / .aux.xml）后重新导出",
                           cat="crs"))
    levels = result.get("overview_levels") or 0
    if pixels >= PIXELS_MANY and not levels:
        items.append(_item("warn", "没有金字塔（概视图）",
                           "缩到全图时要现场抽稀整幅影像，每次打开都慢",
                           "用 gdaladdo 建一次金字塔，之后秒开",
                           cat="pyramid"))
    comp = (result.get("image_structure") or {}).get("COMPRESSION") or ""
    if not comp and (result.get("file") or {}).get("size_bytes", 0) >= 50 * 1024 * 1024:
        items.append(_item("warn", "影像没有压缩",
                           "体积会明显偏大，传输和打开都更慢",
                           "无损场景可以用 LZW 或 DEFLATE 重新导出",
                           cat="compress"))
    if not (result.get("bands") or [{}])[0].get("has_nodata"):
        items.append(_item("warn", "没有设置无效值（NoData）",
                           "影像边缘的填充值会被当成真实数值参与统计",
                           "确认边缘是否该参与统计；需要的话在导出时设 NoData",
                           cat="nodata"))


def _collapse(rows):
    """同一句结论落在多个图层上时合成一条：六十个图层的文件不该刷六十行。"""
    order, groups = [], {}
    for it in rows:
        key = (it["level"], it["title"])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(it)
    out = []
    for key in order:
        got = groups[key]
        base = {k: v for k, v in got[0].items() if k != "layer"}
        names = [it.get("layer") or "" for it in got if it.get("layer")]
        if len(got) > 1 and names:
            tail = "、".join(names[:4]) + ("…" if len(names) > 4 else "")
            base["detail"] = "%s（共 %d 个图层：%s）" % (
                base.get("detail") or "", len(got), tail)
        out.append(base)
    return out


def _rows(kind, items, err=None):
    """把结论摊成一张检查表：每一项都在，没查出来的写"通过"。

    单文件体检要的是完整体检表——知道"查了什么、哪些过了"，
    只列问题的话用户看不出这份数据到底核对过哪几项。
    """
    if err is not None:
        return [{"cat": "read", "label": "可读性", "level": "bad",
                 "title": err.get("title") or "读不出来",
                 "detail": err.get("detail"), "hint": err.get("hint")}]
    spec = ROWS.get(kind or "")
    if not spec:
        return []
    hit = {}
    for it in items:
        cat = it.get("cat")
        if not cat:
            continue
        cur = hit.get(cat)
        if cur is None or LEVEL_ORDER[it["level"]] > LEVEL_ORDER[cur["level"]]:
            hit[cat] = it
    out = []
    for cat, label in spec:
        got = hit.get(cat)
        if got is None:
            out.append({"cat": cat, "label": label, "level": "ok",
                        "title": PASS_TEXT.get(cat) or "正常"})
        else:
            out.append({"cat": cat, "label": label, "level": got["level"],
                        "title": got["title"], "detail": got.get("detail"),
                        "hint": got.get("hint")})
    return out


def facts(result):
    """一份数据的基本事实：什么格式、几个图层、多少要素、多大。

    只写看得懂的事实，不做判断——判断在 judge 里。界面的摘要行和诊断包里的
    xlsx 都从这一份出，两处不各写一遍，否则迟早会漏掉一边。
    """
    f = result.get("file") or {}
    out = []
    label = result.get("driver_label")
    if label:
        out.append(label)
    if result.get("kind") == "vector":
        if result.get("layer_count"):
            out.append("%d 个图层" % result["layer_count"])
        if result.get("feature_count_total"):
            # 不写千分位：摘要行是一句话，不是表格，"109,007" 里的逗号只会让人多看一眼
            out.append("%d 个要素" % int(result["feature_count_total"]))
    elif result.get("kind") == "raster":
        w, h = result.get("width"), result.get("height")
        if w and h:
            out.append("%d × %d 像元" % (int(w), int(h)))
        if result.get("band_count"):
            out.append("%d 个波段" % result["band_count"])
    if f.get("size_label"):
        out.append(f["size_label"])
    return out


def judge(result):
    """一份体检结果 -> {level, items, rows, counts, ok}。level 取最重的一条。"""
    items = []
    if not result.get("ok"):
        err = result.get("error") or {}
        items.append(_item("bad", err.get("title") or "读不出来",
                           err.get("detail"), err.get("hint"), cat="read"))
        return {"level": "bad", "items": items, "rows": _rows(result.get("kind"), items, err),
                "counts": {"bad": 1}, "ok": False}

    kind = result.get("kind")
    # 不再按 is_dir 判"这是个文件夹"：.gdb / .zarr 在磁盘上也是目录，引擎却能按
    # 一份数据打开（kind=vector/raster，图层齐全）。早先在这里先看 is_dir，结果
    # 这类数据只得到一句"这是个文件夹"，坐标系、字段、要素数一条都没查。
    # 真正的文件夹走不到这里——引擎对目录返回的本来就是"这是一个文件夹"的错误。
    if kind == "vector":
        rows = []
        for layer in result.get("layers") or []:
            got = []
            _vector(layer, result, got)
            for it in got:
                it["layer"] = layer.get("name") or ""
            rows.extend(got)
        items.extend(_collapse(rows))
    elif kind == "raster":
        _raster(result, items)
    elif not kind:
        # 打得开却说不出是什么类型：这种容器没法核对坐标系与范围，
        # 不能当"没问题"放过去，也不能报成读不出来
        items.append(_item("warn", "没认出这是什么数据",
                           "文件能打开，但类型不明，坐标系与范围都没法核对",
                           "确认后缀和内容对不对得上；确实需要的话把文件发给我们看看"))

    if not items:
        items.append(_item("ok", "没发现问题", "坐标系、范围、要素数、字段都对得上"))
    counts = {}
    for it in items:
        counts[it["level"]] = counts.get(it["level"], 0) + 1
    return {"level": _worst(items), "items": items, "rows": _rows(kind, items),
            "counts": counts, "ok": True}


def _flat(layer):
    """把参与对比的几项拉成一行，方便逐项比。"""
    return {
        "feature_count": layer.get("feature_count"),
        "geometry_type": layer.get("geometry_type_label"),
        "crs": (layer.get("crs") or {}).get("label"),
        "extent_wgs84": layer.get("extent_wgs84"),
        "field_count": layer.get("field_count"),
        "fields": [f.get("name") for f in (layer.get("fields") or [])],
    }


def _same(a, b, eps=1e-9):
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_same(x, y, eps) for x, y in zip(a, b))
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= eps
    return a == b


def _diff_row(key, label, old, new):
    if _same(old, new):
        return None
    return {"key": key, "label": label, "before": old, "after": new}


def compare(old, new):
    """两次体检的差异。old/new 都是 judge 之前的原始结果字典。

    比对的是"看得见的结论"：要素数、坐标系、范围、字段表、文件大小。
    返回 [] 表示这份数据没变。
    """
    rows = []
    if (old.get("file") or {}).get("size_bytes") != (new.get("file") or {}).get("size_bytes"):
        rows.append(_diff_row("size", "文件大小",
                              (old.get("file") or {}).get("size_label"),
                              (new.get("file") or {}).get("size_label")))
    if old.get("kind") != new.get("kind"):
        rows.append(_diff_row("kind", "数据类型", old.get("kind"), new.get("kind")))
        return [r for r in rows if r]

    if new.get("kind") == "vector":
        a = old.get("layers") or []
        b = new.get("layers") or []
        if len(a) != len(b):
            rows.append(_diff_row("layers", "图层数", len(a), len(b)))
        for i in range(min(len(a), len(b))):
            fa, fb = _flat(a[i]), _flat(b[i])
            name = fb.get("label") or a[i].get("name")
            for key, label in (("feature_count", "要素数"), ("geometry_type", "几何类型"),
                               ("crs", "坐标系"), ("extent_wgs84", "经纬度范围"),
                               ("field_count", "字段数")):
                rows.append(_diff_row("%s.%d" % (key, i), "%s·%s" % (name, label),
                                      fa[key], fb[key]))
            gone = [x for x in fa["fields"] if x not in fb["fields"]]
            added = [x for x in fb["fields"] if x not in fa["fields"]]
            if gone or added:
                rows.append({"key": "fields.%d" % i, "label": "%s·字段表" % name,
                             "before": "、".join(gone) if gone else "（无删除）",
                             "after": "、".join(added) if added else "（无新增）"})
    elif new.get("kind") == "raster":
        for key, label in (("pixels", "像元数"), ("band_count", "波段数"),
                           ("compression_label", "压缩方式"), ("overview_levels", "金字塔层数"),
                           ("pixel_size_label", "像元大小")):
            rows.append(_diff_row("raster." + key, label, old.get(key), new.get(key)))
        rows.append(_diff_row("crs", "坐标系",
                              (old.get("crs") or {}).get("label"),
                              (new.get("crs") or {}).get("label")))
        rows.append(_diff_row("extent", "经纬度范围",
                              old.get("extent_wgs84"), new.get("extent_wgs84")))
    return [r for r in rows if r]
