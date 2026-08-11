# -*- coding: utf-8 -*-
"""本地拉起中转约 3 秒：health + register + chat（假模型）。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-boot-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "boot"
    os.environ["CONTROL_ENABLED"] = "1"
    os.environ["CONTROL_REQUIRE_USER"] = "0"
    os.environ["RELAY_TOKEN"] = "boot-legacy"
    os.environ["RELAY_PORT"] = "0"

    import suggest
    import proofread as pr

    suggest.chat = lambda **k: {"ok": True, "reply": "boot-ok"}
    suggest.generate_options = lambda **k: {"ok": True, "options": []}
    pr.proofread = lambda **k: {"ok": True, "issues": []}

    from control_db import init_db
    from relay_server import Handler

    init_db()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.15)
    base = f"http://127.0.0.1:{port}"

    def call(method, path, body=None, token=""):
        data = None if body is None else json.dumps(body).encode()
        h = {"Accept": "application/json"}
        if data is not None:
            h["Content-Type"] = "application/json"
        if token:
            h["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, data=data, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode() or "{}")

    st, h = call("GET", "/api/health")
    assert st == 200 and h.get("control") is True, h
    email = f"boot{int(time.time())}@t.com"
    st, reg = call("POST", "/api/auth/register", {"email": email, "password": "password123"})
    assert st == 200, reg
    st, chat = call(
        "POST", "/api/chat",
        {"message": "ping", "capability": "fast"},
        token=reg["access_token"],
    )
    assert st == 200 and chat.get("reply") == "boot-ok", chat
    httpd.shutdown()
    print("BOOT OK port=", port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
