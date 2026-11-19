"""栅格按视野重采样：放大后不该是 512 个像素被拉满屏。

手工跑：app\\runtime\\python.exe tests\\raster_view.py
"""

from __future__ import annotations

import struct
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gisviewer import cache, server  # noqa: E402

SAMPLE = ROOT / "data" / "samples" / "pre_2000_01.tif"
CHECKS: list[str] = []
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (CHECKS if ok else FAILED).append(f"{name}{(' — ' + detail) if detail else ''}")
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))


def png_size(blob: bytes) -> tuple[int, int]:
    return struct.unpack(">II", blob[16:24])


def main() -> int:
    if not SAMPLE.exists():
        print(f"SKIP 样本不存在：{SAMPLE}")
        return 0

    full, _fw, _fh = server.thumbnail(SAMPLE, 1)
    fw, fh = png_size(full)
    box = server.raster_grid(SAMPLE, [1], 512)[1]
    check("整幅缩略图仍是 512 宽", fw == 512, f"{fw}x{fh}")

    # 视野取整幅的 1/20，正好是“放大 20 倍后应该看到的那块”
    w, s, e, n = box
    cx, cy = (w + e) / 2, (s + n) / 2
    dw, dh = (e - w) * 0.025, (n - s) * 0.025
    view = [cx - dw, cy - dh, cx + dw, cy + dh]

    view_png, _vw, _vh = server.thumbnail(SAMPLE, 1, max_side=2048, bbox=view)
    cover = server.raster_grid(SAMPLE, [1], 512, bbox=view)[1]
    vw, vh = png_size(view_png)
    check("视野图长边到 2048", max(vw, vh) == 2048, f"{vw}x{vh}")
    check("视野图比整幅宽得多", vw > fw * 2, f"{vw} vs {fw}")
    check("视野在数据内部时，返回框就是请求框",
          all(abs(a - b) < 1e-6 for a, b in zip(view, cover, strict=True)), str([round(v, 4) for v in cover]))

    # 只给一部分重叠：返回的框必须被数据边界截住，不能把边缘拉伸着铺出去
    far = [e - (e - w) * 0.02, cy - dh, e + (e - w) * 0.2, cy + dh]
    edge_arrays, edge_cover = server.raster_grid(SAMPLE, [1], 512, bbox=far)
    ew, eh = png_size(server.thumbnail(SAMPLE, 1, max_side=1024, bbox=far)[0])
    check("视野部分越界也能出图", ew > 0 and eh > 0, f"{ew}x{eh}")
    # 投影数据靠重投影的 NoData 留白，返回框保持请求框；越界那一侧必须是透明/掩膜
    check("越界视野返回框仍是请求框",
          all(abs(a - b) < 1e-6 for a, b in zip(far, edge_cover, strict=True)),
          str([round(v, 4) for v in edge_cover]))
    edge_arr = edge_arrays[0]
    right_col = edge_arr.mask[:, -1] if edge_arr.mask.ndim == 2 else edge_arr.mask
    check("越界那一列是空像元", bool(right_col.all()), f"{int(right_col.sum())}/{right_col.size}")

    # 完全在数据外面：不该出错，给一张空的
    outside, _ow, _oh = server.thumbnail(SAMPLE, 1, max_side=512,
                                        bbox=[e + 10, n + 10, e + 20, n + 20])
    ow, oh = png_size(outside)
    check("完全越界返回 1x1 占位", (ow, oh) == (1, 1), f"{ow}x{oh}")

    # 分级设色也要吃到同一个 bbox，否则放大后颜色分级和影像对不上
    edges = [0, 7.8, 19.5, 42.9, 70.2, 249.7]
    colors = ["#440154", "#3b528a", "#22908c", "#5fc861", "#fde725"]
    cls, _cw, _ch = server.class_image(SAMPLE, 1, edges, colors, fill=None,
                                      max_side=1024, bbox=view)
    cw, ch = png_size(cls)
    check("分级图同样按视野出图", max(cw, ch) == 1024, f"{cw}x{ch}")

    # 地理坐标数据走的是另一条分支：没有重投影，贴图框必须用被数据边界截过的框，
    # 不然超出数据的那一侧会被拉伸着铺过去
    geo = ROOT / "tests" / "fixtures" / "big_sparse.tif"
    if geo.exists():
        gw, gs, ge, gn = server.raster_grid(geo, [1], 512)[1]
        gview = [ge - (ge - gw) * 0.1, gs + (gn - gs) * 0.2,
                 ge + (ge - gw) * 0.3, gs + (gn - gs) * 0.4]
        _ga, gcover = server.raster_grid(geo, [1], 512, bbox=gview)
        check("经纬度数据越界时贴图框被截到数据边界", gcover[2] <= ge + 1e-9,
              f"cover.right={gcover[2]:.4f} <= data.right={ge:.4f}")

    # 视野贴图的内存缓存：同一块视野再要一次不该重算，超大图不硬塞进内存
    cache.init(Path(tempfile.mkdtemp(prefix="tulan-view-cache-")))
    png1, _pw, _ph = server.thumbnail(SAMPLE, 1, max_side=1024, bbox=view)
    key = cache.key("view", SAMPLE, "t=1")
    cache.save_view(key, png1)
    again = cache.load_view(key)
    check("视野贴图能进内存缓存", again == png1, f"{len(png1)} B")
    big = b"x" * (17 * 1024 * 1024)
    cache.save_view(cache.key("view", SAMPLE, "t=2"), big)
    check("超过 16 MB 的贴图不进内存",
          cache.load_view(cache.key("view", SAMPLE, "t=2")) is None, "17 MB 被拒")

    # 窗口尺度的读数对不对：取视野中心，源数组里应该不是全 NoData
    arrays, cover2 = server.raster_grid(SAMPLE, [1], 512, bbox=view)
    arr = arrays[0]
    valid = int(arr.count())
    check("视野中心有有效像元", valid > arr.size * 0.5, f"{valid}/{arr.size}")

    print()
    print(f"栅格视野重采样：{len(CHECKS)} 项通过，{len(FAILED)} 项失败")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    raise SystemExit(main())
