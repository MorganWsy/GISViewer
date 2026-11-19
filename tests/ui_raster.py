"""栅格贴图方向回归：整幅图与“按视野重采样”之后都不能翻转。

做法：造一张四象限彩色 GeoTIFF（左上红 / 右上绿 / 左下蓝 / 右下黄），
在浏览器里读画布像素，看每个象限是不是对得上应得的颜色。
早先 refreshRaster 把四角顺序写成（西,南）打头，贴出来就是整张图转了 180°——
肉眼不容易发现，像素一比就露馅。

依赖 Edge + playwright-cli；机器没有时明确跳过（不算失败）。
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = (
    "() => (async () => {"
    " const m = GisMap.__map();"
    " await new Promise((r) => setTimeout(r, 900));"
    " const cv = m.getCanvas();"
    " const g = document.createElement('canvas');"
    " g.width = cv.width; g.height = cv.height;"
    " const ctx = g.getContext('2d');"
    " ctx.drawImage(cv, 0, 0);"
    " const sx = cv.width / cv.clientWidth;"
    " const px = (lng, lat) => {"
    "   const p = m.project([lng, lat]);"
    "   const d = ctx.getImageData(Math.round(p.x * sx), Math.round(p.y * sx), 1, 1).data;"
    "   return [d[0], d[1], d[2]];"
    " };"
    " const c = m.getCenter();"
    " const src = m.getSource('gis-image');"
    " return JSON.stringify({"
    "   zoom: +m.getZoom().toFixed(2),"
    "   center: [+c.lng.toFixed(3), +c.lat.toFixed(3)],"
    "   corners: src ? src.coordinates : null,"
    "   q: {NW: px(101.7, 22.3), NE: px(102.3, 22.3), SW: px(101.7, 22.3 - 0.6), SE: px(102.3, 21.7)}"
    " });"
    "})()"
)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def cli(*args, timeout=90):
    cmd = ["npx", "--yes", "--package", "@playwright/cli", "playwright-cli",
           "--session", "tulan-ui-raster"]
    return subprocess.run(cmd + list(args), capture_output=True, text=True,
                          encoding="utf-8", errors="replace",
                          timeout=timeout, cwd=str(ROOT), check=False)


def make_fixture(path):
    """四象限彩图：100~104E、20~24N，左上红、右上绿、左下蓝、右下黄。"""
    # 只有这一处用得上，放函数内导入：没装 rasterio 的机器上其余用例照样跑
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds

    size = 64
    arr = np.zeros((3, size, size), dtype="uint8")
    half = size // 2
    arr[0, :half, :half] = 255                                  # 左上 红
    arr[1, :half, half:] = 255                                  # 右上 绿
    arr[2, half:, :half] = 255                                  # 左下 蓝
    arr[0, half:, half:] = 255
    arr[1, half:, half:] = 255                                  # 右下 黄
    with rasterio.open(
        str(path), "w", driver="GTiff", height=size, width=size, count=3,
        dtype="uint8", crs="EPSG:4326",
        transform=from_bounds(100, 20, 104, 24, size, size),
    ) as ds:
        ds.write(arr)


def dominant(rgb):
    """哪个通道最大就是哪个颜色，抗住一点重采样误差。"""
    r, g, b = rgb[:3]
    if r > 120 and g > 120 and b < 90:
        return "黄"
    if r > 120 and g < 90 and b < 90:
        return "红"
    if g > 120 and r < 90 and b < 90:
        return "绿"
    if b > 120 and r < 90 and g < 90:
        return "蓝"
    return "?"


def check(parsed, where):
    want = {"NW": "红", "NE": "绿", "SW": "蓝", "SE": "黄"}
    bad = []
    for key, expect in want.items():
        got = dominant(parsed["q"][key])
        if got != expect:
            bad.append(f"{where} {key}: 期望{expect}，实际{got} {parsed['q'][key]}")
    corners = parsed.get("corners") or []
    if len(corners) == 4:
        # 四角顺序必须是「左上、右上、右下、左下」：第一个角是西北角
        tl, tr, br, bl = corners
        if not (tl[1] > br[1] and tl[0] < tr[0] and tr[1] > br[1]):
            bad.append(f"{where} 四角顺序不对: {corners}")
    return bad


def main():
    try:
        import rasterio  # noqa: F401  -- 检查依赖在不在
    except Exception:  # noqa: BLE001
        print("SKIP: 没有 rasterio，跳过栅格方向回归")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix="tulan-ui-raster-"))
    fixture = tmp / "quadrants.tif"
    make_fixture(fixture)
    old_data = os.environ.get("GISVIEWER_DATA_DIR")
    env = dict(os.environ)
    env["GISVIEWER_DATA_DIR"] = str(tmp / "data")
    env.pop("GISVIEWER_TOKEN", None)
    port = free_port()
    server = None
    try:
        server = subprocess.Popen(
            [sys.executable, "-m", "gisviewer.server", "--port", str(port), "--no-open"],
            cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        base = f"http://127.0.0.1:{port}"
        for _ in range(120):
            try:
                urllib.request.urlopen(base + "/", timeout=0.5)  # pi-lens-ignore: S310 -- 只访问本机测试服务
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.1)
        else:
            print("server did not start")
            return 2

        opened = cli("open", "--browser", "msedge",
                     f"{base}/?path={urllib.parse.quote(str(fixture))}")
        if opened.returncode != 0:
            print("SKIP: playwright-cli/Edge unavailable")
            print((opened.stderr or opened.stdout)[-300:])
            return 0

        for _ in range(40):
            got = cli("eval", "() => !!document.querySelector('#map canvas')")
            if "true" in (got.stdout or "").lower():
                break
            time.sleep(0.25)

        import json  # noqa: PLC0415

        def sample(label):
            got = cli("eval", SAMPLE)
            raw = (got.stdout or "").strip()
            line = next((x for x in raw.splitlines() if x.startswith('"')), "")
            if not line:
                print(f"FAIL: {label} 读不到画布结果: {raw[-200:]}")
                return None
            return json.loads(json.loads(line))

        full = sample("整幅")
        if full is None:
            return 3
        print("整幅:", full["q"], "corners:", full["corners"])
        bad = check(full, "整幅")

        # 放大到视野比数据小：这会触发按视野重采样的那张新贴图
        cli("eval", "() => { GisMap.__map().jumpTo({center: [102, 22], zoom: 8}); return 1; }")
        time.sleep(1.2)
        zoomed = sample("放大后")
        if zoomed is None:
            return 3
        print("放大后:", zoomed["q"], "corners:", zoomed["corners"])
        bad += check(zoomed, "放大后")

        if bad:
            for line in bad:
                print("FAIL:", line)
            return 3
        print("ui raster: ok（整幅与重采样后方向一致）")
        return 0
    finally:
        cli("close", timeout=30)
        if server:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        if old_data is None:
            os.environ.pop("GISVIEWER_DATA_DIR", None)
        else:
            os.environ["GISVIEWER_DATA_DIR"] = old_data
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
