# -*- coding: utf-8 -*-
"""组织席位占位冒烟。"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-org-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "org-smoke"
    os.environ["CONTROL_REGISTER_MODE"] = "open"
    from control_db import init_db
    from control_auth import register
    from control_org import create_org, add_member, list_orgs, remove_member

    init_db()
    create_org("acme", "测试单位", seat_limit=1)
    e1 = f"a{int(time.time())}@ex.com"
    e2 = f"b{int(time.time())}@ex.com"
    register(e1, "password123")
    register(e2, "password123")
    add_member("acme", e1)
    try:
        add_member("acme", e2)
        raise AssertionError("seat limit should block")
    except ValueError as e:
        assert "席位" in str(e)
    remove_member(e1)
    add_member("acme", e2)
    orgs = list_orgs()
    assert orgs and orgs[0]["seats_used"] == 1
    print("ORG ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
