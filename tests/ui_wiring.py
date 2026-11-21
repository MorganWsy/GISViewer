"""界面接线回归：init() 拆成小事之后，各块按钮还接得上吗。

`web/app.js` 原来把所有接线塞在一个 588 行的 init() 里，pi-lens 数出 177 个分支。
拆成二十几个具名函数之后，光看代码看不出“某颗按钮忘了接”，所以这里用真浏览器
逐块点一遍，看状态有没有按照界面本来的约定变。

覆盖：设置面板开关与分栏、主题循环、体检与互转浮层、图例与文件卡收起、
图层切换、属性表开关。

依赖 Edge + playwright-cli；机器没有时明确跳过（不算失败）。
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "tests" / "fixtures" / "mixed.geojson"
SESSION = "tulan-ui-wiring"

STEPS = (
    "() => (async () => {"
    ' const q = (s) => document.querySelector(s);'
    ' const vis = (s) => { const n = q(s); if (!n || n.hidden) return false;'
    " const cs = getComputedStyle(n);"
    " return cs.display !== none0 && cs.visibility !== hidden0 && cs.opacity !== zero0; };"
    ' const wait = (ms) => new Promise((r) => setTimeout(r, ms));'
    " const out = {};"
    " out.settingsClosed = !vis('#settings');"
    " q('#settingsBtn').click(); await wait(150);"
    " out.settingsOpen = vis('#settings');"
    ' out.paneBase = !!q("#setNav button.on[data-sec=base]");'
    ' q("#setNav button[data-sec=sys]").click(); await wait(100);'
    ' out.paneSys = !!q("#setNav button.on[data-sec=sys]");'
    " out.paneSysBody = vis('#setBody .set-pane[data-sec=sys]');"
    " q('#cfgClose').click(); await wait(150);"
    " out.settingsClosedAgain = !vis('#settings');"
    " const mode0 = q('#themeBtn').dataset.mode;"
    " q('#themeBtn').click(); await wait(150);"
    " out.themeChanged = q('#themeBtn').dataset.mode !== mode0;"
    " q('#checkBtn').click(); await wait(150);"
    " out.checkOpen = vis('#checkPop');"
    " document.body.click(); await wait(150);"
    " out.checkClosed = !vis('#checkPop');"
    " q('#convBtn').click(); await wait(200);"
    " out.convOpen = vis('#convPop');"
    " q('#convBtn').click(); await wait(150);"
    " out.convClosed = !vis('#convPop');"
    " q('#legendFold').click(); await wait(200);"
    " out.legendFolded = vis('#legendTab');"
    " q('#legendTab').click(); await wait(200);"
    " out.legendBack = vis('#legendFold');"
    " out.layerChip = !!q('#chipLayerBtn');"
    " q('#chipFold').click(); await wait(200);"
    " out.chipFolded = vis('#chipTab');"
    " q('#chipTab').click(); await wait(250);"
    # attr panel opens by itself once vectors are drawn: assert the toggle only
    " const a0 = !q('#attrPanel').hidden;"
    " q('#attrBtn').click(); await wait(300);"
    " const a1 = !q('#attrPanel').hidden;"
    " q('#attrBtn').click(); await wait(300);"
    " const a2 = !q('#attrPanel').hidden;"
    " out.attrToggles = (a1 === !a0) && (a2 === a0);"
    " return JSON.stringify(out);"
    "})()"
).replace("none0", "'none'").replace("hidden0", "'hidden'").replace("zero0", "'0'")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def cli(*args, timeout=90):
    cmd = ["npx", "--yes", "--package", "@playwright/cli", "playwright-cli",
           "--session", SESSION]
    return subprocess.run(cmd + list(args), capture_output=True, text=True,
                          encoding="utf-8", errors="replace",
                          timeout=timeout, cwd=str(ROOT), check=False)


def main():
    if not SAMPLE.exists():
        print("SKIP: 没有 tests/fixtures/mixed.geojson")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix="tulan-ui-wiring-"))
    env = dict(os.environ)
    env["GISVIEWER_DATA_DIR"] = str(tmp / "data")
    env.pop("GISVIEWER_TOKEN", None)
    port = free_port()
    server = None
    try:
        server = subprocess.Popen(
            [sys.executable, "-m", "gisviewer.server", "--port", str(port), "--no-open"],
            cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        base = f"http://127.0.0.1:{port}"
        for _ in range(120):
            try:
                urllib.request.urlopen(base + "/", timeout=0.5)  # pi-lens-ignore: S310 -- 只访问本机测试服务
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.1)
        else:
            print("server did not start")
            return 2

        opened = cli("open", "--browser", "msedge",
                     f"{base}/?path={urllib.parse.quote(str(SAMPLE))}")
        if opened.returncode != 0:
            print("SKIP: playwright-cli/Edge unavailable")
            print((opened.stderr or opened.stdout)[-300:])
            return 0

        # 等地图画出来再接下去点：按钮接线要在地图就绪之后才有意义
        for _ in range(60):
            got = cli("eval", "() => !!document.querySelector('#map canvas')")
            if "true" in (got.stdout or "").lower():
                break
            time.sleep(0.25)
        time.sleep(1.2)

        got = cli("eval", STEPS)
        raw = (got.stdout or "").strip()
        line = next((x for x in raw.splitlines() if x.startswith('"')), "")
        if not line:
            print("FAIL: 读不到界面状态:", raw[-400:])
            return 3
        state = json.loads(json.loads(line))

        want = {
            "settingsClosed": True,
            "settingsOpen": True,
            "paneBase": True,
            "paneSys": True,
            "paneSysBody": True,
            "settingsClosedAgain": True,
            "themeChanged": True,
            "checkOpen": True,
            "checkClosed": True,
            "convOpen": True,
            "convClosed": True,
            "legendFolded": True,
            "legendBack": True,
            "layerChip": True,
            "chipFolded": True,
            "attrToggles": True,
        }
        bad = [f"{k}: 期望 {v}，实际 {state.get(k)}" for k, v in want.items()
               if state.get(k) != v]
        print("状态:", json.dumps(state, ensure_ascii=False))
        if bad:
            for item in bad:
                print("FAIL:", item)
            return 3
        print(f"ui wiring: ok（{len(want)} 项接线都接上了）")
        return 0
    finally:
        cli("close", timeout=30)
        if server is not None:
            server.terminate()


if __name__ == "__main__":
    sys.exit(main())
