# -*- coding: utf-8 -*-
"""运维开通 / 禁用 / 踢人 单元冒烟。"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-admin-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "admin-smoke"
    from control_db import init_db
    from control_auth import (
        register,
        set_user_status,
        revoke_user_sessions,
        grant_subscription,
        verify_access,
        user_is_active,
        find_user_id,
    )

    init_db()
    email = f"adm{int(time.time())}@ex.com"
    sess = register(email, "password123")
    uid = find_user_id(email)
    assert uid and user_is_active(uid)
    assert verify_access(sess["access_token"])
    grant_subscription(email, "pro", 14)
    old = sess["access_token"]
    n = revoke_user_sessions(uid)
    assert n >= 1
    from control_auth import access_still_valid
    assert not access_still_valid(verify_access(old) or {"uid": uid, "ver": 0})
    set_user_status(email, "disabled")
    assert not user_is_active(uid)
    set_user_status(email, "active")
    assert user_is_active(uid)
    from control_auth import list_users
    users = list_users(10)
    assert any(u["email"] == email for u in users), users
    print("ADMIN ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
