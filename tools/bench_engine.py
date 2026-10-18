"""量引擎从进程起来到能应答 /api/formats 的耗时，并让引擎自己报分阶段时间。"""
import os
import socket
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    exe = sys.executable
    cwd = ROOT
    if "--dist" in sys.argv:
        cwd = os.path.join(ROOT, "dist")
        exe = os.path.join(cwd, "runtime", "python.exe")
    env = dict(os.environ)
    env["PYTHONPATH"] = cwd
    env["GISVIEWER_TIMING"] = "1"
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()

    t0 = time.perf_counter()
    p = subprocess.Popen([exe, "-m", "gisviewer.server",
                          "--port", str(port), "--no-open"],
                         cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    ready = None
    while time.perf_counter() - t0 < 30:
        try:
            c = socket.create_connection(("127.0.0.1", port), 0.2)
            c.close()
            ready = time.perf_counter() - t0
            break
        except OSError:
            time.sleep(0.02)
    ok = False
    if ready:
        import urllib.request
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/api/formats" % port, timeout=5) as r:
                ok = r.status == 200
        except Exception as exc:
            print("接口失败", exc)
    p.terminate()
    try:
        out = p.communicate(timeout=8)[0].decode("utf-8", "replace")
    except Exception:
        p.kill()
        out = ""
    print("端口可连 %.0f ms   接口就绪 %s" % (ready * 1000 if ready else -1, ok))
    for line in out.splitlines():
        if line.strip():
            print("  引擎自报:", line.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
