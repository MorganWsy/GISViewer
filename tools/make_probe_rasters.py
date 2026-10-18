"""造两个小栅格用于自测：三波段带名称的、带调色板的分类栅格。"""
import numpy as np
import rasterio
from rasterio.transform import from_origin

h = w = 420
gt = from_origin(110.0, 30.0, 0.004, 0.004)
yy, xx = np.mgrid[0:h, 0:w]

with rasterio.open("tests/fixtures/multi_bands.tif", "w", driver="GTiff",
                   height=h, width=w, count=3, dtype="uint8",
                   crs="EPSG:4326", transform=gt) as d:
    d.write((xx / 4).astype("uint8"), 1)
    d.write((yy / 4).astype("uint8"), 2)
    d.write(((xx + yy) / 8).astype("uint8"), 3)
    d.descriptions = ("高程", "坡度", "水系密度")

cls = (np.where(xx < w // 2, 0, 1) + np.where(yy < h // 2, 0, 2)).astype("uint8")
pal = {0: (26, 102, 178, 255), 1: (214, 94, 0, 255),
       2: (62, 150, 80, 255), 3: (230, 200, 60, 255)}
with rasterio.open("tests/fixtures/class_palette.tif", "w", driver="GTiff",
                   height=h, width=w, count=1, dtype="uint8",
                   crs="EPSG:4326", transform=gt) as d:
    d.write(cls, 1)
    d.write_colormap(1, pal)
print("ok")
