"""Windows 长路径：超过 260 字符时补 `\\\\?\\` 前缀再交给系统调用。

GDAL 自己会补（实测 316 字符的 geojson / json / csv / tif 全部能打开），Python 的
os.stat 与 os.path.exists 不会，于是"这个文件在不在"这一步先把能读的判成找不到，
用户看到的是"找不到这个文件"。

只在探测时用：回给界面的路径、交给 GDAL 的路径都不能带前缀，`\\\\?\\D:\\...` 没人看得懂。
"""

import os

PREFIX = "\\\\?\\"
LONG_ENOUGH = 248      # 与 260 之间留一点余量；短路径不加前缀，免得凭空变成另一种写法


def long_path(path):
    """长路径加前缀，其余原样返回。"""
    if os.name != "nt":
        return str(path)
    text = str(path)
    if text.startswith(PREFIX):
        return text
    full = os.path.abspath(text)
    if len(full) < LONG_ENOUGH:
        return text
    return PREFIX + full.replace("/", "\\")


def stat(path):
    try:
        return os.stat(path)
    except OSError:
        long = long_path(path)
        if long == str(path):
            raise
        return os.stat(long)


def isdir(path):
    return os.path.isdir(long_path(path))


def exists(path):
    try:
        stat(path)
        return True
    except OSError:
        return False
