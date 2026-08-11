# -*- coding: utf-8 -*-
"""S1 控制面本地冒烟：注册登录、验票、配额、路由（不调真实模型）。"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-control-")
    os.environ["CONTROL_DB"] = str(Path(td) / "control.sqlite")
    os.environ["CONTROL_SECRET"] = "smoke-secret-" + str(time.time())
    os.environ["CONTROL_ENABLED"] = "1"
    os.environ["RELAY_TOKEN"] = "legacy-smoke-token"

    from control_db import init_db
    from control_auth import register, verify_access, refresh, me
    from control_gate import check_quota, record_usage, resolve_route, quota_snapshot, upsert_route

    init_db()
    email = f"smoke_{int(time.time())}@example.com"
    sess = register(email, "password123")
    assert sess.get("access_token"), "no access"
    payload = verify_access(sess["access_token"])
    assert payload and payload["uid"], payload

    check_quota(payload, "fast", 100)
    try:
        check_quota(payload, "strong", 100)
        raise SystemExit("strong should be blocked on free plan")
    except ValueError:
        pass

    route = resolve_route("fast", "chat")
    assert route and route["provider"] and route["model"], route

    record_usage(int(payload["uid"]), "chat", "fast", chars_in=100, ok=True)
    snap = quota_snapshot(payload)
    assert snap["used_day"] >= 1, snap

    sess2 = refresh(sess["refresh_token"])
    assert sess2["access_token"] != sess["access_token"]
    assert me(verify_access(sess2["access_token"]))["ok"]

    upsert_route(
        "strong", "chat", "openai", "gpt-test",
        weight=100, enabled=1, exclusive=True,
    )
    r2 = resolve_route("strong", "chat")
    assert r2["provider"] == "openai", r2

    # 伪造无票：verify 失败
    assert verify_access("bad.token") is None

    print("ALL PASS")
    print("db=", os.environ["CONTROL_DB"])
    print("route_fast=", route)
    print("quota=", {"used_day": snap["used_day"], "remain_day": snap["remain_day"]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
