"""跨模块共用的错误类型：引擎各层都要用它把人话错误带到界面上。

单独放一个文件是因为 inspect 会导入 vector、raster，
这些模块反过来 import inspect 就成环了。
"""


class InspectError(Exception):
    def __init__(self, title, detail=None, hint=None):
        super().__init__(title)
        self.title = title
        self.detail = detail
        self.hint = hint
