"""高德瓦片纠偏代理。

高德的栅格瓦片按 GCJ-02 经纬网切分，直接叠在标准经纬网上会偏 300~600 米。
这里逐像素把输出瓦片重采样回标准经纬网：动的只是底图的像素，
用户数据的坐标一个字节都不改（底图只是参照物，不能反过来挪数据）。
"""

import math
import threading
import warnings
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np

# 瓦片本来就没有地理信息，这个提示对纯图像操作没意义
warnings.filterwarnings("ignore", message=".*no geotransform.*")

TILE = 256
A = 6378245.0
EE = 0.00669342162296594323
CHINA_BOX = (72.004, 0.8293, 137.8347, 55.8271)
HOSTS = ("webst01", "webst02", "webst03", "webst04")
STYLE = "6"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
MAX_LEVEL = 18
MEM_CACHE = 3000

_cache_dir = None
_mem = {}
_lock = threading.Lock()


def set_cache_dir(path):
    global _cache_dir
    _cache_dir = Path(path) / "tiles"
    _cache_dir.mkdir(parents=True, exist_ok=True)


def _disk_key(z, x, y):
    return _cache_dir / "amap" / str(z) / str(x) / ("%d.png" % y)


def _shift_lat(x, y):
    r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * np.sqrt(np.abs(x))
    r = r + (20.0 * np.sin(6.0 * x * math.pi) + 10.0 * np.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r = r + (20.0 * np.sin(y * math.pi) + 40.0 * np.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    r = r + (160.0 * np.sin(y / 12.0 * math.pi) + 320.0 * np.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return r


def _shift_lon(x, y):
    r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * np.sqrt(np.abs(x))
    r = r + (20.0 * np.sin(6.0 * x * math.pi) + 20.0 * np.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r = r + (20.0 * np.sin(x * math.pi) + 40.0 * np.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    r = r + (150.0 * np.sin(x / 12.0 * math.pi) + 300.0 * np.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return r


def wgs84_to_gcj02(lon, lat):
    """标准经纬度 → 高德经纬度。入参可以是标量或可广播的数组。"""
    dx = lon - 105.0
    dy = lat - 35.0
    d_lon = _shift_lon(dx, dy)
    d_lat = _shift_lat(dx, dy)
    rad = lat / 180.0 * math.pi
    magic = 1.0 - EE * np.sin(rad) * np.sin(rad)
    root = np.sqrt(magic)
    d_lat = d_lat * 180.0 / ((A * (1.0 - EE)) / (magic * root) * math.pi)
    d_lon = d_lon * 180.0 / (A / root * np.cos(rad) * math.pi)
    x0, y0, x1, y1 = CHINA_BOX
    inside = (lon > x0) & (lon < x1) & (lat > y0) & (lat < y1)
    return np.where(inside, lon + d_lon, lon), np.where(inside, lat + d_lat, lat)


def _fetch(url):
    req = Request(url, headers={"User-Agent": UA, "Referer": "https://www.amap.com/"})
    try:
        with urlopen(req, timeout=8) as resp:
            data = resp.read()
    except Exception:
        return b""
    return data if data[:8] == b"\x89PNG\r\n\x1a\n" or data[:2] == b"\xff\xd8" else b""


def _raw(z, x, y):
    """取一张高德原始瓦片（未纠偏），带内存和磁盘两级缓存。"""
    n = 2 ** z
    if x < 0 or y < 0 or x >= n or y >= n:
        return b""
    key = (z, x, y)
    with _lock:
        hit = _mem.get(key)
    if hit is not None:
        return hit
    host = HOSTS[(x + y) % len(HOSTS)]
    data = _fetch("https://%s.is.autonavi.com/appmaptile?style=%s&x=%d&y=%d&z=%d"
                  % (host, STYLE, x, y, z))
    with _lock:
        if len(_mem) > MEM_CACHE:
            _mem.clear()
        _mem[key] = data
    return data


def _decode(blob):
    if not blob:
        return None
    # rasterio 只有纠偏瓦片才用得到，放到函数里导，引擎启动能省 100 多毫秒
    from rasterio.io import MemoryFile
    try:
        with MemoryFile(blob) as mem:
            with mem.open() as src:
                arr = src.read()
    except Exception:
        return None
    if arr is None or arr.ndim != 3:
        return None
    if arr.shape[0] == 1:
        arr = np.repeat(arr, 3, axis=0)
    if arr.shape[0] == 3:
        alpha = np.full((1,) + arr.shape[1:], 255, dtype="uint8")
        arr = np.concatenate([arr, alpha], axis=0)
    if arr.shape[0] != 4:
        return None
    return np.transpose(arr, (1, 2, 0))


def _encode(rgba):
    from rasterio.io import MemoryFile
    h, w = rgba.shape[:2]
    with MemoryFile() as mem:
        with mem.open(driver="PNG", width=w, height=h, count=4, dtype="uint8") as dest:
            for i in range(4):
                dest.write(rgba[:, :, i], i + 1)
        return mem.read()


def _plain(z, x, y):
    """取不到或算不动时，原样给回高德瓦片：宁可偏一点，也不要地图上开天窗。"""
    blob = _raw(z, x, y)
    if not blob:
        return None
    img = _decode(blob)
    return _encode(img) if img is not None else None


def render(z, x, y):
    """输出标准经纬网下第 (z,x,y) 张瓦片的 PNG 字节。"""
    z = int(z)
    x = int(x)
    y = int(y)
    if z < 0 or z > MAX_LEVEL:
        return None
    path = _disk_key(z, x, y) if _cache_dir else None
    if path and path.is_file():
        try:
            return path.read_bytes()
        except OSError:
            pass
    n = 2 ** z
    span = 1.0 / TILE
    frac = (np.arange(TILE) + 0.5) * span
    lon = ((x + frac) / n) * 360.0 - 180.0
    lat = np.arctan(np.sinh(math.pi * (1.0 - 2.0 * (y + frac) / n))) * 180.0 / math.pi
    glon, glat = wgs84_to_gcj02(lon[None, :], lat[:, None])
    src_x = (glon + 180.0) / 360.0 * n * TILE
    src_y = (1.0 - np.arcsinh(np.tan(glat / 180.0 * math.pi)) / math.pi) / 2.0 * n * TILE
    x0 = int(np.floor(src_x.min() / TILE))
    x1 = int(np.floor(src_x.max() / TILE))
    y0 = int(np.floor(src_y.min() / TILE))
    y1 = int(np.floor(src_y.max() / TILE))
    if (x1 - x0 + 1) * (y1 - y0 + 1) > 4:
        return _plain(z, x, y)
    mosaic = np.zeros(((y1 - y0 + 1) * TILE, (x1 - x0 + 1) * TILE, 4), dtype="uint8")
    got = False
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            img = _decode(_raw(z, tx, ty))
            if img is None:
                continue
            got = True
            mosaic[(ty - y0) * TILE:(ty - y0 + 1) * TILE,
                   (tx - x0) * TILE:(tx - x0 + 1) * TILE] = img
    if not got:
        return None
    col = np.clip(np.rint(src_x - x0 * TILE).astype("int32"), 0, mosaic.shape[1] - 1)
    row = np.clip(np.rint(src_y - y0 * TILE).astype("int32"), 0, mosaic.shape[0] - 1)
    out = _encode(mosaic[row, col])
    if path and out:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(out)
        except OSError:
            pass
    return out
