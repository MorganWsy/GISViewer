"""文本清洗：一个函数，单独一个文件，为的是不让它背上 GDAL。

元数据里可能带着非 UTF-8 的原始字节（MapInfo 的 .tab/.mif、WKT CSV），Python 用
代理字符记着那串字节，直接 json.dumps 后 encode 会抛 UnicodeEncodeError，一次就把
整条响应带崩。服务端每条响应都要洗一遍，所以这个函数不能有依赖——早先它住在
report.py 里，而那个模块顶部 import 了 inspect，inspect 又拉起 bootstrap 与 osgeo：
GDAL 一旦不可用，连 /api/config 都会因为这一句 import 直接断连。
"""


def clean_text(text):
    """把代理字符还原成原来的字节，再按 UTF-8 容错解码。

    坏字节换成替换符，其余照常——与其整份失败，不如让用户先看到能看的部分。
    """
    return str(text).encode("utf-8", "surrogateescape").decode("utf-8", "replace")
