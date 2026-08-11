# -*- coding: utf-8 -*-
"""S1 HTTP 联调：启临时中转，验无票 401、登录、超额 402、路由热切换（不调真实模型）。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _req(base: str, method: str, path: str, body=None, token: str = ""):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-Relay-Token"] = token
    r = urllib.request.Request(
        base + path, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            j = json.loads(raw or "{}")
        except Exception:
            j = {"error": raw}
        return e.code, j


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-http-")
    os.environ["CONTROL_DB"] = str(Path(td) / "control.sqlite")
    os.environ["CONTROL_SECRET"] = "http-smoke-secret"
    os.environ["CONTROL_ENABLED"] = "1"
    os.environ["CONTROL_REQUIRE_USER"] = "0"
    os.environ["RELAY_TOKEN"] = "legacy-http-token"
    # 避免冒烟真打模型：用 monkeypatch 替换 suggest/proofread 入口
    import suggest
    import proofread as pr

    def fake_generate_options(**kwargs):
        return {"ok": True, "options": ["x"], "model": "should-strip"}

    def fake_chat(**kwargs):
        return {"ok": True, "reply": "hi", "provider": "x", "model": "should-strip"}

    def fake_proofread(**kwargs):
        return {"ok": True, "issues": [], "model": "should-strip"}

    suggest.generate_options = fake_generate_options
    suggest.chat = fake_chat
    pr.proofread = fake_proofread

    from control_db import init_db, connect
    from relay_server import Handler

    init_db()
    # free 套餐日额度压到 1，方便测 402
    with connect() as conn:
        conn.execute(
            "UPDATE plans SET daily_requests=1, monthly_requests=10 WHERE code='free'"
        )
        conn.commit()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    time.sleep(0.2)

    st, health = _req(base, "GET", "/api/health")
    assert st == 200 and health.get("ok"), health

    # S4：运维页公开，无需令牌
    req_admin = urllib.request.Request(base + "/admin", method="GET")
    with urllib.request.urlopen(req_admin, timeout=10) as resp:
        html = resp.read().decode("utf-8", errors="replace")
        assert resp.status == 200 and "运维后台" in html, html[:200]

    st, bad = _req(base, "POST", "/api/chat", {"message": "hi"})
    assert st == 401, (st, bad)

    email = f"u{int(time.time())}@ex.com"
    st, reg = _req(
        base, "POST", "/api/auth/register",
        {"email": email, "password": "password123"},
    )
    assert st == 200 and reg.get("access_token"), (st, reg)
    access = reg["access_token"]

    st, chat = _req(
        base, "POST", "/api/chat",
        {"message": "hello", "capability": "fast"},
        token=access,
    )
    assert st == 200 and chat.get("reply") == "hi", (st, chat)
    assert "model" not in chat or chat.get("model") is None

    # 第二次应 402（日额度=1）
    st, over = _req(
        base, "POST", "/api/chat",
        {"message": "again", "capability": "fast"},
        token=access,
    )
    assert st == 402, (st, over)

    # legacy 运维票仍可调（不走用户配额）
    st, leg = _req(
        base, "POST", "/api/suggest",
        {"md": "a", "requirement": "b", "capability": "fast"},
        token="legacy-http-token",
    )
    assert st == 200 and leg.get("ok"), (st, leg)

    st, routes = _req(
        base, "POST", "/api/admin/routes",
        {
            "capability": "fast",
            "task": "chat",
            "provider": "openai",
            "model": "gpt-smoke",
            "exclusive": True,
        },
        token="legacy-http-token",
    )
    assert st == 200 and routes.get("ok"), (st, routes)

    from control_gate import resolve_route
    r = resolve_route("fast", "chat")
    assert r["provider"] == "openai" and r["model"] == "gpt-smoke", r

    # CONTROL_REQUIRE_USER=1：legacy 不可再调 AI
    os.environ["CONTROL_REQUIRE_USER"] = "1"
    st, blocked = _req(
        base, "POST", "/api/chat",
        {"message": "nope", "capability": "fast"},
        token="legacy-http-token",
    )
    assert st == 401, (st, blocked)
    os.environ["CONTROL_REQUIRE_USER"] = "0"

    # 踢人：禁用后 access 立刻失效
    st, dis = _req(
        base, "POST", "/api/admin/user-status",
        {"email": email, "status": "disabled"},
        token="legacy-http-token",
    )
    assert st == 200 and dis.get("ok"), (st, dis)
    st, dead = _req(base, "GET", "/api/quota", token=access)
    assert st == 401, (st, dead)

    # 重新启用并 grant pro
    st, en = _req(
        base, "POST", "/api/admin/user-status",
        {"email": email, "status": "active"},
        token="legacy-http-token",
    )
    assert st == 200, (st, en)
    st, grant = _req(
        base, "POST", "/api/admin/grant",
        {"email": email, "plan": "pro", "days": 7},
        token="legacy-http-token",
    )
    assert st == 200 and grant.get("ok"), (st, grant)

    os.environ["CONTROL_MAINTENANCE"] = "维护中"
    st, m = _req(
        base, "POST", "/api/suggest",
        {"md": "a", "requirement": "b"},
        token="legacy-http-token",
    )
    assert st == 503, (st, m)
    os.environ["CONTROL_MAINTENANCE"] = ""

    httpd.shutdown()
    print("HTTP ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
