# -*- coding: utf-8 -*-
"""S5 邀请码注册冒烟。"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-invite-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "invite-smoke"
    os.environ["CONTROL_REGISTER_MODE"] = "invite"
    from control_db import init_db
    from control_auth import register
    from control_invite import create_invite, revoke_invite, list_invites

    init_db()
    try:
        register(f"no{int(time.time())}@ex.com", "password123")
        raise AssertionError("invite mode should block open register")
    except ValueError as e:
        assert "邀请码" in str(e)

    inv = create_invite(plan_code="pro", max_uses=1, days=7, note="smoke")
    code = inv["code"]
    email = f"ok{int(time.time())}@ex.com"
    sess = register(email, "password123", code)
    assert sess.get("ok") and sess.get("plan", {}).get("code") == "pro"

    try:
        register(f"again{int(time.time())}@ex.com", "password123", code)
        raise AssertionError("used-up invite should fail")
    except ValueError as e:
        assert "用尽" in str(e) or "无效" in str(e)

    inv2 = create_invite(plan_code="free", max_uses=2, days=7, code="SMOKE2")
    revoke_invite("SMOKE2")
    try:
        register(f"rv{int(time.time())}@ex.com", "password123", "SMOKE2")
        raise AssertionError("revoked should fail")
    except ValueError as e:
        assert "作废" in str(e)

    os.environ["CONTROL_REGISTER_MODE"] = "open"
    sess2 = register(f"open{int(time.time())}@ex.com", "password123")
    assert sess2.get("plan", {}).get("code") == "free"

    assert any(x["code"] == code for x in list_invites())
    print("INVITE ALL PASS")
    print("sample_code=", code, "inv2=", inv2["code"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
