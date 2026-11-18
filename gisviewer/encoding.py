"""属性表编码识别。

分两类：一类是"字节自己定编码"的格式（shp 的 DBF、csv），要真的去认；
另一类（FileGDB、GeoPackage、GeoJSON 等）按规范固定 UTF-8，直接给名字。
界面只显示识别结果（UTF-8、GBK 这类名字），不显示依据与置信度。

实测（GDAL 3.10.3，见 2026-11-13 的回归）：
- `.cpg` 认；里面写 GBK、CP936、UTF-8 都按它解码
- 没有 `.cpg` 时看 DBF 第 29 字节的 LDID，0x57（ANSI）按 CP1252 解，GBK 内容因此出乱码
- `SHAPE_ENCODING` 可以整体覆盖上面两条，值为 GDAL 认识的编码名
"""

import os
import zipfile

# 常见写法归一到界面用的名字；GDAL 那边用 _GDAL 里的名字
_LABELS = {
    "utf-8": "UTF-8", "utf8": "UTF-8", "65001": "UTF-8", "utf8sig": "UTF-8",
    "gbk": "GBK", "cp936": "GBK", "936": "GBK", "gb2312": "GBK", "gb-2312": "GBK",
    "gb18030": "GB18030", "gb-18030": "GB18030",
    "big5": "Big5", "cp950": "Big5", "950": "Big5",
    "shiftjis": "Shift-JIS", "shift_jis": "Shift-JIS", "cp932": "Shift-JIS", "932": "Shift-JIS",
    "iso-8859-1": "ISO-8859-1", "8859-1": "ISO-8859-1", "latin1": "ISO-8859-1",
    "latin-1": "ISO-8859-1",
    "windows-1252": "CP1252", "cp1252": "CP1252", "1252": "CP1252", "ansi": "CP1252",
    "utf-16": "UTF-16", "utf16": "UTF-16", "unicode": "UTF-16",
}

# 界面名 → 传给 GDAL SHAPE_ENCODING 的名字（GDAL 靠 iconv 认，用它文档里的写法）
_GDAL = {
    "UTF-8": "UTF-8", "GBK": "GBK", "GB18030": "GB18030", "Big5": "BIG5",
    "Shift-JIS": "SHIFT_JIS", "ISO-8859-1": "ISO-8859-1", "CP1252": "CP1252",
    "UTF-16": "UTF-16",
}

# 嗅探顺序：先严格 UTF-8（无 BOM 的 UTF-8 也认），再 GB18030，再 Big5。
# GB18030 是 GBK 的超集，能按 GBK 干净解码时界面写"GBK"，认的用户更多
_SNIFF = (("utf-8", "UTF-8"), ("gb18030", "GB18030"), ("big5", "Big5"))


def _norm(name):
    key = str(name or "").strip().lower().replace(" ", "").replace("_", "-")
    return _LABELS.get(key) or _LABELS.get(key.replace("-", "")) or None


def _dbf_sample(path, max_records=200):
    """取 DBF 里字符字段的原始字节（最多前 max_records 条）与 LDID。"""
    try:
        with open(path, "rb") as fh:
            return _dbf_sample_fh(fh, max_records)
    except OSError:
        return b"", 0


def _dbf_sample_fh(fh, max_records=200):
    """同上，但读的是已打开的文件对象：压缩包里的 .dbf 只能这样读。"""
    header = fh.read(32)
    if len(header) < 32:
        return b"", 0
    rec_count = int.from_bytes(header[4:8], "little")
    header_size = int.from_bytes(header[8:10], "little")
    rec_size = int.from_bytes(header[10:12], "little")
    ldid = header[29]
    if header_size < 33 or rec_size < 1:
        return b"", ldid
    fields = []
    fh.seek(32)
    while fh.tell() + 32 <= header_size:
        fd = fh.read(32)
        if not fd or fd[0] == 0x0D:
            break
        fields.append((chr(fd[11]), fd[16]))
    buf = bytearray()
    fh.seek(header_size)
    for _ in range(min(rec_count or 0, max_records)):
        rec = fh.read(rec_size)
        if len(rec) < rec_size:
            break
        off = 1
        for ftype, flen in fields:
            chunk = rec[off:off + flen]
            off += flen
            if ftype in ("C", "M"):
                buf += chunk.rstrip(b" \x00")
    return bytes(buf), ldid


def _csv_sample(path, max_bytes=65536):
    try:
        with open(path, "rb") as fh:
            return fh.read(max_bytes)
    except OSError:
        return b""


def _sniff(data):
    """按内容判编码。纯 ASCII 会先认成 UTF-8，这不影响读出来的字。"""
    if not data:
        return None
    if data.startswith(b"\xef\xbb\xbf"):
        return "UTF-8"
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "UTF-16"
    for codec, label in _SNIFF:
        try:
            data.decode(codec)
        except UnicodeDecodeError:
            continue
        if label == "GB18030":
            # 都是 GBK 里有的字就写 GBK，写不下的（生僻字、竖排符号）才叫 GB18030
            try:
                data.decode("gbk")
                return "GBK"
            except UnicodeDecodeError:
                pass
        return label
    return None


def _zip_parts(path):
    """把 /vsizip/盘:/路径/包.zip/里的文件.shp 拆成（包路径，成员名）。

    压缩包是软件自己用 /vsizip/ 前缀打开的，此时沿包内成员找 .dbf 与 .cpg，
    不能拿 os.path 去问——那串虚拟路径在文件系统上不存在。"""
    low = path.lower()
    if not low.startswith("/vsizip/") or ".zip/" not in low:
        return None
    cut = low.find(".zip/")
    return path[len("/vsizip/"):cut + 4], path[cut + 5:]


def _detect_in_zip(zpath, member):
    low = member.lower()
    if not low.endswith(".shp"):
        return None
    base = member[:-4].lower()
    try:
        with zipfile.ZipFile(zpath) as zf:
            names = {n.lower(): n for n in zf.namelist()}
            data, ldid = b"", 0
            if base + ".dbf" in names:
                with zf.open(names[base + ".dbf"]) as fh:
                    data, ldid = _dbf_sample_fh(fh)
            if base + ".cpg" in names:
                with zf.open(names[base + ".cpg"]) as fh:
                    name = _norm(fh.read(64).decode("utf-8", "replace"))
                if name and _decodable(data, name):
                    return name
    except (OSError, zipfile.BadZipFile):
        return None
    got = _sniff(data)
    if got:
        return got
    return {0x7A: "GBK", 0x7B: "Shift-JIS", 0x78: "Big5", 0x79: "Big5"}.get(ldid)


def detect(target):
    """识别属性表编码，返回界面显示的名字（如 UTF-8、GBK），认不出返回 None。"""
    path = str(target or "")
    low = path.lower()
    try:
        zipped = _zip_parts(path)
        if zipped:
            return _detect_in_zip(*zipped)
        if low.endswith(".shp"):
            base = path[:-4]
            cpg = base + ".cpg"
            data, ldid = _dbf_sample(base + ".dbf") if os.path.exists(base + ".dbf") else (b"", 0)
            if os.path.exists(cpg):
                try:
                    with open(cpg, encoding="utf-8", errors="replace") as fh:
                        name = _norm(fh.read(64))
                except OSError:
                    name = None
                # .cpg 写什么就按什么解，解得动才算数；解不动再按内容判
                if name and _decodable(data, name):
                    return name
            got = _sniff(data)
            if got:
                return got
            # 内容判不出来（空表或全是奇怪字节）时退回 LDID 的常见写法
            return {0x7A: "GBK", 0x7B: "Shift-JIS", 0x78: "Big5", 0x79: "Big5"}.get(ldid)
        if low.endswith(".csv"):
            return _sniff(_csv_sample(path))
    except OSError:
        return None
    return None


def _decodable(data, label):
    if not data:
        return True
    codec = {"GBK": "gbk", "GB18030": "gb18030", "UTF-8": "utf-8", "Big5": "big5",
             "Shift-JIS": "shift_jis", "ISO-8859-1": "latin-1", "CP1252": "cp1252",
             "UTF-16": "utf-16"}.get(label)
    if not codec:
        return True
    try:
        data.decode(codec)
        return True
    except (UnicodeDecodeError, LookupError):
        return False


def gdal_shape_encoding(target):
    """打开 shp 时该给 GDAL 的 SHAPE_ENCODING 值；不用覆盖时返回 None。"""
    path = str(target or "")
    if not path.lower().endswith(".shp"):
        return None
    label = detect(path)
    return _GDAL.get(label) if label else None


# 哪些驱动的属性表编码不固定，值得在信息栏里显示出来
SHOW_FOR_DRIVERS = ("ESRI Shapefile", "CSV")

# 按规范固定用 UTF-8 的驱动：它们读出来的文字已经是 UTF-8，
# 信息栏照给一行，用户不必为"这文件会不会乱码"再猜一次
FIXED_UTF8_DRIVERS = (
    "OpenFileGDB", "FileGDB", "GPKG", "GeoJSON", "TopoJSON", "KML", "LIBKML",
    "GML", "FlatGeobuf", "SQLite", "ESRIJSON", "XLSX", "ODS", "Parquet",
)


def fixed_encoding(driver):
    """编码由格式规范写死的驱动，返回它对外的编码名。"""
    return "UTF-8" if driver in FIXED_UTF8_DRIVERS else None
