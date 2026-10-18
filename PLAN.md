# GISViewer 实施计划

项目位置：`D:\GISViewer`
立项日期：2026-10-11
本文档记录已核实的事实和已做的决定，避免后续遗忘或重复验证。改动事实部分时更新本节日期。

---

## 0. 一句话目标

把文件拖进来，一秒内看到这个 GIS 文件的全部关键信息和空间分布，替代"为此打开一次 ArcGIS Pro / QGIS"。

它不是轻量 GIS 软件，是**文件体检工具**。凡是增加编辑、分析、符号化能力的提议都先拒绝。

---

## 1. 硬性要求

1. **免安装 + 原生窗口**，后续要能分发给别人（用户明确表态）。
2. **拖拽和上传两种入口都要有**，路径输入框也要有（大文件靠它做到零拷贝秒开）。
3. **深/浅两套主题**，跟随系统并可手动覆盖。
4. **有底图 / 无底图两种模式**在界面内一键切换。
5. 引擎层与界面壳分离：换分发形态只能加入口文件，不许重写解析和界面代码。

---

## 2. 已核实的环境事实（2026-10-11 实测）

### 运行时

- Python 3.12.7，miniconda 在 `D:\Software\miniconda`
- Node v22.18.0、npm 10.9.3（本项目用不上，见第 3 节）
- rasterio 1.4.3、pyogrio 0.11.0、pyproj 3.7.2 / PROJ 9.6.2
- **conda 里是一套完整的 GDAL 3.10.3**：`Library\bin` 下有 `gdal.dll`、`gdalinfo.exe`、`ogrinfo.exe`、`gdal_translate.exe`、`gdalwarp.exe`、`gdalmdiminfo.exe`、`ogr2ogr.exe` 等全套命令行
- rasterio 没有自带 `.libs` 目录，它链接的就是 conda 这套 `gdal.dll` → **环境里只有一份 GDAL**，打包时不会撞版本
- `from osgeo import gdal` 不可用（缺 python 绑定包），但不需要它

### 驱动覆盖（权威结果来自 `gdalinfo --formats` / `ogrinfo --formats`）

可用：

- 矢量：ESRI Shapefile、GeoJSON、GeoJSONSeq、TopoJSON、GPKG、SQLite/Spatialite、**OpenFileGDB（读 `.gdb` 目录）**、**DXF（完整读写）**、MapInfo、GML、LIBKML（含 kmz）、KML、GPX、CSV、XLSX、**OSM（XML 和 PBF 都支持）**、MVT、PMTiles、MBTiles、FlatGeobuf
- 栅格：GTiff、**COG**、**HFA（Erdas .img）**、NITF、RPFTOC、ECRGTOC、Zarr、VRT、GPKG、ENVI、EHdr、KEA 无、WCS/WMS、SNODAS、USGSDEM、RMF、AAIGrid、NGSGEOID
- **DWG：`CAD` 驱动支持读取**（只读，GDAL 逆向实现，非 ODA）。不是完整支持，块参照和某些版本可能失败，但可以先试读、失败再提示转 DXF。

当前缺失（conda-forge 把这些驱动拆成了独立插件包，本环境只装了 `libgdal-core`）：

- **netCDF、HDF4/HDF5、GRIB、JP2OpenJPEG、KEA、ECW、TileDB**
- 补齐办法已验证存在：conda-forge 上有 `libgdal-netcdf` 等插件包（GDAL 会把 dll 放进 `Library\lib\gdalplugins\`）
- 注意版本必须与 `libgdal-core` 对齐，本环境是 3.10.3
- `netcdf.dll`、`hdf.dll`、`mfhdf.dll`、`hdf5.dll` 已经在 `Library\bin` 里了（netcdf4 / pyhdf 带进来的），装插件包不需要再拉一遍运行库

**已解决（Phase 0 完成）**：新环境 `D:\miniAnaconda\envs\gisviewer`，Python 3.12.15、GDAL 3.10.3、rasterio 1.4.4、pyogrio 0.11.0、osgeo 绑定可用。装上 `libgdal-netcdf`、`libgdal-hdf4`、`libgdal-hdf5`（都是 3.10.3 build 27，与 libgdal-core 完全对齐），插件落在 `Library\lib\gdalplugins\`。注册驱动数从 200 涨到 **210**，`netCDF / HDF4 / HDF4Image / HDF5 / HDF5Image` 全部可用，并用 `gdal_create` 写了个 `t.nc` 用 rasterio 成功读回（driver=netCDF）。GRIB 和 JP2OpenJPEG 仍未装，Phase 5 按需再补。

### 启动时必须显式设置的路径（踩过，必须写进引导代码）

1. **用户级持久环境变量 `PROJ_DATA` 和 `GDAL_DATA` 指向 base 环境**（`D:\Software\miniconda\Library\share\...`）。它们会盖过任何其它 GDAL/PROJ 安装。不覆盖的话新环境的 GDAL 去读 base 的 `proj.db`，报 `DATABASE.LAYOUT.VERSION.MINOR = 5 whereas >= 6 is expected`，**后果是所有 EPSG 定义查不到，坐标系识别整个失效**。程序启动时必须用自身目录把这两个变量重写一遍。
2. **GDAL 在 Windows 上按 exe 所在目录推导插件路径**，直接调用 `envs\gisviewer\python.exe` 时找不到 `Library\lib\gdalplugins`，netCDF/HDF 就不注册。要么正确激活环境，要么显式设 `GDAL_DRIVER_PATH`。打包成免安装版后必须走显式设置这条路。
3. **`_gdal.pyd` 需要 `Library\bin` 在 DLL 搜索路径里**（Python 3.8 之后不再从 PATH 找依赖库），否则报 `DLL load failed while importing _gdal`。base 环境里那个 `No module named '_gdal'` 也是同一个原因，不是没装。引导代码里要先 `os.add_dll_directory(<env>\Library\bin)` 再 import osgeo。

### 压缩信息的正确读法（已定位，别再绕）

`COMPRESSION` 在 **dataset 级的 `IMAGE_STRUCTURE` 域**，不在波段级：

- `ds.GetMetadata('IMAGE_STRUCTURE')` → `{'COMPRESSION': 'LZW', 'INTERLEAVE': 'BAND'}` ✅
- `ds.GetRasterBand(1).GetMetadata('IMAGE_STRUCTURE')` → `{}` ❌（之前误在这里找）
- rasterio 的 `ds.tags(1, ns='IMAGE_STRUCTURE')` 也返回空，**这项必须用 osgeo 读**
- 统计值在波段默认域：`STATISTICS_MINIMUM/MAXIMUM/MEAN/STDDEV/VALID_PERCENT`，样例里是 `0 / 249.71 / 16.36 / 21.64 / 37.37%`
- `gdal.Info(ds, options=['-json'])` 在 GDAL 3.10 的 Python 绑定里**直接返回 dict**，不是 JSON 字符串

### 样例文件（`D:\GISViewer\samples`，用户提供）

| 文件 | 实测结果 | 暴露的设计问题 |
|---|---|---|
| `China2019.zip` 9.5 MiB | zip 直读 **0.09 秒**，5 个成员（shp/shx/dbf/prj/cpg），35 个面要素，4 个中文字段，编码 UTF-8 | 压缩包不解压直读完全可行；中文属性表字段名要正确处理 |
| `pre_2000_01.tif` 108.9 MiB | GeoTIFF，9665×10509，单波段 Float32，**COMPRESSION=LZW**，条带存储 9665×1 非分块，NoData=-32768，灰度，**无金字塔**，统计值已存在文件内（Min 0 / Max 249.715 / Mean 16.357 / StdDev 21.637），未压缩 387.5 MiB，实/未 = **28.1%** | 未压缩大小和压缩率算法验证通过；统计值优先读文件内已有的，瞬时返回 |
| `wuningGEP.json` 132.2 MiB | GeoJSON FeatureCollection，**109,007 个要素**，EPSG:4326，22 个字段，**geometry_type = Unknown（混合几何类型）**，范围 114.47~115.44 / 28.88~29.57 | 大 GeoJSON 不能整份交给浏览器画，必须后端抽稀；界面要能显示"混合几何类型"并统计各类数量 |

### 最重要的一个真实边界情况

**两个样例用的是同一套自定义 Albers 投影（`China_ Albers Equal Area Conic`），`to_epsg()` 返回 None，没有 EPSG 编码。** 这是国内栅格和 shp 的常态，不是异常。

界面必须这样处理：显示投影名 + 关键参数（中央经线 105、标准纬线 25/47、单位米），并明确写"自定义坐标系，无标准编码"，而不是显示一个空白或 `None`。WKT 全文放进一个可复制的折叠区。

另外 rasterio 的 `ds.tags(1)` 和 `ds.meta['compress']` 在这个文件上返回空/None，而 `gdalinfo` 明确给出 `COMPRESSION=LZW`。**待办：确认 rasterio 读 IMAGE_STRUCTURE 命名空间的正确调用方式，`gdalinfo -json` 作为兜底数据源。**

---

## 3. 架构决定

**不用 Electron，不用 Tauri。** 沿用历书软件（`D:\ICalendar\build.ps1`）已跑通的方案。

三层：

```
C# WinForms + WebView2 壳          几 MB，csc.exe 直接编译
  ├─ 原生窗口 / 单实例 / 深浅色主题
  ├─ OLE 拖放 → DataFormats.FileDrop → 真实绝对路径
  └─ 以 http://127.0.0.1:<随机端口> 加载页面

Python 引擎子进程（sidecar）        ~250-300 MB，GDAL 是体积大头
  ├─ inspect 层：路径 → 元数据 JSON（纯函数，不依赖任何 Web 框架）
  ├─ tile 层：栅格降采样 PNG、矢量抽稀 GeoJSON
  └─ 同时伺服 API 和前端静态页面

前端 HTML + MapLibre GL JS         只做显示，绝不参与文件解析
```

理由记录：

- Electron 空壳要多带约 180 MB Chromium 和一套 Node 运行时；Tauri 强制要求 Rust 工具链（本机未装）。两者省下的都不是大头，GDAL 才躲不掉。
- **只有原生壳能拿到拖放文件的真实路径。** 网页内拖文件只得 File 对象，必须走一次上传；C# 的 `DragEnter` 直接给绝对路径，二十 GB 影像零拷贝打开。
- 打包用 **conda-pack** 而不是 PyInstaller：rasterio 和 pyogrio 各自可能带 GDAL，PyInstaller 去重容易出事，conda-pack 原样搬走环境。
- WebView2 运行时 Win11 自带，分发包照历书的做法带上 `MicrosoftEdgeWebview2Setup.exe` 兜底。
- 构建顺序上，壳放到最后做，它是风险最低的一块。

---

## 4. 界面字段清单与取法

**栅格**

| 显示项 | 取法 |
|---|---|
| 行列数 | `width` × `height` |
| 范围 | `bounds`，四角坐标 + 中心点 |
| 坐标系 | 投影名、EPSG 码或"自定义无编码"、线性单位、轴序；WKT 折叠可复制 |
| 像元大小 | `res`，X/Y 不等时分别列出；同时给经纬度度量的近似值 |
| 波段数量与名称 | `count` + 每波段 `ColorInterp` + `description`（nc/hdf 用变量名） |
| 数据类型与深度 | `dtype` + `itemsize*8` 位，标注有符号/浮点/整型 |
| NoData | 每波段 `nodata`，另标 `mask_flag_enums`（是否有独立掩膜波段） |
| 统计值 | 优先文件内 `STATISTICS_*`；缺失时降采样算，并明确标注"近似值，按 降采样后 数据计算" |
| 压缩算法 | `IMAGE_STRUCTURE/COMPRESSION` + `PREDICTOR`；LZW/Deflate/PackBits/JPEG 等映射成中文可读名 |
| 未压缩大小 | `width × height × count × itemsize`；同时显示实际大小和节省百分比 |
| 存储组织 | 条带/分块、块尺寸、有无金字塔及层数与重采样方式 |
| 像元总量 | `width × height × count`，用"亿"做单位，帮用户判断文件量级 |

**矢量**

| 显示项 | 取法 |
|---|---|
| 要素数 | `read_info()['features']` |
| 几何类型 | `geometry_type`；`Unknown` 时逐层统计实际类型分布 |
| 坐标系 | 同栅格规则 |
| 范围 | `total_bounds`，另给面积占地球/中国比例 |
| 字段表 | 名称、类型、宽度、样例值；中文字段名要正常显示 |
| 伴生文件 | shp 的 `.shx/.dbf/.prj/.cpg/.sbn` 齐全性与编码声明 |
| 压缩包内清单 | zip 内成员与各自大小，识别出有几套图层 |

**界面语言规则**：面向 GIS 使用者，WGS84、EPSG、LZW、NoData 这些保留；但不出现库名、驱动内部名、接口域名。`GTiff/GeoTIFF` 显示成 `GeoTIFF`，`ESRI Shapefile` 显示成 `Shapefile`，`LIBKML` 显示成 `KML`。

---

## 5. 底图与地图显示

### 底图下拉选项（放在设置页）

| 选项 | 密钥 | 说明 |
|---|---|---|
| 天地图 影像 | 用户已有 | **默认** |
| 天地图 矢量 | 同上 | 与影像层配对的注记层 |
| Esri World Imagery | 不需要 | 无偏移，国内一般可直连 |
| OpenStreetMap | 不需要 | 国内不稳定，仅备选 |
| 高德 影像 | 不需要 | 有 GCJ-02 偏移，见下 |
| 无底图 | — | 白底/深底只画数据本身，离线可用 |

**"天地图矢量注记层"是独立开关**，不与底图选项绑定：选了天地图影像可以单独打开注记叠加，选了 Esri 影像也能叠天地图注记（注记层的密钥单独配）。

### 必须遵守的加载方式

页面**必须以 `http://127.0.0.1:<端口>` 加载**。不能用 `file://`，也不能照搬历书的 `SetVirtualHostNameToFolderMapping` 虚拟域名。

原因：天地图的浏览器端密钥校验 Origin/Referer 白名单。后两种情况 Origin 变成 null 或不认识的域名，瓦片请求直接 403，表现为底图全灰。

密钥白名单填 `127.0.0.1` 和 `localhost`。分发给别人时不用改——每个用户都是从自己本机发起，Origin 相同。

密钥会明文躺在包里，可能被刷日配额：默认内置用户的密钥，设置页允许覆盖并说明配额风险。

### 高德的纠偏做在底图侧，不动用户数据（用户明确要求）

天地图（CGCS2000≈WGS84）、Esri、OSM 都不需要纠偏。只有高德需要，做法：

1. 本地服务做瓦片代理，向高德取瓦片
2. 对取回的瓦片做 **GCJ-02 → WGS84** 的重投影：按瓦片范围生成 5×5 控制点网格，用 `gdalwarp` 或 Python 侧仿射/多项式重采样
3. 结果写磁盘缓存（瓦片是幂等的，第二次零成本）
4. 以标准 XYZ 吐给前端

代价：首次浏览某区域时每张瓦片一次重采样（约 10~50 ms），之后走缓存。精度可到米级。pyproj 3.7.2 已具备转换所需能力。

**排期上这是地图部分的最后一项**，因为默认底图是天地图，它不阻塞主线。

### 大矢量的绘制

109,007 要素这种量级不能整份塞给浏览器。第一期做法：后端按当前视野和缩放做**抽稀**（`pyogrio` 读时带 `bbox` +  Douglas-Peucker 容差按缩放分级），单次返回上限设 5 MB 或 5000 要素。范围框、要素重心始终全量显示。

GDAL 有 `MVT` 驱动可写 mbtiles 矢量切片，等抽稀不够用时再上，第一期不做。

---

## 6. 主题

深/浅两套，CSS 变量实现，一套布局两套色板。

- 启动默认跟随系统（读注册表 `AppsUseLightTheme`），设置页可强制覆盖
- 无底图模式下深色主题用深灰底而不是纯黑，浅色主题用纯白
- 栅格缩略图和矢量填色在两套主题下都要有足够对比度，深色主题下给影像加 1px 描边
- 地图控件、信息卡片、表格斑马纹、选中态四类元素两套都要单独调，不允许只靠 `filter: invert()`

---

## 7. 执行步骤

### Phase 0 环境（已完成 2026-10-11）

- [x] 建独立环境，不动 base：`D:\miniAnaconda\envs\gisviewer`，Python 3.12.15 + GDAL 3.10.3 + rasterio 1.4.4 + pyogrio 0.11.0
- [x] 加科学格式插件：`libgdal-netcdf libgdal-hdf4 libgdal-hdf5`
- [x] 验收：驱动数 210，netCDF/HDF4Image/HDF5Image 出现，`t.nc` 读写回环通过
- [x] 已获用户批准后执行
- [ ] 遗留：GRIB / JP2OpenJPEG 未装（Phase 5 按需）；开发期调用一律走 `conda run -n gisviewer` 或在引导代码里显式设三个路径

### Phase 1 引擎（已完成 2026-10-12）

代码在 `D:\GISViewer\gisviewer\`：`bootstrap.py`（路径引导）、`labels.py`（内部名到人话）、`crs.py`（坐标系）、`raster.py`、`vector.py`、`inspect.py`（分发与压缩包）、`__main__.py`（命令行与人话渲染）。测试样例生成器在 `tests/make_fixtures.py`。

- [x] `inspect_file(path) -> dict`，纯函数，不依赖 Web 框架
- [x] 类型识别：先按栅格试、再按矢量试，JSON 走独立嗅探
- [x] `/vsizip/` 直读 zip 与 kmz，枚举包内图层，报告解压后总大小
- [x] 栅格分支：第 4 节字段全部落地，压缩信息用 osgeo 读 dataset 级 IMAGE_STRUCTURE
- [x] 矢量分支：字段名/类型/宽度/示例值、要素数、混合几何类型抽样统计
- [x] 自定义无 EPSG 投影：投影名 + 参数 + 椭球 + 基准 + "无标准编码"文案
- [x] nc/hdf 多变量：枚举子数据集，并为每个变量直接出尺寸、类型、统计
- [x] 错误路径：损坏文件、缺伴生文件、找不到文件、密码 zip 都返回人话标题 + 说明 + 建议
- [x] 命令行 `python -m gisviewer <路径> [--json] [--no-stats]`
- [x] 输出保证是合法 JSON（NaN 和无穷都清掉了），Phase 2 可直接序列化给前端

实测基准（gisviewer 环境，D 盘本地文件）：

| 文件 | 耗时 | 结果 |
|---|---|---|
| `China2019.zip` 9.5 MB | 96 ms | 不解压直读，35 个面要素、中文字段与示例值正确 |
| `pre_2000_01.tif` 108.9 MB / 1.02 亿像元 | 15~22 ms | 统计走文件内已有值 |
| `wuningGEP.json` 132 MB / 10.9 万要素 | 3.5 s | 瓶颈是 GDAL 解析整个 GeoJSON，元数据全出 |
| `big_sparse.tif` 2.25 亿像元（无统计） | 259 ms | 降采样估算，标注"约 1/9 分辨率 · 1666×1666 像元" |
| 同上但 `--no-stats` | 11 ms | 跳过估算的通道 |
| `multi_var.nc` | 12 ms | 2 个变量，各自尺寸与统计 |
| `two_layer.gpkg` | 33 ms | 2 个图层，各自字段表 |
| `truncated.tif` | — | 人话错误，不吐 Python 栈 |

#### 引擎里踩到的新坑（改代码时别退回去）

1. **子数据集键名是单数 `SUBDATASET_1_NAME`**，不是 `SUBDATASETS_1_NAME`。写错时表现为"里面没有栅格波段"，netCDF 打不开且没有任何提示。
2. **一律转成绝对路径再交给 GDAL**。插件驱动（netCDF/HDF）在相对路径下识别不稳定，同一文件出现过一次能开一次不能。`_clean_input()` 已做 `abspath` 加正斜杠。
3. TopoJSON 驱动**只读**，`ogr2ogr -f TopoJSON` 造不出样例，读取没问题。
4. GDAL 打开某些栅格会顺带生成 `.aux.xml`（统计缓存），测试目录里会冒出来，不是 bug。
5. `osgeo` 绑定必须先 `os.add_dll_directory(<env>/Library/bin)`，否则报的是 `No module named '_gdal'`，容易误判成没装。

#### 实测中新增的体检项

`crs.extent_warning()`：坐标数值和声明的坐标系明显矛盾时给提示。KML 和由无 `.prj` 的 shapefile 转出的 GeoJSON 都声明 EPSG:4326，实际坐标却是百万米级投影值，界面直接说"坐标值超出经纬度范围，文件声明的坐标系可能有误（常见于把投影坐标当成经纬度存盘）"。反向矛盾（声明米制投影、数值像经纬度）同样报。

Shapefile 伴生文件检查分成"必需"和"重要"两档：缺 `.shx/.dbf` 提示属性表可能读不出；缺 `.prj` 明确说坐标系信息看不到，不再误报"齐全"。

### Phase 2 服务与界面骨架（已完成 2026-10-12）

- [x] 本地服务：标准库 `http.server` + `ThreadingHTTPServer`，只绑 `127.0.0.1`，不引入 FastAPI/uvicorn
- [x] 接口：`GET /api/inspect?path=`、`POST /api/path`、`POST /api/upload`、`GET /api/thumbnail`、`GET /api/histogram`、`GET|POST /api/config`、`GET /api/formats`、`GET /api/preload`
- [x] 上传目录走系统临时目录（`tempfile.mkdtemp(prefix="gisviewer-")`），退出即 `shutil.rmtree`；路径输入那条通道完全不复制文件
- [x] 单页界面：左列信息卡片（文件/概览/空间信息/坐标系/波段与统计/存储与压缩/字段），右列影像预览 + 栅格值分布 + 空间分布，全部用表格排版
- [x] 三个入口：拖放区、文件选择器、路径输入框
- [x] 深/浅色主题切换（`auto/light/dark`），跟随系统并可手动覆盖

踩过的坑，别再犯：

1. **HTTP 请求头只允许 latin-1**，中文文件名直接放 `X-File-Name` 会在 `fetch` 里抛
   `String contains non ISO-8859-1 code point`，请求根本发不出去。
   现在前端 `encodeURIComponent(file.name)`，服务端 `unquote()` 后再 `_safe_name()`。
2. **一次拖多个文件时不能拿最后一个去读**：Shapefile 的 `.dbf/.shx/.prj` 排在后面会读到伴生文件。
   引擎加了 `is_primary(path)`，`/api/upload` 回 `primary` 标记，前端只自动打开主文件。
3. **文件夹路径**：`.gdb/.zarr` 直接读；普通文件夹里只有一个主文件时自动打开它，并在"文件"卡片里
   补一行"来自文件夹"；多个候选时把文件名列出来让用户指定，不再是一句"这是一个文件夹"。
4. **网页版拖不进文件夹**：浏览器的 `DataTransfer` 只给文件给不了目录内容，靠
   `webkitGetAsEntry().isDirectory` 识别后给明确文案，让用户改用路径框（Phase 4 原生壳拿到的是真实路径，没这个问题）。
5. **CLI 的 `--json` 之前会被 `print("=" * 72)` 污染**，机器没法解析。现在 `--json` 只输出 JSON：
   单路径是对象，多路径是数组；文本模式仍保留分隔线。

### Phase 3 地图与主题（进行中 2026-10-12）

- [x] MapLibre GL JS 4.7.1 本地打包进 `web/vendor/`（js+css，不走 CDN），前端新增 `web/map.js`
- [x] `GET /api/vector?path=&layer=&bbox=&limit=&tolerance=`：按视野取要素，统一转经纬度 GeoJSON，
  面/线用 `SimplifyPreserveTopology` 抽稀，单次上限 5000 要素，元信息在返回体的 `gisviewer` 里
- [x] 栅格贴合：`corners_wgs84` 四角点单独投影（MapLibre image 源支持任意四边形），
  `extent_ring_wgs84` 画真实轮廓（圆锥投影的边是弧，用外包框会明显错位）
- [x] 底图注册表：天地图影像/矢量（注记 `cia_w`/`cva_w` 独立开关）、Esri、OSM、高德、无底图；
  天地图没填密钥时不加图层，只提示
- [x] 图层选择器：多图层文件、压缩包成员、nc 变量都进同一个下拉框；nc 变量按需再 inspect 一次取几何
- [x] 主题：`--map-bg/--map-data/--map-fill/--map-extent` 四套色板进 CSS 变量，切主题只改 paint
- [x] 本地矢量切片金字塔（`{z}/{x}/{y}.pbf`）按视野直出：`/api/tileset` + MapLibre vector 源，
      图层样式按抽样瓦片里的图层名自动生成
- [x] 高德瓦片纠偏代理 `/api/tile/amap/{z}/{x}/{y}`：`gisviewer/amap.py` 逐像素重采样
      （输出瓦片每个像素 → 标准经纬度 → GCJ-02 → 源瓦片像素），rasterio 解 PNG/编 PNG，
      内存 + 磁盘（`%APPDATA%\GISViewer\tiles/amap/z/x/y.png`）两级缓存。
      实测：变换与公开参考值差 0.0001°；z=12 那张瓦片与原始瓦片的相关位移正好是 (−18, +5) 像素，
      残差 0.0（未纠偏时平均差 17.5 灰度）；偏移随级别 0.04px(z=3) → 145px(z=15)，
      所以整瓦片平移不够，必须逐像素
- [x] 屏幕上的视觉核对通道：`tools/shot.mjs`（无头 Edge + CDP，`Emulation.setDeviceMetricsOverride`
      固定视口，支持滚到某元素和先跑一段 JS），这样像素级对位、配色、深浅主题都能自己验

踩过的坑：

1. **`/vsi...` 和 `NETCDF:"x.nc":var` 不能被 `_clean_input` 规范化**，`os.path.abspath` 会把
   `/vsizip/D:/...` 变成 `C:/vsizip/...`。现在这两类路径原样透传，存在性交给 `gdal.VSIStatL`；
   包内成员的大小也从 VSIStatL 取。
2. **`parse_qs` 已经解过一次百分号**，接口里不能再 `unquote`，否则路径里的 `%` 会被二次解码。
3. **`Feature.ExportToJson()` 在这套绑定里返回字符串**，不是 dict，要 `json.loads` 再拼 FeatureCollection。
4. **抽稀容差必须跟着缩放走**：China2019 的 35 个面不抽稀是 32 MB GeoJSON，0.05° 容差下只有 0.33 MB。
   现在按 `1.5 × 360 / 2^z / 256` 取度数。
5. **GeoJSON 规范强制 WGS84**，国内大量"投影坐标直接存进 GeoJSON"的文件（`fixtures/china_small.geojson`
   就是），经纬度外包框会算到几百万；只提示不改数据（`extent_warning`），地图按用户数据的原始声明画。
6. **底图一直空白，真凶是样式里的 `sources` 写成了数组**。MapLibre 要的是 `{id: 定义}` 对象，
   数组过不了样式校验，样式永远加载不完，`getStyle()` 返回空、`addLayer` 抛
   "Style is not done loading"，于是所有绘制被跳过。之前把它归因成"页面拿不到渲染帧"是错的——
   那个环境确实拿不到帧，但用户可见窗口里同样空白。判据要自己在真浏览器里复现，别拿环境当借口。
7. **矢量切片的 `tileSize` 只能是 512**，写 256 会被 MapLibre 直接拒掉（栅格切片才用 256）。
8. **TopoJSON 不带坐标系，`describe` 走了默认 WGS84，`read_features` 却还在按"没坐标系"报错**，
   结果信息栏正常、地图画不出来。现在两处共用 `DEFAULT_WGS84_DRIVERS`。
9. **容器尺寸被右栏挤动时 MapLibre 不会自己重算**（它只监听 window），加 `ResizeObserver` 调 `map.resize()`。

### Phase 4 原生壳与分发

- [x] C# WinForms + WebView2 壳，照 `D:\ICalendar\build.ps1` 的 csc.exe 编译方式
      （`build.ps1` → `dist\GISViewer.exe` 174 KB；这台机器只有 .NET 运行时没有 SDK，
      `Framework64\v4.0.30319\csc.exe` 够用，WebView2 程序集直接借历书的 `lib\`）
- [x] 启动时拉起 Python sidecar，分配空闲端口，健康检查通过再加载页面
      （`FreePort()` 用 `TcpListener` 让系统分配，不能用 `HttpListener`——非管理员要 URL ACL，
      实测拿不到端口会直接卡成错误弹窗；端口被别的程序占着也能避开）
- [x] `DragEnter` 拿绝对路径传给引擎：`_web.AllowExternalDrop = false` 后拖落走 WinForms，
      `DataFormats.FileDrop` 给的是真实路径，交给页面的 `window.GisDropPaths()`；
      命令行 `GISViewer.exe D:\...\x.tif` 也直读，实测 1.8 秒出图
      （**从资源管理器真实拖一次还没做**，代码路径与命令行入参共用同一条通道）
- [x] 深浅色主题同步给壳的窗口和 WebView2（页面 `chrome.webview.postMessage('theme:dark')`，
      壳改 `BackColor` 与 `DefaultBackgroundColor`）
- [x] 退出时回收子进程：正常关窗走 `OnFormClosing` + `taskkill /T /F`（只杀父会留子孙进程）；
      被任务管理器强杀时，引擎靠 `GISVIEWER_PPID` 监视父进程自己收摊，8 秒内退出，
      顺带删临时副本。实测强杀后 python 与 msedgewebview2 都不残留
- [~] 免安装 runtime：**conda-pack 用不上也没装**，改成整目录复制 + 剔除运行时不需要的东西
      （`tools\pack_runtime.ps1`：头文件、`.lib`/`.a` 静态库、Perl/Tk 运行时、`Library\vendor`、
      `conda-meta`、pip/setuptools/wheel、`__pycache__`），1204 MB → **788 MB**。
      `Library\lib\gdalplugins`（格式驱动插件）和 `Library\bin\dwg2dxf.exe` + libredwg DLL 都保留，
      `tools\check_runtime.py` 八项体检全通过：numpy 2.5.4 / GDAL 3.10.3 / PROJ 9.6 /
      GeoTIFF 元数据 / 精确直方图 / 压缩包 shapefile / DWG 转换兜底 1694 要素 / 投影换算
- [ ] 打成 zip 并压一次实测体积
- [ ] 在一台没装过 Python 和 GDAL 的机器上验一次全流程

### Phase 5 第二期格式（用户样例已到位，2026-10-12 实测）

- [x] **`.gdb` 目录**：`D:\GISViewer\samples\GISProject.gdb` 7 个图层 130 ms 读完，含 XY 表转成的点图层
      和纯属性表；无几何的表不进地图下拉，只在图层清单和字段里显示
- [x] **DXF**：`Cars.dxf` 读到 `entities` 图层 2 个要素 + 6 个字段，几何类型分布抽样正常（多线·含高程 / 点·含高程），
      DXF 本身不记坐标系，界面显示"未记录坐标系"是正确行为
- [x] **TopoJSON**：`中国_省.json` 两个图层（省面 34 + 境界线 8）读通；
      文件不带坐标系 → 按规范默认 WGS 84，并在"坐标系"卡片里写清是默认值
- [x] **PBF**：用户给的不是 OSM 的 .pbf，而是 `{z}/{x}/{y}.pbf` **矢量切片金字塔目录**
      （`cropland-pbf`，10~16 级 2982 张 74.91 MB）→ 新增 `tileset.py` 识别 + `kind=tileset` 结果
      + `/api/tileset?path=&z=&x=&y=&ext=` 本地瓦片服务 + 地图按视野直接渲染切片
      （单张瓦片 GDAL 也能读：MVT 驱动，图层名/字段/几何类型从抽样瓦片取）
- [x] **DWG**：`architectural.dwg` 是 AC1021（AutoCAD 2007~2009），GDAL 自带的 CAD 组件只到 2000 版，
      直接读必失败。已装 **libredwg**（conda-forge 有 win-64 包，含 `dwg2dxf.exe`）做兜底：
      `.dwg` 直接读失败 → 自动 `dwg2dxf` 转临时 DXF → 正常读取，实测 1,694 个要素、114 ms；
      文件卡片仍显示用户那个 .dwg 的名字和大小，格式栏写"DWG · 经 DXF 转换"，并给出转换说明
- [ ] OSM `.osm` / `.osm.pbf` 单文件仍未实测（用户给的 cropland-pbf 是切片金字塔，不是 OSM PBF）
- [ ] GRIB / JP2 / ECW：等用户有真实需求再说（ECW 是商业 SDK，装不上）

实测中修掉的读取坑：

1. `ogr.GeometryTypeToName(值)` 遇到 OpenFileGDB 返回的 `-2147483647`（旧式 0x80000001 带 Z 编码）
   会 `OverflowError`，整个图层信息被吞成一条错误。现在先 `& 0xFFFFFFFF` 再拆标志位，
   并且类型名改用自己的表，不再调 GDAL 的这个名字函数。
2. 属性表（`wkbNone`=100）的 `GetExtent()` 返回 `(0,0,0,0)`，会显示成"左 0 · 右 0"的假范围；
   现在无几何图层的范围一律置空。
3. 目录型数据（.gdb / 切片目录）以前 size 显示 `None`，现在统计目录内文件数与总大小
   （`_dir_total`，扫到 2 万个文件为止）。
4. Git Bash 里传 `/vsizip/...` 会被 MSYS 改写成 `D:/Software/Git/vsizip/...`，
   命令行验证这类路径要加 `MSYS_NO_PATHCONV=1` 或在 Python 里直接调。

### 界面控件与设置弹窗（2026-10-12）

- [x] 设置弹窗打不开的根因：`.modal { display: flex }` 覆盖了 `hidden` 属性，
      加了全局 `[hidden] { display: none !important; }`，保存/关闭都恢复作用
- [x] `web/controls.js`：自绘下拉框（保留原 `select` 读写 `value`，只换外观，支持键盘上下键）
      + 开关式复选框（`appearance: none`）+ 自绘滚动条 + `color-scheme` 跟随主题
- [x] 底图连通性实测（浏览器上下文里 fetch 真实瓦片）：天地图影像 200 / 天地图注记 200 /
      Esri 200 / 高德 200 / **OpenStreetMap 超时**，与第 5 节的判断一致，OSM 只当备选
- [x] 天地图"浏览器端密钥"用 curl 请求会返回 `301012 权限类型错误`，
      **这不是密钥失效**，必须在浏览器里带 `Origin` 发请求才通；调试时别被 403 误导

### 布局定稿：方案 A + 信息栏 A3（2026-10-12 用户选定）

渲染对比图在 `design/layout_options.png`（整页三案）和 `design/info_rail_options.png`
（信息栏三案 + 加载骨架）。选定：地图占主区，右栏 440px 一张分节长表。
（这两张图后来按用户要求随 `design` 目录一起删了，结论以本节文字为准）

- 左：`.map-pane` 地图铺满，左上角胶囊显示"文件名 + 大小 + 格式"，右上角图层下拉与
  "值分布"按钮，值分布点开是浮层气泡（不再单独占一张卡）；地图下方一行小字说明当前画法
- 右：`.rail` 单张表，分节标题用强调色（概览 / 空间 / 坐标 / 波段 / 统计 / 存储 / 属性 / 文件），
  表头随滚动吸顶；不标"重点"，不加与字段无关的说明
- 删掉"影像预览"卡：地图本身信息更全
- 拖入即出：先渲染骨架行（`.sk` 微光条，`prefers-reduced-motion` 下静止），数据到了整栏替换
- 数字与英文一律 Arial 优先（`--font-num`），中文走 `--font-ui` 的思源/霞鹜/雅黑回退
- 主题按钮：文字显示当前档位 + 历书那三枚图标（跟随系统 / 浅色 / 深色），SVG 内联、
  `currentColor` 跟随主题，不依赖图标字体
- 改动前的旧版界面存在 `design/backup_web_20261012/`

### 第二轮打磨（2026-10-12 用户看图后提的意见，全部落地）

- **信息不冗余是硬要求**：文件级的事实（名称、大小、格式、修改时间、路径、内含文件、
  成员数、图层数与要素总数、伴生文件是否齐全）只在地图左上角胶囊里出现一次；
  右栏标题下不再重复，"文件"分节整节删掉，读取耗时并进地图下面那行说明
- 右栏只留数据本身的分节：栅格 = 空间 / 坐标 / 波段 / 统计 / 存储；
  矢量 = 空间 / 坐标 / 属性；切片 = 切片 / 空间 / 属性。压缩包成员只有一份时不再冠成员名
- **栅格 NoData 必须透明**：`thumbnail()` 多写一条 alpha 通道（掩膜处为 0），
  底图透得出来，不再糊成一片黑。实测 `pre_2000_01.tif` 62.6% 的像素全透明，与有效像元 37.37% 对得上
- 值分布：柱形按气泡内容宽度铺满，纵轴改对数（长尾才看得见），x 轴五个刻度标签；
  按钮换成柱状图标并并进 MapLibre 右上角那一组控件，气泡下移到控件组下方，避免盖住开关
- 图例组件（地图左下角）：连续值按自然间断点（Jenks 加权动态规划，5 级）分级，
  色带用与出图相同的 2%~98% 灰度拉伸，图例明暗和影像一一对应。离散值等色表通道
- 地图与右栏之间加可拖分隔条，宽度存 `localStorage`（300~760px）
- logo：九宫格用户稿里选 `c33`（蓝底扁平地球+放大镜），16/24px 下仍可辨；
  `c11` 层次更丰富，留作关于页大图。产物 `web/img/logo.png`、`shell/gisviewer.ico`（16~256 多尺寸）
- 属性表放哪：三种方案对比图 `design/attr_table_options.png`（地图底部浮窗 / 右栏内展开 /
  横跨整窗抽屉），**等用户选**（design 目录已在第九轮按用户要求整个删掉）

### 第三轮：0.9（2026-10-13 用户看图后提的意见，全部落地）

- **值分布改成全图逐像元**：`band_histogram()` 默认 `GetStatistics(0,1)` + `GetHistogram(approx_ok=0)`，
  4 亿像元以内不再降采样。实测 `pre_2000_01.tif` 1.02 亿像元 0.95 s 出 64 个分箱；
  来源标签带上尺寸和单位（"全图逐像元统计 · 9,665×10,509 共 101,531,585 像元"），
  只有超过 `EXACT_HISTOGRAM_LIMIT` 才退回抽样并明说"快速抽样估算（未逐像元）"
- **分级设色搬到后端**：`natural_breaks()` 用加权 Fisher-Jenks 在分箱序号上求间断点，
  `classify()` 出 5 级（界值、颜色、像元数），色带是 viridis 十档插值，黑白灰那套删掉。
  带色表的分类栅格走 `band_color_table()`，分级和颜色照文件自己的调色板，
  调色板按 256 项补齐的只列实际出现的那几类（界值取自统计，`GetStatistics` 一次给四个值）
- **上色的影像**：`class_image()` 用 `np.digitize` + 颜色表出 RGBA PNG，图例和影像共用同一份分级，
  NoData 处透明。两处坑：① 前端拼 URL 时颜色里的 `#` 不转义会被当成片段截断，服务端收到空色表，
  影像静默退回灰度——`rasterUrl()` 现在整段 `enc()`；② 没有 NoData 时 `arr.mask` 是标量 `False`，
  直接下标会塌成 0 维，统一改 `np.ma.getmaskarray()`
- 图例组件重做：波段换成自绘下拉框（多波段可自由切换，切换后影像、图例、值分布同步刷新），
  最大高度 44% 内部滚动，色块加高到 16px，界值保留 2 位小数，字号跟正文一致（14px），
  顶部一行只写分级方法（自然间断点法 / 调色板分类）。地图那行说明不再写死"自然间断点"，
  由前端把方法带过来
- 值分布气泡：波段标签按钮整排删掉（和图例下拉是同一件事，做两处就是冗余），
  标题一行写当前波段，刻度字号 10px→12px
- **属性表用方案一**：地图下方一块浮窗（压掉约四成地图高度，看完图看表视线不移），
  字段全列出、横向滚动、表头吸顶、行悬停高亮，右上角关闭图标取自历书 `close.svg` 改 `currentColor`。
  不做"展开为整窗"。数据直接复用地图已经按视野取回的要素，不另发一次请求，
  视野变化时浮窗跟着刷新。整型属性按原样显示（省代码 430000 不加千分位）
- **左键点选识别**：`raster.identify_value()` 把经纬度转到栅格自身坐标系读那一格，
  `vector.identify_point()` 先找正好压住的要素、没有就取容差内最近的几个，
  结果用 MapLibre 弹窗展示（深浅主题都重绘过）。中键按住可拖动地图，`cursor: grabbing`
- 临时上传目录：启动时清扫 12 小时以上的残留、退出时 `atexit` 删除本轮副本；
  胶囊不再显示 `%TEMP%\gisviewer-*\...` 这种路径，改成一句"程序退出后自动删除"，路径行允许换行
- logo 定稿 `c11`（浅色）/ `c22`（深色）成对，随主题切换，顶栏显示尺寸 26px→34px；
  `shell/gisviewer.ico` 重建为 c11 多尺寸
- 右栏分节标题 12px→13px，与同栏正文一致；"色表"一行改读 `palette_count`（原来读的是不存在的字段，永远显示"无"）
- 版本号：`gisviewer.__version__ = "0.9"`（放在 `configure()` 之前，`--version` 不必启动 GDAL），
  `/api/config` 一并回传，设置弹窗底部显示；更新记录另见 `CHANGELOG.md`
- 开发期截图工具 `tools/shot.mjs` 补两件事：`Input.dispatchMouseEvent` 发真实点击（合成事件不被地图认），
  以及跑完按 `--user-data-dir` 精确收掉整批无头 Edge 进程并删临时目录（只 kill 父进程会留一串子进程）

---

### 第四轮：0.9 打磨（2026-10-13 用户看图后提的六组意见）

- **进程残留**：上一轮无头 Edge 收得不干净（27 个进程、36 个临时用户目录）。`tools/shot.mjs` 改成
  一次启动跑完整批 spec、跑完 `Browser.close` + 按 `--user-data-dir` 精确收整批 + 删临时目录；
  另加一小时以上的残留目录清扫。原生壳这边补 `watch_parent()`：C# 被强杀时引擎自己退，
  不再留孤儿 python 进程
- **数值一律不加千分位**：`num()`、`count()`、`valText()` 以及后端 `raster/vector/labels/__main__`
  里所有 `:,` 格式全部去掉。理由是数值要能直接抄进别的软件
- **图例**：标题只写"波段1"（原来带"（灰度）"）；单波段也显示波段下拉；分级方法文本删除。
  三波段合成时图例位给一句"三波段合成没有分级图例，切到单个波段可看"
- **影像不再灰→彩跳变**：`renderResult()` 改异步，先等第一波段的配色算完再让地图画影像，
  等待期间地图中央显示转圈 + "正在准备影像配色…"，`prefers-reduced-motion` 下不转
- **气泡与按钮**：值分布气泡挪到按钮正下方（`top:10px; right:48px`），不再离着半张地图；
  直方图和属性表两个按钮都加了 `.on` 高亮态，点一次亮、再点灭，状态始终等于屏幕上有没有
- **点选弹窗**：指示箭头按锚点方向重画（原来是方块）；关闭按钮 24×24 并和标题垂直居中；
  标题改成"图层：<图层名称>"，其余信息一律进主体
- **光标**：左键不再显示抓手，只有按住中键才 `grabbing`
- **可收起**：胶囊和图例各加一个减号按钮（与标题垂直居中，展开时换成加号），
  用 `grid-template-rows` 做高度过渡，收起/展开都有动画；胶囊字号统一成 14px
- **路径不再显示临时副本**：`setChip()` 直接读 `f.path` 显示文件真实位置，只有网页版上传才有那句临时副本说明
- **地图底部一排**：比例尺从 MapLibre 控件换成自绘的，挪到图例右侧（原来被图例压住）；
  新增位置组件显示 经度/纬度/层级/坐标系（EPSG），鼠标和视图事件都做了节流（约 90ms 一帧），
  组件只在有值时占位，不会带着父元素一起抖
- **属性表**：去掉关闭按钮（地图上的按钮就是开关），标题前加同风格图标并垂直居中，
  与地图之间加可拖动分隔条（120~520px，高度记在本地），矢量/压缩包这类有属性的图层自动打开
- **间距**：地图、分隔条、右栏之间从 12px 收到 5px，外边距 16px→8px
- **设置**：删掉主题项（顶栏"跟随系统"已经管这件事），密钥输入框改 `type=password` 加"显示"按钮
- **版本号上标题**：`__version__` 经 `/api/config` 回传，前端写顶栏、写 `document.title`，
  同时 `postMessage('ver:x')` 给原生壳改窗口标题栏——版本号只有引擎一处来源
- **空状态**：投放框改成铺满工作区（原来上面一小块、下面一片白），文字垂直居中；
  虚线框即投放区，和实际可投放范围一致
- 原生壳实测：`GISViewer.exe <文件路径>` 直接带着文件启动，矢量（China2019.zip，
  属性表自动打开）和栅格（pre_2000_01.tif，5 级设色 + 波段下拉 + 比例尺）都在原生窗口里截图核对过；
  启动到引擎就绪 1.6 s。自动化键盘事件进不去 WebView2 的 DOM，所以界面内的输入只能靠真实拖放验证

---

### 第五轮：0.9 设置页扩容、去 MKL、启动提速（2026-10-13）

- **顶栏定稿 D 方案**：中文主名 + 英文副名两行，版本号小字跟主名垂直居中，logo 在最左
- **设置页扩到六段**：底图 / 栅格显示 / 矢量与属性表 / 外观 / 系统 / 文件与副本。
  栅格四项（色带、分级级数、没有数据的地方、多波段默认画哪张）改完点保存就把当前波段重算一遍，
  不用重新拖文件；矢量两项是要素与范围线的颜色、属性表一次列出的要素数
- **界面字号用 CSS `zoom`，只加在界面 DOM 上**：顶栏、右栏、弹窗、地图上的浮板、地图缩放控件都放大，
  `#map` 画布本身不参与，取点和坐标换算不受影响。两处按屏幕像素量的尺寸要除回去——
  比例尺的条长（`paintView`）和属性表的高度（`wireAttrSplit`），否则 130% 下条子会虚报实地距离。
  字号改完立刻重画一次比例尺，不等下一次拖动地图
- **面板不透明度**只作用在浮于地图的那几块（`--overlay`），顶栏和右栏保持实心，设置里这句话写在选项下面，
  免得用户以为没生效
- **原生壳新增 `src/Host.cs`**：`RegisterHotKey` + `WndProc` 收全局快捷键、`HKCU\...\Run` 管开机自启、
  `WScript.Shell` 建桌面 `.lnk`、GitHub Releases 查新版、`InstalledFontCollection` 把本机字体报给界面。
  壳和页面之间加了一条双向通道：`postMessage` 上、`window.GisHost()` 下，
  字体名单、自启状态、快捷键、检查结果都从壳这一侧回推
- **全局快捷键**默认 Ctrl+Alt+G，点按钮再按组合键即可改，Esc 取消；注册失败自动回退默认值并说明是谁占着，
  启动时如果旧进程还占着热键，每 400ms 重试，最多 15 次。软件缩到任务栏也能用它在任何程序里叫出来
- **开机自启**写的是 `<exe> --hidden`，开机只挂托盘不弹窗口；**桌面快捷方式**勾上就在桌面放一个带图标的 .lnk，
  取消勾选就删掉。两项失败都会把系统给的原因原话显示出来，不写"这个目录不让动"这种猜的话
- **检查更新**只问"有没有新版"，下载和安装由用户自己点"去下载"在系统浏览器里完成，不做原地自更新。
  频率可选不检查/每次启动/每 3 天/每周/每月，上次检查时间记在本地。私有仓库要填访问令牌，
  令牌只在那一次请求里用，不写进任何文件
- **numpy 换成不带 MKL 的**：conda 装的 numpy 链的是 MKL（一整套商业数学库，光 dll 就 400 多 MB），
  PyPI 的 wheel 自带 OpenBLAS。`pip install --force-reinstall --no-deps numpy==2.5.4` 换掉后
  runtime 788 MB→364 MB，免安装 zip 274 MiB→127 MiB，8 项体检全过。MKL 是什么：
  Intel 的数学库，矩阵运算比参考实现快，我们这种量级的降采样和分位数用不上它
- **启动提速**：GDAL/rasterio 改成按需加载。`formats.py` 只放常量和色带表，
  `gisviewer/__init__.py` 与 `server.py` 用 PEP 562 的模块 `__getattr__` 在第一次真用到时才 `load_engine()`，
  引擎模块导入 278 ms→161 ms，服务 ~159 ms（热）/~410 ms（冷）就能应答 `/api/formats`；
  后台线程再把引擎预热。壳这边把 WebView 初始化和等引擎改成并行，探测节奏改成前 3 秒每 120ms 一次。
  **原生实测：进程起来到界面导航完成 713~743 ms**（此前 1.44~1.94 s），跑的是打包 runtime，不是开发机环境
- **验证方式补一条**：自动化键盘事件仍然进不了 WebView2 的 DOM，但可以给壳加
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=NNNN`，用 `tools/cdpeval.mjs` 直连
  真实窗口的 CDP 读 DOM 现状、点按钮。这一轮的原生快捷键改键、开机自启写注册表、桌面 .lnk 建删、
  字体名单（141 项）回推、开机自动查更新，全是在真窗口里这样跑通并核对的；
  跑完把注册表项、桌面快捷方式和测试写的配置全部还原
  （带调试端口时启动会慢到 ~1.2 s，所以上面 0.72 s 是不带端口的干净值）

### 第六轮：改名「图览」、自绘无边框标题栏与一批界面收口（2026-10-14 用户提的八组意见）

- **软件改名「图览」**（英文副名 MAP AT A GLANCE 保留）：窗口标题、任务栏、桌面快捷方式 `图览.lnk`、
  开机自启项 `Tulan`、exe 名 `Tulan.exe`、发布包 `图览-0.10-win64.zip` 一起换。
  `build.ps1` 输出改成 `dist\Tulan.exe`，打包前先杀 `Tulan` 和 `GISViewer` 两个旧进程名
- **顶栏就是标题栏**（用户选定这个方案，因为顶栏和系统标题栏各写一遍标题加版本号是冗余）：
  `FormBorderStyle.None`，再在 `CreateParams` 里把 `WS_CAPTION|WS_THICKFRAME|WS_MINIMIZEBOX|
  WS_MAXIMIZEBOX|WS_SYSMENU` 加回去，`WM_NCCALCSIZE` 直接返回 0 让客户区等于窗口本身——
  系统边框、阴影、贴边吸附、Win11 圆角全都还在，只是那条自带的标题栏没了。
  拖动靠 `ReleaseCapture(); SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)`，
  输入框、按钮、下拉这些区域用 `.no-drag` 加 `closest()` 排除，否则点不动
  - 踩到的坑一：`tagMINMAXINFO` 的字段顺序必须是 reserved / maxSize / maxPosition / minTrack / maxTrack，
    顺序写错系统读到的是另一回事，最大化会跑到别的屏幕上去
  - 踩到的坑二：`WM_NCCALCSIZE` 里再按 `SM_CXSIZEFRAME+SM_CXPADDEDBORDER` 内缩一次是多余的，
    加上 `WindowState` 赋值和它的抢跑，最大化后窗口成了 1936×1048 落在 (3832,-8)，顶栏被挤出屏幕。
    现在 `WM_GETMINMAXINFO` 直接报显示器工作区大小，实测 1920×1032 落在 (3840,0)，顶栏上沿 y=0
- **窗口缩放闪烁**（用户问是不是 bug：是）：拖动改变尺寸时 resize 每帧来一次，每次都重设画布尺寸，
  中间帧是空的所以一路闪。改成 `ResizeObserver` 把变化攒到一帧里只调一次 `map.resize()`
  （宽高没变就跳过），并开 `preserveDrawingBuffer` 让中间帧保留上一幅画面
- **收起成胶囊**：图例和信息窗点减号后只剩标题和加号（`grid-template-rows: 1fr→0fr` 做高度动画，
  收拢时 `max-width:0`，否则胶囊还占着原来 300 px 的宽）。波段下拉框 148→96 px，
  图例数值加 `white-space:nowrap`，204 px 宽下不再把 "-19456.2" 断成两行
- **位置组件**：打开图层即显示图层中心（`emitView` 多带 `lat/lng`），鼠标一进地图换成鼠标位置；
  经纬度 5 位、层级 1 位小数。鼠标和视图事件统一到 `TICK = 200ms` 一个常量——
  视图事件（`move`/`zoom`，也就是比例尺、层级、中心点这一组）原来是 120ms 的 leading 节流，
  现在和鼠标一样走 200ms 带尾帧，最后一帧一定落地，不会停在半路的值。
  比例尺并进同一枚胶囊（`#statusBox`），图例、位置、比例尺的下边距收到 6 px
- **直方图**：像元总数走 `labels.human_count`（"共 24.0 万像元"）。
  y 轴刻度原来是线性取的 0/1/2/3 却按对数摆柱，标签和柱顶对不上；
  现在刻度和柱形用同一个对数公式定位，取 1/2/5 的整齐值
- **属性表**：图标 15→19 px，"N 个字段 · 只列当前视野内的要素"从底部挪进标题行
- **点选弹窗**：内边距收到 7/10 px，关闭按钮改成浮在右上角的 22 px 圆钮，行间分隔线删掉，
  "位置"改"行列号"、值写成"(行 131, 列 364)"，切图层时跟着 `GisMap.clear()` 一起关掉
- **层级全线梳理**：地图浮层是 2~8，模态框原来压根没写 z-index，所以设置弹窗压不住位置组件、图例、
  信息窗、缩放/直方图/属性表按钮、attribution、右栏标题和属性表表头。`.modal` 定 60
- **设置弹窗**：标题行右侧加关闭图标，底部的"GIS 文件速览 0.9"和保存、关闭按钮全删——
  每一项改动即时生效，"保存"这个动作本身是冗余的；内边距 12/16/14 px
- **字体名单**（用户问"怎么没有 Noto Sans SC"、"不要 ESRI 字体"）：两个原因——原来 `Take(140)` 截断，
  而且同族字重各算一项把名额占满。现在去掉条数上限，按 `Skip` 表排除 ESRI 系、Wingdings、
  Segoe Fluent 图标这类符号字体，再用 `Weights` 表把 " Light/Bold/Italic" 等变体折叠回族名，CJK 优先排
- **信息窗显示真实路径**（原生壳拖入的文件原来显示临时副本目录），标题右上角加 × 关闭图层，
  点了走 `closeLayer()` 回到初始界面
- **加载动画统一**：`loadTip()` 挪到 `inspectPath` 一进来就开、`finally` 里关，
  矢量、压缩包、切片这些原来没动画的格式现在都有"正在读取…"
- **检查更新**不再提供"每次启动"：软件打开后延迟 14 秒自己查一次，配置里遗留的 `boot` 值自动迁成 `open`
- **报错文案**：矢量图层没有坐标系时界面显示"读取时出了意外 / ValueError: …"，是工程术语。
  这类我们自己判断出来的情况改抛 `InspectError`（新增 `gisviewer/errors.py`——`inspect.py` 已经导入
  `vector.py`，反向 import 会成环），标题直接写"这个图层没有坐标系，没法画到地图上"
- **关掉图层要连地图底下那行说明一起清**：`GisMap.clear()` 原来只清画不清话，
  关掉图层后底下还留着"读取 37 毫秒 · …"。改成 clear() 里把 `token`/`idToken` 递增作废在途请求、
  `data`/`pending`/`lastVec` 归零并 `note('')`；`elapsed` 不动，因为 `renderResult` 是先写
  "读取 X 毫秒"再调 clear()，一起抹掉会让这半截前缀消失
- **每轮迭代留一份可分发包**：`build.ps1 -Zip` 从 `__init__.py` 读版本号，写 `archive\图览-<版本>-win64.zip`，
  同名旧包先带时间戳存档再覆盖；`design\arc` 那批历史渲染图按用户要求删掉。
  踩到的坑：PowerShell 变量名不分大小写，脚本里 `$zip = Join-Path ...` 写的是自己那个 `[switch]$Zip` 参数，
  报的是"无法把 String 转成 SwitchParameter"——本地变量改名 `$zipPath` 才通

### 第七轮：改名后的实机九组意见（2026-10-14，进行中）

- **投影栅格和底图对不上**（用户问：pre_2000_01.tif 对不上、China2019.zip 对得上）：
  两个都是 China Albers 等积圆锥投影，但矢量是把**每个顶点**转到经纬度再画，边跟着弧走；
  栅格是把一张 PNG 贴到**四个角点**上，MapLibre 的 image 源只能拉一个四边形，
  圆锥投影下四条边是弧线，直连之后整幅就漂了（这份数据跨 68~136°E、4~54.7°N，误差上百公里）。
  改法：出图前先把栅格转到经纬度网格。不直接用 `WarpedVRT`——它要对 9665×10509 的源整个重算，
  实测 3.2 秒；改成"先在原坐标系降到 512，再 `reproject` 到经纬度"，实测 0.27 秒。
  贴图范围用 `inspect` 里同一个 `bounds_to_wgs84(densify:16)` 算，出图网格和四角才完全对齐；
  数据范围外是 NaN，透明，所以看到的仍然是弧线轮廓
- **缩放闪烁没修干净**：上一轮只合并了我们自己的观察者，漏了 MapLibre 的 `trackResize`
  （默认 true，它自己监听 window resize，一次都不合并）。改成 `trackResize:false` +
  尺寸稳住 140ms 才 `map.resize()`，中间帧用 CSS 把画布拉伸到新尺寸。
  实测：容器连续变化 19 次，画布尺寸一次都没动，停手后只重绘一次
- **拖放打不开**：`_web.AllowExternalDrop = false` 让 WebView2 把外部拖入整个拒了，
  WinForms 那侧的 DragEnter 永远收不到（真正命中的是 WebView2 的子窗口）。
  改成 `true`，拖放由页面接：document 级 dragenter/over/leave/drop，空状态高亮原投放框，
  已打开文件时铺一层 `#dropVeil` 说明整窗口都能接。原生下优先取 `File.path` 的真实路径。
  顺带修了 `isFolderDrop`：`webkitGetAsEntry()` 可能返回 null，原来直接取 `.isDirectory` 会抛，
  整个 drop 处理函数被这一句打断
- **无边框窗口最大化**：内容要按系统边框厚度缩进去，否则顶栏贴着屏幕上沿。
  壳里 `SystemInformation.FrameBorderSize` 报给页面（`GisHost('frame', 7)`），
  `body.maxed { padding: var(--max-inset) }`。窗口三键从 34×26 增到 42×32
- **图例收起动画把内容挤高**：`max-width:0` 瞬间生效，204px 的面板被压成窄条、文字换行、
  高度先窜一截。改成宽度写死过渡（204→84px、300→112px），和高度同步收，不再挤压
- **波段下拉点不开**：`.fold-in { overflow:hidden }` 是为收起动画加的，把向上探出的下拉列表裁掉了。
  改成平时 `overflow: visible`，只在收拢那 260ms 加 `.folding` 裁一下
- **位置组件抖动**：经纬度位数变化让胶囊宽度跟着变。数字改 `tabular-nums` 并给数值列固定最小宽度；
  圆角从 999px 改成和别的浮板一致的 8px；底图版权行从地图右下角搬进这一排，不再互相盖
- **报错与文案**：直方图 y 轴原来用 `count()` 出"2.4 万"这种带单位带小数的标签，改成纯整数刻度 +
  左上角一个"像元数"轴标题，左边留白按最长标签算，不再截断；x 轴分箱是整数时不再写 15000.5；
  数据类型标签从"32 位单精度浮点"缩成 Float/Double（位深另有独立一行，不重复）；
  NoData 的"非数"改成 NaN／未设置；波段表六列一律左对齐，波段没有名称留空而不是回填颜色解释；
  耗时超过 1 秒改按秒显示；三波段合成点值分布按钮原来直接抛异常
  （`fillHistogram(undefined)` 读 `.band`），现在明说"合成没有值分布，切到单个波段可看"
- **点选弹窗**：超过 6 行改两列并排，标题下加分隔线，行列号写成"行 131 · 列 364"，
  关闭按钮和图例收起按钮同一套样式；信息窗的关闭按钮去掉红色特殊态，与收起按钮一致
- **属性表开合动画**：`height` 从 0 过渡到设定值，收尾再 `hidden`；
  加载动画加大（22px 转环、15px 字）并给地图蒙一层，右栏那套要不要合并成同一个还在定

### 第八轮：实机六组意见与一张大影像的出图 bug（2026-10-14）

用户实机再提六组，逐条落地。其中"pre_2000_01.tif 地图上不显示"在浏览器里直接复现，是引擎的 bug。

- **投影影像不出现（根因）**：`raster_grid` 把整幅降到 512 之后，重投影仍传 `src.transform`
  ——那是原分辨率的像元变换，于是重投影只读到小数组左上角的一小块。
  实测：`/api/thumbnail` 对这份 1.02 亿像元的文件返回 512×379 PNG，
  不透明像元只有 118 个（0.06%），所以地图上是空的、只剩范围线。
  改成按降采样后的网格重算源变换 `from_bounds(左,下,右,上,小宽,小高)`，
  有效像元回到 67942/236032（29%），耗时 0.27 s
- **顺带把目标网格从 EPSG:4326 换成 EPSG:3857**：MapLibre 的 `image` 源是把一张图线性铺在
  四个角点围成的**墨卡托**矩形里，铺到经纬度网格上中纬度照样拉偏（30°N 处约偏 6%）。
  出图范围仍取 inspect 里同一个经纬度外框，四角和网格一一对应。
  浏览器和原生窗口都复测：影像的海岸线、四川盆地、台湾和海南和底图对得上
- **收图例时地图抖一下（根因）**：上一批为了让波段下拉探得出去，把 `.fold-in` 的
  `overflow:hidden` 改成只在收拢那 260ms 生效，结果收起之后内容没裁住、在 0fr 那一行外面继续占位，
  把整页顶出一条竖向滚动条——`.layout` 客户宽 1904→1893，地图少 11px 就重排一次。
  原生窗口实测：收起时画布 1431→1420，展开又回到 1431，正是用户看到的抖。
  改成 `.folded .fold-in { overflow:hidden }`（收起一律裁住，展开才放开），
  `.folding` 那套定时器和样式删掉。同时 `.map-bar` 从 `left:8/right:4/bottom:6` 改成铺满地图边框，
  离边距离写进各组件自己的 margin，胶囊贴边不再靠负外边距探出去
  （负边距本身就是溢出来源）。复测：展开/收起 layout 宽 1904、滚高差 0、画布尺寸不变，
  图例左 16 底 991 与地图左 16 底 991 完全贴合，信息窗左上同理
- **点选识别的反馈与高亮**：识别请求发出时先在点击处挂"正在读取…"弹窗；点中的要素描一圈高亮
  （新增 `gis-hl` 源和三层：面 0.16 透明填充、2.8px 描边、点 7px 圆），
  关掉弹窗、点别处、换图层都撤掉。识别接口原来只回属性，现在补回几何
  （投影坐标系下克隆一份转到经纬度再给前端）。"此处有 1 个要素"这类重复说明删掉
- **拖放真实路径**：原来 `postMessage(files)` 把 File 数组当普通消息序列化，
  外壳的 `AdditionalObjects` 是空的，路径取不到。改成 `postMessage('drop', ...files)`
  逐个作附加参数，外壳认 `drop` 这个暗号去读 `CoreWebView2File.Path`；
  同一批路径两秒内只认第一次，避免 WebView2 和窗口 DragDrop 两条通道各读一遍。
  取不到路径时页面 2.6s 后弹窗提示改用输入框，不会一直蒙着
- **最大化后的纵向滚动条**：原生窗口实测 `--max-inset` 8px、`body.maxed` 生效、
  `.layout` 内容高 958 = 可视高 958、文档零溢出——上一批的 `box-sizing:border-box` 已经修掉，
  用户看到的还是旧包。真正还在的溢出是上面那条图例收起
- **属性表分隔条卡顿**：拖动过程中每帧调一次 `GisMap.resize()`，改成不主动调，
  交给地图那个攒到停手 140ms 的 ResizeObserver 补一次；`.resizing` 期间画布拉满容器，不留白
- **文案与观感**：注记层默认关掉（`config.annotation` 默认 false，用户本机的配置文件同步改掉）；
  版权行改成常开一行（`attributionControl:false` 后自建 `AttributionControl({compact:false, customAttribution:''})`，
  顺带去掉尾巴上那个组件库名和链接）；加载遮罩 .45→.62、转环删掉换成整块呼吸；
  顶栏中英两行间距 3→5px；直方图气泡改成和属性表一样的双向过渡；
  信息栏"数据类型"和"位深"合并成"32 位 Float"
- **design 目录清理**：60 MB 的排查截图、临时 spec、备份目录、logo 候选全删，
  只留三张还没定稿的渲染对比图；两张探针影像挪进 `tests/fixtures`，
  `tools/make_probe_rasters.py` 的输出路径同步改

### 第九轮：拖放回到真实路径、遮罩等画完再收、直方图改均匀刻度（2026-10-15）

用户实机又提五组，外加上一批收尾时留下的两处观感问题。

- **拖放又打不开了（根因）**：上一批那条 `postMessage('drop', ...files)` 的路子在本机走不通——
  `CoreWebView2WebMessageReceivedEventArgs.AdditionalObjects` 运行时是 null
  （这个属性属于 `...EventArgs2`，本机 WebView2 版本取不到），所以外壳一个路径都读不到，
  页面只能等 2.6 秒后弹"没有接到拖进来的文件"。改成完全不走 File 对象：
  `WebView2.AllowExternalDrop = false` 把拖放交还给 WinForms，窗口自己的 `DragDrop`
  用 `DataFormats.FileDrop` 拿到的就是资源管理器里的真实路径；
  拖入和拖出用 `Push("drag", ...)` 通知页面蒙层，`DroppedPaths` 和 `drop` 分支删掉。
  外壳那侧留一行日志（`拖入 N 项：<首条路径>`），下次再不通可以直接从日志定位
- **遮罩收得太早**：`wuningGEP.json` 出元数据 3.6 秒，图层真正画完要十几秒，
  遮罩在元数据回来那一刻就撤了。现在地图每画完一次派发一个 `gis:drawn`（矢量三条路、
  栅格、清空都发），页面 `holdVeil('正在画图层…')` 之后只认这个事件收尾，
  超时兜底一并撤掉。信息窗上"读取 N 秒"同一个时刻收，不再是元数据耗时
- **点选识别 11.7 秒**：GeoJSON 没有空间索引，每次识别都重新打开数据集、逐要素取包络。
  改成把包络按 (路径, 图层号, mtime, 大小) 缓存在进程内（只留一份，换文件即重建），
  命中缓存直接扫内存数组，候选封顶 400 个。实测 `wuningGEP.json` 11.69 s → 0.02 s
- **弹窗先报名字**：识别请求一发出就把标题挂成"图层：China2019"，主体写"正在读取…"，
  等结果再替换；撤高亮挂在关闭按钮的点击上，不依赖库的 close 事件
- **直方图 y 轴刻度挤在顶部**：上一批把轴标签从 `count()` 改成按数量级给单位之后，
  刻度还是按对数分布取的，看着全挤在上面。换成 1/2/5×10ⁿ 的等间距整数刻度，
  柱高按同一个顶点线性折算。原生窗口实测：0/200/400/600/800 五档，格线间距 30px 一律对齐。
  这张图一直是自己画的 SVG，没有用图表库——免安装包只带一个本地 js，不值得为刻度再拖一坨
- **转环按原样留着**：上一批把加载遮罩的转环删了是判断错了，用户没让删，已恢复
  （`index.html` 的 `<i class="load-spin">` 和 `@keyframes spin` 都在）
- **贴边只贴左边**：图例和信息窗收起后的胶囊改成贴地图左边缘、上下留一点边距
  （`.map-legend.folded` 左边距 0 并去掉左上左下圆角，`.map-chip.folded` 同理），
  展开时留 6px；字号一起收：信息窗表格 13px、路径 12.5px、图例数值 13px。
  底图版权组件整个不要了（`attributionControl:false` 且不再自建控件，相关 CSS 全删），
  位置组件靠右（`margin:0 4px 6px auto`）
- **展开图例仍抖**：收起方向上一批已经修住，展开那一下是内容在过渡里短暂超出胶囊宽，
  又顶出滚动条。给 `.map-stage` 加 `overflow:hidden`——地图这一整块本来就不该溢出到页面。
  原生窗口复测：展开→收起→再展开，`.layout` 宽恒 1904、滚动高差 0、画布恒 1431×599
- **顶栏输入框收窄**：`flex:0 1 46%`（最小 240px），工具组 `margin-left:auto` 顶到右边，
  中间空出来的一段就是拖窗口的位置
- **信息栏重构（上一批欠的，用户免了渲染对比图直接做）**：范围拆成西/东/南/北四行，
  投影坐标系下每行后面括号补经纬度；坐标一节按中心纬线、中央经线、两条标准纬线、
  假东偏距、假北偏距一行一行列出来，去掉"坐标轴"这种没用的行，单位改成 m/km/°/ft 符号；
  栅格的统计节挪到波段节上面；矢量不再单列字段表，字段类型和宽度并进属性表表头第二行，
  多图层文件改成给一张图层表；几何类型那行说清"类型混合（Mixed）：面 20、多面 15"
- **本轮收尾两处**：`像元大小 0.004 × 0.004 °` 那个多余空格（度不隔空格、米隔一个，引擎侧改）；
  从矢量切到栅格之后属性表还留着上一个图层的行（`gis:drawn` 里非矢量一律 `closeAttr()`）
- **design 目录整个删掉**：剩下三张已定稿的渲染对比图也删了；探针截图以后不再往仓库里落，
  `tools/grabwin.ps1` 默认输出改到 `%TEMP%\gisviewer-probe`。
  `tools/make_assets.py` 的输入是 `design/logos` 的用户稿，源目录上一批已经删空，这个工具一并删

### 第十轮：拖放的真根因、遮罩时机、点选只认画出来的要素（2026-10-15）

这一轮先修两个"又坏了"的：拖放和遮罩。两个都在本机复现到了根因，
顺手把用户提的显示问题一起做掉。

- **拖放的根因（上一轮猜错了）**：`AllowExternalDrop=false` 只是让 WebView2 自己不吃这个拖放，
  它并不会顺手让给父窗口——父窗口的 `DragDrop` 因此永远收不到。WebView2 在自己的**好几层**
  子窗口上都挂了接收器，而拖放落点其实在最里面那层 `Chrome_RenderWidgetHostHWND` 上。
  改成自己实现 `IDropTarget`，先用 `RevokeDragDrop` 把 WebView2 挂的那些摘掉，
  再在整棵子窗口树上 `RegisterDragDrop` 挂我们的（`src/DropTarget.cs`），
  拖进来拿到的 `DataFormats.FileDrop` 就是资源管理器里的真实路径。
  为了不再靠"让用户试"来验证，写了 `tools/dropsrc.cs`（一个只会发起拖放的源窗口）
  和 `tools/dragdrop_test.ps1`（真实鼠标按下—移动—松开的 OLE 拖放），
  实测：日志出现"拖入 1 项：D:\GISViewer\samples\中国_省.json"，页面把这一层画出来了
- **遮罩挂晚了（120 秒的真凶）**：`holdVeil` 原来写在 `inspectPath` 的 finally 里，
  也就是**渲染之后**才挂；栅格是同步画完的，`gis:drawn` 早发过了，
  于是永远等不到"下一次绘制"，只能等那个 120 秒的兜底定时器。改成先挂遮罩再渲染，
  并且按绘制序号判定（只认比挂起更晚的那一次）。清空图层（`none`）不算画完——
  切文件时先清一次旧图层，那一下收遮罩就收早了；"这层画不出来"用 `skip` 立刻撤。
  兜底从 120 秒收到 30 秒。顺带发现栅格自己的"正在准备影像配色…"和遮罩打架，
  现在是同一套收放。地图底部那个"读取 N 秒"取的是元信息 + 图层显示之和
- **点选识别改成只认眼前画出来的**：原来问服务端要一圈范围内的要素，
  超大文件里没画出来的也算"识别到了"，用户觉得别扭。改成 `queryRenderedFeatures`
  直接取渲染出来的要素——点中的就是看见的，判定完全在本地，不再有等待。
  没点中就不弹窗（"此处没有要素""这个位置没有要素"这类话全删），
  弹窗标题不再重复文件名，关闭按钮从 22px 放大到 30px
- **属性表改成浮在地图里的浮窗**：原来它占地图下面一行，每次切文件地图都要重排，
  地图元素跟着抖。现在是一张浮在地图上的卡片（可拖上沿调高度，高度记在本机），
  图例和读数会让开它。多图层文件（含压缩包成员）在标题行右侧出现图层标签，
  默认第一个图层，别的图层按当前视野单独取一次
- **字段类型给准数**：原来把 OGR 的 real 翻成"小数"，用户一眼就看出不对。
  现在直接写引擎读到的类型名：Integer / Integer64 / Real / String / Date…
  压缩包的成员图层也带上了字段类型（上一版只有单文件矢量有）
- **直方图换成图表库**：自己画的 SVG 换成本地打包的 Chart.js（`web/vendor/chart.umd.min.js`，
  206 KB，不从 CDN 取），y 轴标题竖排在轴左侧，刻度按 1/2/5×10ⁿ 等距，
  悬停显示分箱区间和像元数。以后要加别的图也有地方画
- **信息栏与设置**：字段列宽 37%→29%，值列宽出来；"范围"归成一行、四个方向各占一行
  （投影坐标系里后面括号补经纬度）；单位写法做成设置项，英文（m/km/°）与
  中文（米/千米/度）二选一，**默认英文**，改完只重画右栏、地图不动；
  设置弹窗排成两列，不用再上下滚半天
- **位置组件**：经度/纬度/层级/坐标系之间的间距减半（9px→5px），比例尺那一段同步收
- **改名与图标**：英文副名改回 `Tulan`（顶栏"图览 / Tulan"），顶栏不再显示版本号
  （窗口标题和更新检查里还留着）；`gisviewer.ico` 改名 `tulan.ico`，
  四角白底在 `tools/make_icon.ps1` 里从四角灌水做成透明（16~256 共 7 个尺寸）——
  桌面快捷方式上那圈白边就是原图的白色底；桌面快捷方式一律叫"图览"，
  启动时发现桌面上有指向本程序但名字不对的快捷方式就就地改名
- **双击顶栏最大化**：原来靠 `dblclick`，但第一次按下就把窗口交给了系统拖动循环，
  第二个 click 根本回不到页面里。改成一个 450ms 的计数，两下就切换最大化/还原

---

### 第十一轮：首次拖放、位置组件失联、信息栏与属性表大修（2026-10-15）

六组意见。两个"又坏了"都在本机复现到根因；属性表这一组改动最大，
从"只列视野"改成按批滚动读取，还补上了缓存和整列复制。

- **首次拖放不生效（用户第一次打开软件就拖）**：`DropTarget.Attach` 挂在导航完成时，
  但 WebView2 在启动过程里还会自己造新窗口（日志抓到 `Intermediate D3D Window` 等），
  这些晚出生的窗口没挂上接收器，落点正好在它上面就收不到。改成装一个 400ms 的自查定时器：
  拖动中不打扰，没在拖就扫描一次子窗口树，只给集外的新窗口补挂，句柄被系统复用时重建集合。
  另外导航完成前收到的拖放先记在 `_earlyDrops`，就绪后补送。
  实测（重建后的 exe）：启动日志出现"补挂 1 个新窗口（Intermediate D3D Window）"，
  立即拖入即打开"拖入 1 项：…中国_省.json"，第二次拖也照常
- **位置组件失联的真根因**：`addEventListener('gis:view', () => { paintView(); })` 把事件对象丢了，
  `lastView` 一直是空，层级/坐标系停在"—"、比例尺没有内容、鼠标不进地图整块都不显示。
  上一轮重构引入的；现在把事件完整传下去。这一条也被用户点名要"改动波及的问题先自查一遍"
- **信息栏**：每个分组标题变成手风琴（点击/回车切换，收起只藏该组行，默认全开）；
  字段名后挂提示图标（照历书的 `.hint` 那套，SVG 直接复用），悬停出固定定位气泡，
  指针离开或滚动即收；字段列宽固定 30%、值列 70%（`table-layout: fixed` 配 colgroup，
  之前首行是 colspan 的节标题导致列宽算不准）；范围与左上角坐标改成
  "西 -2625585.832286 m (67.994384°E)"，放不下自动换行；标准纬线、假东/北偏距、
  长/短半轴、最小/最大值各合并一行；统计新增中位数/不同取值/无数据像元/有效像元占比
  （中位数和取值数由前端从直方图计数里推，不额外请求）；矢量新增数据类型、Z 值坐标、M 值坐标
  （引擎 `_split_geom_code` 认 WKT 的 Z/M 后缀，顺带修了旧编码分支）
- **点选弹窗关闭按钮**：改成浮起圆钮后顶部偏移写死，和标题差了半个字高。
  现在按标题中线对齐，实测两者 getBoundingClientRect 中线 156/156，齐了
- **缩放卡顿自查（没复现）**：真实滚轮输入实打实做过——栅格和 10 万+ 要素矢量上连续滚轮，
  rAF 采样平均 16.7ms、p95 16.8ms、最差 18ms、无一帧超 33ms，就是满 60fps；
  加载期 2032 帧里只有一个 167ms 的尖峰。GPU 是 D3D11（NVIDIA RTX 4060），dpr 1。
  本机复现不出来，先记测量结果，等用户给出具体场景再查
- **属性表大修**：图层标签改标题右侧下拉框（一个图层也在）；左、右、下贴住地图、
  上沿平角、抓手加粗成 64×4 的横条；表头右键说明改成悬停气泡（字段类型和长度各是什么意思）；
  列缝可拖动（拖出来的宽度就是默认，`table-layout: fixed` + colgroup 才拖得动）；
  单击表头选中整列，Ctrl+C 或表头角的复制图标复制 TSV（带表头；剪贴板权限失败退回
  `execCommand`）；**滚动加载**替补"只列当前视野"——服务端加 `offset`（OGR
  `SetNextByIndex`，不支持就退回跳过循环）和 `geom=0`（只要属性不序列化几何），
  109k 要素实测能一直往下翻、批大小在设置里选；收起后再打开读缓存（实测 0ms，
  转圈动画挪进表体首屏）；标题右侧那行信息删掉，字段数补到地图底部那行
- **设置弹窗与顶栏**：弹窗限高 `min(72vh, 640px)`、主体左右边距与标题对齐、
  滚动条改右侧留白不再压内容；顶栏"跟随系统""设置"两枚按钮挪到"选择文件"后面
- 打包策略：`archive\图览-<版本>-win64.zip` 每版本只留一份，打磨批次直接覆盖

---

### 第十二轮：拖放的真实现场与识别弹窗分页（2026-10-15）

用户两条：识别弹窗还是把多个要素堆在一起、太高；第一次打开拖文件依旧没反应。
拖放这条已经反复三轮了，这次先把"到底谁收到/没收到"变成能查的事实，再动手。

- **先取证**：写了 `tools/droptarget_probe.ps1`，把进程的整棵窗口树连 OLE 登记留下的窗口属性
  （`OleDropTargetInterface`）一起列出来。用户那个还在跑的实例上探到：4 个内层窗口全都有接收器，
  而且属性值跨三个进程完全一致——同一个 COM 对象，就是我们挂的那一个
- **再当场验一次**：用 `tools/dragdrop_test.ps1 -Hover`（新加的开关：只把文件悬到窗口上再收回来，
  不真的放下）对用户实例走了一遍真实 OLE 拖放，日志立刻出现
  `22:49:44 dragenter files=True` / `22:49:46 dragleave`——接收器是活的
- **第一次测失败的经过本身就是答案**：那一回落点上盖着微信内嵌浏览器的窗口
  （`WindowFromPoint` 返回 pid=3260 WeChatAppEx 的 `Chrome Legacy Window`），拖放整个被它接走，
  我们这边一行日志都不会有。这解释了"没反应却查不到记录"，也说明用户侧根本分辨不出是哪种情况
- **顺手查出两处真问题**：① 启动头几百毫秒里落点在窗口自己身上，那条路走的是 WinForms 的
  `AllowDrop`，一行日志不写、也不经过我们自己的接收器；现在 `OnHandleCreated` 就把窗口自身也纳入
  挂载范围，退路那条也补了日志。② 界面没就绪时补送过去的路径会赶在 `loadConfig` /
  `GisMap.init` 之前跑，画不出来也不吭声；现在页面自己攒着（`pageReady` 队列），
  初始化完成后回一句 `ready` 让壳记日志，且**拖进来的优先于"恢复上次的文件"**
- **看门狗改成核对式**：每 400 毫秒把整棵窗口树比一遍——新窗口补挂、
  登记值变零（被摘掉）重新挂上、登记值变了（被别的接收器顶掉）抢回来，三种分开记日志；
  读不到登记值的系统上改用 `RegisterDragDrop` 的返回码判定，不刷日志。
  一个窗口一个接收器实例，日志说得出是哪块窗口收到的；`InDrag` 卡住十秒自动放开
- **实测**（`tools/earlydrop_test.ps1`：先把拖放拉起来，再启动软件让窗口出现在光标底下）：
  日志完整走通——`拖放进来（WindowsForms10...）` → `拖放进来（Chrome_RenderWidgetHostHWND）` →
  `拖入 1 项：…（界面还没就绪，先攒着）` → `导航完成` → `补送启动期间拖入的 1 项` → `界面就绪`，
  图层正常打开（读取 671 毫秒、34 个要素）。常规拖放同样通过。
  再从外部 `RemoveProp` 摘掉渲染窗口的接收器，2 秒内日志出现
  `拖放接收器：1 个被摘掉后重新挂上（Chrome_RenderWidgetHostHWND）`
- **识别弹窗**：主体限高 `min(46vh, 380px)` 内部滚动（40 字段的样本实测内容 860 像素压到 380，
  滚动条走全局自绘样式 11 像素）；多个要素改成 ‹ 1/3 › 分页，只重画主体不重建弹窗，
  头尾按钮禁用、翻页时弹窗位置不跳（用两块互相压住的面做样本实测 1/2 来回翻）；
  "此处有 N 个要素""另有 N 个未列出"删掉
- **自查查出来的连带问题**：弹窗挂在 `#map` 里而 `#map` 自己不占层级，
  点在地图下半部分时弹窗下半截被属性表（`z-index: 7`）那几张半透明浮层盖住，
  看着像字淡掉了——补成 `z-index: 12`（高于所有地图浮层、低于设置弹窗 60 与提示气泡 90），
  整屏抓图复核过。顺带清掉 `popupNode` 里再没人调的"标题+占位"分支和 `.idp-empty`
- 新增工具：`tools/droptarget_probe.ps1`、`tools/clickwin.ps1`（真实鼠标点击，带 `-RaiseOnly`）、
  `tools/earlydrop_test.ps1`；`tools/dragdrop_test.ps1` 加 `-Hover`。
  壳加了 `GISVIEWER_DATA_DIR` 开关，测试实例不再和正在跑的实例抢同一份界面组件数据、
  也不再互相覆盖日志

---

### 第十三轮：拖放真正修好——手写接收器整条路都是死的（2026-10-16）

用户第四次报"拖放还是没用"，并说自己两屏摆位（图览在左主屏、资源管理器在右副屏）、
禁止光标没有"松开"提示，还怀疑上次测试时屏幕上的"拖放接收器"窗口是成功前提。
这次用一系列对照实验把手写注册这条路钉死，换成验证可行的方案。

- **手写注册的接收器，外部拖放一次都不会调进来**。对照实验（新工具
  `tools/droptest_manual.cs`，编译成 `droptest_manual.exe`）：一个普通顶层窗口，
  只挂图览同款手写 `RegisterDragDrop` 注册，资源管理器拖上去毫无反应；
  同一个 exe 把注册换成窗口自带的 `AllowDrop`（`Opacity=0.75` 半透明，实测）——
  `dragenter files=True`、`松手 3 项 …` 立刻就来。**唯一区别是注册方式**
- **中途量到的两个硬数据**：手写注册在 OLE 没初始化时返回 `0x8007000E`（E_OUTOFMEMORY），
  窗口已带别人的注册时返回 `0x80040101`（已注册）——`tools/droptarget_probe.ps1` 里能直接看到
  `OleDropTargetInterface` / `OleDropTargetMarshaller` 两个属性的值，手写注册和正常窗口的
  属性布局一模一样，但前者就是没人调
- **之前 4 个窗口全收不到的原因清楚了**：窗口树上的接收器全是手写注册那一套；
  内层渲染窗口又属于浏览器进程，资源管理器只认"落点窗口所在进程自己注册的接收器"。
  子窗口/透明层/整棵树的看门狗都救不了这条路，全部删除（`src/DropTarget.cs` 整个移除）
- **改用"接收遮罩"**：外部拖放进行时，在窗口上盖一块半透明遮罩（顶层、带所有者、
  `AllowDrop`，中央写"松开即可打开"），收到后拿到的就是资源管理器的真实路径。
  遮挡层的显示时机照旧用轮询判断（按下的一瞬间在不在窗口里）
- **实测走通**（`tools/explorer_drag.ps1` 从资源管理器真拖，工具这次加了列表滚到底
  再取坐标、按下前核对上层窗口两道保险）：
  `外部拖放进入窗口，接收层已显示` → `拖放进来` → `拖入 1 项：D:\GISViewer\samples\wuningGEP.json`，
  页面 `current.path` 同步变成该文件；启动期拖放（`earlydrop_test.ps1`）也补送成功
- **启动期的一个时机坑**：软件刚起来时左键已经按着在拖，第一跳轮询会误判成"在自己窗口里按下"，
  遮罩亮不起来；`_btnWas` 初值改成 true 解决。另外"主窗口层的拖放离开"事件不再去关遮罩
  （遮罩接管时主窗口必然收到离开，会把遮罩关掉），遮罩的显隐完全由轮询负责
- **副屏最大化滑出屏幕**：`MINMAXINFO.ptMaxPosition` 是相对显示器左上角的坐标，
  原实现按屏幕绝对坐标填了 `rcWork.Left`，副屏上等于让窗口挪到 x=1920+
  自己屏宽的位置。改成 `rcWork - rcMonitor` 相对值；实测副屏最大化后窗口稳稳盖在副屏
  （1912,-8 - 3848,1040）
- 用户问的"拖放接收器"窗口：那只是测试用的拖动起点，不是成功前提

---

### 第十四轮：弹窗工具行、真几何量算、滚轮平滑度实测（2026-10-16）

用户六条反馈：识别弹窗收尾、滚轮缩放体感、位置组件间距、信息栏文案、属性表细节、
设置窗口与关闭按钮行为；顶栏样式要方案图。

- **识别弹窗**：底部工具行 [聚焦][面积周长] …… [‹ 1/2 ›]，上下切换图标改用历书那枚
  单色 chev（放大到 9×16、和页码垂直居中）；关闭按钮从"文字行高定位"改成 flex 居中，
  实测与标题中线同为 338.7px 才定稿（top 从 6px 试到 3px 再回 6px，以实测为准）
- **量算绕了个弯也是这轮最有价值的发现**：地图上画的几何是 `/api/vector` 按视野
  抽稀过的（displayed 几何比真实小 ~6%，拿属性表自带的 Shape_Area 对出来的），
  前端的 Vincenty/等积纬度实现虽然和 GDAL 只差 0.02 平方米（用 tools 里 ring.json +
  `ogr.GeodesicArea` 对照验证），但输入是抽稀几何，结果照样错。最终改成新接口
  `/api/measure?path&layer&fid`：引擎按 OGR FID 回读原始要素，转 WGS84 后
  `GeodesicArea/GeodesicLength`（GDAL 3.10 自带，与 GeographicLib 同源），
  顺带返回经纬度包围盒给"聚焦"用（聚焦同样不能用抽稀几何的范围）。
  前端删掉自带的测地算法，只留格式化和按钮禁用判断；FID 缺失时按钮置灰
- **滚轮平滑度（用户说"改不了告诉我"）实测结论**：逐帧渲染不是瓶颈——矢量和影像
  两种场景各采样 240 帧，p50/p90/p99 全是 17ms（60 帧），没有卡帧；单格滚轮是
  一次约 130ms 的缓出动画（zoom 逐步 0.02/帧收尾），本身就是"平滑过渡"。
  与 ArcGIS Pro 的差别在**快节奏连滚**：每格动画会被下一格打断重来，形成一顿一顿的
  脉冲节奏，而不是连续惯性缩放。MapLibre 只暴露"每格缩放步长"一个旋钮
  （scrollZoom.setZoomRate，默认 1/100）；试过 1/160，同样手势位移变小、脉冲略减。
  未擅自改默认值——要给用户选：默认立即响应，还是要更绵密的步长
- **位置组件**：间距不齐的根因是数值列预留宽度（5.6em）在不同小数位下塞不满，
  空档时大时小；干脆去掉预留（保留等宽数字），项距统一 5px，任何位数下都一样
- **属性表**：抓手改为"容器不响应 + 64×10 内部命中区 + ::after 画 4px 色条"，
  颜色加深到 text-dim；表头气泡去掉"字段名："前缀，类型说明重写；点表体任意空白
  取消整列选中（复用 selectAttrCol 的切换逻辑）；`.load-spin` 补 `display:inline-block`
  （它是 `<i>`，行内元素上 width/height 不生效，这就是"变形"的原因），续读行居中
- **设置窗口**：`.modal-body` 的负边距+右内边距留白删除；`.card-title` 加通条分隔线
  （高 900 的窗口里两个弹窗共用，一并生效）
- **关闭按钮行为**：新配置项 `close_act`（min/exit，默认 min=最小化留在托盘）。
  网页读设置后 `toShell('closeact:…')`，壳里 `win:close` 分支据此最小化或退出；
  引擎白名单同步放行 `close_act`。实测：默认→点击后窗口最小化并记日志；
  切到 exit→点击后进程退出、引擎正常回收
- **顶栏方案**：出了"现状 / 细线 / 浮岛 / 高密度"四条约 1:1 的渲染图（含真 logo、
  实际色板），交互页已在对话里给出，**等用户挑定后再动正式代码**
- 连同上一轮遗留：识别弹窗页脚图标、位置组件等改动都在 19:05 的包里有实测记录

---

### 第十五轮：顶栏定稿方案 C、拖放遮罩按内容点亮、托盘驻留不带任务栏按钮（2026-10-16）

- **顶栏**：按用户挑定的"高密度"方案重排。整条 44px（原来 56px），只留 logo + "图览"，
  路径框与"查看"连体、最大 560px；选择文件 / 主题 / 设置三枚改成 32×30 的图标按钮
  （图标 19px，比原来 15px 大一圈），说明全部放进悬停提示。选择文件用用户给的
  `选择文件.svg`（改成 currentColor + 两层不透明度，深浅主题都跟），设置用历书那枚
  `ICO.gear`。中间 `.bar-gap` 是弹性空白，实测 544×43px，专门留给拖窗口和双击最大化
  - 实测（真鼠标 + `tools/winrect.ps1`）：在空白处按住移动 200×120，窗口矩形从
    `2160,66-3600,966` 变成 `2360,186-3800,1086`；连点两下 → `win:max`，
    `body.maxed=true`，窗口 `1912,-8-3848,1040`（跨双屏的工作区）
  - 踩到的坑：第一次用 CDP 合成事件测拖动没反应——`Input.dispatchMouseEvent` 只进
    渲染进程的输入管线，系统那套"按住标题栏移动窗口"的循环拿不到真实按键，
    必须用 `mouse_event` 打真实输入才测得准
- **拖放遮罩改为"确认是文件才亮"**：原先轮询一判定是外部拖动就把 0.62 的遮罩压上去，
  于是拖任何软件、拖一段文字都提示"松开即可打开"。改成遮罩先以**看不见**的状态就位，
  `DragEnter` 拿到数据对象、`GetDataPresent(FileDrop)` 为真才把透明度和页面提示一起亮出来
  - 试过在亮遮罩之前先问 OLE：`OleGetClipboard` + `IDataObject.QueryGetData(CF_HDROP)`
    实测返回 `0x8004006A`（DV_E_FORMATETC），连文件拖放也问不出来——拿到的不是被拖的
    数据对象，这条路放弃，代码删干净
  - **`Opacity = 0` 不行**：整条透明之后系统不再把拖放命中给这个窗口，实测连 `DragEnter`
    都收不到（日志里只有"已就位"没有"拖放进来"）。改用 `HIDDEN_ALPHA = 0.004`
    （alpha 1/255，肉眼看不出来），命中测试还在，实测 25ms 后就收到 `DragEnter`
- **被资源管理器盖住就拖不进来的真正原因**：不是 Z 序一件事。
  一是"这次按住算不算外部拖动"只比了坐标——资源管理器压在我们窗口上时，拖动的起点坐标
  也在我们矩形内，被误判成"自己窗口里的拖动"，遮罩根本不亮；二是遮罩不是置顶窗口，
  命中测试被资源管理器抢走。改成按下那一刻用 `WindowFromPoint` + `GetAncestor(GA_ROOT)`
  看"这个点最上面的窗口是谁家的"，并且遮罩在拖放期间 `TopMost`
  - `tools/explorer_drag.ps1` 加 `-Overlap`：把资源管理器摆到目标窗口左半边上面、
    落点选在露出来的右半边，并且不再把目标窗口提回前台。实测文件成功打开
    （日志：接收层已就位 → 拖放进来：是文件 → 拖入 1 项）
  - 反向验证：`tools/dropsrc.cs` 加 `text:` 前缀可以拖一段纯文字，实测日志是
    "拖放进来但不是文件，遮罩不亮"，页面 `body.className` 全程没有 `native-drop`
- **关闭按钮收进托盘**：`WindowState = Minimized` 任务栏上照样留着按钮（改
  `WS_EX_TOOLWINDOW` 也压不住已经建好的那个，UI 自动化实测仍列得到"图览 - 1 个运行窗口"），
  而改 `ShowInTaskbar` 会重建窗口句柄、把 WebView2 一起废掉。最后用 `Hide()`：
  窗口一藏，任务栏按钮和 Alt+Tab 那一项同时没了。`tools/taskbar.ps1`（UI 自动化列任务栏按钮）
  实测：关闭前 True → 收进托盘后 False → 按 Ctrl+Alt+G 回来后 True
- **弹窗关闭按钮**：改成弹窗挂出来之后按实测行高现算 `top`，对的是 `.idp-name`
  那行文字的中线而不是 `.idp-title` 那一整格（格子里还垫着 5px 内边距和 1px 分隔线，
  照着格子中线摆就低 3px）。实测默认字号 `delta=0`，把标题强改成 22px/1.6 之后 `delta=0.4`
- **设置弹窗滚动条右侧那条带**：来源是 `.modal-card` 自己的 16px 右内边距（上一轮删的是
  内容层的，所以没删掉）。改成卡片不再占左右内边距，`.card-title`/`.modal-body`/`.alert-body`
  各自缩进 16px，滚动条贴住卡片内缘；实测 `.modal-body` 右缘 1079、卡片内缘 1080、
  滚动条宽 11，右侧再没有第二条带子
- **属性表**：点空白取消整列选中的监听从 `table` 挪到 `#attrBody`（最后一行下面那块空白
  属于容器不属于表格，事件根本走不到旧监听上）；实测点 `.attr-body` 之后 `attrCol` 由 2 → -1、
  `.col-sel` 由 4 → 0。续读提示从"表格最后一行"改成浮在面板下缘的胶囊（旧做法新行一插
  就把它顶出可视区，等于永远看不见）；实测滚动到底时提示可见、读完自动收。
  标题下边距 8→6、抓手 10→8、与位置组件的间距 10→4
- **文案**：`FIELD_TIPS` 全部去掉结尾句号，非坐标几节按"这是什么 + 看它做什么"重写；
  `typeExplain` 改成通用叫法（双精度浮点 Real、长整数 Integer64、文本 String…），
  实测 32 条气泡 0 条以句号结尾。左上角坐标改成"西 …"/"北 …"两行，与"范围"四边同一套写法
- 新增工具：`tools/cdpshot.mjs`（连已在跑的 WebView2 抓真实渲染帧，可只裁某个选择器）、
  `tools/cdpclick.mjs`（CDP 真实点击，坐标可写 `sel:选择器` 让它自己量中心）、
  `tools/taskbar.ps1`（UI 自动化列任务栏按钮）

---

### 第十六轮：置顶遮罩闯的祸、弹窗对齐退回纯 CSS、图层切换入口讨论（2026-10-16）

- **置顶接收层是错的**：上一轮为了"被资源管理器盖住也能拖进来"把遮罩设成 `TopMost`，
  图览最大化时它铺满整屏，盖住并抢走别的软件的拖放（用户实测：拖其他软件过去被遮挡、
  历书/微信的按钮点了没反应）。真正的根因只是"按下那一下算不算外部拖动"用坐标判断。
  去掉 `TopMost` 之后两条都成立：
  - 新增 `tools/dragcover_check.ps1`：最大化图览、压一个资源管理器在它左半边、
    从 `dropsrc` 拖文件悬住不放，中途逐点 `WindowFromPoint`。实测落点（露出来的右半边）
    最上面是我们的接收层（`WindowsForms10.Window…`，矩形 `8,52-1912,1024`），
    资源管理器那块最上面是 `CabinetWClass` —— 接收层不再骑到别家窗口头上
  - 同一份 `-Overlap` 回归再跑一次：仍然 `拖放进来：是文件 → 拖入 1 项`，
    说明置顶从来就不是必需的，坐标判断那一条修好就够
  - 拖文字的回归第一次没触发 `DragEnter`，查下来是测试脚本自己的问题：图览最大化时
    `dropsrc` 的窗口被压在下面，按下点落到了图览上。把窗口还原后重跑，
    日志 `拖放进来但不是文件，遮罩不亮`、页面 `body.className` 全程无 `native-drop`
- **弹窗关闭按钮退回纯 CSS**：界面缩放是 `html { zoom: var(--ui-zoom) }` 的等比缩放，
  所有像素一起变，所以只要把 `.idp-title` 的 `line-height` 写死成 20px，
  按钮 `top` 就是 `内容顶边距 7 + 半行高 10 - 半按钮 11 = 6px` 这个恒等式，
  不需要 JS 现量。`alignClose()` 删除。实测 `delta=0`，按钮 22×22、圆角 5px、padding 0，
  与信息窗收起按钮 `.fold-btn` 完全一致
- **识别弹窗两列定宽**：`.idp-row` 从 `flex + space-between` 改成
  `grid-template-columns: 92px minmax(0,1fr)`，字段名换行不挤列。实测四行的名称列
  都是 `left=119 width=92`、值列都从 221 起
- **属性表**：标题下边距 6→3、抓手 8→5、与位置组件 4→2（实测 3px/5px/2px）；
  取消整列选中的监听从 `#attrBody` 提到 `#attrPanel`，点标题栏也生效
  （实测点表头 `attrCol=1`、点标题栏回到 -1）
- **顶栏字号**：logo 22→28、"图览" 15→22（`line-height:1.1` 保证在 44px 条里居中）、
  起始页标题 22→20；实测全页字号分布里 22px 只有"图览"一处，最大
- **待议（未动代码）**：多图层文件的切换入口现在有三处（地图右上角原生 `select#mapLayer`、
  属性表标题栏 `select#attrLayer`、左上角信息窗只显示文件名）。用户提议把信息窗标题和
  信息栏标题都换成同步的下拉框。讨论结论见对话，先不执行

---

### 第十七轮：选中即开、设置页体检、按定位补的四个小功能（2026-10-17）

- **Ctrl+Alt+空格 = 打开资源管理器里选中的东西**：全局热键第二个（`HotkeyId2`，注册失败只记日志
  不影响别的），命中后走 `Shell.Application` → 最上面那个资源管理器窗口的
  `Document.SelectedItems()` → `Path`，拿到的就是真实路径，复用拖放那条链路（`OnDroppedPaths`）。
  只认"屏幕上最上面的资源管理器窗口"（`EnumWindows` 顺序即 Z 序），不去翻某个不知道什么时候
  开着、还留着上次选择的窗口。一次最多五项。
  - 用 `keybd_event` 打真实按键实测：选中 `pre_2000_01.tif` 按热键 → 日志
    `选中即开拿到 1 项` → 界面 rail 标题变成该文件；选中 `GISProject.gdb` 文件夹同样能开
  - 空格单独按被系统自己的"快速预览"占了，抢不过来，这点写进设置页说明
- **设置页整体体检**（逐项看文案、布局、是否真生效）：
  - 色带下拉画出真实色带：`/api/config` 多带一份 `ramps`（放在 config 外面，它是"有哪些可选"
    而不是用户的一项设置），页面按 value 给 `<option>` 挂 `data-grad`，
    `controls.js` 在按钮和每个选项下面画一条渐变；端点颜色只有引擎里那一份
  - 布局：所有控件统一 36 像素高、6 像素圆角；密钥那格 `grid-column: 1/-1` 横跨两列；
    系统一节改成"高的配高的"（快捷键|关闭按钮、两条按键说明、两个开关），不再有一列空一块
  - 文案：`发布页访问令牌（仓库不公开时才需要）` → `更新检查用的访问代码（软件没公开时才需要填）`；
    快捷键说明从"缩到任务栏"改成"收进托盘"；新增两条按键说明字段（选中即开、Esc/F/Ctrl+F）
  - 踩到两个真 bug：① 快捷键那句说明被脚本里的 `HK_HINT` 常量覆盖，改页面文字没生效；
    ② 原 `select` 拿到焦点时把焦点环画在标签上（看着像"色带"缺一个字），给 `.combo-source`
    关掉 outline
  - 实测生效项：色带 viridis→redblue（图例色块变成 33,102,172…178,24,43）、
    分级 5→7（图例 15→21 个元素）、单位 en→zh（"500 × 500 米"）、面板不透明度 100
    （`--panel-alpha: 1.00`）、界面字号 110（`.bar` 的 computed zoom=1.1、高 44→48.4）、
    没有数据的地方→涂黑、主题切深色后顶栏整套跟色
- **配置目录不隔离的真 bug**：`config_dir()` 写死 `%APPDATA%\GISViewer`，而壳的日志和
  WebView2 缓存跟着 `GISVIEWER_DATA_DIR` 走——我拿隔离实例改色带，实际改掉了用户真正的设置
  （已把 ramp/class_count/nodata_view/ui_zoom/panel_alpha/unit_lang 恢复成默认并清掉测试路径）。
  改成 `GISVIEWER_DATA_DIR` 优先，实测隔离实例写自己的 config.json、用户那份纹丝不动
- **按"快速查阅"定位补的四样**：
  - 最近打开：`config.recent`（引擎白名单加一项，最多 8 条，临时副本不记），
    路径框聚焦弹下拉，点一条直接重开，可一键清空。实测点开、重开都正常
  - 坐标定位：同一个路径框两用，`parseLonLat` 认 `116.4, 39.9`、`116.4 39.9`、`116.4E 39.9N`，
    带路径符号或结尾像扩展名的一律不当坐标；命中就 `GisMap.goTo` + 十字标记 + 一枚小提示
    （地图底下那行说明会被视野变化刷掉，所以不复用它）。实测 100.5,26.5 飞过去、
    位置组件读数跟着变、当前图层没被重开
  - 属性表查找：标题栏一个框，按关键字筛已加载的行、右边报"命中 N / 共 M"，续读进来的新行
    跟着一起筛；`/api/vector` 在 `geom=0` 那一路多带一个 `fid`（画图层那一路不带，
    免得动到地图自己的要素 id），双击某行用 `/api/measure` 的 bbox 把地图框到该要素。
    实测筛"乙区"命中 1/3、双击后层级 10.3→11.4
  - 按键：Esc 一层层收（提示→设置→弹窗→识别弹窗→属性表）、F 回全图、Ctrl+F 聚焦查找框，
    打字时不抢键。实测三条都对
- 新增工具：`tools/dragcover_check.ps1`（拖放期间逐点问"谁在最上面"，防遮罩再犯）、
  `tools/cdpclick.mjs` 改成一次调用发单击+双击

---

### 第十八轮：选中即开取窗、单实例、图层切换与量算提速（2026-10-17）

- **选中即开取错对象**：旧 `TopmostExplorer()` 直接拿 `EnumWindows` 里第一个资源管理器窗口，
  不判可见、不判最小化，用户现场留下过 `D:/ICalendar/_deps` 的旧窗口就被选中。
  改成 `VisibleExplorers()` 只收可见、未最小化的窗口并按 Z 序排：前台是资源管理器就用它；
  否则取层级最上、确实有选中项的窗口；只剩一扇可见窗口而没选中时用它的当前文件夹；
  都没有就推一条明确提示。实测在 samples 里选中 China2019 相关文件按热键，打开的是该文件
- **第二条快捷键进设置页**：`hk2_mods/hk2_vk`（默认 3/32）进引擎配置白名单，页面按下即录、
  可恢复默认，壳里 `ApplyHotkey2()` 立即重注册；失败退回默认并推 `hotkey2Failed`，不静默。
  实测改成 Ctrl+Alt+K 注册成功并落盘，恢复默认 Ctrl+Alt+空格 也正常
- **选择文件按钮回归**：本机隔离实例和打包版都复现不出用户那次失效，于是把可疑点全部加固：
  `#filePickBtn` 改为挂在 `document` 顶层的点击委托，不再依赖初始化顺序；`OpenFileDialog`
  从上次打开数据所在目录起步（首次退回我的文档）、`RestoreDirectory=true` 不污染系统记忆；
  从打开框来的路径不再走两秒同路径去重；每一步写进日志。打包版全流程实测
  「点按钮→系统框→选 China2019.zip / wuningGEP.json→正常加载」
- **识别弹窗收边**：主体 padding `7px 10px`，关闭按钮 `top:6px;right:10px` 并与主体右边界
  对齐（实测 close x=658..680、body 右边界 680）；标题右留 26px 防压字；翻页按钮
  22×22、箭头 7×12，与关闭按钮同尺寸；聚焦/计算 26×26、图标 15px；要素数量 13px 与正文
  一致；隐藏 `OBJECTID` 和 `_` 开头的内部字段
- **聚焦/计算半天才响应**：根因是每次量算都重开并解析整份大 GeoJSON，wuningGEP（133 MB）实测
  单次 7.4～14.8 秒。`vector.read_features` 在抽稀前用原始 WGS84 几何算好
  `_msr_area/_msr_len` 放进 feature.properties（`_METRICS` 缓存上限 30000）；前端优先用本地值，
  没带才回退 `/api/measure`，服务端用 `_MEASURE_SRC/_MEASURE_HITS` 复用已开 dataset。
  实测点击到出结果 1 ms，值 18452.128 m² / 1123.09 m 与服务端一致；聚焦改用 `geomBBox()`
  即时 fitBBox，点击 0 ms、层级到 7.9
- **抽稀规则与提示**：线/面在每个缩放级别按 1.5 屏幕像素误差抽稀
  （`1.5*360/2^z/256`，高倍去掉了 2 米地板），点与栅格不抽稀。`WkbSize()` 前后比较判断是否
  真删点，meta 带 `simplified/simplified_features`；只有真删点才在地图说明后追加
  「显示几何已抽稀 · 抽稀误差不超过 2 个屏幕像素，量算仍按原始几何」。China2019 实测出现提示。
  抽稀时机（档位/是否手动）仍待与用户确认
- **连滚一顿一顿**：`scrollZoom:false` 自绘累加器，把每格增量累加成目标层级，rAF 逐帧追进
  （每帧 32%），`jumpTo` 后修正鼠标锚点经纬度；单格约 0.2 级、单次上限 0.6。实测 `__zs`
  3.19→3.24→3.27…→5.5 连续变化，不再互相打断
- **属性表两个加载提示**：删掉行内「正在读取要素…」，`#attrBody` 外包 `.attr-body-wrap`，
  `#attrLoad` 胶囊定位 `top/left:50%`；首屏与滚动续读共用。实测胶囊中心 (492.5,755.4)
  与容器中心完全一致，加载完隐藏，行数 501→1001，`inline:false`
- **图层切换单一入口**：`map.js` 维护 `targets/activeTarget` 并 `emit('gis:layers')`，
  `selectLayer(i)` 同时切地图、图例、说明和属性表；文件信息标题改成自绘下拉
  `#chipLayerBtn/#layerPop`（单层不可点），删除地图右上角 `#mapLayer` 和属性表标题栏
  `#attrLayer`。GDB 5 层实测切第 2 层后表头变 `NO_Real`、501 行、说明变
  `T_stationsgeo__XYTableToPoint`
- **单实例唤回**：`Local\Tulan_GISViewer_Instance` 互斥量；后启动进程用 `EnumWindows` 按标题
  「图览」+ WinForms 类名找主窗口，`PostMessage(WM_APP+17)`，首实例 `ShowFromTray()` 后
  后启动进程退出。实测收进托盘后再启动，第二实例退出、首实例窗口回到前台。
  曾试的 WM_COPYDATA 文件转发在本机被系统拦截（Send 返回 False），用户只要求唤回，已删除
- 波及面自查：页面 `jserr:` 无报错；设置页新增快捷键项、恢复默认、两条热键同步均实测；
  顶栏/信息窗/属性表布局全窗截图核对。自查发现并修掉两处：多图层长文件名会把信息窗
  撑到 387 像素宽、把收起/关闭按钮挤出卡片（`.fold-in` 作为网格项 `min-width:auto`，
  改为 0，实测标题按钮回到卡片内、长名省略号）；图层下拉用半透明底色，列表文字和
  背后信息窗叠在一起（改用不透明 `--panel`）。修正后 `head=280`、`close x=282..304`

---

### 第十九轮：本地缓存、弹窗量算、艺术字标题与反馈修复（2026-10-17，0.11）

- **本地缓存**（本版主打）：`gisviewer/cache.py` 两层（内存 OrderedDict LRU 48 条 + 磁盘
  `config_dir()/cache/`），键 = 用途 + 参数 + 规范化路径 + 文件指纹（文件看大小/修改时间，
  目录型扫清单）+ 引擎版本；256 MB 上限按 mtime LRU 清理。server 侧包住 inspect、直方图、
  缩略图三路；命中时 `elapsed_ms` 改写为读缓存耗时并置 `cached=True`，页面显示"缓存命中"。
  实测（隔离 DATA_DIR）：geojson 5.94 s→0.002 s、tif 30 ms→2 ms、直方图 29 ms→3 ms、
  缩略图 694 ms→12 ms、分级缩略图 125 ms→2 ms；touch 后自动失效重读；上传临时副本与
  失败结果不缓存。设置页"数据缓存"显示占用/条数并可清空（真窗口实测 32.95 KB（2 项）→
  清空后"还没有缓存内容"）
- **点选弹窗量算**：弹窗工具行尺子按钮（`ICON_MEASURE`），`vector.measure_feature` 按原始几何
  `GeodesicArea/GeodesicLength` 算真实面积周长；结果块钉在工具行上方（`.idp-measure` 插在
  `footNode` 前），翻页 `step` 回调 `if (measureOn) { dropMeasure(); doMeasure(feats[idx]); }`
  自动重算。真窗口实测：内蒙 1146000 km²/12480 km，量算块底 236 贴在工具行顶 239 上方
- **标题艺术字**：MaShanZheng 子集化「图览」→ `web/fonts/title.woff2`（1,572 B），
  `@font-face "Tulan Title"` 接入顶栏，随包分发不依赖用户字体
- **用户反馈 10 项**：①系统文件对话框点不动——根因是拖放轮询的"按下的点在自己窗口里吗"
  判定只认主窗口，对话框上的按下被当成外部拖入、遮罩盖住对话框吃点击；改为进程判定
  （`Host.PidOfWindow`）+ 弹框期间 `SuspendDragWatch`、关上 `ResumeDragWatch`（重置
  `_btnWas`）②.gdb 打开文件夹（路径按钮 pickPop 菜单 + IFileOpenDialog 选目录）③多图层
  标题两行（第一行图层名，第二行 文件名 · 第 N/M 层）④属性表列宽固定 ⑤弹窗量算
  ⑥"有效值范围"文案 ⑦查找计数移左 ⑧路径框 placeholder ⑨悬停气泡阴影 ⑩错误/警告
  浮层卡片（替代系统弹窗，原图层保留；真窗口逐一实测）
- **自查发现并修**：直方图缓存命中没打 `cached` 标记和命中耗时——`cached_band_stats`
  命中分支漏了 `_stamp_elapsed`，补上与 inspect 对齐（全格式 sweep 里发现）
- **全格式 CLI 自查**（隔离数据目录 sweep，22 项全 PASS）：wuningGEP（10.9 万要素，
  inspect 3.6 s → 缓存 0.000 s）、tif（直方图 bins=12、缩略图两次同字节且第二次 0.012 s）、
  China2019.zip（按 `read_path` 的 `/vsizip/` 路径读矢量；measure 北京 16405 km²；
  identify 内蒙古坐标命中 1）、GISProject.gdb（7 层）、architectural.dwg（版本不支持时给
  友好说明）、坏块 osm.pbf（整体不炸、逐层带错误）、cropland-pbf（tileset 8.8 KB 瓦片 +
  单 pbf 当矢量读 3 要素）、不存在/空路径/栅格当矢量都有友好错误；页面 `jserr` 无报错
- **测试工具教训**：拖放回归连挂四次，根因不在产品——源窗口被用户浏览器盖着，而
  `BringWindowToTop`/`SetForegroundWindow` 在后台进程里被前台锁静默拒绝。`tools/dragdrop_test.ps1`
  改为 `SetWindowPos(HWND_TOPMOST)` 硬置顶 + 按下点按进程号验证（盖错当场警告）、测完收掉置顶；
  全链路重测通过（`mouse down → drag done Copy →`「拖放进来：是文件」`→`「拖入 1 项」）

### 第二十轮：0.11 反馈修复批次（2026-10-18，0.12 待打包）

用户对 0.11 的反馈全部落地，代码已就绪（Shell 侧未编译，等打包时一起验）：

- **大文件"二次打开慢"**：根因是 `/api/vector` 从不缓存（0.11 的缓存只包了 inspect/直方图/缩略图）。
  `read_features` 改手写序列化（`geom.ExportToJson` + 按索引 `GetField`，不再逐要素建 dict），
  `_stamp` 外提、`layer_total_hint` 跳全量计数；加 `kind="vec"` 响应缓存（键含 layer/limit/tol/bbox，
  offset==0 才存、>48MB 不存、命中时 `_stamp_elapsed` + `gisviewer.cached`）。
  实测 wuningGEP 27 s → 11 s、重开 0.39 s
- **DWG 打开不自动聚焦**：转换出的 DXF 不记坐标系，`read_features` 抛"这个图层没有坐标系"。
  现在无坐标系且驱动不在 `DEFAULT_WGS84_DRIVERS` 的，按原始坐标当米（EPSG:3857 语义）临时摆放，
  meta 带 `assumed_local=True`（bbox 过滤忽略、in_bbox=layer_total）；新增 `vector.read_target()`：
  .dwg 先 `ogr.Open`、失败再 `dwg2dxf`（dwg.py 按 路径+mtime+size 缓存转换产物，不再每次转）；
  identify/measure 对 assumed_local 做 3857 换算（高亮转回经纬度、量算按椭球）；
  map.js 无 wgs 数据时按要素包围盒 fit 一次（vecLocalFit 记账），note 注明"按原始坐标当作米临时摆放，仅供预览"
- **几何类型计数**：`vector.geom_type_counts` + `GET /api/geomtypes`（kind="gtypes" 缓存）；
  前端混合类型时先"正在统计…"，异步取回结果后重画信息栏；109007 要素首次 12 s、缓存 0.02 s
- **坐标系全名 + EPSG 独立行**：`crsRows` 拆两行显示（0.11 批次起），本轮补下划线美化
  （`prettyCrsName`，`China_Albers...` → 空格）
- **注记切换丢图层**：`refresh()` 走 `setStyle` 后数据源/图层全没，而 `wire()` 不会补。
  现在 refresh 置 `needRedraw`、`wire()` 在 styledata 后 `draw(data, true)`；
  keepView 参数贯通 draw/drawTarget/drawVector/drawTileset（跳过 fitTo，视野不动）
- **错误/警告浮层重做**：icon 26px 填充三角与文字垂直居中、top 56→84px、去左边橙条、去关闭按钮；
  12 s 自动隐藏（errToastTimer）+ 点卡片即关；DWG 转换说明改浮层（renderResult 里 showErrToast）
- **地图指北/复位**：NavigationControl 开 showCompass（标题中文化"指北：把地图转向正北"）；
  homeBtn（十字准星图标）并入右上角控件组，点击 `jumpTo [104,35] z3.2 bearing0 pitch0`
- **设置页批量**：SETTING_TIPS（按控件 id）+ SETTING_LABEL_TIPS（无 for 的标签按文字）给全部
  27 个标签挂提示图标（复用 `[data-tip]` 悬停气泡）；密钥"显示"按钮换输入框尾部眼睛图标
  （`.key-eye`，peeking 类切换眼睛/划线眼）；底图选项去中文空格；"最近打开显示条数"控件
  （`cfgRecentMax`，config.recent_max 默认 5、内部 RECENT_KEEP=20）；缓存路径显示
  （/api/cache 新增 `data_dir` 字段 → `#cachePathHint` 写明缓存文件夹位置）；
  自启文案改"只挂托盘，不占任务栏"
- **Shell 侧**：PickFiles `Multiselect=false`（UIA 实测对话框 `CanSelectMultiple=False`）；
  ExplorerSelection 加 `_sawVirtualPick` 防护（选到"此电脑"这类 `::` 虚拟对象给
  "这里没有能打开的文件"）、ReadSelection 过滤 `::` 且 `GetRange(0,1)` 只取首个；
  开机自启托盘-only——打包前发现"只拦第一次显示"有个洞：`--hidden` 进场时窗口句柄从未创建，
  `OnHandleCreated` 里的全局快捷键根本没注册、界面/引擎也要等第一次显示才开始初始化。
  修法：进 ctor 先 `Handle`（强制建句柄，快捷键与拖放层就位）+ `BeginInvoke(Boot)` 后台预热，
  `_booted` 旗标挡住 Load 的第二次 Boot。真窗口实测：`--hidden` 启动无窗口
  （MainWindowHandle=0）但引擎 682 ms 就绪、页面已加载、快捷键已挂上；
  再启动一个实例（单实例转发）窗口立刻亮出；WM_HOTKEY 消息链（最小化/还原）直接 PostMessage 验证通过
- **验证**：隔离无头 Edge + CDP 逐项核对（设置弹窗截图、眼睛切换、recent_max 落盘、
  toast 自动隐藏/点击关闭、compass/homeBtn、DWG assumed_local 视野 query、
  最近打开 gdb/瓦片目录点击重开、属性表查找框截图）；全格式 sweep 27 项全 PASS；
  真窗口（`dist\Tulan.exe` + CDP）核对：标题"图览 0.12"、`--hidden` 无窗口后台就绪、
  单实例唤起、单选文件对话框（UIA `CanSelectMultiple=False`）、compass/homeBtn/属性表查找框、
  gdb 与瓦片目录经最近打开重开、DWG 预览 + 转换浮层；退出后无 python/webview2 残留
- 打包：`archive\图览-0.12-win64.zip`（124.4 MiB）已出，含上述全部修复

### 第二十轮补充：0.12 打包后的一批小修（2026-10-18）

用户在 0.12 打包后补了一批小意见，代码已改、无头 Edge + CDP 验证通过，**尚未重新打包**：

- **CAD 图层不自动带底图**：无坐标系图层（`assumed_local`）显示时把 `bm`/`bm-note`
  两层设成 `visibility:none`（map.js `setBaseHidden()`），切回正常坐标系的矢量、栅格、
  切片时恢复；换底图/开关注记触发样式重建后，`wire()` 按记账立刻重新收起。
  验证：开 architectural.dwg 后跳到欧洲视野 0 个 OSM 瓦片请求、切回 China2019.zip 后 45 个；
  状态栏 note 补一句"底图与注记已暂时收起"
- **顶栏**：路径输入框加宽（46%→54%、max 560→660px）；占位符去掉开头的"示例"二字
- **地图控件**：指北针悬停光标从库默认的"抓"改普通指针（`:active` 仍"抓取中"）；
  复位按钮图标十字准星→房子；右上角控件组加 `overflow:hidden`——
  原来最下面的按钮悬停底色是方的，会从组的圆角里冒出来
- **信息栏**：FIELD_TIPS 新增 'EPSG'（原来只有"坐标系"一行有提示图标）
- **设置页精修**：全部静态小字说明移进标签后的提示气泡并改正式措辞；
  "开机自动启动（只挂托盘，不占任务栏）"→"开机自启动"；
  "副本存放位置"的提示只在引擎报错时出现；快捷键两行提示只在改键过程中出现
  （`settleHotkey` 清空）；缓存目录写进"数据缓存"气泡末尾（拿到 /api/cache 的
  `data_dir` 后动态补上，原 `#cachePathHint` 一行删除，`cacheLab` 记账那个标签）
- 打包与真窗口复验（2026-10-18）：`archive\图览-0.12-win64.zip`（124.4 MiB）重新打出、
  `dist\Tulan.exe` 12:27 编译；真窗口把上次锁屏做不了的两项补上——屏幕截图（全屏与
  "图览：选择要看的数据文件"对话框裁剪都正常）、真实按键触发 Ctrl+Alt+G（最小化/还原都对）。
  另复验：单选对话框 UIA `CanSelectMultiple=False`、控件组圆角裁剪、指北指针光标、房子图标、
  CAD 开图后跳转 0 瓦片请求、设置页 27 提示且无小字、缓存气泡含真实路径；退出无残留

---

## 8. 风险与待验证

| 项 | 状态 |
|---|---|
| nc / hdf 支持 | **已支持**，插件包已装并通过读写回环验证 |
| rasterio 读不到压缩信息 | **已定位**：压缩在 dataset 级 `IMAGE_STRUCTURE` 域，改用 osgeo 读，见第 2 节 |
| PROJ/GDAL 数据目录被用户全局变量污染 | **已处理**：`bootstrap.configure()` 重写 PROJ_DATA/GDAL_DATA/GDAL_DRIVER_PATH 并加 DLL 目录 |
| 几十 GB 大 tif 无样例 | 已用 2.25 亿像元稀疏栅格做代理压测：259 ms 出全部信息，降采样估算生效；真要 20 GB 仍需用户提供 |
| DWG 读取 | **已解决**：GDAL 自带的 CAD 组件只到 AutoCAD 2000，`architectural.dwg` 是 AC1021（2007~2009）。已加 libredwg 兜底：直接读失败就 `dwg2dxf` 转临时 DXF 再读，实测 1,694 个要素 114 ms。免安装版要把 `dwg2dxf.exe` 和 `libredwg-*.dll` 一起带上 |
| 天地图 Origin | **实测通过**：浏览器上下文取瓦片 200（影像和注记都是），curl 直连会被判"权限类型错误"，属正常；OSM 在本机超时 |
| 中文控制台乱码 | 已处理：CLI 里 `sys.stdout.reconfigure(encoding="utf-8")`，中文字段名与示例值输出正确；Git Bash 里的乱码是终端代码页，不影响程序 |
| 中文文件名上传 | 已处理：请求头 latin-1 限制，前端 `encodeURIComponent` + 服务端 `unquote`，中文名称落盘和回显都正确 |
| 打包体积 | **实测**：gisviewer 环境 1204 MB，剔除编译期内容、numpy 换成不带 MKL 的之后 runtime **364 MB**，整个 `dist` 377 MB，`tar -a` 压成 zip 后 **127 MiB**。解压到干净目录后直接双击即可跑：日志显示用的是包内 `runtime\python.exe`，引擎就绪约 0.7 s，底图、矢量、图例、比例尺全部正常 |
| MKL 占体积 | **已解决**：conda 的 numpy 链 Intel MKL，`Library/bin` 里那批 `mkl_*.dll` 445 MB。改成 PyPI 的 numpy wheel（自带 OpenBLAS）：`pip install --force-reinstall --no-deps numpy==2.5.4`，runtime 788 MB→364 MB，zip 274 MiB→127 MiB，`tools/check_runtime.py` 8 项健康检查全过 |
| 拖放拿真实路径 | **已解决**：手写 `IDropTarget` + `RegisterDragDrop` 挂在任何窗口上，外部拖放都不会调进来（对照实验钉死）。改成外部拖放时盖一块顶层半透明遮罩（`AllowDrop`，即窗口自带的接收方式）来接，拿到的就是资源管理器里的真实路径；本机实测资源管理器拖 wuningGEP.json 全链路走通 |
| 拖放验证 | **能自动化**：`tools/dropsrc.cs` 出一个只发起拖放的源窗口，`tools/dragdrop_test.ps1` 用真实鼠标按下—移动—松开走一遍 OLE 拖放，日志里看"拖入 N 项" |
| 超大 GeoJSON 首屏 | 132 MB / 10.9 万要素的 `wuningGEP.json` 出元数据要 3.5 s，瓶颈是 GDAL 得把整份读完；实测 OGR 并不比 `json.load` 快，要再快只能做流式/局部解析（读前几个要素 + 扫一遍拿范围），本轮没做 |

---

## 9. 明确不做

- 编辑、数字化、符号化、渲染样式定制
- 投影转换和重投影（只读信息，不改数据）
- 属性表的选择集、排序、筛选和导出（只按视野列出当前画出来的要素）
- 网络数据源、WFS/WMTS 服务浏览
- 多图层叠加对比
- 百度底图（BD-09 坐标系加私有瓦片编号，成本明显高于收益）
- 捆 ODA File Converter 来读 DWG（第三套运行时，分发包不可接受）

---

## 10. 版本

版本号由用户决定，本文件不自行递增。软件名「图览」，当前 `0.12`（用户确认）：
0.11 反馈修复批次（矢量响应缓存、DWG 本地坐标预览、几何类型计数、浮层重做、指北/复位、
设置页完善、Shell 单文件与托盘自启）已全部落地、真窗口验收通过并打包
`archive\图览-0.12-win64.zip`，见第二十轮记录；打包后又跟了一批界面小修
（CAD 不自动铺底图、控件与设置气泡化，见第二十轮补充），已重打包并真窗口复验通过。
原生壳 `dist\Tulan.exe` 加 364 MB 免安装
runtime 可跑，启动到界面出来约 0.7 s，无边框自绘标题栏。
剩下两件：在没装过 Python/GDAL 的机器上验一次全流程、发布到仓库的 Releases。
版本变更记录见 `CHANGELOG.md`。
