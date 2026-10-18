"""内部标识到界面文案的映射。界面上不出现驱动内部名和库名。"""

import re

COMPRESSION_LABELS = {
    "NONE": "未压缩",
    "1": "未压缩",
    "LZW": "LZW（无损）",
    "DEFLATE": "Deflate（无损）",
    "PREFLATE": "Deflate（无损）",
    "PACKBITS": "PackBits（无损）",
    "CCITT_R4": "CCITT Group 4",
    "CCITT_R6": "CCITT Group 3",
    "JPEG": "JPEG（有损）",
    "JPEG2000": "JPEG 2000",
    "ZSTD": "Zstandard（无损）",
    "LERC": "LERC",
    "LERC_V2": "LERC v2",
    "WEBP": "WebP",
    "SFLUZZ": "SfLUZZ（无损）",
    "DEFLATE_OVERSUM": "Deflate（无损）",
}

DRIVER_LABELS = {
    "GTiff": "GeoTIFF",
    "BIGTIFF": "BigGeoTIFF",
    "COG": "Cloud Optimized GeoTIFF",
    "HFA": "Erdas IMG",
    "ILWIS": "ILWIS",
    "EHdr": "ESRI BIL 头文件栅格",
    "ENVI": "ENVI 栅格",
    "netCDF": "netCDF",
    "HDF4": "HDF4",
    "HDF4Image": "HDF4 子数据集",
    "HDF5": "HDF5",
    "HDF5Image": "HDF5 子数据集",
    "GRIB": "GRIB",
    "KEA": "KEA",
    "Zarr": "Zarr",
    "VRT": "VRT 虚拟栅格",
    "NITF": "NITF",
    "RPFTOC": "RPFTOC 影像镶嵌",
    "AAIGrid": "ArcInfo ASCII 栅格",
    "SAGA": "SAGA 栅格",
    "USGSDEM": "USGS DEM",
    "RMF": "Raster Matrix Format",
    "NGSGEOID": "NOAA 大地水准面格网",
    "ESRI Shapefile": "Shapefile",
    "GeoJSON": "GeoJSON",
    "GeoJSONSeq": "GeoJSON 行序列",
    "TopoJSON": "TopoJSON",
    "ESRIJSON": "ArcGIS JSON",
    "LIBKML": "KML / KMZ",
    "KML": "KML / KMZ",
    "GPKG": "GeoPackage",
    "SQLite": "SQLite 空间库",
    "OpenFileGDB": "文件地理数据库",
    "PGeo": "个人地理数据库",
    "DXF": "DXF",
    "CAD": "DWG",
    "OSM": "OpenStreetMap",
    "MapInfo File": "MapInfo TAB",
    "GPX": "GPX",
    "CSV": "CSV 表格",
    "MVT": "矢量切片",
    "PMTiles": "PMTiles",
    "MBTiles": "MBTiles",
    "GMT": "GMT 格网",
    "DGN": "Microstation DGN",
}

COLOR_INTERP_LABELS = {
    "Gray": "灰度",
    "Uncolored": "未指定颜色",
    "Palette": "调色板索引",
    "Red": "红波段",
    "Green": "绿波段",
    "Blue": "蓝波段",
    "Alpha": "透明度",
    "RedBand": "红波段",
    "GreenBand": "绿波段",
    "BlueBand": "蓝波段",
    "Cyan": "青",
    "Magenta": "品红",
    "Yellow": "黄",
    "Black": "黑",
    "RGB": "彩色三通道",
    "RGBA": "彩色三通道加透明",
    "Panchromatic": "全色",
    "Thematic": "专题",
    "Luminance": "亮度",
    "UVIndex": "紫外线指数",
    "NearInfrared": "近红外",
    "Infrared": "红外",
    "RedInfrared": "红红外",
    "GreenInfrared": "绿红外",
    "BlueInfrared": "蓝红外",
    "Pan": "全色",
    "Coz": "浑浊度",
    "Afu": "全氟化合物",
    "Hyp": "深度",
    "Fea": "铁",
    "Nit": "氮",
    "Und": "未指定",
    "NULL": "未指定",
}

# 位深、有无符号这些信息在界面上另有单独一行，这里只给最短的类型名，别把同一件事说两遍
DATA_TYPE_LABELS = {
    "Byte": "Byte",
    "Int8": "Int8",
    "UInt8": "UInt8",
    "Int16": "Int16",
    "UInt16": "UInt16",
    "Int32": "Int32",
    "UInt32": "UInt32",
    "Int64": "Int64",
    "UInt64": "UInt64",
    "Float32": "Float",
    "Float64": "Double",
    "CInt16": "CInt16",
    "CInt32": "CInt32",
    "CFloat32": "CFloat32",
    "CFloat64": "CFloat64",
}

GEOM_TYPE_LABELS = {
    0: "类型混合",
    1: "点",
    2: "线",
    3: "面",
    4: "多点",
    5: "多线",
    6: "多面",
    7: "几何集合",
}

GEOM_TYPE_NAMES = {
    "Point": "点",
    "LineString": "线",
    "Polygon": "面",
    "MultiPoint": "多点",
    "MultiLineString": "多线",
    "MultiPolygon": "多面",
    "GeometryCollection": "几何集合",
    "None": "无几何",
    "Unknown": "混合类型",
    "Curve": "曲线",
    "Surface": "曲面",
}

# 投影法中文名。键一律用规范化写法（小写、非字母数字换成下划线），
# 这样 WKT 里的 Albers_Conic_Equal_Area 和 Albers Equal Area 都能命中。
METHOD_LABELS = {
    "albers_conic_equal_area": "Albers 等积圆锥投影",
    "albers_equal_area_conic": "Albers 等积圆锥投影",
    "albers_equal_area": "Albers 等积圆锥投影",
    "lambert_conformal_conic": "兰伯特等角圆锥投影",
    "lambert_conformal_conic_2sp": "兰伯特等角圆锥投影",
    "lambert_conformal_conic_1sp": "兰伯特等角圆锥投影",
    "lambert_azimuthal_equal_area": "兰伯特方位等积投影",
    "mercator": "墨卡托投影",
    "mercator_1sp": "墨卡托投影",
    "mercator_2sp": "墨卡托投影",
    "popular_visualisation_pseudo_mercator": "网络墨卡托投影",
    "web_mercator": "网络墨卡托投影",
    "transverse_mercator": "横轴墨卡托投影",
    "gauss_kruger": "高斯克吕格投影",
    "gauss_kruger_transverse_mercator": "高斯克吕格投影",
    "oblique_mercator": "斜轴墨卡托投影",
    "hotine_oblique_mercator": "斜轴墨卡托投影",
    "stereographic": "球面投影",
    "polar_stereographic": "极射赤面投影",
    "double_stereographic": "双标准纬线球面投影",
    "oblique_stereographic": "斜轴球面投影",
    "polyconic": "多圆锥投影",
    "american_polyconic": "美国多圆锥投影",
    "krovak": "克洛万投影",
    "cassini_soldner": "卡西尼投影",
    "cassini": "卡西尼投影",
    "equidistant_cylindrical": "等距圆柱投影",
    "equirectangular": "等距圆柱投影",
    "azimuthal_equidistant": "方位等距投影",
    "mollweide": "摩尔魏特投影",
    "robinson": "罗宾逊投影",
    "sinusoidal": "斜等距圆柱投影",
    "van_der_grinten": "范德格林滕投影",
}

PARAM_LABELS = {
    "latitude_of_origin": "原点纬度",
    "latitude_of_center": "中心纬度",
    "longitude_of_origin": "原点经线",
    "central_meridian": "中央经线",
    "longitude_of_center": "中央经线",
    "standard_parallel_1": "第一标准纬线",
    "parallel_1": "第一标准纬线",
    "latitude_of_1st_standard_parallel": "第一标准纬线",
    "latitude_of_1st_parallel": "第一标准纬线",
    "standard_parallel_2": "第二标准纬线",
    "parallel_2": "第二标准纬线",
    "latitude_of_2nd_standard_parallel": "第二标准纬线",
    "latitude_of_2nd_parallel": "第二标准纬线",
    "scale_factor": "比例因子",
    "false_easting": "假东偏距",
    "false_northing": "假北偏距",
    "azimuth": "方位角",
    "rectified_grid_angle": "改正网格方位角",
}


def _norm_key(text):
    import re

    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")

# 单位一律用国际写法：和数字挨在一起时"500 × 500 米"比"500 × 500 m"占地方得多
UNIT_LABELS = {
    "metre": "m",
    "meter": "m",
    "kilometre": "km",
    "kilometer": "km",
    "foot": "ft",
    "us_survey_foot": "ft (US survey)",
    "clarke_foot": "ft (Clarke)",
    "indian_foot": "ft (India)",
    "degree": "°",
    "degrees": "°",
    "angular_degree": "°",
    "nautical_mile": "nmi",
    "chain_benoit": "chain (Benoit)",
    "yard": "yd",
}

# OGR 字段类型名：直接写引擎读到的类型，不翻译成"整数""小数"这种含糊说法——
# 用户看的是"这个字段到底存成什么"，Real 和 Integer64 的区别不能糊掉
FIELD_TYPE_LABELS = {
    "integer": "Integer",
    "integer64": "Integer64",
    "real": "Real",
    "string": "String",
    "date": "Date",
    "datetime": "DateTime",
    "time": "Time",
    "binary": "Binary",
    "integerlist": "IntegerList",
    "realist": "RealList",
    "stringlist": "StringList",
    "widestring": "WideString",
}


def unit(name):
    if not name:
        return None
    return UNIT_LABELS.get(_norm_key(name), str(name))


def field_type(name):
    if not name:
        return None
    return FIELD_TYPE_LABELS.get(_norm_key(name), str(name))


def compression(value):
    if not value:
        return "未记录"
    return COMPRESSION_LABELS.get(str(value).upper(), str(value))


def driver(name):
    if not name:
        return "未知格式"
    return DRIVER_LABELS.get(name, name)


def data_type(name):
    return DATA_TYPE_LABELS.get(name, name or "未知")


def color_interp(name):
    if not name:
        return "未指定"
    return COLOR_INTERP_LABELS.get(name, name)


def method(name):
    if not name:
        return None
    return METHOD_LABELS.get(_norm_key(name), str(name).replace("_", " "))


def param(name):
    if name in (None, ""):
        return None
    got = PARAM_LABELS.get(_norm_key(name))
    if got:
        return got
    return PARAM_LABELS.get(str(name))


def geom_type(name):
    if not name:
        return "无几何"
    return GEOM_TYPE_NAMES.get(name, name)


def human_size(num_bytes):
    """给人看的文件大小，中文习惯用 MB 而不是 MiB。"""
    b = float(num_bytes)
    for unit_name, limit in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if b >= limit:
            return f"{b / limit:.2f} {unit_name}"
    return f"{int(b)} 字节"


def human_count(n):
    if n >= 100_000_000:
        return f"{n / 100_000_000:.2f} 亿"
    if n >= 10_000:
        return f"{n / 10_000:.1f} 万"
    return str(int(n))

# 驱动抛出来的英文报错，换成一句人话。放这里是因为矢量层也要用，
# 而 inspect 层反过来被 vector 引用，不能两边互相 import。
FRIENDLY_HINTS = (
    ("failed to read directory", "文件结构不完整，像是被截断或在保存中断"),
    ("cannot read tiff directory", "文件结构不完整，像是被截断或在保存中断"),
    ("not recognized as being in a supported file format", "无法识别的文件格式"),
    ("no such file or directory", "找不到需要的配套文件"),
    ("does not support this version", "文件版本较新，当前读取组件只支持 AutoCAD 2000 及更早版本"),
    ("non increasing node id", "OSM 数据里的节点编号不是递增的，需要改用兼容索引方式读取"),
    ("unique constraint failed", "OSM 数据里有重复的编号，建立索引时冲突；换成正规导出的提取文件即可"),
    ("failed inserting node", "OSM 数据里有重复的节点，建立索引时冲突；换成正规导出的提取文件即可"),
    ("permission denied", "文件正被其他程序占用，或没有读取权限"),
    ("is not a valid", "文件内容与声明的格式不一致"),
    ("unsupported", "暂不支持这个版本的文件"),
)


def friendly_error(detail):
    """把驱动抛出的英文技术信息换成一句人话。"""
    text = re.sub(r"^[\w./:\-]+:\s*", "", str(detail or "")).strip()
    low = text.lower()
    for key, phrase in FRIENDLY_HINTS:
        if phrase and key in low:
            return phrase
    return (text or "未知原因")[:180]
