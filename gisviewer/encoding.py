# -*- coding: utf-8 -*-
"""属性表编码识别。

只处理"字节自己定编码"的格式：shp 的 DBF、csv。GeoJSON、GPKG、KML 按规范就是 UTF-8，
不参与识别。界面只显示识别结果（UTF-8、GBK 这类名字），不显示依据与置信度。

实测（GDAL 3.10.3，见 2026-11-13 的回归）：
- `.cpg` 认；里面写 GBK、CP936、UTF-8 都按它解码
- 没有 `.cpg` 时看 DBF 第 29 字节的 LDID，0x57（ANSI）按 CP1252 解，GBK 内容因此出乱码
- `SHAPE_ENCODING` 可以整体覆盖上面两条，值为 GDAL 认识的编码名
"""

import os

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
    with open(path, "rb") as fh:
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
    with open(path, "rb") as fh:
        return fh.read(max_bytes)


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


def detect(target):
    """识别属性表编码，返回界面显示的名字（如 UTF-8、GBK），认不出返回 None。"""
    path = str(target or "")
    low = path.lower()
    try:
        if low.endswith(".shp"):
            base = path[:-4]
            cpg = base + ".cpg"
            data, ldid = _dbf_sample(base + ".dbf") if os.path.exists(base + ".dbf") else (b"", 0)
            if os.path.exists(cpg):
                try:
                    name = _norm(open(cpg, "r", encoding="utf-8", errors="replace").read(64))
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
    return _GDAL.get(label)


# 哪些驱动的属性表编码不固定，值得在信息栏里显示出来
SHOW_FOR_DRIVERS = ("ESRI Shapefile", "CSV")
