"""本地接口鉴权：有 GISVIEWER_TOKEN 时，/api/* 必须带令牌且 Host/Origin 合规。"""
import http.client
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TOKEN = "test-token-" + secrets.token_hex(16)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(port, path, token=None, origin=None, host=None, data=None, method=None):
    headers = {}
    if token is not None:
        headers["X-GISViewer-Token"] = token
    if origin is not None:
        headers["Origin"] = origin
    if host is not None:
        headers["Host"] = host
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method or ("POST" if data is not None else "GET"), path, body=data,
                     headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def main():
    port = free_port()
    data = tempfile.mkdtemp(prefix="tulan-auth-")
    env = os.environ.copy()
    env["GISVIEWER_DATA_DIR"] = data
    env["GISVIEWER_TOKEN"] = TOKEN
    proc = subprocess.Popen([sys.executable, "-m", "gisviewer.server", "--port", str(port),
                             "--no-open"], env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    checks = []
    try:
        for _ in range(100):
            try:
                code, _ = call(port, "/api/formats?t=" + TOKEN)
                if code == 200:
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("服务没起来")

        code, _ = call(port, "/api/config")
        checks.append(("无令牌被拒", code == 403))
        code, _ = call(port, "/api/config?t=" + TOKEN)
        checks.append(("查询串令牌放行", code == 200))
        code, _ = call(port, "/api/config", token=TOKEN)
        checks.append(("请求头令牌放行", code == 200))
        code, _ = call(port, "/api/config", token=TOKEN[:-1] + "x")
        checks.append(("错误令牌被拒", code == 403))
        code, _ = call(port, "/api/config", token=TOKEN, origin="http://evil.example")
        checks.append(("跨源 Origin 被拒", code == 403))
        code, _ = call(port, "/api/config", token=TOKEN, host="evil.example")
        checks.append(("伪造 Host 被拒", code == 403))
        code, _ = call(port, "/")
        checks.append(("首页静态可开", code == 200))
        body = json.dumps({"theme": "light"}).encode()
        code, _ = call(port, "/api/config", data=body, method="POST")
        checks.append(("无令牌写配置被拒", code == 403))
        code, _ = call(port, "/api/config", data=body, method="POST", token=TOKEN)
        checks.append(("带令牌写配置放行", code == 200))

        from gisviewer.server import _readable
        checks.append(("普通文件可读", _readable(__file__)))
        checks.append(("vsizip 虚拟路径放行", _readable("/vsizip/C:/x.zip/a.shp")))
        checks.append(("vsitar 虚拟路径放行", _readable("/vsitar/C:/x.tar/a.shp")))
        checks.append(("NETCDF 连接串被拒", not _readable('NETCDF:"C:/x.nc":v')))
        checks.append(("vsicurl 被拒", not _readable("/vsicurl/http://example.com/a.tif")))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    bad = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(("PASS  " if ok else "FAIL  ") + name)
    print(f"{len(checks) - len(bad)}/{len(checks)} passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
