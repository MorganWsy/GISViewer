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
| --- | --- | --- |
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

```text
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

### 第三方库：openpyxl 要不要自带（2026-11-02，结论：暂不引入）

体检结果导出的 xlsx 目前由 `gisviewer/xlsx.py` 用标准库 `zipfile` 手写最小 OOXML（262 行），发布运行时里没有 openpyxl。**结论是继续这样，不带 openpyxl 进包。** 依据是能力对不上：导出只有三张结构固定的表，用到的恰好是手写实现已经覆盖的那部分——列宽、表头冻结、筛选、五种样式（标题/表头/正文/边框/加粗）、共享字符串；用不到的是合并单元格、图表、条件格式、超链接、图片、自定义数字格式（现在 `numFmtId` 全是 0）。为一个用不上的能力往发布物里加依赖，往后每次升级都要重打包验证，不划算。

实测数据（2026-11-02 在本机 conda 环境重跑，不是估的）：

| 项 | 数据 |
| --- | --- |
| openpyxl 3.1.5 | wheel 245 KB（0.24 MB），解包 0.82 MB，195 个文件，纯 Python 无 C 扩展，requires-python ≥3.8 |
| 依赖 et_xmlfile 2.0.0 | wheel 18 KB，解包 58 KB，没有别的依赖 |
| 许可 | 两者均 MIT，随包分发无障碍 |
| 打包方式 | `tools/pack_runtime.ps1` 是黑名单（`$excludeDir`），装进 conda 环境就会随包带走，脚本不用改 |
| 体积占比 | 现运行时 384 MB，加 0.9 MB 是 +0.23% |
| 导入耗时 | `import openpyxl` 294 ms（本机热缓存），只发生在导出那一下，不影响启动 |

三条路线当时比过：A 维持手写（0 成本，能力已够）；B 自带并改写 `xlsx.py`（换来图表、条件格式、合并单元格，但要重写 `build`/`write` 并重跑导出回归）；C 装了只用于导出后自检（不划算，为验证把测试依赖塞进发布物，标准库 `zipfile` 读回 XML 就能校验）。**取 A。**

将来转 B 的触发条件写在这里，免得又变成空谈：报告里要出现图表、要按档位给单元格配色、要合并表头、要让数字在 Excel 里能直接改格式——这四条里任何一条成立就转。转换时按四步走：① 装进 conda 环境；② 改 `xlsx.py` 的 `build`/`write`；③ 对外函数签名不变，`report.py` 不用动；④ 回归里补一条"用 openpyxl 读回三张表逐格核对"。

### 更新：清单放静态桶，替换交给独立的 updater（2026-11-13）

**边界先划清。** 这里做的是"用户点了才更新"：启动 15 秒后悄悄问一次清单（与设置页"每次打开后 15 秒"是同一个数），有新版本才在顶栏标题右边亮一枚图标，点开看说明，再点"立即更新"才开始下载。不做强制更新、不做后台静默替换、不做差分包（首次发布的整包才 30 多 MB，为了省这点流量引入二进制 diff 与版本链校验，风险远大于收益）。

**为什么不能自己换自己。** 运行中的 `Tulan.exe` 与同目录的 dll 被系统锁着，进程内写同名文件必失败；WebView2 的子进程在主管退出后还要多占几百毫秒。所以 `app\TulanUpdater.exe` 是一个几十 KB 的独立程序：主程序把「主进程 PID / 解压好的暂存目录 / 安装目录」三样传给它，自己立刻退出；它等 PID 消失（最多 120 秒）再逐个文件覆盖，完成后把 `Tulan.exe` 拉起来。三条原则写在文件头：只覆盖不删除（用户自己的配置与缓存保持原样）、逐个文件重试（12 次 × 250 ms，专治"锁着但马上就放"）、每步都写日志。

**发布侧就是一个静态目录。** 清单、签名与安装包同放一处，默认 `https://wsy-release.oss-cn-hangzhou.aliyuncs.com/tulan`（与历书共用同一个只读桶，不同前缀）。无鉴权、无服务端逻辑，客户端全程只发 GET；"发布"这个动作就是手动传三个文件，先包、再清单、最后签名——反过来会出现"清单有了包还没到"的窗口期，点更新就是 404。换地址改 `Host.cs` 的 `ManifestBase`，调试时用环境变量 `TULAN_UPD_BASE` 覆盖，不必重编译（本机就是用 `python -m http.server 8911` 当发布源验完的）。

**清单必须带签名。** `latest.json.sig` 是对"清单字节的 SHA-256"做的 ECDSA P-256 签名（88 字节 base64，IEEE P1363 的 r‖s），公钥写死在 `Host.cs` 里，私钥在 `D:\tulan-keys\update-private.txt`。为什么非签不可：`pkg` 与 `sha256` 都写在同一个清单里，只做校验和等于让被改过的包自己声明"我是好的"；签名把"这份清单出自私钥持有者"钉死之后，其余字段才能当数据用。**私钥丢了就等于断掉所有已安装副本的更新通道**（换机器要一起带走，别随手重生成）。

| 清单字段 | 含义 | 客户端怎么用 |
| --- | --- | --- |
| `ver` | 版本号 `X.Y` | 与引擎报来的 `ver:` 按两段整数比大小（字符串比会把 0.10 判成小于 0.9），更大才提示 |
| `date` | 发布日期 `YYYY-MM-DD` | 弹层里显示 |
| `notes` | 这一版改了什么，字符串数组；也接受一整段按行分开的文字 | 弹层分条列出 |
| `pkg` | 安装包文件名，与清单同目录 | 拼下载地址 |
| `size` | 字节数 | 下载时当总长算进度，下完再核一遍 |
| `sha256` | 整包校验和，64 位十六进制 | 不一致判"没下完整"，丢弃重来，现有文件一点不动 |
| `page` | 发布页地址（可选） | 弹层里给一个"看详情"的入口 |

多出来的字段一律不读，留着给以后换包格式用。

**打包一条命令：`tools\publish.ps1 -Ver 0.14 -Notes '第一条','第二条'`。** 它做四件事：① 对账——清单里的版本必须与 `app\gisviewer\__init__.py` 的 `__version__` 一字不差，不然客户端要么永远提示、要么永远不提示；② 把 `app` 下除 `runtime` 以外的全部打成 `tulan-patch-v<版本>.zip`（`runtime` 381 MB 且不随版本变，只有 `-Full` 才连它一起打）；③ 解包自查——`web/app.js`、`gisviewer/__init__.py` 必须在原位，根目录只准躺 exe 与 dll，混进 `runtime/` 直接报错；④ 写清单、算 sha256、签出 `.sig`，并核对私钥与 `Host.cs` 里的公钥是一对。当前 0.14 的包是 1.70 MB、41 个文件。

**客户端三步，任何一步失败都退回原样。** ① `Query()` 先取清单再取签名，**验签通过才解析**；网络不通、404、JSON 坏了、签名对不上都返回可读的话而不是抛异常（"还没有发布过版本"只在清单本身 404 时说，缺签名文件说的是"发布不完整"）；② `Fetch()` 下载到 `%LOCALAPPDATA%\GISViewer\update\v<版本>\`，核大小、核 sha256，再解压到 `stage\`；③ `Apply()` 起 updater 并退出。包内如果套了一层与包名同名的目录（`tulan-v0.14\...`）就把那层让出来——判据只认包名对齐，不拿"只有一个目录"当条件，因为增量包可能整包只有一个 `web\`，按"只有一个目录"拆会把文件摆到安装目录根上（0.14 开发期踩过，现为回归项）。日志固定落在 `%LOCALAPPDATA%\GISViewer\update.log`，不放在版本目录里——替换成功要删整份暂存，日志跟着删就什么都查不到。

**这一轮被自测抓出来的两个真问题。** 一是 `HttpWebRequest` 自带的进程内缓存：只写请求头 `Cache-Control: no-cache` 不管用，python http.server 这类只给 `Last-Modified` 的源会被按"启发式新鲜度"存住，改了清单再查还是旧字节；必须设 `CachePolicy = BypassCache`（清单与包两处都设）。二是验签的入参——把清单原始字节直接当哈希传给 `VerifyHash`，CNG 只取前 32 字节参与运算，改后半段照样验得过（实测），等于只保护了开头一小段；现在两边都先算 SHA-256 再签/验。

**还没经过真实 OSS 验证。** 本地静态源把「提示 → 下载 → 校验 → 替换 → 拉起」全链路跑通了（1.70 MB 的包覆盖 40 个文件、0 失败、暂存清空、日志齐全），篡改清单、缺签名文件两条拒绝路径也各验过一次；但公网桶的 CORS、CDN 缓存与真实带宽没测过，要等首版真发上去再确认一次。README 里不写"自动更新"，在确认之前只说"可以检查更新"。

---

## 4. 界面字段清单与取法

### 栅格

| 显示项 | 取法 |
| --- | --- |
| 行列数 | `width` × `height` |
| 范围 | `bounds`，四角坐标 + 中心点 |
| 坐标系 | 投影名、EPSG 码或"自定义无编码"、线性单位、轴序；WKT 折叠可复制 |
| 像元大小 | `res`，X/Y 不等时分别列出；同时给经纬度度量的近似值 |
| 波段数量与名称 | `count` + 每波段 `ColorInterp` + `description`（nc/hdf 用变量名） |
| 数据类型 | `dtype` 直接用 GDAL 的写法：Byte、Int16、Int32、Float32、Float64。不再在前面挂"16 位"，也不把 Float32 叫 Float——同一件事说两遍，还和代码里对不上；位数、取值范围、`GDT_*` 与 NumPy 类型放进气泡 |
| NoData | 每波段 `nodata`；波段上没写就看元数据 `_FillValue` / `missing_value`，另标 `mask_flag_enums`（是否有独立掩膜波段）。来源是元数据时，统计与直方图都按它自己挖掩膜，不信 GDAL 的文件统计——否则 -9999 会把均值拖成 -7287 |
| 数值单位 / 缩放系数 / 数值偏移 | 先取波段自身的 `GetUnitType` / `GetScale` / `GetOffset`，没有再读波段元数据里的 `units` / `scale_factor` / `add_offset`（HDF5、netCDF 通常只写在这里）。文件没写就不显示这三行，不拿 1 和 0 占位 |
| 统计值 | 优先文件内 `STATISTICS_*`；缺失时降采样算，并明确标注"近似值，按 降采样后 数据计算"。一律换算成物理量（原始值 × 缩放系数 + 偏移），另给一行"原始值范围"备查 |
| 无坐标原因 | `no_georef_reason`：没有投影/坐标系属性、没有像元到坐标的变换（GeoTransform）、文件里也没有经纬度变量，三条串成一句话（逗号断开、不用分号）只印在地图区底栏，前面一枚警告图标；信息栏不再单列一行，也不弹浮层。这是"文件本身没写"，不是"格式不支持" |
| 压缩算法 | `IMAGE_STRUCTURE/COMPRESSION` + `PREDICTOR`；LZW/Deflate/PackBits/JPEG 等映射成中文可读名 |
| 未压缩大小 | `width × height × count × itemsize`；同时显示实际大小和节省百分比 |
| 存储组织 | 条带/分块、块尺寸、有无金字塔及层数与重采样方式 |
| 像元总量 | `width × height × count`，用"亿"做单位，帮用户判断文件量级 |

### 矢量

| 显示项 | 取法 |
| --- | --- |
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
| --- | --- | --- |
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

> 各轮的逐条记录都已落地，细节见 `CHANGELOG.md` 与 git 历史；这里只留阶段划分和仍然有效的结论。

### 阶段划分

| 阶段 | 结果 |
| --- | --- |
| Phase 0 环境 | Python 3.12.15 + GDAL 3.10.3 + rasterio；驱动 210 个（含 netCDF/HDF4/HDF5）；遗留 GRIB、JP2OpenJPEG 未装 |
| Phase 1 引擎 | 格式识别、子数据集、CRS 判断、字段与范围、统计与直方图、错误文案全部就位 |
| Phase 2 服务与界面骨架 | 本机 HTTP 服务 + WebView2 界面，双栏布局 |
| Phase 3 地图与主题 | MapLibre 底图、图层切换、主题跟随系统 |
| Phase 4 原生壳与分发 | 无边框窗口、托盘、单实例、拖放、更新与签名 |
| Phase 5 第二期格式 | CAD（DWG 转 DXF）、GeoParquet、TopoJSON、OSM PBF、压缩包与文件夹 |

### 之后的迭代

0.9 到 0.17 之间陆续做了四十来轮实机反馈（界面定稿、拖放、量算、缓存与索引、栅格贴图、金字塔、文件对比），
每版改了什么都写在 `CHANGELOG.md` 里；具体到某个行为的取舍记在 `docs/` 下的专题文档。

#### 引擎里踩到的新坑（改代码时别退回去）

1. **子数据集键名是单数 `SUBDATASET_1_NAME`**，不是 `SUBDATASETS_1_NAME`。写错时表现为"里面没有栅格波段"，netCDF 打不开且没有任何提示。
2. **一律转成绝对路径再交给 GDAL**。插件驱动（netCDF/HDF）在相对路径下识别不稳定，同一文件出现过一次能开一次不能。`_clean_input()` 已做 `abspath` 加正斜杠。**唯一的例外是连接串**（`NETCDF:"x.nc":变量`）：它整体不是路径，`abspath()` 会把它拼成 `D:\...\NETCDF:"x.nc":变量`，然后报"找不到这个文件"。判据是 `^[A-Za-z][\w.]*:"`，命中就只规范化引号里的那一段。同理，这类输入失败后不能再拿 `open(path, "rb")` 去猜 JSON，否则 `Errno 22` 会把原本可读的错误盖掉。
3. TopoJSON 驱动**只读**，`ogr2ogr -f TopoJSON` 造不出样例，读取没问题。
4. GDAL 打开某些栅格会顺带生成 `.aux.xml`（统计缓存），测试目录里会冒出来，不是 bug。
5. `osgeo` 绑定必须先 `os.add_dll_directory(<env>/Library/bin)`，否则报的是 `No module named '_gdal'`，容易误判成没装。

#### 实测中新增的体检项

`crs.extent_warning()`：坐标数值和声明的坐标系明显矛盾时给提示。KML 和由无 `.prj` 的 shapefile 转出的 GeoJSON 都声明 EPSG:4326，实际坐标却是百万米级投影值，界面直接说"坐标值超出经纬度范围，文件声明的坐标系可能有误（常见于把投影坐标当成经纬度存盘）"。反向矛盾（声明米制投影、数值像经纬度）同样报。

Shapefile 伴生文件检查分成"必需"和"重要"两档：缺 `.shx/.dbf` 提示属性表可能读不出；缺 `.prj` 明确说坐标系信息看不到，不再误报"齐全"。

## 8. 风险与待验证

| 项 | 状态 |
| --- | --- |
| nc / hdf 支持 | **已支持**，插件包已装并通过读写回环验证 |
| rasterio 读不到压缩信息 | **已定位**：压缩在 dataset 级 `IMAGE_STRUCTURE` 域，改用 osgeo 读，见第 2 节 |
| PROJ/GDAL 数据目录被用户全局变量污染 | **已处理**：`bootstrap.configure()` 重写 PROJ_DATA/GDAL_DATA/GDAL_DRIVER_PATH 并加 DLL 目录 |
| 几十 GB 大 tif 无样例 | 已用 2.25 亿像元稀疏栅格做代理压测：259 ms 出全部信息，降采样估算生效；真要 20 GB 仍需用户提供 |
| DWG 读取 | **已解决**：GDAL 自带的 CAD 组件只到 AutoCAD 2000，`architectural.dwg` 是 AC1021（2007~2009）。已加 libredwg 兜底：直接读失败就 `dwg2dxf` 转临时 DXF 再读，实测 1,694 个要素 114 ms。免安装版要把 `dwg2dxf.exe` 和 `libredwg-*.dll` 一起带上 |
| 天地图 Origin | **实测通过**：浏览器上下文取瓦片 200（影像和注记都是），curl 直连会被判"权限类型错误"，属正常；OSM 在本机超时 |
| 中文控制台乱码 | 已处理：CLI 里 `sys.stdout.reconfigure(encoding="utf-8")`，中文字段名与示例值输出正确；Git Bash 里的乱码是终端代码页，不影响程序 |
| 中文文件名上传 | 已处理：请求头 latin-1 限制，前端 `encodeURIComponent` + 服务端 `unquote`，中文名称落盘和回显都正确 |
| 打包体积 | **实测**：gisviewer 环境 1204 MB，剔除编译期内容、numpy 换成不带 MKL 的之后 runtime **364 MB**，整个 `app` 377 MB，`tar -a` 压成 zip 后 **127 MiB**。解压到干净目录后直接双击即可跑：日志显示用的是包内 `runtime\python.exe`，引擎就绪约 0.7 s，底图、矢量、图例、比例尺全部正常 |
| MKL 占体积 | **已解决**：conda 的 numpy 链 Intel MKL，`Library/bin` 里那批 `mkl_*.dll` 445 MB。改成 PyPI 的 numpy wheel（自带 OpenBLAS）：`pip install --force-reinstall --no-deps numpy==2.5.4`，runtime 788 MB→364 MB，zip 274 MiB→127 MiB，`tools/check_runtime.py` 8 项健康检查全过 |
| 拖放拿真实路径 | **已解决**：手写 `IDropTarget` + `RegisterDragDrop` 挂在任何窗口上，外部拖放都不会调进来（对照实验钉死）。改成外部拖放时盖一块顶层半透明遮罩（`AllowDrop`，即窗口自带的接收方式）来接，拿到的就是资源管理器里的真实路径；本机实测资源管理器拖 wuningGEP.json 全链路走通 |
| 拖放验证 | **能自动化**：`tools/dropsrc.cs` 出一个只发起拖放的源窗口，`tools/dragdrop_test.ps1` 用真实鼠标按下—移动—松开走一遍 OLE 拖放，日志里看"拖入 N 项" |
| 超大 GeoJSON 首屏 | 132 MB / 10.9 万要素的 `wuningGEP.json` 出元数据要 3.5 s，瓶颈是 GDAL 得把整份读完；实测 OGR 并不比 `json.load` 快，要再快只能做流式/局部解析（读前几个要素 + 扫一遍拿范围），本轮没做 |
| 就地更新全链路 | **本地源已通**：`http.server 8911` 当发布源，徽标出现 → 弹层 → 下载校验 → updater 覆盖（40 个文件、0 失败）→ 拉起新版，日志齐全、暂存清空。拒绝路径也验过：篡改清单一个字节、删掉 `.sig`，都按预期不出徽标并给出原因。公网 OSS（CORS、CDN 缓存、真实带宽）等首版发上去再验 |
| HDF5 缺地理参照 | **不是格式问题**：`SM_2003001.h5` 实测 `projection=''`、恒等 GeoTransform、无 lat/lon 变量，文件里真的没有坐标。现在把缺的三样写进底栏那一句，统计按属性里的 `scale_factor`/`add_offset`/`_FillValue` 换算，遮罩值不再把均值拖成 -7287 |

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

版本号由用户决定，本文件不自行递增。软件名「图览」，当前 `0.14`。0.12 打包（`archive\图览-0.12-win64.zip`）之后又走了两轮：0.13 是窗口与体检那一批（五套配色、边缘与四角拖拽缩放、启动位置与还原抖动、体检浮层与诊断包、文件被外部修改的横幅、指北针与角度徽标），0.14 是 HDF5 的单位与缩放系数、无坐标原因、"放不到地图上"的说法、顶栏更新提示与就地更新。原生壳 `app\Tulan.exe` 加 364 MB 免安装 runtime 可跑，启动到界面出来约 0.7 s，无边框自绘标题栏。剩下三件：在没装过 Python/GDAL 的机器上验一次全流程、把 0.14 打到 `archive\`、首版发到 OSS 之后在真实网络下验一次更新。版本变更记录见 `CHANGELOG.md`。

---

## 11. 工程约定（2026-10-18 建立）

0.12 打包之后补的一轮工程加固，不改任何功能行为。

### 11.1 源码、样例、产物分三处（同一个根目录下）

| 位置 | 内容 | 进版本库 |
| --- | --- | --- |
| `D:\GISViewer\` | 引擎 `gisviewer\`、前端 `web\`、原生壳 `src\` `shell\` `lib\`、脚本 `tools\`、测试 `tests\`、`build.ps1`、`PLAN.md`、`CHANGELOG.md` | 是 |
| `D:\GISViewer\app\` | 可运行产物 384 MB：`Tulan.exe` + `runtime\` + `web\` + `gisviewer\` | 否 |
| `D:\GISViewer\data\samples\` | 用户提供的原始样例 9 项 351 MB | 否 |
| `D:\GISViewer\build\archive\` | 各版本发布 zip（0.9~0.12）500 MB | 否 |
| `D:\GISViewer\archive\mkl-backup\` | 旧 MKL 运行时备份 445 MB | 否 |

`app` 是运行目录（原 `dist`）：桌面/开始菜单快捷方式与开机自启都已指向 `D:\GISViewer\app\Tulan.exe`，改名时同步入口即可。它靠 `.gitignore` 排除——ripgrep 认 ignore 文件，检索和 `git status` 都不会再碰上那 4253 个文件。

样例、构建存档、MKL 备份也收进同一个根目录，只是各自放在 `data\`、`build\`、`archive\` 下并用 `.gitignore` 排除；盘符根目录只剩 `GISViewer` 一个入口，不再平铺四个目录。

换盘符或换机器时设两个环境变量即可，脚本里没有第二份硬编码路径：`TULAN_DATA` 指向样例的上级目录（默认 `data`），`TULAN_OUT` 指向存档的上级目录（默认 `build`）。

### 11.2 版本控制

- `git init -b main`，首次提交 `5da6ce9`「0.12 基线：源码定格，产物与样例数据移出源码树」，70 个文件 1.9 MB
- 提交身份是仓库级的 `吴博士 <wenwen99@users.noreply.github.com>`，不动全局配置，可随时改
- 被忽略的：`app/`、`build/`、`archive/`、`samples/`、`tests/fixtures/`、`__pycache__/`、编辑器目录
- `tests/fixtures/` 88 MB 是 `tests/make_fixtures.py` 生成得出来的，所以不入库；换机器先跑一次生成脚本

### 11.3 回归：一条命令

```powershell
pwsh -File tools\regress.ps1
```

四节，全过 18 s 上下：

| 节 | 做什么 | 失败意味着 |
| --- | --- | --- |
| syntax | 22 个 Python 文件过 `compile()`，3 个前端 js 过 `node --check` | 语法改坏了 |
| shell | `csc.exe` 把 `Shell.cs` + `Host.cs` 编到临时目录（不覆盖 `app`） | 原生壳改坏了，打包必失败 |
| sweep | `tests\sweep.py` 23 条用例：8 个真实样例、12 个固件、3 条应当友好失败 | 引擎读错、崩溃，或错误提示不友好 |
| api | `tests\api_smoke.py` 14 项：起真服务、打 `/api/*`、看返回约定 | 接口层坏了 |

- `-Only sweep` 只跑一节，`-Offline` 只做静态检查，`-SkipShell` 跳过 C# 编译
- sweep 与 api 都在临时数据目录里跑，不碰用户设置与缓存，跑完自动删
- 固件缺失时 sweep 直接提示先跑 `tests\make_fixtures.py`；样例缺失时提示设 `TULAN_DATA`
- **不覆盖**：真窗口行为（托盘、全局热键、拖放、单实例、原生对话框）仍要人工验，`tools\*.mjs` 那套 CDP 脚本是给人用的，不进自动回归

### 11.4 编码：`.ps1` 和 `.cs` 一律 UTF-8 带 BOM

PowerShell 5.1 与 `csc.exe` 对无 BOM 的文件按系统 ANSI 代码页解释，中文全变乱码。本轮给 18 个脚本和 2 个 C# 源文件补齐了 BOM（`build.ps1` 原来就有）。Python 3 默认 UTF-8，不需要。新增脚本时务必带 BOM，否则只能在 PowerShell 7 下正常。

### 11.5 构建

```powershell
pwsh -File build.ps1              # 只出 exe 与资源
pwsh -File build.ps1 -Pack -Zip   # 一次出完整发布包
```

`-Pack` 现在真能跑：调 `tools\pack_runtime.ps1` 整份复制 conda 环境到 `app\runtime`，再用包内解释器跑 `tools\check_runtime.py` 体检，不过就中止。此前它指向不存在的 `pack_env.ps1`（conda-pack 那条路早已废弃），属于死代码，本轮删掉。
