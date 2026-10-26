"""把表写成 xlsx：发布包里的运行时不带 openpyxl，这里按 Office Open XML 手写一个最小的包。

xlsx 本质上是一堆 XML 装进 zip，导出一张体检表用得到的只有三样：工作表、共享字符串、
一张样式表。用标准库 zipfile 拼出这三样，比为了一个导出功能往 384 MB 的运行时里再塞
一个第三方库划算得多，也不用担心那个库和 Python 版本对不上。

对外只有 write()：给一串表，落成一个文件。表格长什么样由调用方决定，这里管格式。
"""

import io
import re
import zipfile
from xml.sax.saxutils import escape

# 单元格样式：序号与 _STYLES 里 cellXfs 的顺序一一对应。
# 整张表一律左对齐——几百行里竖着一列居中数字，眼睛得来回找基准线
TITLE = 0   # 大标题（目前没用到，留着给以后加表头）
HEAD = 1    # 表头：强调色底、白字
TEXT = 2    # 正文：左对齐、顶端对齐、自动换行
BOLD = 3    # 加粗正文
NUM = 4     # 数字与短标识（序号、结论）：同样是左对齐
DIM = 5     # 次要信息（路径这类）：灰字

# Excel 不认控制字符，留着会让整个文件打不开
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

_FONTS = ('<fonts count="5">'
          '<font><sz val="10.5"/><color rgb="FF1F2933"/><name val="微软雅黑"/><family val="2"/></font>'
          '<font><b/><sz val="10.5"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/><family val="2"/></font>'
          '<font><b/><sz val="10.5"/><color rgb="FF1F2933"/><name val="微软雅黑"/><family val="2"/></font>'
          '<font><sz val="10.5"/><color rgb="FF6B7684"/><name val="微软雅黑"/><family val="2"/></font>'
          '<font><b/><sz val="12"/><color rgb="FF1A6FB0"/><name val="微软雅黑"/><family val="2"/></font>'
          '</fonts>')

_FILLS = ('<fills count="3">'
          '<fill><patternFill patternType="none"/></fill>'
          '<fill><patternFill patternType="gray125"/></fill>'
          '<fill><patternFill patternType="solid"><fgColor rgb="FF1A6FB0"/>'
          '<bgColor indexed="64"/></patternFill></fill>'
          '</fills>')

_BORDERS = ('<borders count="2">'
            '<border><left/><right/><top/><bottom/><diagonal/></border>'
            '<border><left/><right/><top/>'
            '<bottom style="thin"><color rgb="FFE3E8EE"/></bottom><diagonal/></border>'
            '</borders>')

_STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
           + _FONTS + _FILLS + _BORDERS +
           '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
           '<cellXfs count="6">'
           # 0 标题
           '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1">'
           '<alignment vertical="center"/></xf>'
           # 1 表头：只居中竖直方向，横向统一靠左（整张表都左对齐，眼睛只用一条基准线）
           '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1">'
           '<alignment horizontal="left" vertical="center"/></xf>'
           # 2 正文：wrapText 让长路径和长说明在列宽内折行，而不是被截掉
           '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1">'
           '<alignment horizontal="left" vertical="top" wrapText="1"/></xf>'
           # 3 加粗
           '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1">'
           '<alignment horizontal="left" vertical="top" wrapText="1"/></xf>'
           # 4 数字与短字段：必须显式写 left，光靠默认对齐数字会贴到右边
           '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1">'
           '<alignment horizontal="left" vertical="top" wrapText="1"/></xf>'
           # 5 灰字
           '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1">'
           '<alignment horizontal="left" vertical="top" wrapText="1"/></xf>'
           '</cellXfs>'
           '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>'
           '</styleSheet>')

_RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
         '<Relationship Id="rId1" '
         'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
         'Target="xl/workbook.xml"/></Relationships>')


def _text(value):
    """清掉代理字符与控制字符：两样都会让 Excel 直接拒绝打开文件。"""
    s = str(value)
    if any("\ud800" <= ch <= "\udfff" for ch in s):
        # 有些驱动把元数据按本地代码页原样吐回来，Python 用代理字符记着那串字节
        s = s.encode("utf-8", "replace").decode("utf-8", "replace")
    return _CTRL.sub("", s)


def _num(value):
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    return ("%.10g" % value)


def _col(index):
    """0 -> A，26 -> AA。"""
    out = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


class _Strings:
    """共享字符串：同一个词只存一份。体检表里"图层结构""可读性"这些会重复几千次，
    不合并的话文件会大出好几倍。"""

    def __init__(self):
        self.items = []
        self.refs = 0
        self._at = {}

    def index(self, value):
        key = _text(value)
        self.refs += 1
        got = self._at.get(key)
        if got is None:
            got = len(self.items)
            self._at[key] = got
            self.items.append(key)
        return got

    def xml(self):
        body = "".join('<si><t xml:space="preserve">%s</t></si>' % escape(s) for s in self.items)
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'count="%d" uniqueCount="%d">%s</sst>' % (self.refs, len(self.items), body))


def _sheet_xml(sheet, strings):
    """一张工作表。

    sheet 认得这几项：name / cols（列宽）/ rows（行）/ head（表头占几行）/ filter（要不要筛选）。
    rows 里每一格是 (值, 样式) 或直接给值（按正文处理）。
    """
    rows = sheet.get("rows") or []
    head = int(sheet.get("head") or 0)
    width = max([len(r) for r in rows] + [1])
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           '<dimension ref="A1:%s%d"/>' % (_col(width - 1), max(len(rows), 1))]

    if head:
        # 表头冻住：几百行往下滚时还知道哪一列是什么
        out.append('<sheetViews><sheetView workbookViewId="0" tabSelected="1">'
                   '<pane ySplit="%d" topLeftCell="A%d" activePane="bottomLeft" state="frozen"/>'
                   '<selection pane="bottomLeft" activeCell="A%d" sqref="A%d"/>'
                   '</sheetView></sheetViews>' % (head, head + 1, head + 1, head + 1))
    else:
        out.append('<sheetViews><sheetView workbookViewId="0" tabSelected="1"/></sheetViews>')

    out.append('<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>')

    cols = sheet.get("cols") or []
    if cols:
        out.append("<cols>")
        for i, w in enumerate(cols):
            out.append('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (i + 1, i + 1, w))
        out.append("</cols>")

    out.append("<sheetData>")
    for ri, row in enumerate(rows, start=1):
        cells = []
        for ci, cell in enumerate(row):
            value, style = (cell, TEXT) if not isinstance(cell, tuple) else cell
            if value is None or value == "":
                continue
            ref = "%s%d" % (_col(ci), ri)
            if isinstance(value, bool):
                value = "是" if value else "否"
            if isinstance(value, (int, float)):
                cells.append('<c r="%s" s="%d"><v>%s</v></c>' % (ref, style, _num(value)))
            else:
                cells.append('<c r="%s" s="%d" t="s"><v>%d</v></c>'
                             % (ref, style, strings.index(value)))
        if not cells:
            continue
        if ri <= head:
            out.append('<row r="%d" ht="24" customHeight="1">%s</row>' % (ri, "".join(cells)))
        else:
            out.append('<row r="%d">%s</row>' % (ri, "".join(cells)))
    out.append("</sheetData>")

    if sheet.get("filter") and head:
        # 筛选条压在表头上：按结论、按检查项目分开看，比整表顺着读有用
        out.append('<autoFilter ref="A%d:%s%d"/>' % (head, _col(width - 1), head))
    out.append('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>')
    out.append("</worksheet>")
    return "".join(out)


def _workbook_xml(names):
    body = "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (escape(n), i + 1, i + 1)
                   for i, n in enumerate(names))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets>%s</sheets></workbook>' % body)


def _workbook_rels(count):
    body = "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/'
                   'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>'
                   % (i + 1, i + 1) for i in range(count))
    body += ('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/'
             '2006/relationships/styles" Target="styles.xml"/>' % (count + 1))
    body += ('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/'
             '2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' % (count + 2))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + body + '</Relationships>')


def _content_types(count):
    sheets = "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/'
                     'vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1)
                     for i in range(count))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + sheets +
            '<Override PartName="/xl/styles.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            '</Types>')


def build(sheets):
    """一串表 -> 一份 xlsx 的字节。不落盘，方便直接塞进诊断包。"""
    if not sheets:
        raise ValueError("至少要有一张表")
    names = [s.get("name") or ("表%d" % (i + 1)) for i, s in enumerate(sheets)]
    strings = _Strings()
    body = [(names[i], _sheet_xml(s, strings)) for i, s in enumerate(sheets)]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _content_types(len(sheets)))
        z.writestr("_rels/.rels", _RELS)
        z.writestr("xl/workbook.xml", _workbook_xml(names))
        z.writestr("xl/_rels/workbook.xml.rels", _workbook_rels(len(sheets)))
        z.writestr("xl/styles.xml", _STYLES)
        for i, (_, xml) in enumerate(body):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), xml)
        z.writestr("xl/sharedStrings.xml", strings.xml())
    return buf.getvalue()


def write(sheets, path):
    data = build(sheets)
    with open(path, "wb") as fh:
        fh.write(data)
    return path, len(data)
