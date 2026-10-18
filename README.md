# 图览 (Tulan)

一款 Windows 桌面端的**本地数据体检工具**：把 GIS 数据拖进来，几秒钟看清坐标系、字段结构、要素数量与几何质量。定位是"打开看看、快速判断"，不是轻量 GIS，也不做编辑。

![版本](https://img.shields.io/badge/版本-0.12-blue) ![平台](https://img.shields.io/badge/平台-Windows%2010%2B-blue)

## 它解决什么问题

拿到一份陌生的 GIS 数据（Shapefile、GeoJSON、DWG……），第一件事往往是：坐标系是什么？有哪些字段？要素有多少？几何有没有问题？为此打开 QGIS/ArcGIS 太重，写脚本太慢。图览把这个"看一眼"做到秒级：

- **秒开元数据**：大 GeoJSON 走头部解析，132 MB / 10.9 万要素约 1 秒出第一屏；
- **信息栏体检报告**：坐标系与单位、字段清单（类型/宽度/样例）、要素数量、几何类型分布、范围、无数据像元、压缩方式；
- **直方图与分级**：数值型栅格自动统计直方图、分位拉伸、按色带设色；
- **属性表**：滚动分页加载大图层，列选中复制（整列），查找定位，双击回到要素并高亮；
- **辅助定位**：路径框直接粘贴坐标（多种写法）定位到地图；
- **选中即开**：在资源管理器里选中文件按 Ctrl+空格 直接打开，不用先开软件再找文件。

## 支持的格式

| 类别 | 格式 |
|---|---|
| 矢量 | Shapefile、GeoJSON、KML、GDB（文件夹）、DXF、OSM PBF、TopoJSON 等 OGR 可读格式 |
| 栅格 | GeoTIFF（含 COG）、IMG、JPEG、PNG 等 GDAL 可读格式 |
| 其他 | 瓦片目录（TMS/XYZ）、上述格式的 zip 压缩包 |

明确的边界：**不做**编辑、符号化、重投影、属性表编辑、多图层叠加、网络数据源。

## 下载与安装

从 [Releases](https://github.com/MorganWsy/GISViewer/releases) 下载 zip，解压即用：

- `Tulan.exe` 是主程序，双击即可运行；
- 运行时会自动在 `%APPDATA%\GISViewer` 存放配置与读取缓存，卸载时删掉该目录即可；
- 需要 Windows 10 及以上 + [WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 一般已自带）。

## 使用说明

| 操作 | 方式 |
|---|---|
| 打开数据 | 拖进窗口 / 顶栏"打开"菜单 / 粘贴完整路径回车 / 粘贴坐标回车定位 |
| 选中即开 | 资源管理器里选中文件，按 `Ctrl+空格`（可在设置里改键） |
| 唤出/收起 | `Ctrl+Alt+G`（可改键） |
| 页内操作 | `Esc` 收起提示与弹窗、`F` 回到图层全图、`Ctrl+F` 属性表查找（均可改键） |

设置项支持：底图与天地图密钥（自备）、色带与分级、字体与字号、深浅色主题、面板不透明度、快捷键、文件框起始目录、缓存清理等，全部即改即生效。

## 隐私与密钥

- 数据**只在本机读取**，不联网上传；联网的只有可选的底图瓦片与更新检查；
- 天地图底图需要你自己的"浏览器端"密钥，在设置页填一次即可，只保存在本机 `%APPDATA%\GISViewer\config.json`，**不会随仓库或安装包分发**；
- 软件以本机方式运行，与天地图授权域名无关。

## 从源码构建

```powershell
git clone https://github.com/MorganWsy/GISViewer.git
cd GISViewer
pwsh -File build.ps1 -Pack -Zip   # 出免安装发布包；-Zip 额外打压缩包
```

依赖：.NET Framework 4.x（csc 编译原生壳）、Python 3.12+ 及 GDAL 绑定、Node.js 仅用于前端语法检查。`tools\regress.ps1` 是回归脚本（语法 / 壳编译 / 全格式 sweep / 接口冒烟）。

## 目录结构

```
gisviewer/   引擎（Python + GDAL）：元数据、直方图、取数、量算
web/         界面（原生 JS + MapLibre GL + Chart.js）
src/         原生壳（C# + WebView2）：窗口、托盘、快捷键、拖放
tools/       打包与回归脚本
tests/       全格式回归 sweep 与接口冒烟
```

## 协议

[MIT](LICENSE)
