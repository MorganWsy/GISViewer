"""前端取数失败回归：/api/vector 500 时不能把“正在更新要素”永远留在屏上。

依赖 Edge + playwright-cli；机器没有时明确跳过（不算失败），有则必须通过。
"""

from __future__ import annotations

import json
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
FIXTURE = ROOT / "tests" / "fixtures" / "mixed.geojson"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def cli(*args, timeout=90):
    cmd = ["npx", "--yes", "--package", "@playwright/cli", "playwright-cli",
           "--session", "tulan-ui-failure"]
    return subprocess.run(cmd + list(args), capture_output=True, text=True,
                          encoding="utf-8", errors="replace",
                          timeout=timeout, cwd=str(ROOT), check=False)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="tulan-ui-"))
    old_data = os.environ.get("GISVIEWER_DATA_DIR")
    env = dict(os.environ)
    env["GISVIEWER_DATA_DIR"] = str(tmp)
    env.pop("GISVIEWER_TOKEN", None)      # 本测试只测前端，鉴权另有用例
    port = free_port()
    server = None
    try:
        server = subprocess.Popen(
            [sys.executable, "-m", "gisviewer.server", "--port", str(port), "--no-open",
             str(FIXTURE)],
            cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/", timeout=0.5)  # pi-lens-ignore: S310 -- 只访问本机测试服务
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.1)
        else:
            print("server did not start")
            return 2

        opened = cli("open", "--browser", "msedge",
                     f"{base}/?path={urllib.parse.quote(str(FIXTURE))}")
        if opened.returncode != 0:
            print("SKIP: playwright-cli/Edge unavailable")
            print((opened.stderr or opened.stdout)[-300:])
            return 0

        # 先等首屏画完，再加 500 路由重载
        for _ in range(40):
            got = cli("eval", "() => !!document.querySelector('#map canvas')")
            if "true" in got.stdout.lower():
                break
            time.sleep(0.25)
        cli("route", "**/api/vector*", "--status", "500",
            "--body", json.dumps({"ok": False, "error": {"title": "mock 500"}},
                                 ensure_ascii=False),
            "--content-type", "application/json")
        cli("reload")
        time.sleep(1.5)
        got = cli("eval", "() => { const b=document.querySelector('#vecBusy'); "
                          "const l=document.querySelector('#loadTip'); "
                          "return {busy: b ? (b.hidden || getComputedStyle(b).display==='none') : true, "
                          "tip: l ? (l.hidden || getComputedStyle(l).display==='none') : true}; }")
        text = (got.stdout or "").strip()
        print("ui state:", text[-400:])
        if "busy" not in text or "false" in text.split("busy", 1)[1][:40].lower():
            print("FAIL: #vecBusy still visible")
            return 3
        print("ui failure: ok (vector 500 recovered)")
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
