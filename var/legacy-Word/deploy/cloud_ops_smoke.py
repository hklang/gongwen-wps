# -*- coding: utf-8 -*-
"""云上联调：注册 → 额度 → chat → 无票401；legacy 仍可用。不打印密钥。"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://49.233.190.103:8080/gongwen-relay"
LOCAL = Path(__file__).resolve().parent / "server.local.md"


def req(method: str, path: str, body=None, token: str = ""):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json", "X-Gongwen-Client": "night-smoke"}
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-Relay-Token"] = token
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            j = json.loads(raw or "{}")
        except Exception:
            j = {"error": raw}
        return e.code, j


def legacy_token() -> str:
    text = LOCAL.read_text(encoding="utf-8")
    m = re.search(r"中转\s*Token[：:]\s*`([^`]+)`", text)
    if not m:
        m = re.search(r"gongwen-rly-[a-f0-9]+", text)
        return m.group(0) if m else ""
    return m.group(1).strip()


def main() -> int:
    st, health = req("GET", "/api/health")
    assert st == 200 and health.get("control"), health
    print("OK health control=", health.get("control"), "require_user=", health.get("require_user"))

    st, deny = req("POST", "/api/chat", {"message": "x", "capability": "fast"})
    assert st == 401, (st, deny)
    print("OK no-token -> 401")

    email = f"ops{int(time.time())}@ex.com"
    st, reg = req("POST", "/api/auth/register", {"email": email, "password": "password123"})
    assert st == 200 and reg.get("access_token"), (st, reg)
    access = reg["access_token"]
    print("OK register", email)

    st, quota = req("GET", "/api/quota", token=access)
    assert st == 200 and quota.get("ok"), (st, quota)
    print("OK quota remain_day=", quota.get("remain_day"))

    st, chat = req(
        "POST",
        "/api/chat",
        {
            "message": "只回复两个字：收到",
            "capability": "fast",
            "force_final": True,
            "allow_edit": False,
        },
        token=access,
    )
    assert st == 200, (st, chat)
    assert "model" not in chat or chat.get("model") in (None, "")
    reply = (chat.get("reply") or chat.get("raw") or "")[:40]
    print("OK chat status=200 capability=", chat.get("capability"), "reply=", reply)

    leg = legacy_token()
    assert leg, "legacy token missing in server.local.md"
    st, sug = req(
        "POST",
        "/api/suggest",
        {"md": "测试", "requirement": "用一句话润色", "capability": "fast", "count": 1},
        token=leg,
    )
    assert st == 200, (st, sug)
    print("OK legacy suggest still works")
    print("CLOUD OPS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
